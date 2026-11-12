import { utcNow, type GitHubRepoRef } from "@gitlib/core";
import { findRemoteOnly } from "../lib/catalog";
import {
  isStale,
  missingItems,
  parseCommunityProfile,
  parseStoredProfile,
  refreshIntervalMs,
  serializeProfile,
  DEFAULT_COMMUNITY_SCOPE,
  type CommunityProfile,
  type CommunityScope,
  type CommunityScoreEntry,
  type CommunitySlugScore,
} from "../lib/community";
import { buildCatalog } from "./catalog.server";
import { readCommunityScope } from "./community-scope.server";
import { githubGet, githubToken, groupReposByGitHubSlug, resolveGitHubSource, sourceOf, type GitHubSource } from "./github.server";
import { getApp } from "./gitlib.server";
import type { Provider } from "./provider";

export interface CommunityView {
  /** Where the profile comes from, or null when the repo has no supported remote. */
  provider: Provider | null;
  /** The repo's `owner/repo` path on that provider. */
  slug: string | null;
  /** Link to the repo's community standards page on the provider's site. */
  communityUrl: string | null;
  profile: CommunityProfile | null;
  /** When `profile` was fetched from GitHub; the profile is read from gitlib's database, not fetched per view. */
  fetchedAt: string | null;
  /** Why the profile couldn't be fetched. A stored profile may still be present, from an earlier fetch. */
  error: string | null;
}

export interface CommunityScoresView {
  status: "ok" | "error";
  /** Which repos are scored, from the Settings page. Repos outside it are neither fetched nor listed in `scores`. */
  scope: CommunityScope;
  /** Score and which checklist items are missing, by repo relativePath; repos with no stored profile are absent. */
  scores: Record<string, CommunityScoreEntry>;
  /**
   * The same by lowercased `owner/repo`, for the lists that include repos with no clone, with when each was
   * fetched. Under "favorites" only favorited repos are here; under "all" every stored profile is.
   */
  bySlug: Record<string, CommunitySlugScore>;
  /** The most recent refresh's failure, if it had one. Scores already stored are still returned. */
  error: string | null;
  /** The oldest fetch time among the scores shown, i.e. how current the table is; null with no scores. */
  updatedAt: string | null;
  /** A refresh is running now; the scores gain entries as it goes. */
  refreshing: boolean;
}

/** Requests in flight at once; GitHub asks integrations not to hammer the API. */
const CONCURRENCY = 6;
/**
 * Scoring every repo is a bulk job, so it stops with this many GitHub requests left, keeping them for the
 * Issues and Pull requests tabs. Without a token GitHub allows only 60 an hour, shared by all of those.
 */
const RATE_RESERVE = 12;
/** How often the running server checks whether any stored profile has aged out. */
const CHECK_EVERY_MS = 60 * 60_000;
/** After a refresh failed, page loads and checks leave GitHub alone for this long. */
const RETRY_AFTER_MS = 60 * 60_000;

interface RefreshRun {
  /** Whether it fetches every repo rather than only those that are due. */
  force: boolean;
  /** Whether it also covers GitHub repos that aren't cloned (only ever the case under the "all" setting). */
  uncloned: boolean;
  promise: Promise<void>;
}

interface CommunityState {
  run?: RefreshRun;
  timer?: ReturnType<typeof setInterval>;
  lastAttemptAt: number | null;
  lastError: string | null;
  /** Requests GitHub says were left after the most recent profile fetch; null until one has answered. */
  rateRemaining: number | null;
}

// Kept on globalThis so dev-server module reloads reuse one timer and one refresh.
const state = ((globalThis as { __gitlibCommunity?: CommunityState }).__gitlibCommunity ??= {
  lastAttemptAt: null,
  lastError: null,
  rateRemaining: null,
});

type Lookup =
  | { profile: CommunityProfile; error: null; fetchedAt: string }
  | { profile: null; error: string; status: number };

