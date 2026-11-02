import type { UpdateType } from "./types.js";

/**
 * Dependabot ends its commit message with a YAML block between `---` and `...`, one list item per updated dependency.
 * No docs page describes it as a supported format, so everything here reads it defensively and answers "unknown"
 * rather than guessing; see docs/dependabot-watch.md section 3.
 */
const BLOCK = /^---[ \t]*\r?\n([\s\S]*?)\r?\n\.\.\.[ \t]*$/m;

const SEMVER_LEVELS: Record<string, Exclude<UpdateType, "unknown">> = {
  "version-update:semver-major": "major",
  "version-update:semver-minor": "minor",
  "version-update:semver-patch": "patch",
};

const unquote = (value: string): string => value.trim().replace(/^(["'])(.*)\1$/, "$2");

export interface CommitMetadata {
  updateType: UpdateType;
  /** `dependency-name` of every list item, in order. */
  dependencies: string[];
}

/** Reads the `update-type` of every dependency in a Dependabot commit message and keeps the biggest bump. */
export function parseCommitMetadata(message: string): CommitMetadata {
  const block = BLOCK.exec(message)?.[1];
  if (block === undefined) return { updateType: "unknown", dependencies: [] };

  // `- dependency-name: x` opens an item; the indented lines after it belong to it.
  const items: { name: string | null; updateType: string | null }[] = [];
  for (const line of block.split(/\r?\n/)) {
    const entry = /^\s*(?<opens>-\s+)?(?<key>[\w-]+):\s*(?<value>.*)$/.exec(line);
    if (!entry?.groups) continue;
    const { opens, key, value } = entry.groups as { opens?: string; key: string; value: string };
    if (opens) items.push({ name: null, updateType: null });
    const item = items[items.length - 1];
    if (!item) continue;
    if (key === "dependency-name") item.name = unquote(value);
    else if (key === "update-type") item.updateType = unquote(value);
  }

  const dependencies = items.flatMap((item) => (item.name ? [item.name] : []));
  if (items.length === 0) return { updateType: "unknown", dependencies };

  const levels = items.map((item) => (item.updateType ? (SEMVER_LEVELS[item.updateType] ?? null) : null));
  if (levels.includes("major")) return { updateType: "major", dependencies };
  // One dependency without a usable level could be anything, so the group cannot be called minor or patch.
  if (levels.includes(null)) return { updateType: "unknown", dependencies };
  return { updateType: levels.includes("minor") ? "minor" : "patch", dependencies };
}

/** `npm_and_yarn` from `dependabot/npm_and_yarn/undici-6.29.1`; null for a custom prefix or separator. */
export function parseBranchEcosystem(headRefName: string): string | null {
  const segments = headRefName.split("/");
  return segments.length >= 3 && segments[0] === "dependabot" && segments[1] ? segments[1] : null;
}
