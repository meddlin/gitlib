import { createApplication, type GitLibApp } from "@gitlib/core";

interface GitLibState {
  app?: GitLibApp;
  scanned: boolean;
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
