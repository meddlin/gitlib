import "./env.server";
import { remoteKey, type ListingPage } from "#/lib/catalog";
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

/** Which host and account a stored listing was made for, so changing either never shows the old one's repos. */
export const gitlabScope = (): string => `${gitlabBase()}|${gitlabToken() ? "member" : `user:${gitlabUsername() ?? ""}`}`;
