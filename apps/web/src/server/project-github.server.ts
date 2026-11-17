import { resolveGitHubSource, githubToken, type GitHubSource } from "./github.server";
import { fetchOpenIssues, fetchOpenPulls, fetchRecentCommits } from "./github-lists.server";
import type { GitHubList, ProjectGitHubRepo, ProjectGitHubView } from "./project-github";

/**
 * A read-only look at what GitHub holds for the repos in a project. Nothing here writes to GitHub, and
 * nothing is saved: the only copy is the in-memory cache below, which a restart empties. Gitlib's own
 * planning data is never read or changed, so the two cannot drift or be mistaken for one another.
 */

export const GITHUB_CACHE_TTL_MS = 5 * 60_000;
/** Repos read at once. Each one is three requests, and an unauthenticated client only gets 60 an hour. */
const CONCURRENCY = 4;

type Activity = Pick<ProjectGitHubRepo, "pulls" | "issues" | "commits">;

const cache = new Map<string, { at: number; activity: Promise<Activity> }>();

/** Empties the in-memory cache, so the next look asks GitHub again. */
export function clearProjectGitHubCache(): void {
  cache.clear();
}

async function settle<T>(read: Promise<GitHubList<T>>, fallback: string): Promise<GitHubList<T>> {
  try {
    return await read;
  } catch (caught) {
    return { items: [], hasMore: false, error: caught instanceof Error ? caught.message : fallback };
  }
}

async function readActivity(source: GitHubSource): Promise<Activity> {
  const [pulls, issues, commits] = await Promise.all([
    settle(fetchOpenPulls(source), "Could not load pull requests."),
    settle(fetchOpenIssues(source), "Could not load issues."),
    settle(fetchRecentCommits(source), "Could not load commits."),
  ]);
  return { pulls, issues, commits };
}

const failedEntirely = ({ pulls, issues, commits }: Activity) =>
  pulls.error !== null && issues.error !== null && commits.error !== null;

function activityOf(source: GitHubSource, refresh: boolean): Promise<Activity> {
  const key = source.slug.toLowerCase();
  const cached = cache.get(key);
  if (!refresh && cached && Date.now() - cached.at <= GITHUB_CACHE_TTL_MS) return cached.activity;

  const entry = { at: Date.now(), activity: readActivity(source) };
  cache.set(key, entry);
  // A lookup that failed outright is worth retrying next time rather than keeping for minutes.
  void entry.activity.then((activity) => {
    if (failedEntirely(activity) && cache.get(key) === entry) cache.delete(key);
  });
  return entry.activity;
}

const noList = <T>(): GitHubList<T> => ({ items: [], hasMore: false, error: null });

/** Runs `work` over `items` with at most `limit` in flight, keeping the results in order. */
async function inPool<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Open pull requests, open issues and recent commits from GitHub for each repo path, in the order given.
 * Only repos gitlib knows are read (`resolveGitHubSource` refuses any other), and a repo without a GitHub
 * remote, or one that cannot be read, is reported on its own without affecting the rest.
 */
export async function readProjectGitHub(
  repoPaths: readonly string[],
  { refresh = false, remotes = [] }: { refresh?: boolean; remotes?: readonly string[] } = {},
): Promise<ProjectGitHubView> {
  const repos = await inPool(repoPaths, CONCURRENCY, async (relativePath): Promise<ProjectGitHubRepo> => {
    const empty = { relativePath, slug: null, url: null, pulls: noList<never>(), issues: noList<never>(), commits: noList<never>() };
    let resolved: ReturnType<typeof resolveGitHubSource>;
    try {
      resolved = resolveGitHubSource(relativePath);
    } catch {
      return { ...empty, error: "Gitlib no longer finds this repository." };
    }
    if (resolved.error) return { ...empty, error: resolved.error };
    if (!resolved.source) return { ...empty, error: null };

    const { source } = resolved;
    return {
      ...empty,
      slug: source.slug,
      url: `https://github.com/${source.slug}`,
      error: null,
      ...(await activityOf(source, refresh)),
    };
  });
  // Hosted repos the project holds without a clone, by `owner/repo`. One whose slug a clone already covers is skipped.
  const seen = new Set(repos.flatMap((repo) => (repo.slug ? [repo.slug.toLowerCase()] : [])));
  const hosted = remotes.filter((slug) => {
    const key = slug.toLowerCase();
    return !seen.has(key) && seen.add(key);
  });
  const hostedRepos = await inPool(hosted, CONCURRENCY, async (slug): Promise<ProjectGitHubRepo> => {
    const empty = { relativePath: slug, slug, url: `https://github.com/${slug}`, error: null, pulls: noList<never>(), issues: noList<never>(), commits: noList<never>() };
    const [owner, repo, ...rest] = slug.split("/");
    if (!owner || !repo || rest.length > 0) return { ...empty, slug: null, url: null, error: "That is not a GitHub repository name." };
    return { ...empty, ...(await activityOf({ provider: "github", owner, repo, slug }, refresh)) };
  });
  return { repos: [...repos, ...hostedRepos], fetchedAt: new Date().toISOString(), hasToken: githubToken() !== undefined };
}
