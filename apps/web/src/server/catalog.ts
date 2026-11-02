import { createServerFn } from "@tanstack/react-start";
import { buildCatalog, refreshAllListings } from "./catalog.server";

export type { CatalogView, ProviderStatus } from "./catalog.server";

/**
 * Local clones joined with the repositories GitHub and GitLab list for the configured accounts. The hosts'
 * listings are read from gitlib's database, never fetched per view; one that is missing or older than
 * `GITLIB_REPO_REFRESH_HOURS` is refreshed in the background and the host's status says `refreshing`.
 */
export const getCatalog = createServerFn({ method: "GET" }).handler(() => buildCatalog());

/** Asks both hosts for their complete listings now, ignoring ETags, and rereads every clone's remotes. */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(() => refreshAllListings());
