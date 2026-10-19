import { createApplication, type GitLibApp } from "@gitlib/core";

interface GitLibState {
  app?: GitLibApp;
  scanned: boolean;
  /** The search index build currently in flight, if any. */
  indexing?: Promise<void>;
}

// Kept on globalThis so dev-server module reloads reuse one app (and one scan).
const state = ((globalThis as { __gitlib?: GitLibState }).__gitlib ??= { scanned: false });

/** The shared gitlib application; honours GITLIB_HOME just like the CLI, so both see the same data. */
export function getApp(): GitLibApp {
  return (state.app ??= createApplication());
}

/** Scans disk on first use; later calls read the cache unless `force` is set. */
export function loadRepositories(force = false) {
  const app = getApp();
  if (force || !state.scanned) {
    const repositories = app.refresh();
    state.scanned = true;
    return repositories;
  }
  return app.loadRepositories();
}

/**
 * Like `loadRepositories`, but also refreshes the search index whenever disk was scanned. Indexing
 * never blocks or breaks the page: the first load indexes in the background, and an explicit
 * rescan waits so the results that follow are current.
 */
export async function loadAndIndexRepositories(force = false) {
  const alreadyScanned = state.scanned;
  const repositories = loadRepositories(force);
  if (force || !alreadyScanned) {
    const indexing = getApp()
      .reindexSearch()
      .then(() => undefined)
      .catch((error: unknown) => {
        if (getApp().search.enabled) console.warn("Search index not updated:", error instanceof Error ? error.message : error);
      })
      .finally(() => {
        if (state.indexing === indexing) state.indexing = undefined;
      });
    state.indexing = indexing;
    if (force) await indexing;
  }
  return repositories;
}

/** Resolves once any index build in flight has finished, so a search never races the first build. */
export async function settleIndexing(): Promise<void> {
  await state.indexing;
}
