import path from "node:path";
import { isDirectory, resolvePath, walk } from "./fsutil.js";
import type { DiscoveredRepo } from "./models.js";

function relativePath(root: string, repoPath: string): string {
  const relative = path.relative(root, repoPath).split(path.sep).join("/");
  return relative || ".";
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
