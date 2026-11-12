import { createServerFn } from "@tanstack/react-start";
import { utcNow } from "@gitlib/core";
import { loadAndIndexRepositories } from "./gitlib.server";
import { checkRepos } from "./sync.server";

export interface SyncStatusView {
  /**
   * Repos whose upstream branch has commits the local branch lacks (so they need a `git pull`), by relativePath,
   * each with the branch it tracks, e.g. `origin/main`. Repos that are up to date, or have nothing to compare, are absent.
   */
  behind: Record<string, string>;
  /** Repos that track a remote branch but could not be asked about it (offline, no credentials). */
  failed: number;
  /** Why the first of those failed. */
  error: string | null;
  /** When the remotes were asked; null if this view is a client-side stand-in for a failed request. */
  checkedAt: string | null;
}

/** Asking every remote takes a moment and they rarely change faster than this; a rescan asks again at once. */
const SYNC_TTL_MS = 5 * 60_000;

async function computeSyncStatus(): Promise<SyncStatusView> {
  // Linked worktrees sit on feature branches and are hidden by default; the clones are what get pulled.
  const repos = (await loadAndIndexRepositories()).filter((repo) => !repo.isWorktree && !repo.isMissing);
  const checks = await checkRepos(repos);

  const behind: Record<string, string> = {};
  let failed = 0;
  let error: string | null = null;
  for (const [relativePath, sync] of checks) {
    if (sync.state === "behind") behind[relativePath] = sync.upstream;
    else if (sync.state === "failed") {
      failed += 1;
      error ??= sync.error;
    }
  }
  return { behind, failed, error, checkedAt: utcNow() };
}

interface SyncCache {
  entry?: { at: number; result: Promise<SyncStatusView> };
}

// Kept on globalThis because the server function and the rescan that clears this cache don't always share one copy
// of this module (the dev server loads the function's handler separately), so a module-level variable would be
// cleared in one place and read in another.
const cache = ((globalThis as { __gitlibSync?: SyncCache }).__gitlibSync ??= {});

/** Drops the cached answer so the next request asks the remotes again (a rescan does this). */
export function clearSyncStatus(): void {
  cache.entry = undefined;
}

/** Which clones have fallen behind the remote branch they track, checked with `git ls-remote` and cached for a few minutes. */
export const getSyncStatus = createServerFn({ method: "GET" }).handler((): Promise<SyncStatusView> => {
  if (!cache.entry || Date.now() - cache.entry.at > SYNC_TTL_MS) {
    const entry = { at: Date.now(), result: computeSyncStatus() };
    cache.entry = entry;
    // Listing the repos is the only thing that can reject; don't keep that.
    entry.result.catch(() => {
      if (cache.entry === entry) cache.entry = undefined;
    });
  }
  return cache.entry.result;
});