async function fetchProfile(source: GitHubSource): Promise<Lookup> {
  try {
    // fetch follows the redirect GitHub sends for a renamed or transferred repo.
    const result = await githubGet<unknown>(source, "/community/profile", {});
    if (result.error !== null) return { profile: null, error: result.error, status: result.status };
    if (result.rateRemaining !== null) state.rateRemaining = result.rateRemaining;
    const profile = parseCommunityProfile(result.data);
    const fetchedAt = utcNow();
    getApp().store.saveCommunityProfile(source.slug, serializeProfile(profile), fetchedAt);
    return { profile, error: null, fetchedAt };
  } catch (caught) {
    return { profile: null, error: caught instanceof Error ? caught.message : "Could not load the community profile.", status: 0 };
  }
}

const isRateLimited = (lookup: Lookup): boolean => lookup.profile === null && (lookup.status === 403 || lookup.status === 429);

const slugKey = (ref: { owner: string; repo: string }): string => `${ref.owner}/${ref.repo}`.toLowerCase();

/** Every stored profile that is still readable, by lowercased slug. */
function storedProfiles(): Map<string, { profile: CommunityProfile; fetchedAt: string }> {
  const stored = new Map<string, { profile: CommunityProfile; fetchedAt: string }>();
  for (const row of getApp().store.listCommunityProfiles()) {
    const profile = parseStoredProfile(row.payload);
    if (profile) stored.set(row.slug, { profile, fetchedAt: row.fetchedAt });
  }
  return stored;
}

const refreshInterval = (): number | null => refreshIntervalMs(process.env["GITLIB_COMMUNITY_REFRESH_HOURS"]);

interface ScoreTarget {
  ref: GitHubRepoRef;
  /** relativePaths of the clones that share this remote; empty for a repo that isn't cloned. */
  paths: string[];
}

/**
 * The repositories whose scores gitlib keeps current, under `scope`: favorited clones, or every clone. With
 * `uncloned`, and only under "all" (a repo that isn't cloned can't be favorited), also the GitHub repos the
 * catalog lists that have no clone.
 */
async function scoredRepos(scope: CommunityScope, uncloned: boolean): Promise<ScoreTarget[]> {
  const local = await groupReposByGitHubSlug();
  const targets = local.filter(({ favorite }) => scope === "all" || favorite).map(({ ref, paths }) => ({ ref, paths }));
  if (!uncloned || scope !== "all") return targets;

  const seen = new Set(local.map(({ ref }) => slugKey(ref)));
  for (const entry of (await buildCatalog()).entries) {
    const source = entry.github && sourceOf(entry.github.fullName);
    if (!source || seen.has(slugKey(source))) continue;
    seen.add(slugKey(source));
    targets.push({ ref: { owner: source.owner, repo: source.repo }, paths: [] });
  }
  return targets;
}

/** Asks GitHub about the repos that are due (or all of them), saving each answer. Never rejects. */
async function runRefresh(force: boolean, uncloned: boolean): Promise<void> {
  state.lastAttemptAt = Date.now();
  let failure: string | null = null;
  try {
    const entries = await scoredRepos(readCommunityScope(), uncloned);
    const stored = storedProfiles();
    const staleAfter = refreshInterval() ?? Infinity;
    // Oldest first, never-fetched ahead of those, so a run cut short by the rate limit resumes where it left off.
    const due = entries
      .filter(({ ref }) => force || isStale(stored.get(slugKey(ref))?.fetchedAt, Date.now(), staleAfter))
      .sort((a, b) => (stored.get(slugKey(a.ref))?.fetchedAt ?? "").localeCompare(stored.get(slugKey(b.ref))?.fetchedAt ?? ""));
    let next = 0;

    await Promise.all(
      Array.from({ length: CONCURRENCY }, async () => {
        // After a rate limit every further request would fail the same way, so stop asking.
        while (next < due.length && !failure) {
          const { ref } = due[next++]!;
          if (state.rateRemaining !== null && state.rateRemaining <= RATE_RESERVE) {
            failure = `Stopped early to leave some of GitHub's request limit for the Issues and Pull requests tabs.${
              githubToken() ? "" : " Set GITLIB_GITHUB_TOKEN to raise the limit."
            }`;
            break;
          }
          const result = await fetchProfile({ provider: "github", owner: ref.owner, repo: ref.repo, slug: `${ref.owner}/${ref.repo}` });
          if (result.profile) continue;
          if (isRateLimited(result)) failure = result.error;
          else if (result.status === 0 || result.status >= 500) failure ??= result.error;
          // Anything else (a private or deleted repo) just leaves that repo without a score.
        }
      }),
    );
  } catch (caught) {
    failure = caught instanceof Error ? caught.message : "Could not refresh community scores.";
  }
  state.lastError = failure;
}

