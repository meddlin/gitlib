import { MAX_REPO_SLUG_LENGTH, type LocalIssue, type PlanningRepoStatus, type RepoRecord } from "@gitlib/core";
import type { PlanningRepoView, PlanningReposView } from "./planning-repos";

// Server-only (`.server.ts`) so the runtime import of @gitlib/core never reaches a client bundle.
export const slugLimit = (): number => MAX_REPO_SLUG_LENGTH;

/**
 * Every planning repo, by short name, with its issue counts, and the scanned repos a lost one can be relinked to:
 * non-worktree repos no planning repo already holds (an archived one still holds its path).
 */
export function planningReposView(
  planned: readonly PlanningRepoStatus[],
  scanned: readonly RepoRecord[],
  issues: readonly LocalIssue[],
): PlanningReposView {
  const repos: PlanningRepoView[] = planned
    .map((repo) => {
      const own = issues.filter((issue) => issue.repoId === repo.id);
      return {
        id: repo.id,
        slug: repo.slug,
        path: repo.path,
        found: repo.found,
        archived: repo.archivedAt !== null,
        issueCount: own.length,
        openIssueCount: own.filter((issue) => issue.state === "open").length,
      };
    })
    .sort((a, b) => a.slug.localeCompare(b.slug, undefined, { sensitivity: "base" }));
  const claimed = new Set(planned.map((repo) => repo.path));
  return {
    repos,
    relinkTargets: scanned
      .filter((repo) => !repo.isWorktree && !claimed.has(repo.relativePath))
      .map(({ relativePath, name }) => ({ relativePath, name }))
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
    slugLimit: slugLimit(),
  };
}
