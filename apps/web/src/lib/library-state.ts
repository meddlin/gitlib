import { useSyncExternalStore } from "react";
import type { SortDir, SortKey } from "#/components/repo-table";

/** The Repositories table's filters and sort: the part of its URL worth restoring when you come back. */
export interface LibraryTableState {
  q?: string;
  tech?: string;
  /** Linked git worktrees are hidden unless this is set. */
  worktrees?: true;
  sort?: SortKey;
  dir?: SortDir;
}

const STORAGE_KEY = "gitlib:repositories-table";
const EMPTY: LibraryTableState = {};

let current: LibraryTableState | undefined;
const listeners = new Set<() => void>();

function read(): LibraryTableState {
  if (current) return current;
  try {
    const stored = sessionStorage.getItem(STORAGE_KEY);
    current = stored ? (JSON.parse(stored) as LibraryTableState) : EMPTY;
  } catch {
    current = EMPTY;
  }
  return current;
}

const isEmpty = (state: LibraryTableState) => Object.values(state).every((value) => value === undefined);

const sameState = (a: LibraryTableState, b: LibraryTableState) =>
  a.q === b.q && a.tech === b.tech && a.worktrees === b.worktrees && a.sort === b.sort && a.dir === b.dir;

/** Remembers the table's state for this browser tab; session storage keeps it across reloads too. */
export function saveLibraryState(next: LibraryTableState): void {
  const state: LibraryTableState = isEmpty(next) ? EMPTY : next;
  if (sameState(read(), state)) return;
  current = state;
  try {
    if (isEmpty(state)) sessionStorage.removeItem(STORAGE_KEY);
    else sessionStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Private mode or blocked storage: the in-memory copy still covers navigation within the page.
  }
  listeners.forEach((listener) => listener());
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/**
 * The remembered table state, for links back to the Repositories page. Empty during server rendering
 * and hydration, so the first paint matches the server's.
 */
export function useLibraryState(): LibraryTableState {
  return useSyncExternalStore(subscribe, read, () => EMPTY);
}
