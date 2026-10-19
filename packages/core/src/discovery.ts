import fs from "node:fs";
import path from "node:path";
import { isDirectory, resolvePath, walk } from "./fsutil.js";
import type { DiscoveredRepo } from "./models.js";

function relativePath(root: string, repoPath: string): string {
  const relative = path.relative(root, repoPath).split(path.sep).join("/");
  return relative || ".";
}

/**
 * A linked worktree has a `.git` *file* reading `gitdir: <common>/worktrees/<name>`.
 * Submodules also use a `.git` file, but theirs points into `.git/modules/`, so they
 * are not matched and stay ordinary repositories.
 */
export function isLinkedWorktree(repoPath: string): boolean {
  let contents: string;
  try {
    contents = fs.readFileSync(path.join(repoPath, ".git"), "utf-8");
  } catch {
    return false; // `.git` is a directory (or unreadable): a standalone repo.
  }
  const match = /^gitdir:\s*(.+?)\s*$/m.exec(contents);
  if (!match) return false;
  return path.basename(path.dirname(path.resolve(repoPath, match[1]!))) === "worktrees";
}

export function discoverRepos(
  roots: Iterable<string>,
  ignoreDirs: ReadonlySet<string>,
): DiscoveredRepo[] {
  const discovered: DiscoveredRepo[] = [];

  for (const configuredRoot of roots) {
    if (!isDirectory(configuredRoot)) continue;
    const root = resolvePath(configuredRoot);

    for (const entry of walk(root)) {
      const hasGitMarker =
        entry.dirnames.includes(".git") || entry.filenames.includes(".git");
      // Mutate in place so the walker skips ignored directories.
      const kept = entry.dirnames.filter((name) => !ignoreDirs.has(name));
      entry.dirnames.splice(0, entry.dirnames.length, ...kept);

      if (!hasGitMarker) continue;

      discovered.push({
        rootPath: root,
        relativePath: relativePath(root, entry.dirpath),
        absolutePath: resolvePath(entry.dirpath),
        name: path.basename(entry.dirpath),
        isWorktree: entry.filenames.includes(".git") && isLinkedWorktree(entry.dirpath),
      });
    }
  }

  discovered.sort(
    (a, b) =>
      compare(a.rootPath, b.rootPath) || compare(a.relativePath, b.relativePath),
  );
  return discovered;
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
