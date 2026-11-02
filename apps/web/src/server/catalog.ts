import { createServerFn } from "@tanstack/react-start";
import { isGitLibError } from "@gitlib/core";
import { findRemoteOnly, type CatalogEntry, type RemoteProvider } from "#/lib/catalog";
import { getApp } from "./gitlib.server";
import { buildCatalog, cloneRemoteRepo, refreshAllListings, type CloneResult } from "./catalog.server";

export type { CatalogView, CloneResult, ProviderStatus } from "./catalog.server";

/**
 * Local clones joined with the repositories GitHub and GitLab list for the configured accounts. The hosts'
 * listings are read from gitlib's database, never fetched per view; one that is missing or older than
 * `GITLIB_REPO_REFRESH_HOURS` is refreshed in the background and the host's status says `refreshing`.
 */
export const getCatalog = createServerFn({ method: "GET" }).handler(() => buildCatalog());

/** Asks both hosts for their complete listings now, ignoring ETags, and rereads every clone's remotes. */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(() => refreshAllListings());

interface RemoteRepoInput {
  provider: RemoteProvider;
  fullName: string;
}

function validateRemoteRepo(input: RemoteRepoInput): RemoteRepoInput {
  if ((input?.provider !== "github" && input?.provider !== "gitlab") || typeof input.fullName !== "string" || !input.fullName) {
    throw new Error("Invalid repository request.");
  }
  return input;
}

/** A repo that GitHub or GitLab has and no local clone does; null when it is unknown or already cloned. */
export const getRemoteRepo = createServerFn({ method: "GET" })
  .validator(validateRemoteRepo)
  .handler(async ({ data }): Promise<CatalogEntry | null> => findRemoteOnly((await buildCatalog()).entries, data.provider, data.fullName));

/** Clones a remote-only repo into the clone directory. */
export const cloneRepo = createServerFn({ method: "POST" })
  .validator(validateRemoteRepo)
  .handler(({ data }): Promise<CloneResult> => cloneRemoteRepo(data.provider, data.fullName));

/** Where "Clone locally" puts repositories, and the roots it may be inside of. */
export const getCloneDirectory = createServerFn({ method: "GET" }).handler(() => {
  const { cloneDir, roots } = getApp().config;
  return { directory: cloneDir, roots };
});

/** Saves the clone directory; a bad one comes back as a message to show beside the field. */
export const saveCloneDirectory = createServerFn({ method: "POST" })
  .validator((input: { directory: string }) => {
    if (typeof input?.directory !== "string") throw new Error("Invalid directory.");
    return input;
  })
  .handler(async ({ data }): Promise<{ ok: true; directory: string } | { ok: false; error: string }> => {
    try {
      return { ok: true, directory: getApp().setCloneDirectory(data.directory) };
    } catch (error) {
      if (isGitLibError(error)) return { ok: false, error: error.message };
      throw error;
    }
  });
