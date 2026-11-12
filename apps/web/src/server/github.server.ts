import { loadGitRemotes, selectGitHubRepo, type GitHubRepoRef } from "@gitlib/core";
import { remoteKey, type ListingPage } from "#/lib/catalog";
import { MAX_README_LENGTH, NO_README, isMarkdownFileName, type RemoteReadme } from "#/lib/readme";
import { getApp, loadAndIndexRepositories } from "./gitlib.server";
import type { Provider } from "./provider";
import { ProviderSetupError } from "./provider-errors";
import { PAGE_SIZE, fetchListingPages } from "./remote-listing.server";

export const githubToken = (): string | undefined =>
  process.env["GITLIB_GITHUB_TOKEN"] || process.env["GITHUB_TOKEN"] || undefined;

export interface GitHubSource {
  provider: Provider;
  owner: string;
  repo: string;
  /** `owner/repo`. */
  slug: string;
}

/** The source for an `owner/repo` full name; null for anything else (a nested path, a missing half). */
export function sourceOf(fullName: string): GitHubSource | null {
  const [owner, repo, ...rest] = fullName.split("/");
  return owner && repo && rest.length === 0 ? { provider: "github", owner, repo, slug: fullName } : null;
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

/**
 * Every GitHub repository behind the repos gitlib knows about, with the relativePaths that share it.
 * Linked worktrees share a remote with their main repo, so callers can ask GitHub about each repository once.
 * `favorite` is true when any of those paths is a favorite.
 */
export async function groupReposByGitHubSlug(): Promise<{ ref: GitHubRepoRef; paths: string[]; favorite: boolean }[]> {
  const app = getApp();
  const bySlug = new Map<string, { ref: GitHubRepoRef; paths: string[]; favorite: boolean }>();
  for (const repo of await loadAndIndexRepositories()) {
    const { remotes, error } = loadGitRemotes(repo.absolutePath, app.system);
    const ref = error ? null : selectGitHubRepo(remotes);
    if (!ref) continue;
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const entry = bySlug.get(key) ?? { ref, paths: [], favorite: false };
    entry.paths.push(repo.relativePath);
    // A repo counts as a favorite when any clone or worktree of it is.
    entry.favorite ||= repo.isFavorite;
    bySlug.set(key, entry);
  }
  return [...bySlug.values()];
}

/** GETs a repo-scoped GitHub REST endpoint, turning the common failures into messages worth showing. */
export async function githubGet<T>(
  source: GitHubSource,
  path: string,
  params: Record<string, string>,
): Promise<{ data: T; error: null; rateRemaining: number | null } | { data: null; error: string; status: number }> {
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
      status: 404,
      error: token
        ? `${source.slug} was not found on GitHub.`
        : `${source.slug} was not found on GitHub. If it is private, set GITHUB_TOKEN.`,
    };
  }
  if (response.status === 403 || response.status === 429) {
    return {
      data: null,
      status: response.status,
      error: token ? "GitHub rate limit reached. Try again later." : "GitHub rate limit reached. Set GITHUB_TOKEN to raise it.",
    };
  }
  if (!response.ok) return { data: null, status: response.status, error: `GitHub responded with ${response.status}.` };
  const remaining = response.headers.get("x-ratelimit-remaining");
  return {
    data: (await response.json()) as T,
    error: null,
    rateRemaining: remaining !== null && Number.isFinite(Number(remaining)) ? Number(remaining) : null,
  };
}

/**
 * The README GitHub picks for `owner/repo`. A repository without one is `NO_README`, not an error (GitHub answers 404
 * for both, and callers only ask about repos the account's listing already shows). A README in another format than
 * Markdown comes back with its name but no text.
 */
export async function fetchGitHubReadme(fullName: string): Promise<RemoteReadme> {
  const [owner, repo, ...extra] = fullName.split("/");
  if (!owner || !repo || extra.length > 0) {
    return { fileName: null, markdown: null, error: `${fullName} is not a GitHub owner/repo name.` };
  }

  const result = await githubGet<{ name: string; content: string; encoding: string }>(
    { provider: "github", owner, repo, slug: `${owner}/${repo}` },
    "/readme",
    {},
  );
  if (result.error !== null) {
    return result.status === 404 ? NO_README : { fileName: null, markdown: null, error: result.error };
  }

  const { name, content, encoding } = result.data;
  if (!isMarkdownFileName(name)) return { fileName: name, markdown: null, error: null };
  // GitHub leaves the content out of this response for files over 1 MB.
  if (encoding !== "base64") {
    return { fileName: name, markdown: null, error: `${name} is too large for GitHub to send; open it on GitHub instead.` };
  }
  return { fileName: name, markdown: Buffer.from(content, "base64").toString("utf-8").slice(0, MAX_README_LENGTH), error: null };
}

interface GitHubAccountRepo {
  full_name: string;
  name: string;
  description: string | null;
  html_url: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  updated_at: string | null;
  language: string | null;
}

/** Every repository the token's user owns, collaborates on, or can reach through an organization. */
export async function listGitHubRepos(previous: readonly ListingPage[] = []) {
  const token = githubToken();
  if (!token) throw new ProviderSetupError("Set GITLIB_GITHUB_TOKEN to list your GitHub repositories.");

  return fetchListingPages(
    async (page, etag) => {
      const url = new URL("https://api.github.com/user/repos");
      url.search = new URLSearchParams({
        per_page: String(PAGE_SIZE),
        page: String(page),
        sort: "pushed",
        affiliation: "owner,collaborator,organization_member",
      }).toString();
      const response = await fetch(url, {
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "gitlib",
          Authorization: `Bearer ${token}`,
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) throw new Error("GitHub rejected the token (401).");
      if (response.status === 403 || response.status === 429) throw new Error("GitHub rate limit reached. Try again later.");
      if (!response.ok && response.status !== 304) throw new Error(`GitHub responded with ${response.status}.`);
      return response;
    },
    (body) =>
      (body as GitHubAccountRepo[]).map((item) => ({
        provider: "github",
        key: remoteKey("github.com", item.full_name),
        fullName: item.full_name,
        name: item.name,
        description: item.description ?? "",
        url: item.html_url,
        isPrivate: item.private,
        isFork: item.fork,
        isArchived: item.archived,
        updatedAt: item.pushed_at ?? item.updated_at,
        language: item.language,
      })),
    previous,
  );
}
