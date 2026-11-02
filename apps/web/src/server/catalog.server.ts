import { classifyProvider, loadGitRemotes, selectPreferredRemote, utcNow } from "@gitlib/core";
import {
  mergeCatalog,
  parseLandingPage,
  parseStoredListing,
  type CatalogEntry,
  type ListingPage,
  type LocalClone,
  type LocalRemote,
  type RemoteProvider,
  type RemoteRepo,
  type StoredListing,
} from "#/lib/catalog";
import { isStale, refreshIntervalMs } from "#/lib/community";
import { githubToken, listGitHubRepos } from "./github.server";
import { getApp, loadAndIndexRepositories } from "./gitlib.server";
import { gitlabHost, gitlabScope, gitlabToken, gitlabUsername, listGitLabProjects } from "./gitlab.server";
import { ProviderSetupError } from "./provider-errors";

export interface ProviderStatus {
  /** "not-configured" means gitlib has no credentials for the service; "error" means the last check failed. */
  status: "ok" | "not-configured" | "error";
  message: string | null;
  /** Repositories the service listed for the account, as last stored. */
  count: number;
  /** When the service was last asked (whether or not anything changed); null if never. */
  fetchedAt: string | null;
  /** A check is running now. */
  refreshing: boolean;
}

export interface CatalogView {
  entries: CatalogEntry[];
  github: ProviderStatus;
  gitlab: ProviderStatus;
}

const PROVIDERS: readonly RemoteProvider[] = ["github", "gitlab"];

/** Hours between automatic checks. A check that finds nothing new costs no GitHub quota (ETag revalidation). */
const DEFAULT_REFRESH_HOURS = 6;
const refreshInterval = (): number | null => refreshIntervalMs(process.env["GITLIB_REPO_REFRESH_HOURS"], DEFAULT_REFRESH_HOURS);

/** How often the running server checks whether a stored listing has aged out. */
const CHECK_EVERY_MS = 15 * 60_000;
/** After a check failed, page loads and the timer leave that host alone for this long. */
const RETRY_AFTER_MS = 30 * 60_000;

const isConfigured = (provider: RemoteProvider): boolean =>
  provider === "github" ? Boolean(githubToken()) : Boolean(gitlabToken() || gitlabUsername());

/** Identifies the account a listing is for; a stored listing from another account or host is ignored. */
const scopeOf = (provider: RemoteProvider): string => (provider === "github" ? "github.com" : gitlabScope());

interface HostState {
  run?: Promise<void>;
  lastAttemptAt: number | null;
  lastError: string | null;
}

interface CatalogState {
  hosts: Record<RemoteProvider, HostState>;
  timer?: ReturnType<typeof setInterval>;
}

// Kept on globalThis so dev-server module reloads reuse one timer and one check per host.
const state = ((globalThis as { __gitlibCatalog?: CatalogState }).__gitlibCatalog ??= {
  hosts: { github: { lastAttemptAt: null, lastError: null }, gitlab: { lastAttemptAt: null, lastError: null } },
});

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

/** Forgets the scanned clones' remotes (a rescan does this); stored host listings are untouched. */
export function clearCatalogClones(): void {
  cachedClones = undefined;
}

interface StoredHost {
  listing: StoredListing;
  fetchedAt: string;
}

/** The host's listing as last stored, if it is readable and for the account that is configured now. */
function storedHost(provider: RemoteProvider): StoredHost | null {
  const row = getApp().store.getRemoteListing(provider);
  const listing = row ? parseStoredListing(row.payload, scopeOf(provider)) : null;
  return row && listing ? { listing, fetchedAt: row.fetchedAt } : null;
}

/**
 * Asks the host for its listing and stores the answer. Unless `full`, pages the host says haven't changed are
 * reused (free for GitHub). The stored time moves to now even when nothing changed, since it was just checked.
 * Never rejects.
 */
