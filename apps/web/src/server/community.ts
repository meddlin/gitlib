import { createServerFn } from "@tanstack/react-start";
import { missingItems, parseCommunityProfile, type CommunityItemId, type CommunityProfile } from "../lib/community";
import { githubGet, githubToken, groupReposByGitHubSlug, resolveGitHubSource, type GitHubSource } from "./github.server";
import type { Provider } from "./provider";

export interface CommunityView {
  /** Where the profile comes from, or null when the repo has no supported remote. */
  provider: Provider | null;
  /** The repo's `owner/repo` path on that provider. */
  slug: string | null;
  /** Link to the repo's community standards page on the provider's site. */
  communityUrl: string | null;
  profile: CommunityProfile | null;
  error: string | null;
}

export interface CommunityScoresView {
  status: "ok" | "error";
  /** Score and which checklist items are missing, by repo relativePath; repos GitHub couldn't report on are absent. */
  scores: Record<string, { score: number; missing: CommunityItemId[] }>;
  error: string | null;
}

const TTL_MS = 30 * 60_000;
/** Requests in flight at once; GitHub asks integrations not to hammer the API. */
const CONCURRENCY = 6;
/**
 * Scoring every repo is a bulk job, so it stops with this many GitHub requests left, keeping them for the
 * Issues and Pull requests tabs. Without a token GitHub allows only 60 an hour, shared by all of those.
 */
const RATE_RESERVE = 12;

/** Requests GitHub says were left after the most recent profile fetch; null until one has answered. */
let rateRemaining: number | null = null;

type Lookup = { profile: CommunityProfile; error: null } | { profile: null; error: string; status: number };

async function fetchProfile(source: GitHubSource): Promise<Lookup> {
  try {
    // fetch follows the redirect GitHub sends for a renamed or transferred repo.
    const result = await githubGet<unknown>(source, "/community/profile", {});
    if (result.error !== null) return { profile: null, error: result.error, status: result.status };
    if (result.rateRemaining !== null) rateRemaining = result.rateRemaining;
    return { profile: parseCommunityProfile(result.data), error: null };
  } catch (caught) {
    return { profile: null, error: caught instanceof Error ? caught.message : "Could not load the community profile.", status: 0 };
  }
}

/** Rate limits, outages and network failures are worth retrying; a missing or private repo will answer the same way. */
const isTransient = (lookup: Lookup): boolean =>
  lookup.profile === null && (lookup.status === 0 || lookup.status === 403 || lookup.status === 429 || lookup.status >= 500);

const isRateLimited = (lookup: Lookup): boolean => lookup.profile === null && (lookup.status === 403 || lookup.status === 429);

const cache = new Map<string, { at: number; lookup: Promise<Lookup> }>();

/** Drops cached profiles so the next request asks GitHub again (a rescan does this). */
export function clearCommunity(): void {
  cache.clear();
}

const isFresh = (entry: { at: number } | undefined): boolean => entry !== undefined && Date.now() - entry.at <= TTL_MS;

/** One repo's profile, shared by every caller asking for it within a few minutes (including calls still in flight). */
function lookup(source: GitHubSource): Promise<Lookup> {
  const key = source.slug.toLowerCase();
  const hit = cache.get(key);
  if (hit && isFresh(hit)) return hit.lookup;

  const entry = { at: Date.now(), lookup: fetchProfile(source) };
  cache.set(key, entry);
  void entry.lookup.then((result) => {
    if (isTransient(result) && cache.get(key) === entry) cache.delete(key);
  });
  return entry.lookup;
}

/** The community profile for a repository gitlib knows about, read from the GitHub remote; never an arbitrary repo. */
export const getCommunityProfile = createServerFn({ method: "GET" })
  .validator((input: { relativePath: string }) => {
    if (typeof input?.relativePath !== "string" || !input.relativePath) {
      throw new Error("Invalid community profile request.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<CommunityView> => {
    const none: CommunityView = { provider: null, slug: null, communityUrl: null, profile: null, error: null };
    try {
      const { source, error } = resolveGitHubSource(data.relativePath);
      if (error) return { ...none, error };
      if (!source) return none;
      const view = { ...none, provider: source.provider, slug: source.slug, communityUrl: `https://github.com/${source.slug}/community` };

      const result = await lookup(source);
      return result.profile ? { ...view, profile: result.profile } : { ...view, error: result.error };
    } catch (caught) {
      return { ...none, error: caught instanceof Error ? caught.message : "Could not load the community profile." };
    }
  });

async function fetchScores(): Promise<CommunityScoresView> {
  const entries = await groupReposByGitHubSlug();
  const scores: CommunityScoresView["scores"] = {};
  let failure: string | null = null;
  let next = 0;

  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      // After a rate limit every further request would fail the same way, so stop asking.
      while (next < entries.length && !failure) {
        const { ref, paths } = entries[next++]!;
        const source: GitHubSource = {
          provider: "github",
          owner: ref.owner,
          repo: ref.repo,
          slug: `${ref.owner}/${ref.repo}`,
        };
        if (!isFresh(cache.get(source.slug.toLowerCase())) && rateRemaining !== null && rateRemaining <= RATE_RESERVE) {
          failure = `Stopped early to leave some of GitHub's request limit for the Issues and Pull requests tabs.${
            githubToken() ? "" : " Set GITHUB_TOKEN to raise the limit."
          }`;
          break;
        }
        const result = await lookup(source);
        if (result.profile) {
          const entry = { score: result.profile.score, missing: missingItems(result.profile).map((item) => item.id) };
          for (const path of paths) scores[path] = entry;
        } else if (isRateLimited(result)) {
          failure = result.error;
        } else if (result.status === 0 || result.status >= 500) {
          failure ??= result.error;
        }
        // Anything else (a private or deleted repo) just leaves that repo without a score.
      }
    }),
  );

  return failure ? { status: "error", scores, error: failure } : { status: "ok", scores, error: null };
}

/** Community scores for every repo with a GitHub remote, with the missing items behind each. */
export const getCommunityScores = createServerFn({ method: "GET" }).handler(
  async (): Promise<CommunityScoresView> => {
    try {
      return await fetchScores();
    } catch (caught) {
      return { status: "error", scores: {}, error: caught instanceof Error ? caught.message : "Could not load community scores." };
    }
  },
);
