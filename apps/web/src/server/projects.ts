import { createServerFn } from "@tanstack/react-start";
import { MAX_PROJECT_NAME_LENGTH, type ProjectRepo, type RepoRecord } from "@gitlib/core";
import { getApp, loadRepositories } from "./gitlib.server";
import type { EpicLimits, EpicView } from "./epics";
import { epicLimits, epicViews } from "./epics.server";
import type { MilestoneLimits, MilestoneView } from "./milestones";
import { milestoneLimits, milestoneViews } from "./milestones.server";
import { toView, type LocalIssueView, type PlanningRepoOption } from "./planning";

export interface ProjectRepoView {
  /** The planning repo's id, which stays the same when the repo moves. */
  id: number;
  /** Short name its issues are shown under (`slug#3`). */
  slug: string;
  relativePath: string;
  name: string;
  /** False when the repo has moved or been removed since it was added. */
  known: boolean;
  /** The repo itself is archived in planning, so its issues are hidden from the planning lists. */
  archived: boolean;
}

export interface ProjectSummary {
  id: number;
  name: string;
  archived: boolean;
  repoCount: number;
  openIssueCount: number;
  issueCount: number;
}

export interface ProjectsView {
  projects: ProjectSummary[];
  nameLimit: number;
}

export interface ProjectDetail {
  id: number;
  name: string;
  /** An archived project takes no new repos, issues or milestones until it is restored. */
  archived: boolean;
  repos: ProjectRepoView[];
  /** Repos taken out of the project. Their issues stay filed under it; adding a repo again brings it back. */
  removedRepos: ProjectRepoView[];
  /** Known repos not yet in the project. */
  availableRepos: PlanningRepoOption[];
  issues: LocalIssueView[];
  /** Issues in no project, which can be added. */
  unassignedIssues: LocalIssueView[];
  /** Soonest due date first, then milestones with no due date; archived ones included (see `MilestoneView.archived`). */
  milestones: MilestoneView[];
  milestoneLimits: MilestoneLimits;
  /** By title; archived ones included (see `EpicView.archived`). */
  epics: EpicView[];
  epicLimits: EpicLimits;
  nameLimit: number;
}

/** For pickers: every project, by name. */
export interface ProjectOption {
  id: number;
  name: string;
}

// A function, not a constant: client bundles must not keep a runtime import of @gitlib/core.
const nameLimit = (): number => MAX_PROJECT_NAME_LENGTH;

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

function repoView({ id, slug, path, archived }: ProjectRepo, repos: readonly RepoRecord[]): ProjectRepoView {
  const repo = repos.find((candidate) => candidate.relativePath === path);
  return { id, slug, relativePath: path, name: repo?.name ?? path.split("/").pop() ?? path, known: repo !== undefined, archived };
}

export const getProjects = createServerFn({ method: "GET" }).handler(async (): Promise<ProjectsView> => {
  const app = getApp();
  const issues = app.listLocalIssues({ includeArchived: true });
  return {
    projects: app.listProjects({ includeArchived: true }).map((project) => {
      const inProject = issues.filter((issue) => issue.projectId === project.id);
      return {
        id: project.id,
        name: project.name,
        archived: project.archivedAt !== null,
        repoCount: project.repoPaths.length,
        issueCount: inProject.length,
        openIssueCount: inProject.filter((issue) => issue.state === "open").length,
      };
    }),
    nameLimit: nameLimit(),
  };
});

export const getProjectOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectOption[]> => getApp().listProjects().map(({ id, name }) => ({ id, name })),
);

export const getProjectDetail = createServerFn({ method: "GET" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<ProjectDetail | null> => {
    const app = getApp();
    const project = app.planning.getProject(data.id);
    if (!project) return null;
    const repos = loadRepositories();
    // The project page shows everything filed under it, including issues of archived repos (labelled as such).
    const issues = app.listLocalIssues({ includeArchived: true });
    return {
      id: project.id,
      name: project.name,
      archived: project.archivedAt !== null,
      repos: project.repos.map((repo) => repoView(repo, repos)),
      removedRepos: project.removedRepos.map((repo) => repoView(repo, repos)),
      availableRepos: repos
        .filter((repo) => !repo.isWorktree && !project.repoPaths.includes(repo.relativePath))
        .map(({ relativePath, name }) => ({ relativePath, name })),
      issues: issues.filter((issue) => issue.projectId === project.id).map((issue) => toView(issue, repos)),
      unassignedIssues: issues
        .filter((issue) => issue.projectId === null && !issue.archived)
        .map((issue) => toView(issue, repos)),
      milestones: milestoneViews(app.listMilestones(project.id, { includeArchived: true }), issues),
      milestoneLimits: milestoneLimits(),
      epics: epicViews(app.listEpics(project.id, { includeArchived: true }), issues),
      epicLimits: epicLimits(),
      nameLimit: nameLimit(),
    };
  });

const validName = (input: { name?: unknown }) => {
  if (typeof input?.name !== "string") throw new Error("Invalid project payload.");
};

export const createProject = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => {
    validName(input);
    return input;
  })
  .handler(async ({ data }): Promise<ProjectOption> => {
    const { id, name } = getApp().createProject(data.name);
    return { id, name };
  });

export const renameProject = createServerFn({ method: "POST" })
  .validator((input: { id: number; name: string }) => {
    validName(input);
    if (!isId(input?.id)) throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<ProjectOption> => {
    const { id, name } = getApp().renameProject(data.id, data.name);
    return { id, name };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().deleteProject(data.id);
  });

export const addProjectRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; repo: string }) => {
    if (!isId(input?.id) || typeof input?.repo !== "string") throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().addRepoToProject(data.id, data.repo);
  });

/** Archives (`archived: true`) or restores a project. */
export const setProjectArchived = createServerFn({ method: "POST" })
  .validator((input: { id: number; archived: boolean }) => {
    if (!isId(input?.id) || typeof input?.archived !== "boolean") throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    if (data.archived) getApp().archiveProject(data.id);
    else getApp().restoreProject(data.id);
  });

/** `repoId` is the planning repo's id (`ProjectRepoView.id`), so a repo that has moved can still be removed. */
export const removeProjectRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; repoId: number }) => {
    if (!isId(input?.id) || !isId(input?.repoId)) throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().removeRepoFromProject(data.id, data.repoId);
  });

/** Pass `projectId: null` to take the issue out of its project. */
export const setIssueProject = createServerFn({ method: "POST" })
  .validator((input: { issueId: number; projectId: number | null }) => {
    if (!isId(input?.issueId) || (input?.projectId !== null && !isId(input?.projectId))) {
      throw new Error("Invalid issue project payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().setLocalIssueProject(data.issueId, data.projectId);
  });
