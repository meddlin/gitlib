import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Equivalent of Python's `Path.expanduser()` for a leading `~`. */
export function expandUser(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

/**
 * Equivalent of Python's `Path.resolve(strict=False)`: symlinks are resolved for the
 * part of the path that exists, and the remainder is appended lexically.
 */
export function resolvePath(value: string): string {
  const absolute = path.resolve(value);
  const missing: string[] = [];
  let current = absolute;
  for (;;) {
    try {
      return path.join(fs.realpathSync(current), ...missing.reverse());
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return absolute;
      missing.push(path.basename(current));
      current = parent;
    }
  }
}

export function isDirectory(value: string): boolean {
  try {
    return fs.statSync(value).isDirectory();
  } catch {
    return false;
  }
}

export function isRelativeTo(value: string, parent: string): boolean {
  const relative = path.relative(parent, value);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export interface WalkEntry {
  dirpath: string;
  /** Mutable: remove names to prevent descending into them (like `os.walk(topdown=True)`). */
  dirnames: string[];
  filenames: string[];
}

/**
 * Top-down directory walk that mirrors `os.walk(..., followlinks=False)`: symlinks to
 * directories are listed in `dirnames` but never descended into.
 */
export function* walk(root: string): Generator<WalkEntry> {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const dirnames: string[] = [];
  const filenames: string[] = [];
  for (const entry of entries) {
    let isDir = entry.isDirectory();
    if (!isDir && entry.isSymbolicLink()) isDir = isDirectory(path.join(root, entry.name));
    (isDir ? dirnames : filenames).push(entry.name);
  }

  yield { dirpath: root, dirnames, filenames };

  for (const name of dirnames) {
    const child = path.join(root, name);
    try {
      if (fs.lstatSync(child).isSymbolicLink()) continue;
    } catch {
      continue;
    }
    yield* walk(child);
  }
}
