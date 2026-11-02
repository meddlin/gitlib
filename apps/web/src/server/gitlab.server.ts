import "./env.server";
import { remoteKey, type RemoteRepo } from "#/lib/catalog";
import { ProviderSetupError } from "./provider-errors";

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

/** Pages of 100, capped like the GitHub listing. */
const PROJECT_PAGES = 10;

/**
 * The projects the token's user is a member of, or, with only a username configured, that user's public
 * projects. Owned, group and shared projects all count as membership.
 */
export async function listGitLabProjects(): Promise<RemoteRepo[]> {
  const token = gitlabToken();
  const username = gitlabUsername();
  if (!token && !username) {
    throw new ProviderSetupError("Set GITLIB_GITLAB_TOKEN (or GITLIB_GITLAB_USERNAME for public projects), and GITLIB_GITLAB_URL if self-hosted.");
  }

  const endpoint = token
    ? `${gitlabBase()}/api/v4/projects`
    : `${gitlabBase()}/api/v4/users/${encodeURIComponent(username!)}/projects`;
  const host = gitlabHost();

  const repos: RemoteRepo[] = [];
  for (let page = 1; page <= PROJECT_PAGES; page += 1) {
    const url = new URL(endpoint);
    url.search = new URLSearchParams({
      per_page: "100",
      page: String(page),
      order_by: "last_activity_at",
      sort: "desc",
      ...(token ? { membership: "true" } : {}),
    }).toString();
    const response = await fetch(url, {
      headers: { Accept: "application/json", "User-Agent": "gitlib", ...(token ? { "PRIVATE-TOKEN": token } : {}) },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 401) throw new Error("GitLab rejected the token (401).");
    if (response.status === 404 && !token) throw new Error(`GitLab has no user named ${username}.`);
    if (response.status === 429) throw new Error("GitLab rate limit reached. Try again later.");
    if (!response.ok) throw new Error(`GitLab responded with ${response.status}.`);

    const batch = (await response.json()) as GitLabProject[];
    for (const item of batch) {
      repos.push({
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
      });
    }
    if (batch.length < 100) break;
  }
  return repos;
}
