import { createServerFn } from "@tanstack/react-start";
import { MAX_PROJECT_NAME_LENGTH, type RepoRecord } from "@gitlib/core";
import { getApp, loadRepositories } from "./gitlib.server";
import { toView, type LocalIssueView, type PlanningRepoOption } from "./planning";

export interface ProjectRepoView {
  relativePath: string;
  name: string;
  /** False when the repo has moved or been removed since it was added. */
  known: boolean;
}

export interface ProjectSummary {
  id: number;
  name: string;
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
  repos: ProjectRepoView[];
  /** Known repos not yet in the project. */
  availableRepos: PlanningRepoOption[];
  issues: LocalIssueView[];
  /** Issues in no project, which can be added. */
  unassignedIssues: LocalIssueView[];
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

function repoView(path: string, repos: readonly RepoRecord[]): ProjectRepoView {
  const repo = repos.find((candidate) => candidate.relativePath === path);
  return { relativePath: path, name: repo?.name ?? path.split("/").pop() ?? path, known: repo !== undefined };
}

export const getProjects = createServerFn({ method: "GET" }).handler(async (): Promise<ProjectsView> => {
  const app = getApp();
  const issues = app.listLocalIssues();
  return {
    projects: app.listProjects().map((project) => {
      const inProject = issues.filter((issue) => issue.projectId === project.id);
      return {
        id: project.id,
        name: project.name,
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
    const issues = app.listLocalIssues();
    return {
      id: project.id,
      name: project.name,
      repos: project.repoPaths.map((path) => repoView(path, repos)),
      availableRepos: repos
        .filter((repo) => !repo.isWorktree && !project.repoPaths.includes(repo.relativePath))
        .map(({ relativePath, name }) => ({ relativePath, name })),
      issues: issues.filter((issue) => issue.projectId === project.id).map((issue) => toView(issue, repos)),
      unassignedIssues: issues.filter((issue) => issue.projectId === null).map((issue) => toView(issue, repos)),
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

export const removeProjectRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; repo: string }) => {
    if (!isId(input?.id) || typeof input?.repo !== "string") throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().removeRepoFromProject(data.id, data.repo);
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