/**
 * Starts a refresh, or joins the one running. A forced refresh isn't satisfied by a run that skips fresh
 * profiles, and a run over clones alone doesn't cover uncloned repos, so each waits for the running one and
 * then runs in full.
 */
function startRefresh(force: boolean, uncloned: boolean): Promise<void> {
  const running = state.run;
  if (running && (running.force || !force) && (running.uncloned || !uncloned)) return running.promise;
  const run: RefreshRun = { force, uncloned, promise: (running?.promise ?? Promise.resolve()).then(() => runRefresh(force, uncloned)) };
  state.run = run;
  void run.promise.finally(() => {
    if (state.run === run) state.run = undefined;
  });
  return run.promise;
}

/** Refreshes in the background when something is due and automatic refreshing is on. */
function refreshIfDue(entries: { ref: { owner: string; repo: string } }[], stored: ReturnType<typeof storedProfiles>): void {
  const interval = refreshInterval();
  if (interval === null || state.run) return;
  // A failure (usually the rate limit) would repeat on every page load, so give GitHub a rest first.
  if (state.lastError && state.lastAttemptAt !== null && Date.now() - state.lastAttemptAt < RETRY_AFTER_MS) return;
  // Never covers uncloned repos: that bulk fetch is only ever started by the button.
  if (entries.some(({ ref }) => isStale(stored.get(slugKey(ref))?.fetchedAt, Date.now(), interval))) void startRefresh(false, false);
}

/** Keeps scores current while the server stays up even if nobody opens the page: one check an hour. */
function ensureScheduler(): void {
  if (state.timer || refreshInterval() === null) return;
  state.timer = setInterval(() => {
    scoredRepos(readCommunityScope(), false)
      .then((entries) => refreshIfDue(entries, storedProfiles()))
      .catch((caught: unknown) => console.warn("Community score check failed:", caught instanceof Error ? caught.message : caught));
  }, CHECK_EVERY_MS);
  state.timer.unref();
}

const noView = (error: string | null = null): CommunityView => ({
  provider: null,
  slug: null,
  communityUrl: null,
  profile: null,
  fetchedAt: null,
  error,
});

/**
 * When a view asks GitHub rather than reading the stored profile:
 * - `missing`: only when nothing is stored. A clone's profile is kept current by the background refresh.
 * - `stale`: also when the stored one is older than the refresh interval. Nothing refreshes a repo that
 *   isn't cloned in the background, so looking at it is what keeps its profile current.
 * - `always`: the user pressed Refresh.
 */
type FetchWhen = "missing" | "stale" | "always";

/** One repository's profile: the stored one, or a fresh one when `when` says so. A failed fetch falls back to what is stored. */
async function sourceView(source: GitHubSource, when: FetchWhen): Promise<CommunityView> {
  const view: CommunityView = { ...noView(), provider: source.provider, slug: source.slug, communityUrl: `https://github.com/${source.slug}/community` };
  const row = getApp().store.getCommunityProfile(source.slug);
  const stored = row ? parseStoredProfile(row.payload) : null;
  const interval = refreshInterval();
  const due = when === "always" || !stored || !row || (when === "stale" && interval !== null && isStale(row.fetchedAt, Date.now(), interval));
  if (!due && stored && row) return { ...view, profile: stored, fetchedAt: row.fetchedAt };

  const result = await fetchProfile(source);
  if (result.profile) return { ...view, profile: result.profile, fetchedAt: result.fetchedAt };
  return { ...view, profile: stored, fetchedAt: stored && row ? row.fetchedAt : null, error: result.error };
}

