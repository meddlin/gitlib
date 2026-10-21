import { loadGitRemotes, selectGitHubRepo } from "@gitlib/core";
import { getApp } from "./gitlib.server";
import type { Provider } from "./provider";

export const githubToken = (): string | undefined =>
  process.env["GITLIB_GITHUB_TOKEN"] || process.env["GITHUB_TOKEN"] || undefined;

export interface GitHubSource {
  provider: Provider;
  owner: string;
  repo: string;
  /** `owner/repo`. */
  slug: string;
}

/** The GitHub repository behind a repo gitlib knows about; never an arbitrary one. Throws if the repo is unknown. */
export function resolveGitHubSource(relativePath: string): { source: GitHubSource | null; error: string | null } {
  const app = getApp();
  const repo = app.getRepository(relativePath);
  const { remotes, error } = loadGitRemotes(repo.absolutePath, app.system);
  if (error) return { source: null, error };
  const ref = selectGitHubRepo(remotes);
  if (!ref) return { source: null, error: null };
  return { source: { provider: "github", owner: ref.owner, repo: ref.repo, slug: `${ref.owner}/${ref.repo}` }, error: null };
}

/** GETs a repo-scoped GitHub REST endpoint, turning the common failures into messages worth showing. */
export async function githubGet<T>(
  source: GitHubSource,
  path: string,
  params: Record<string, string>,
): Promise<{ data: T; error: null } | { data: null; error: string }> {
  const url = new URL(
    `https://api.github.com/repos/${encodeURIComponent(source.owner)}/${encodeURIComponent(source.repo)}${path}`,
  );
  url.search = new URLSearchParams(params).toString();
  const token = githubToken();
  const response = await fetch(url, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "gitlib",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  if (response.status === 404) {
    return {
      data: null,
      error: token
        ? `${source.slug} was not found on GitHub.`
        : `${source.slug} was not found on GitHub. If it is private, set GITHUB_TOKEN.`,
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      data: null,
      error: token ? "GitHub rate limit reached. Try again later." : "GitHub rate limit reached. Set GITHUB_TOKEN to raise it.",
    };
  }
  if (!response.ok) return { data: null, error: `GitHub responded with ${response.status}.` };
  return { data: (await response.json()) as T, error: null };
}
