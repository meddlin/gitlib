import fs from "node:fs";
import path from "node:path";
import { DEFAULT_ROOTS } from "./config.js";
import { GitLibError } from "./errors.js";
import { expandUser, resolvePath } from "./fsutil.js";

export class CloneDirectoryError extends GitLibError {}

export function cloneDirectoryPath(appHome: string): string {
  return path.join(appHome, "clone-directory.json");
}

/** Where clones go until Settings says otherwise. */
export const defaultCloneDirectory = (): string => resolvePath(expandUser(DEFAULT_ROOTS[0]));

/** True when `target` is `root` or inside it. */
function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Tidies a typed directory into an absolute path. It must sit inside a scanned root, or a clone made there would
 * never show up in the library.
 */
export function normalizeCloneDirectory(input: string, roots: readonly string[]): string {
  const text = input.trim();
  if (!text) throw new CloneDirectoryError("Enter the directory where cloned repositories should go, e.g. ~/git.");
  const expanded = expandUser(text);
  if (!path.isAbsolute(expanded)) throw new CloneDirectoryError("Use an absolute path, or one starting with ~/.");
  const directory = resolvePath(expanded);
  if (!roots.some((root) => isWithin(root, directory))) {
    throw new CloneDirectoryError(
      `${directory} is not inside a scanned root (${roots.join(", ") || "none configured"}). Add it to roots in config.toml first.`,
    );
  }
  return directory;
}

/** The saved directory, or null if none was saved or the file is unreadable. */
export function readCloneDirectory(appHome: string): string | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(cloneDirectoryPath(appHome), "utf-8"));
    const directory = raw && typeof raw === "object" ? (raw as Record<string, unknown>)["directory"] : null;
    return typeof directory === "string" && path.isAbsolute(directory) ? directory : null;
  } catch {
    return null;
  }
}

export function writeCloneDirectory(appHome: string, directory: string): void {
  fs.mkdirSync(appHome, { recursive: true });
  fs.writeFileSync(cloneDirectoryPath(appHome), `${JSON.stringify({ directory }, null, 2)}\n`, "utf-8");
}
