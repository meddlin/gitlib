import "./env.server";
import { remoteKey, type ListingPage } from "#/lib/catalog";
import { MAX_README_LENGTH, NO_README, isMarkdownFileName, pickReadmeName, type RemoteReadme } from "#/lib/readme";
import { ProviderSetupError } from "./provider-errors";
import { PAGE_SIZE, fetchListingPages } from "./remote-listing.server";

export const gitlabUsername = (): string | undefined => process.env["GITLIB_GITLAB_USERNAME"] || undefined;

/** A personal access token with `read_api`; without one only a user's public projects can be listed. */
export const gitlabToken = (): string | undefined => process.env["GITLIB_GITLAB_TOKEN"] || undefined;

export const gitlabBase = (): string => (process.env["GITLIB_GITLAB_URL"] || "https://gitlab.com").replace(/\/+$/, "");

export const gitlabHost = (): string => new URL(gitlabBase()).host;

interface GitLabProject {
  path_with_namespace: string;
  path: string;
  description: string | null;
  web_url: string;
  visibility?: string;
  archived?: boolean;
  last_activity_at: string | null;
  forked_from_project?: unknown;
}

/**
 * The projects the token's user is a member of, or, with only a username configured, that user's public
 * projects. Owned, group and shared projects all count as membership.
 */
export async function listGitLabProjects(previous: readonly ListingPage[] = []) {
  const token = gitlabToken();
  const username = gitlabUsername();
  if (!token && !username) {
    throw new ProviderSetupError(
      "Set GITLIB_GITLAB_TOKEN (or GITLIB_GITLAB_USERNAME for public projects), and GITLIB_GITLAB_URL if self-hosted.",
    );
  }

  const endpoint = token
    ? `${gitlabBase()}/api/v4/projects`
    : `${gitlabBase()}/api/v4/users/${encodeURIComponent(username!)}/projects`;
  const host = gitlabHost();

  return fetchListingPages(
    async (page, etag) => {
      const url = new URL(endpoint);
      url.search = new URLSearchParams({
        per_page: String(PAGE_SIZE),
        page: String(page),
        order_by: "last_activity_at",
        sort: "desc",
        ...(token ? { membership: "true" } : {}),
      }).toString();
      const response = await fetch(url, {
        headers: {
          Accept: "application/json",
          "User-Agent": "gitlib",
          ...(token ? { "PRIVATE-TOKEN": token } : {}),
          ...(etag ? { "If-None-Match": etag } : {}),
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status === 401) throw new Error("GitLab rejected the token (401).");
      if (response.status === 404 && !token) throw new Error(`GitLab has no user named ${username}.`);
      if (response.status === 429) throw new Error("GitLab rate limit reached. Try again later.");
      if (!response.ok && response.status !== 304) throw new Error(`GitLab responded with ${response.status}.`);
      return response;
    },
    (body) =>
      (body as GitLabProject[]).map((item) => ({
        provider: "gitlab",
        key: remoteKey(host, item.path_with_namespace),
        fullName: item.path_with_namespace,
        name: item.path,
        description: item.description ?? "",
        url: item.web_url,
        isPrivate: item.visibility !== undefined && item.visibility !== "public",
        isFork: Boolean(item.forked_from_project),
        isArchived: item.archived === true,
        updatedAt: item.last_activity_at,
        language: null,
      })),
    previous,
  );
}

/**
 * One GET against a project's repository API. A 404 comes back for the caller to interpret (no such file, or an empty
 * repository); every other failure is turned into a message worth showing.
 */
async function gitlabRepositoryGet(fullName: string, path: string, params: Record<string, string> = {}): Promise<Response> {
  const token = gitlabToken();
  const url = new URL(`${gitlabBase()}/api/v4/projects/${encodeURIComponent(fullName)}/repository${path}`);
  url.search = new URLSearchParams(params).toString();
  const response = await fetch(url, {
    headers: { "User-Agent": "gitlib", ...(token ? { "PRIVATE-TOKEN": token } : {}) },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 401) throw new Error("GitLab rejected the token (401).");
  if (response.status === 429) throw new Error("GitLab rate limit reached. Try again later.");
  if (!response.ok && response.status !== 404) throw new Error(`GitLab responded with ${response.status}.`);
  return response;
}

/**
 * The README in the root of a project's default branch, found by listing the root (so `readme.md` and `README.markdown`
 * count) and then reading that file. A project without one, or an empty project, is `NO_README`. Only the first 100
 * entries of the root are searched, which holds for any ordinary repository.
 */
export async function fetchGitLabReadme(fullName: string): Promise<RemoteReadme> {
  const tree = await gitlabRepositoryGet(fullName, "/tree", { per_page: "100" });
  if (tree.status === 404) return NO_README;
  const entries = (await tree.json()) as { name: string; type: string }[];
  const fileName = pickReadmeName(entries.filter((entry) => entry.type === "blob").map((entry) => entry.name));
  if (!fileName) return NO_README;
  if (!isMarkdownFileName(fileName)) return { fileName, markdown: null, error: null };

  const raw = await gitlabRepositoryGet(fullName, `/files/${encodeURIComponent(fileName)}/raw`);
  if (raw.status === 404) return NO_README;
  return { fileName, markdown: (await raw.text()).slice(0, MAX_README_LENGTH), error: null };
}

/** Which host and account a stored listing was made for, so changing either never shows the old one's repos. */
export const gitlabScope = (): string => `${gitlabBase()}|${gitlabToken() ? "member" : `user:${gitlabUsername() ?? ""}`}`;