const failedView = (caught: unknown): CommunityView =>
  noView(caught instanceof Error ? caught.message : "Could not load the community profile.");

/** The profile of a repo gitlib has cloned. Never fetches for one that already has a stored profile unless `refresh`. */
export async function localProfileView(relativePath: string, refresh: boolean): Promise<CommunityView> {
  try {
    const { source, error } = resolveGitHubSource(relativePath);
    if (error) return noView(error);
    if (!source) return noView();
    return await sourceView(source, refresh ? "always" : "missing");
  } catch (caught) {
    return failedView(caught);
  }
}

/**
 * The profile of a repo that is on GitHub and not cloned, found by its `owner/repo`. Only a repo the catalog
 * lists as hosted-only qualifies, so this can't be pointed at an arbitrary one. It asks GitHub when nothing is
 * stored or the stored profile has aged out, so no clone, and no background refresh, is needed.
 */
export async function remoteProfileView(fullName: string, refresh: boolean): Promise<CommunityView> {
  try {
    const link = findRemoteOnly((await buildCatalog()).entries, "github", fullName)?.github;
    const source = link && sourceOf(link.fullName);
    if (!source) return noView(`${fullName} is not a GitHub repository that gitlib lists without a clone. It may already be cloned.`);
    return await sourceView(source, refresh ? "always" : "stale");
  } catch (caught) {
    return failedView(caught);
  }
}

async function scoresView(): Promise<CommunityScoresView> {
  const scope = readCommunityScope();
  const entries = await scoredRepos(scope, false);
  const stored = storedProfiles();
  refreshIfDue(entries, stored);

  const summary = (found: { profile: CommunityProfile }): CommunityScoreEntry => ({
    score: found.profile.score,
    missing: missingItems(found.profile).map((item) => item.id),
  });

  const scores: CommunityScoresView["scores"] = {};
  const bySlug: CommunityScoresView["bySlug"] = {};
  let updatedAt: string | null = null;
  for (const { ref, paths } of entries) {
    const found = stored.get(slugKey(ref));
    if (!found) continue;
    const entry = summary(found);
    for (const path of paths) scores[path] = entry;
    bySlug[slugKey(ref)] = { ...entry, fetchedAt: found.fetchedAt };
    if (updatedAt === null || found.fetchedAt < updatedAt) updatedAt = found.fetchedAt;
  }
  // Under "all" a repo that isn't cloned may have a profile too (fetched by the button or by opening its page).
  if (scope === "all") {
    for (const [slug, found] of stored) bySlug[slug] ??= { ...summary(found), fetchedAt: found.fetchedAt };
  }

  return { status: state.lastError ? "error" : "ok", scope, scores, bySlug, error: state.lastError, updatedAt, refreshing: state.run !== undefined };
}

const scoresFailed = (caught: unknown): CommunityScoresView => ({
  status: "error",
  scope: DEFAULT_COMMUNITY_SCOPE,
  scores: {},
  bySlug: {},
  error: caught instanceof Error ? caught.message : "Could not load community scores.",
  updatedAt: null,
  refreshing: false,
});

/**
 * Community scores for the repos the Settings page says to score (favorited ones by default), with the missing
 * items behind each, read from gitlib's database. If any are older than the refresh interval a refresh starts
 * in the background and `refreshing` says so.
 */
export async function readCommunityScores(): Promise<CommunityScoresView> {
  try {
    ensureScheduler();
    return await scoresView();
  } catch (caught) {
    return scoresFailed(caught);
  }
}

/**
 * Starts asking GitHub for every scored repo's profile now, whatever the refresh interval says, and returns at
 * once with `refreshing` set: the scores fill in as it goes and the caller keeps looking until it is done. The
 * bulk job can be hundreds of requests (`uncloned` adds the GitHub repos with no clone, under the "all" setting),
 * too long to hold one request open for.
 */
export async function refreshAllCommunityScores(uncloned: boolean): Promise<CommunityScoresView> {
  try {
    ensureScheduler();
    void startRefresh(true, uncloned);
    return await scoresView();
  } catch (caught) {
    return scoresFailed(caught);
  }
}
