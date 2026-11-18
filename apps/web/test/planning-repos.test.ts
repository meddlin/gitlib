import { describe, expect, it } from "vitest";
import type { LocalIssue, PlanningRepoStatus, RepoRecord } from "@gitlib/core";
import { planningReposView } from "../src/server/planning-repos.server";

const planned = (id: number, slug: string, path: string, extra: Partial<PlanningRepoStatus> = {}): PlanningRepoStatus => ({
  id,
  slug,
  path,
  rootCommit: null,
  archivedAt: null,
  createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  found: true,
  ...extra,
});

const scanned = (relativePath: string, isWorktree = false) =>
  ({ relativePath, name: relativePath.split("/").pop()!, isWorktree }) as RepoRecord;

const issue = (repoId: number, state: "open" | "closed") => ({ repoId, state }) as LocalIssue;

describe("planning repos view", () => {
  it("lists repos by short name with their state and issue counts", () => {
    const view = planningReposView(
      [
        planned(1, "zeta", "zeta"),
        planned(2, "Alpha", "work/alpha", { found: false }),
        planned(3, "beta", "beta", { archivedAt: "2026-02-01T00:00:00Z" }),
      ],
      [scanned("zeta"), scanned("beta")],
      [issue(2, "open"), issue(2, "closed"), issue(1, "closed")],
    );

    expect(view.repos).toEqual([
      { id: 2, slug: "Alpha", path: "work/alpha", found: false, archived: false, issueCount: 2, openIssueCount: 1 },
      { id: 3, slug: "beta", path: "beta", found: true, archived: true, issueCount: 0, openIssueCount: 0 },
      { id: 1, slug: "zeta", path: "zeta", found: true, archived: false, issueCount: 1, openIssueCount: 0 },
    ]);
    expect(view.slugLimit).toBeGreaterThan(0);
  });

  it("offers only scanned, unclaimed, non-worktree repos to relink to", () => {
    const view = planningReposView(
      [planned(1, "alpha", "alpha", { found: false }), planned(2, "kept", "kept", { archivedAt: "2026-02-01T00:00:00Z" })],
      [scanned("moved/alpha"), scanned("kept"), scanned("moved/alpha-wt", true), scanned("other")],
      [],
    );

    // "kept" belongs to an archived planning repo, which still holds its path.
    expect(view.relinkTargets).toEqual([
      { relativePath: "moved/alpha", name: "alpha" },
      { relativePath: "other", name: "other" },
    ]);
  });
});
