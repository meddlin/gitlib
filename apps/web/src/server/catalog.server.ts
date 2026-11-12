import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { classifyProvider, loadGitRemotes, selectPreferredRemote, utcNow, type RemoteFavorite } from "@gitlib/core";
import {
  cloneFolderName,
  cloneUrlOf,
  findRemoteOnly,
  mergeCatalog,
  parseLandingPage,
  parseStoredListing,
  remoteFavoriteId,
  type CatalogEntry,
  type ListingPage,
  type LocalClone,
  type LocalRemote,
  type RemoteProvider,
  type RemoteRepo,
  type StoredListing,
} from "#/lib/catalog";
import { isStale, refreshIntervalMs } from "#/lib/community";
import type { RemoteReadme } from "#/lib/readme";
import { fetchGitHubReadme, githubToken, listGitHubRepos } from "./github.server";
import { getApp, loadAndIndexRepositories } from "./gitlib.server";
import { fetchGitLabReadme, gitlabHost, gitlabScope, gitlabToken, gitlabUsername, listGitLabProjects } from "./gitlab.server";
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
      isFavorite: repo.isFavorite,
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
  const cloned = await (cachedClones ??= loadClones().catch((caught: unknown) => {
    cachedClones = undefined;
    throw caught;
  }));

  // The clones are cached until a rescan, but a star can change at any time (here or in the local table).
  const starred = new Set(
    getApp()
      .loadRepositories()
      .filter((repo) => repo.isFavorite)
      .map((repo) => repo.relativePath),
  );
  const clones = cloned.map((clone) => ({ ...clone, isFavorite: starred.has(clone.relativePath) }));

  const repos: Record<RemoteProvider, RemoteRepo[]> = { github: [], gitlab: [] };
  const stored: Record<RemoteProvider, StoredHost | null> = { github: null, gitlab: null };
  for (const provider of PROVIDERS) {
    // Stored repos of a host that is no longer configured are not shown as if they were current.
    stored[provider] = isConfigured(provider) ? storedHost(provider) : null;
    repos[provider] = (stored[provider]?.listing.pages ?? []).flatMap((page: ListingPage) => page.repos);
  }
  const remoteFavorites = new Set(
    getApp()
      .store.listRemoteFavorites()
      .filter((fav): fav is RemoteFavorite & { provider: RemoteProvider } => PROVIDERS.some((provider) => provider === fav.provider))
      .map((fav) => remoteFavoriteId(fav.provider, fav.key)),
  );
  return {
    entries: mergeCatalog(clones, repos.github, repos.gitlab, remoteFavorites),
    github: statusOf("github", stored.github),
    gitlab: statusOf("gitlab", stored.gitlab),
  };
}

/** Stars or unstars the clones of an entry, or its remote repos when it has no clone. */
function applyFavorite(entry: CatalogEntry, favorite: boolean): void {
  const app = getApp();
  if (entry.locals.length > 0) {
    for (const relativePath of entry.locals) app.saveRepositoryFavorite(relativePath, favorite);
    return;
  }
  for (const provider of PROVIDERS) {
    const link = entry[provider];
    if (link) app.store.setRemoteFavorite({ provider, key: link.key, fullName: link.fullName }, favorite);
  }
}

/** What identifies the repo to star: one of its clones, or (for a repo with no clone) its name on a host. */
export type FavoriteTarget = { relativePath: string } | { provider: RemoteProvider; fullName: string };

/**
 * Stars or unstars a catalog entry and returns the catalog as it is now. A cloned repo uses the same star as the
 * local table; one that only GitHub or GitLab has is starred without cloning it.
 */
export async function setCatalogFavorite(target: FavoriteTarget, favorite: boolean): Promise<CatalogView> {
  const { entries } = await buildCatalog();
  const entry =
    "relativePath" in target
      ? entries.find((candidate) => candidate.locals.includes(target.relativePath))
      : findRemoteOnly(entries, target.provider, target.fullName);
  if (!entry) throw new Error("That repository is not in the catalog, or it has been cloned since the list was loaded.");
  applyFavorite(entry, favorite);
  return buildCatalog();
}

/** Asks both configured hosts for their complete listings now (ignoring ETags), and rereads every clone's remotes. */
export async function refreshAllListings(): Promise<CatalogView> {
  cachedClones = undefined;
  await Promise.all(PROVIDERS.filter(isConfigured).map((provider) => startCheck(provider, true)));
  return buildCatalog();
}

/**
 * The README of a repo that only a host has, read from the host when asked. Like cloning, it only answers for a repo the
 * catalog lists with no local clone, never for a name the caller made up, so the configured tokens can't be pointed at
 * an arbitrary repository. Failures come back as `error` for the page to show.
 */
export async function loadRemoteReadme(provider: RemoteProvider, fullName: string): Promise<RemoteReadme> {
  const link = findRemoteOnly((await buildCatalog()).entries, provider, fullName)?.[provider];
  if (!link) {
    return { fileName: null, markdown: null, error: "That repository is not on a host gitlib lists, or it is already cloned." };
  }
  try {
    return await (provider === "github" ? fetchGitHubReadme(link.fullName) : fetchGitLabReadme(link.fullName));
  } catch (caught) {
    const timedOut = caught instanceof Error && caught.name === "TimeoutError";
    const error = timedOut ? "The host took too long to answer." : caught instanceof Error ? caught.message : "Could not load the README.";
    return { fileName: null, markdown: null, error };
  }
}

export interface CloneResult {
  /** relativePath of the new clone, for linking to its detail page. */
  relativePath: string;
}

const execFileAsync = promisify(execFile);

/**
 * Clones a repo that only a host has into the clone directory from Settings, named after the repo. The URL comes from the
 * catalog, never from the caller, and git never prompts (a private repo needs a credential helper or SSH-free
 * token setup already in place), so a failure comes back as a message instead of a hung request.
 */
export async function cloneRemoteRepo(provider: RemoteProvider, fullName: string): Promise<CloneResult> {
  const entry = findRemoteOnly((await buildCatalog()).entries, provider, fullName);
  const link = entry?.[provider];
  if (!entry || !link) throw new Error("That repository is not on a host gitlib lists, or it is already cloned.");

  const root = getApp().config.cloneDir;
  const folder = cloneFolderName(link.fullName);
  if (!folder) throw new Error("Could not work out a folder name for that repository.");
  fs.mkdirSync(root, { recursive: true });
  const destination = path.join(root, folder);
  if (fs.existsSync(destination)) throw new Error(`${destination} already exists.`);

  try {
    await execFileAsync("git", ["clone", "--", cloneUrlOf(link.url), destination], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      timeout: 10 * 60_000,
    });
  } catch (caught) {
    const stderr = (caught as { stderr?: unknown }).stderr;
    const detail = typeof stderr === "string" && stderr.trim() ? stderr.trim() : caught instanceof Error ? caught.message : "";
    throw new Error(`git clone failed: ${detail}`);
  }

  cachedClones = undefined;
  const repo = (await loadAndIndexRepositories(true)).find((candidate) => path.resolve(candidate.absolutePath) === path.resolve(destination));
  if (!repo) throw new Error(`Cloned to ${destination}, but it is not under a scanned root.`);
  // A starred repo stays starred once it has a clone: the star moves from the remote to the clone, which is where
  // a cloned repo's star is kept.
  if (entry.isFavorite) {
    getApp().saveRepositoryFavorite(repo.relativePath, true);
    applyFavorite(entry, false);
  }
  return { relativePath: repo.relativePath };
}
