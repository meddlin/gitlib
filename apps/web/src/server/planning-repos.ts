import { createServerFn } from "@tanstack/react-start";
import { getApp, loadRepositories } from "./gitlib.server";
import type { PlanningRepoOption } from "./planning";
import { planningReposView } from "./planning-repos.server";

/** A repo planning knows, by the stable id its issues and projects point at. */
export interface PlanningRepoView {
  id: number;
  /** Short name its issues are shown under (`slug#3`). */
  slug: string;
  /** `relativePath` where gitlib last found it. */
  path: string;
  /** False when the last scan found nothing at `path`; it can be relinked to where the repo is now. */
  found: boolean;
  /** Archived repos keep their issues but hide them from the planning lists and take no new ones. */
  archived: boolean;
  /** Every issue filed against it, including closed ones. */
  issueCount: number;
  openIssueCount: number;
}

export interface PlanningReposView {
  /** By short name. */
  repos: PlanningRepoView[];
  /** Scanned, non-worktree repos that no planning repo holds, which a lost repo can be relinked to. */
  relinkTargets: PlanningRepoOption[];
  /** Sent down with the data so the rename form's limit can't drift from the one the server enforces. */
  slugLimit: number;
}

// Repos are always picked by id from the web: a short name can be another repo's path (`AmbiguousPlanningRepoError`).
const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export const getPlanningRepos = createServerFn({ method: "GET" }).handler(async (): Promise<PlanningReposView> => {
  const app = getApp();
  // Scans on first use, so "found" reflects a real scan rather than an empty cache.
  const scanned = loadRepositories();
  return planningReposView(app.listPlanningRepos(), scanned, app.listLocalIssues({ includeArchived: true }));
});

export const renamePlanningRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; slug: string }) => {
    if (!isId(input?.id) || typeof input?.slug !== "string") throw new Error("Invalid planning repo payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().renamePlanningRepo(data.id, data.slug);
  });

/** `path` is the `relativePath` of a scanned repo (one of `PlanningReposView.relinkTargets`). */
export const relinkPlanningRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; path: string }) => {
    if (!isId(input?.id) || typeof input?.path !== "string" || input.path.trim() === "") {
      throw new Error("Invalid planning repo payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    // Only an exact scanned path, never a name a selector might match loosely.
    const target = loadRepositories().find((repo) => repo.relativePath === data.path);
    if (!target) throw new Error(`Gitlib has not scanned a repository at ${data.path}.`);
    if (target.isWorktree) throw new Error(`${data.path} is a linked worktree; relink to the main checkout instead.`);
    getApp().relinkPlanningRepo(data.id, target.relativePath);
  });

/** Archives (`archived: true`) or restores a planning repo. */
export const setPlanningRepoArchived = createServerFn({ method: "POST" })
  .validator((input: { id: number; archived: boolean }) => {
    if (!isId(input?.id) || typeof input?.archived !== "boolean") throw new Error("Invalid planning repo request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    if (data.archived) getApp().archivePlanningRepo(data.id);
    else getApp().restorePlanningRepo(data.id);
  });
