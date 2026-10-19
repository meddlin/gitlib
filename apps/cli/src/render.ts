import { renderSegments, type RepoRecord, type SearchField, type SearchHit, type SearchResult } from "@gitlib/core";

function notesPreview(notes: string, width = 50): string {
  const collapsed = notes.split(/\s+/).filter(Boolean).join(" ");
  if (!collapsed) return "-";
  if (collapsed.length <= width) return collapsed;
  return `${collapsed.slice(0, width - 3)}...`;
}

/** The stable, snake_case JSON shape emitted by `list --json` and `show --json`. */
export function repoToDict(repo: RepoRecord): Record<string, unknown> {
  return {
    name: repo.name,
    relative_path: repo.relativePath,
    absolute_path: repo.absolutePath,
    technologies: repo.technologies,
    has_notes: repo.hasNotes,
    is_worktree: repo.isWorktree,
    last_scanned_at: repo.lastScannedAt,
    notes: repo.notes,
  };
}

export function renderJson(data: unknown): string {
  return JSON.stringify(data, null, 2);
}

export function renderTable(repositories: readonly RepoRecord[]): string {
  if (repositories.length === 0) return "No repositories found.";

  const headers = ["repo", "relative_path", "technologies", "notes"];
  const rows = repositories.map((repo) => [
    repo.name,
    repo.relativePath,
    repo.technologies.length > 0 ? repo.technologies.join(", ") : "-",
    notesPreview(repo.notes),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => row[index]!.length)),
  );
  const formatRow = (cells: string[]) =>
    cells.map((cell, index) => cell.padEnd(widths[index]!)).join("  ");

  return [
    formatRow(headers),
    widths.map((width) => "-".repeat(width)).join("  "),
    ...rows.map(formatRow),
  ].join("\n");
}

export function renderDetail(repo: RepoRecord): string {
  return [
    `repo: ${repo.name}`,
    `relative_path: ${repo.relativePath}`,
    ...(repo.isWorktree ? ["worktree: yes"] : []),
    `absolute_path: ${repo.absolutePath}`,
    `technologies: ${repo.technologies.length > 0 ? repo.technologies.join(", ") : "-"}`,
    `last_scanned_at: ${repo.lastScannedAt || "-"}`,
    "notes:",
    repo.notes || "-",
  ].join("\n");
}

/** Fields worth showing under a result; the name and path are already in the result's own line. */
const SNIPPET_FIELDS: readonly SearchField[] = ["description", "notes", "readme"];

function snippets(hit: SearchHit, wrap?: (text: string) => string): [SearchField, string][] {
  const found: [SearchField, string][] = [];
  for (const field of SNIPPET_FIELDS) {
    const segments = hit.highlights[field];
    if (segments) found.push([field, renderSegments(segments, wrap)]);
  }
  return found;
}

export function renderSearchResults(result: SearchResult, color = false): string {
  if (result.hits.length === 0) return "No repositories match.";
  const wrap = color ? (text: string) => `\u001b[1m${text}\u001b[22m` : undefined;

  return result.hits
    .map((hit) => {
      const lines = [`${hit.repo.name}  (${hit.repo.relativePath})`];
      for (const [field, text] of snippets(hit, wrap)) lines.push(`  ${field}: ${text}`);
      return lines.join("\n");
    })
    .join("\n");
}

export function searchResultToDict(query: string, result: SearchResult): Record<string, unknown> {
  return {
    query,
    mode: result.mode,
    notice: result.notice,
    results: result.hits.map((hit) => ({
      ...repoToDict(hit.repo),
      matches: Object.fromEntries(
        (Object.entries(hit.highlights) as [SearchField, NonNullable<SearchHit["highlights"][SearchField]>][]).map(
          ([field, segments]) => [field, renderSegments(segments, (text) => text)],
        ),
      ),
    })),
  };
}
