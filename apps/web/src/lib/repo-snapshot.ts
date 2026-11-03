/**
 * A snapshot of a GitHub repository that is not cloned locally: what the chat is given to answer questions about
 * it. Parsing and shaping live here, free of server code, so the server and the tests share them.
 */
import type { RemoteSnapshotContext } from "@gitlib/core";

/** The README is stored whole up to this; the chat prompt cuts it further to fit the model's context. */
export const SNAPSHOT_README_CHARS = 20_000;
/** A repository root can list thousands of entries; the prompt only has room for a few dozen names. */
export const SNAPSHOT_MAX_FILES = 200;
const MAX_TOPICS = 30;

export interface SnapshotFile {
  name: string;
  isDir: boolean;
}

/** What is stored for one repository. Percentages are derived from `languages` when read, never stored. */
export interface RepoSnapshot {
  defaultBranch: string | null;
  license: string | null;
  topics: string[];
  stars: number | null;
  sizeKb: number | null;
  /** Bytes of code per language, largest first. */
  languages: { name: string; bytes: number }[];
  files: SnapshotFile[];
  filesTruncated: boolean;
  readme: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const stringOrNull = (value: unknown): string | null => (typeof value === "string" && value ? value : null);
const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Directories first, then files, each by name, so a cut-off list keeps the structure visible. */
function orderFiles(files: SnapshotFile[]): SnapshotFile[] {
  return [...files].sort((a, b) => Number(b.isDir) - Number(a.isDir) || a.name.localeCompare(b.name));
}

function sortLanguages(entries: [string, unknown][]): { name: string; bytes: number }[] {
  return entries
    .flatMap(([name, bytes]) => (typeof bytes === "number" && Number.isFinite(bytes) && bytes > 0 ? [{ name, bytes }] : []))
    .sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));
}

/** GitHub's `{ "TypeScript": 12345, ... }`. */
const parseLanguages = (value: unknown): { name: string; bytes: number }[] => (isRecord(value) ? sortLanguages(Object.entries(value)) : []);

/** The root listing from `GET /repos/{o}/{r}/contents`; anything but a list (an empty repo, a single file) is no files. */
function parseFiles(value: unknown): { files: SnapshotFile[]; truncated: boolean } {
  if (!Array.isArray(value)) return { files: [], truncated: false };
  const all = value.flatMap((item): SnapshotFile[] =>
    isRecord(item) && typeof item["name"] === "string" ? [{ name: item["name"], isDir: item["type"] === "dir" }] : [],
  );
  const ordered = orderFiles(all);
  return { files: ordered.slice(0, SNAPSHOT_MAX_FILES), truncated: ordered.length > SNAPSHOT_MAX_FILES };
}

/**
 * Builds a snapshot from the four GitHub answers: the repository, its languages, its root listing, and its
 * README as text. The last three are empty for a repository that has none, so only `repo` has to be well formed.
 */
export function parseSnapshot(parts: { repo: unknown; languages: unknown; contents: unknown; readme: string }): RepoSnapshot {
  const repo = isRecord(parts.repo) ? parts.repo : {};
  const license = isRecord(repo["license"]) ? repo["license"] : null;
  const spdx = license ? stringOrNull(license["spdx_id"]) : null;
  const topics = Array.isArray(repo["topics"]) ? repo["topics"].filter((topic): topic is string => typeof topic === "string") : [];
  const { files, truncated } = parseFiles(parts.contents);
  return {
    defaultBranch: stringOrNull(repo["default_branch"]),
    // GitHub reports "NOASSERTION" for a license file it could not identify; that says nothing useful.
    license: license ? (spdx && spdx !== "NOASSERTION" ? spdx : stringOrNull(license["name"])) : null,
    topics: topics.slice(0, MAX_TOPICS),
    stars: numberOrNull(repo["stargazers_count"]),
    sizeKb: numberOrNull(repo["size"]),
    languages: parseLanguages(parts.languages),
    files,
    filesTruncated: truncated,
    readme: parts.readme.slice(0, SNAPSHOT_README_CHARS),
  };
}

export function serializeSnapshot(snapshot: RepoSnapshot): string {
  return JSON.stringify(snapshot);
}

/** Reads a stored snapshot back; null when it is unreadable or not shaped like one. */
export function parseStoredSnapshot(payload: string): RepoSnapshot | null {
  try {
    const value: unknown = JSON.parse(payload);
    if (!isRecord(value)) return null;
    if (!Array.isArray(value["languages"]) || !Array.isArray(value["files"]) || !Array.isArray(value["topics"])) return null;
    if (typeof value["readme"] !== "string") return null;
    return {
      defaultBranch: stringOrNull(value["defaultBranch"]),
      license: stringOrNull(value["license"]),
      topics: value["topics"].filter((topic): topic is string => typeof topic === "string"),
      stars: numberOrNull(value["stars"]),
      sizeKb: numberOrNull(value["sizeKb"]),
      languages: sortLanguages((value["languages"] as unknown[]).flatMap((l): [string, unknown][] => (isRecord(l) && typeof l["name"] === "string" ? [[l["name"], l["bytes"]]] : []))),
      files: (value["files"] as unknown[]).flatMap((f): SnapshotFile[] => (isRecord(f) && typeof f["name"] === "string" ? [{ name: f["name"], isDir: f["isDir"] === true }] : [])),
      filesTruncated: value["filesTruncated"] === true,
      readme: value["readme"],
    };
  } catch {
    return null;
  }
}

/** Each language's share of the bytes GitHub attributes to a language, in percent. */
export function languageShares(languages: readonly { name: string; bytes: number }[]): { name: string; percent: number }[] {
  const total = languages.reduce((sum, language) => sum + language.bytes, 0);
  return total > 0 ? languages.map(({ name, bytes }) => ({ name, percent: (bytes / total) * 100 })) : [];
}

/** The snapshot as the chat prompt wants it. */
export function toSnapshotContext(snapshot: RepoSnapshot, fetchedAt: string): RemoteSnapshotContext {
  return {
    fetchedAt,
    defaultBranch: snapshot.defaultBranch,
    license: snapshot.license,
    topics: snapshot.topics,
    stars: snapshot.stars,
    sizeKb: snapshot.sizeKb,
    languages: languageShares(snapshot.languages),
    files: snapshot.files,
    filesTruncated: snapshot.filesTruncated,
    readme: snapshot.readme,
  };
}
