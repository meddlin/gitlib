import type { RepoRecord } from "@gitlib/core";

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
    `absolute_path: ${repo.absolutePath}`,
    `technologies: ${repo.technologies.length > 0 ? repo.technologies.join(", ") : "-"}`,
    `last_scanned_at: ${repo.lastScannedAt || "-"}`,
    "notes:",
    repo.notes || "-",
  ].join("\n");
}
