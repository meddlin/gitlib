import { createServerFn } from "@tanstack/react-start";
import { utcNow } from "@gitlib/core";
import {
  isStale,
  missingItems,
  parseCommunityProfile,
  parseStoredProfile,
  refreshIntervalMs,
  serializeProfile,
  type CommunityItemId,
  type CommunityProfile,
} from "../lib/community";
import { githubGet, githubToken, groupReposByGitHubSlug, resolveGitHubSource, type GitHubSource } from "./github.server";
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
  /** Score and which checklist items are missing, by repo relativePath; repos with no stored profile are absent. */
  scores: Record<string, { score: number; missing: CommunityItemId[] }>;
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

/** Asks GitHub about the repos that are due (or all of them), saving each answer. Never rejects. */
async function runRefresh(force: boolean): Promise<void> {
  state.lastAttemptAt = Date.now();
  let failure: string | null = null;
  try {
    const entries = await groupReposByGitHubSlug();
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
 * profiles, so it waits for that one and then runs in full.
 */
function startRefresh(force: boolean): Promise<void> {
  const running = state.run;
  if (running && (running.force || !force)) return running.promise;
  const run: RefreshRun = { force, promise: (running?.promise ?? Promise.resolve()).then(() => runRefresh(force)) };
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
  if (entries.some(({ ref }) => isStale(stored.get(slugKey(ref))?.fetchedAt, Date.now(), interval))) void startRefresh(false);
}

/** Keeps scores current while the server stays up even if nobody opens the page: one check an hour. */
function ensureScheduler(): void {
  if (state.timer || refreshInterval() === null) return;
  state.timer = setInterval(() => {
    groupReposByGitHubSlug()
      .then((entries) => refreshIfDue(entries, storedProfiles()))
      .catch((caught: unknown) => console.warn("Community score check failed:", caught instanceof Error ? caught.message : caught));
  }, CHECK_EVERY_MS);
  state.timer.unref();
}

async function profileView(relativePath: string, refresh: boolean): Promise<CommunityView> {
  const none: CommunityView = { provider: null, slug: null, communityUrl: null, profile: null, fetchedAt: null, error: null };
  try {
    const { source, error } = resolveGitHubSource(relativePath);
    if (error) return { ...none, error };
    if (!source) return none;
    const view = { ...none, provider: source.provider, slug: source.slug, communityUrl: `https://github.com/${source.slug}/community` };

    const row = getApp().store.getCommunityProfile(source.slug);
    const stored = row ? parseStoredProfile(row.payload) : null;
    if (stored && row && !refresh) return { ...view, profile: stored, fetchedAt: row.fetchedAt };

    // Nothing stored yet (a repo added since the last refresh), or the user asked: this one repo, now.
    const result = await fetchProfile(source);
    if (result.profile) return { ...view, profile: result.profile, fetchedAt: result.fetchedAt };
    return { ...view, profile: stored, fetchedAt: stored && row ? row.fetchedAt : null, error: result.error };
  } catch (caught) {
    return { ...none, error: caught instanceof Error ? caught.message : "Could not load the community profile." };
  }
}

const validateRelativePath = (input: { relativePath: string }) => {
  if (typeof input?.relativePath !== "string" || !input.relativePath) {
    throw new Error("Invalid community profile request.");
  }
  return input;
};

/** The community profile for a repository gitlib knows about, as last stored; never an arbitrary repo. */
export const getCommunityProfile = createServerFn({ method: "GET" })
  .validator(validateRelativePath)
  .handler(({ data }): Promise<CommunityView> => profileView(data.relativePath, false));

/** Asks GitHub again for one repository's profile and stores the answer. */
export const refreshCommunityProfile = createServerFn({ method: "POST" })
  .validator(validateRelativePath)
  .handler(({ data }): Promise<CommunityView> => profileView(data.relativePath, true));

async function scoresView(): Promise<CommunityScoresView> {
  const entries = await groupReposByGitHubSlug();
  const stored = storedProfiles();
  refreshIfDue(entries, stored);

  const scores: CommunityScoresView["scores"] = {};
  let updatedAt: string | null = null;
  for (const { ref, paths } of entries) {
    const found = stored.get(slugKey(ref));
    if (!found) continue;
    const entry = { score: found.profile.score, missing: missingItems(found.profile).map((item) => item.id) };
    for (const path of paths) scores[path] = entry;
    if (updatedAt === null || found.fetchedAt < updatedAt) updatedAt = found.fetchedAt;
  }

  return { status: state.lastError ? "error" : "ok", scores, error: state.lastError, updatedAt, refreshing: state.run !== undefined };
}

const scoresFailed = (caught: unknown): CommunityScoresView => ({
  status: "error",
  scores: {},
  error: caught instanceof Error ? caught.message : "Could not load community scores.",
  updatedAt: null,
  refreshing: false,
});

/**
 * Community scores for every repo with a GitHub remote, with the missing items behind each, read from
 * gitlib's database. If any are older than the refresh interval a refresh starts in the background and
 * `refreshing` says so.
 */
export const getCommunityScores = createServerFn({ method: "GET" }).handler(async (): Promise<CommunityScoresView> => {
  try {
    ensureScheduler();
    return await scoresView();
  } catch (caught) {
    return scoresFailed(caught);
  }
});

/** Asks GitHub for every repo's profile now, whatever the refresh interval says, and returns the new scores. */
export const refreshCommunityScores = createServerFn({ method: "POST" }).handler(async (): Promise<CommunityScoresView> => {
  try {
    ensureScheduler();
    await startRefresh(true);
    return await scoresView();
  } catch (caught) {
    return scoresFailed(caught);
  }
});