async function runCheck(provider: RemoteProvider, full: boolean): Promise<void> {
  const host = state.hosts[provider];
  host.lastAttemptAt = Date.now();
  try {
    const held = full ? [] : (storedHost(provider)?.listing.pages ?? []);
    const pages = await (provider === "github" ? listGitHubRepos(held) : listGitLabProjects(held));
    const listing: StoredListing = { scope: scopeOf(provider), pages };
    getApp().store.saveRemoteListing(provider, JSON.stringify(listing), utcNow());
    host.lastError = null;
  } catch (caught) {
    host.lastError = caught instanceof ProviderSetupError ? null : caught instanceof Error ? caught.message : "Could not list repositories.";
  }
}

/** Starts a check, or joins the one running; a full one waits for a running conditional check first. */
function startCheck(provider: RemoteProvider, full: boolean): Promise<void> {
  const host = state.hosts[provider];
  if (host.run && !full) return host.run;
  const run = (host.run ?? Promise.resolve()).then(() => runCheck(provider, full));
  host.run = run;
  void run.finally(() => {
    if (host.run === run) host.run = undefined;
  });
  return run;
}

/** Starts a background check for each configured host whose stored listing is missing or older than the interval. */
function checkIfDue(): void {
  const interval = refreshInterval();
  for (const provider of PROVIDERS) {
    const host = state.hosts[provider];
    if (!isConfigured(provider) || host.run) continue;
    const stored = storedHost(provider);
    // Nothing stored must be fetched whatever the interval says; otherwise 0 means "only on the button".
    if (stored && (interval === null || !isStale(stored.fetchedAt, Date.now(), interval))) continue;
    // A failure (an expired token, the rate limit) would repeat on every page load, so give the host a rest first.
    if (host.lastError && host.lastAttemptAt !== null && Date.now() - host.lastAttemptAt < RETRY_AFTER_MS) continue;
    void startCheck(provider, false);
  }
}

/** Keeps listings current while the server stays up even if nobody opens the page. */
function ensureScheduler(): void {
  if (state.timer) return;
  state.timer = setInterval(() => {
    try {
      checkIfDue();
    } catch (caught) {
      console.warn("Repository listing check failed:", caught instanceof Error ? caught.message : caught);
    }
  }, CHECK_EVERY_MS);
  state.timer.unref();
}

function statusOf(provider: RemoteProvider, stored: StoredHost | null): ProviderStatus {
  const host = state.hosts[provider];
  const refreshing = host.run !== undefined;
  if (!isConfigured(provider)) {
    const message =
      provider === "github"
        ? "Set GITLIB_GITHUB_TOKEN to list your GitHub repositories."
        : "Set GITLIB_GITLAB_TOKEN (or GITLIB_GITLAB_USERNAME for public projects), and GITLIB_GITLAB_URL if self-hosted.";
    return { status: "not-configured", message, count: 0, fetchedAt: null, refreshing: false };
  }
  return {
    status: host.lastError ? "error" : "ok",
    message: host.lastError,
    count: stored?.listing.pages.reduce((sum, page) => sum + page.repos.length, 0) ?? 0,
    fetchedAt: stored?.fetchedAt ?? null,
    refreshing,
  };
}

export async function buildCatalog(): Promise<CatalogView> {
  ensureScheduler();
  checkIfDue();
  const clones = await (cachedClones ??= loadClones().catch((caught: unknown) => {
    cachedClones = undefined;
    throw caught;
  }));

  const repos: Record<RemoteProvider, RemoteRepo[]> = { github: [], gitlab: [] };
  const stored: Record<RemoteProvider, StoredHost | null> = { github: null, gitlab: null };
  for (const provider of PROVIDERS) {
    // Stored repos of a host that is no longer configured are not shown as if they were current.
    stored[provider] = isConfigured(provider) ? storedHost(provider) : null;
    repos[provider] = (stored[provider]?.listing.pages ?? []).flatMap((page: ListingPage) => page.repos);
  }
  return {
    entries: mergeCatalog(clones, repos.github, repos.gitlab),
    github: statusOf("github", stored.github),
    gitlab: statusOf("gitlab", stored.gitlab),
  };
}

/** Asks both configured hosts for their complete listings now (ignoring ETags), and rereads every clone's remotes. */
export async function refreshAllListings(): Promise<CatalogView> {
  cachedClones = undefined;
  await Promise.all(PROVIDERS.filter(isConfigured).map((provider) => startCheck(provider, true)));
  return buildCatalog();
}
