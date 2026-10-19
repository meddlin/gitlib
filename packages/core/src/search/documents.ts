import fs from "node:fs";
import path from "node:path";
import type { RepoRecord } from "../models.js";
import type { SearchDocument } from "./types.js";

/**
 * Meilisearch only indexes the first 65,535 word positions of an attribute, so there is no point
 * sending more text than this.
 */
export const MAX_README_CHARS = 100_000;
const MAX_README_BYTES = 400_000;

const README_PATTERN = /^readme(\.(md|markdown|txt|rst))?$/i;
const README_PREFERENCE = [".md", ".markdown", "", ".txt", ".rst"];

function readmeRank(fileName: string): number {
  return README_PREFERENCE.indexOf(path.extname(fileName).toLowerCase());
}

/** Reduces Markdown to the words a person would read, so URLs and badge syntax do not match or clutter snippets. */
export function markdownToText(markdown: string): string {
  return markdown
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>\n]+>/g, " ")
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, "")
    .replace(/^\s*(```|~~~).*$/gm, " ")
    .replace(/[`*_~]+/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The repo's README as plain text, or "" if there is none or it cannot be read. */
export function readReadmeText(repoPath: string): string {
  let entries: string[];
  try {
    entries = fs.readdirSync(repoPath);
  } catch {
    return "";
  }

  const readmes = entries
    .filter((entry) => README_PATTERN.test(entry) && readmeRank(entry) !== -1)
    .sort((a, b) => readmeRank(a) - readmeRank(b) || a.localeCompare(b));

  for (const name of readmes) {
    const filePath = path.join(repoPath, name);
    let descriptor: number | undefined;
    try {
      if (!fs.statSync(filePath).isFile()) continue;
      descriptor = fs.openSync(filePath, "r");
      const buffer = Buffer.alloc(MAX_README_BYTES);
      const bytesRead = fs.readSync(descriptor, buffer, 0, MAX_README_BYTES, 0);
      const raw = buffer.toString("utf-8", 0, bytesRead);
      const text = path.extname(name).toLowerCase() === ".txt" ? raw.replace(/\s+/g, " ").trim() : markdownToText(raw);
      return text.slice(0, MAX_README_CHARS);
    } catch {
      continue;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }
  return "";
}

export function buildSearchDocument(
  repo: RepoRecord,
  readReadme: (repoPath: string) => string = readReadmeText,
): SearchDocument {
  return {
    id: repo.id,
    name: repo.name,
    relativePath: repo.relativePath,
    absolutePath: repo.absolutePath,
    technologies: repo.technologies,
    description: repo.description,
    notes: repo.notes,
    readme: repo.isMissing ? "" : readReadme(repo.absolutePath),
  };
}
