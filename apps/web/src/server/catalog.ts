import { createServerFn } from "@tanstack/react-start";
import { classifyProvider, loadGitRemotes, selectPreferredRemote } from "@gitlib/core";
import {
  mergeCatalog,
  parseLandingPage,
  type CatalogEntry,
  type LocalClone,
  type LocalRemote,
  type RemoteProvider,
  type RemoteRepo,
} from "#/lib/catalog";
import { listGitHubRepos } from "./github.server";
import { gitlabHost, listGitLabProjects } from "./gitlab.server";
import { getApp, loadAndIndexRepositories } from "./gitlib.server";
import { ProviderSetupError } from "./provider-errors";

export interface ProviderStatus {
  /** "not-configured" means gitlib has no credentials for the service; "error" means asking it failed. */
  status: "ok" | "not-configured" | "error";
  message: string | null;
  /** Repositories the service listed for the account. */
  count: number;
}

export interface CatalogView {
  entries: CatalogEntry[];
  github: ProviderStatus;
  gitlab: ProviderStatus;
}

const REMOTES_TTL_MS = 5 * 60_000;

/** Which hosting service a landing page belongs to; self-hosted GitLab is recognised by the configured URL. */
function providerOf(host: string): RemoteProvider | null {
  if (host.toLowerCase() === "github.com") return "github";
  if (host.toLowerCase() === gitlabHost().toLowerCase() || classifyProvider(host) === "GitLab") return "gitlab";
  return null;
}

function localRemotes(absolutePath: string): LocalRemote[] {
  const { remotes } = loadGitRemotes(absolutePath, getApp().system);
  const preferred = selectPreferredRemote(remotes);
  const ordered = preferred ? [preferred, ...remotes.filter((remote) => remote !== preferred)] : remotes;
  return ordered.flatMap((remote) => {
    const parsed = parseLandingPage(remote.landingPageUrl);
    const provider = providerOf(remote.host);
    if (!parsed || !provider || !remote.landingPageUrl) return [];
    return [{ provider, key: parsed.key, fullName: parsed.path, url: remote.landingPageUrl }];
  });
}

/** Where each non-worktree clone points. One `git remote -v` per repo, so it is kept until the next rescan. */
let cachedClones: Promise<LocalClone[]> | undefined;

async function loadClones(): Promise<LocalClone[]> {
  const repos = await loadAndIndexRepositories();
  return repos
    .filter((repo) => !repo.isWorktree && !repo.isMissing)
    .map((repo) => ({
      relativePath: repo.relativePath,
      name: repo.name,
      description: repo.description,
      remotes: localRemotes(repo.absolutePath),
    }));
}

type Listing = { status: ProviderStatus; repos: RemoteRepo[] };
const listings = new Map<RemoteProvider, { at: number; result: Promise<Listing> }>();

async function fetchListing(list: () => Promise<RemoteRepo[]>): Promise<Listing> {
  try {
    const repos = await list();
    return { status: { status: "ok", message: null, count: repos.length }, repos };
  } catch (caught) {
    if (caught instanceof ProviderSetupError) {
      return { status: { status: "not-configured", message: caught.message, count: 0 }, repos: [] };
    }
    const message = caught instanceof Error ? caught.message : "Could not list repositories.";
    return { status: { status: "error", message, count: 0 }, repos: [] };
  }
}

function listingFor(provider: RemoteProvider): Promise<Listing> {
  const hit = listings.get(provider);
  if (hit && Date.now() - hit.at <= REMOTES_TTL_MS) return hit.result;
  const entry = {
    at: Date.now(),
    result: fetchListing(provider === "github" ? listGitHubRepos : listGitLabProjects),
  };
  listings.set(provider, entry);
  // Only successful lookups are worth keeping; a failed one should be retried next time.
  void entry.result.then((result) => {
    if (result.status.status !== "ok" && listings.get(provider) === entry) listings.delete(provider);
  });
  return entry.result;
}

/** Forgets the scanned clones' remotes (a rescan does this); the hosts' listings stay until they expire. */
export function clearCatalogClones(): void {
  cachedClones = undefined;
}

function clearCatalog(): void {
  cachedClones = undefined;
  listings.clear();
}

async function buildCatalog(): Promise<CatalogView> {
  const clones = await (cachedClones ??= loadClones().catch((caught: unknown) => {
    cachedClones = undefined;
    throw caught;
  }));
  const [github, gitlab] = await Promise.all([listingFor("github"), listingFor("gitlab")]);
  return {
    entries: mergeCatalog(clones, github.repos, gitlab.repos),
    github: github.status,
    gitlab: gitlab.status,
  };
}

/**
 * Local clones joined with the repositories GitHub and GitLab list for the configured accounts. The hosts'
 * listings are cached for a few minutes; the local half works whether or not either host is reachable.
 */
export const getCatalog = createServerFn({ method: "GET" }).handler(buildCatalog);

/** Asks both hosts again and rereads every clone's remotes. */
export const refreshCatalog = createServerFn({ method: "POST" }).handler(async () => {
  clearCatalog();
  return buildCatalog();
});
