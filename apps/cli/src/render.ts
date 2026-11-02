import {
  BUCKETS,
  renderSegments,
  type Bucket,
  type CiState,
  type ClassifiedPr,
  type DependabotReport,
  type RepoRecord,
  type SearchField,
  type SearchHit,
  type SearchResult,
} from "@gitlib/core";

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

const BUCKET_TITLES: Record<Bucket, string> = {
  ready: "Ready",
  "review-first": "Review first",
  "needs-work": "Needs work",
  waiting: "Waiting",
};

/** One short phrase; the long reason for "unknown" is in the PR's reasons, not here. */
function ciLabel(ci: CiState): string {
  switch (ci.state) {
    case "success":
      return "CI passing";
    case "failing":
      return ci.failed.length > 0 ? `CI failing (${ci.failed.join(", ")})` : "CI failing";
    case "pending":
      return ci.pending.length > 0 ? `CI pending (${ci.pending.join(", ")})` : "CI pending";
    case "unknown":
      return "CI unknown";
  }
}

function renderPullRequest({ pr, reasons, actions }: ClassifiedPr): string[] {
  const facts = [pr.ecosystem, pr.updateType === "unknown" ? "update type unknown" : `${pr.updateType} update`, ciLabel(pr.ci)];
  return [
    `  ${pr.repo}#${pr.number}  ${pr.title}`,
    `    ${facts.filter(Boolean).join(" | ")}`,
    `    ${pr.url}`,
    ...reasons.map((reason) => `    - ${reason}`),
    ...actions.map((action) => `    Next: ${action}`),
  ];
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/** The text report of `dependabot check`: PRs grouped by bucket, then everything that was not or could not be checked. */
export function renderDependabotReport(report: DependabotReport, color = false): string {
  const bold = (text: string) => (color ? `\u001b[1m${text}\u001b[22m` : text);
  const lines: string[] = [];
  const checked = report.watched.filter((repo) => repo.status === "checked");

  const counts = BUCKETS.map((bucket) => `${report.items.filter((item) => item.bucket === bucket).length} ${BUCKET_TITLES[bucket].toLowerCase()}`);
  lines.push(
    `Dependabot pull requests on ${plural(report.watched.length, "starred repository", "starred repositories")} (checked ${report.checkedAt})`,
  );
  lines.push(report.items.length > 0 ? counts.join(", ") : "No open Dependabot pull requests.");

  for (const bucket of BUCKETS) {
    const items = report.items.filter((item) => item.bucket === bucket);
    if (items.length === 0) continue;
    lines.push("", bold(`${BUCKET_TITLES[bucket].toUpperCase()} (${items.length})`));
    for (const item of items) lines.push(...renderPullRequest(item));
  }

  const quiet = checked.filter((repo) => repo.openPrs === 0).map((repo) => repo.slug);
  const notes: string[] = [];
  if (quiet.length > 0 && report.items.length > 0) notes.push(`No open Dependabot pull requests: ${quiet.join(", ")}.`);
  if (report.watched.length === 0) {
    notes.push("No starred repository has a GitHub remote, so there is nothing to check. Star repositories in the web app, then run `gitlib scan`.");
  }
  if (report.skipped.length > 0) {
    notes.push(
      `Skipped ${plural(report.skipped.length, "starred repository", "starred repositories")} (no GitHub remote to ask about):`,
      ...report.skipped.map((repo) => `  ${repo.relativePath}: ${repo.reason}`),
    );
  }
  const unreachable = report.watched.filter((repo) => repo.status === "unreachable").map((repo) => repo.slug);
  if (unreachable.length > 0) {
    notes.push(`NOT CHECKED: GitHub does not show these to your token (private without access, renamed or deleted): ${unreachable.join(", ")}.`);
  }
  for (const { owner, message } of report.errors) notes.push(`NOT CHECKED: ${owner}: ${message}`);
  for (const owner of report.truncatedOwners) {
    notes.push(`INCOMPLETE: ${owner} has more matching pull requests than GitHub search returns, so some are missing.`);
  }
  for (const warning of report.warnings) notes.push(`GitHub warning: ${warning}`);
  if (report.rateLimit) {
    notes.push(`GitHub quota: this check cost ${report.rateLimit.cost}, ${report.rateLimit.remaining} left until ${report.rateLimit.resetAt}.`);
  }
  if (notes.length > 0) lines.push("", ...notes);
  return lines.join("\n");
}

/** The stable, snake_case JSON shape emitted by `dependabot check --json`. */
export function dependabotReportToDict(report: DependabotReport): Record<string, unknown> {
  return {
    checked_at: report.checkedAt,
    summary: Object.fromEntries(BUCKETS.map((bucket) => [bucket, report.items.filter((item) => item.bucket === bucket).length])),
    pull_requests: report.items.map(({ pr, bucket, reasons, actions }) => ({
      repo: pr.repo,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      bucket,
      reasons,
      actions,
      update_type: pr.updateType,
      ecosystem: pr.ecosystem,
      dependencies: pr.dependencies,
      branch: pr.headRefName,
      author: pr.author,
      is_draft: pr.isDraft,
      mergeable: pr.mergeable,
      merge_state_status: pr.mergeStateStatus,
      review_decision: pr.reviewDecision,
      labels: pr.labels,
      commit_count: pr.commitCount,
      ci: pr.ci,
      created_at: pr.createdAt,
      updated_at: pr.updatedAt,
    })),
    repositories: report.watched.map((repo) => ({
      repo: repo.slug,
      status: repo.status,
      open_pull_requests: repo.openPrs,
      paths: repo.paths,
    })),
    skipped: report.skipped.map((repo) => ({ relative_path: repo.relativePath, reason: repo.reason })),
    errors: report.errors,
    truncated_owners: report.truncatedOwners,
    warnings: report.warnings,
    rate_limit: report.rateLimit
      ? { cost: report.rateLimit.cost, remaining: report.rateLimit.remaining, reset_at: report.rateLimit.resetAt }
      : null,
  };
}
