import { createServerFn } from "@tanstack/react-start";
import {
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  isIssueStatus,
  type IssueStatus,
  type LocalIssue,
  type LocalIssueState,
  type RepoRecord,
} from "@gitlib/core";
import { getApp, loadRepositories } from "./gitlib.server";
import type { EpicOption } from "./epics";
import type { MilestoneOption } from "./milestones";

/** An issue that lives in gitlib's own planning database; nothing here is read from or sent to a forge. */
export interface LocalIssueView extends LocalIssue {
  /** The repo's short name in planning (`LocalIssue.repoSlug`), so the issue reads as `repoName#3`. */
  repoName: string;
  /** False when the repo has moved or been removed since the issue was filed. */
  repoKnown: boolean;
}

export interface PlanningRepoOption {
  relativePath: string;
  name: string;
}

/** Sent down with the data so the form's limits can't drift from the ones the server enforces. */
export interface IssueLimits {
  title: number;
  body: number;
}

export interface PlanningView {
  /** Repos an issue can be filed against: every known repo except linked worktrees. */
  repos: PlanningRepoOption[];
  /** Every issue, most recently updated first; the page filters them. */
  issues: LocalIssueView[];
  limits: IssueLimits;
  /** Every project, by name, for labelling and choosing. */
  projects: { id: number; name: string }[];
}

export interface LocalIssueDetail {
  issue: LocalIssueView;
  limits: IssueLimits;
  projects: { id: number; name: string }[];
  /** Milestones of the issue's project, which are the only ones it can be put in; empty when it has no project. */
  milestones: MilestoneOption[];
  /** Epics of the issue's project, likewise. */
  epics: EpicOption[];
}

// A function, not a constant: client bundles must not keep a runtime import of @gitlib/core.
const issueLimits = (): IssueLimits => ({ title: MAX_ISSUE_TITLE_LENGTH, body: MAX_ISSUE_BODY_LENGTH });

export function toView(issue: LocalIssue, repos: readonly RepoRecord[]): LocalIssueView {
  const repo = repos.find((candidate) => candidate.relativePath === issue.repoPath);
  return {
    ...issue,
    repoName: issue.repoSlug,
    repoKnown: repo !== undefined,
  };
}

export const getPlanning = createServerFn({ method: "GET" }).handler(async (): Promise<PlanningView> => {
  const repos = loadRepositories();
  return {
    repos: repos
      .filter((repo) => !repo.isWorktree)
      .map(({ relativePath, name }) => ({ relativePath, name })),
    issues: getApp()
      .listLocalIssues()
      .map((issue) => toView(issue, repos)),
    limits: issueLimits(),
    projects: projectOptions(),
  };
});

/** Projects to choose from; an archived one only when it is `keep`, the issue's own, labelled as archived. */
const projectOptions = (keep: number | null = null) =>
  getApp()
    .listProjects({ includeArchived: keep !== null })
    .filter((project) => project.archivedAt === null || project.id === keep)
    .map(({ id, name, archivedAt }) => ({ id, name: archivedAt ? `${name} (archived)` : name }));

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** One issue by id with the form limits, or null if there is none. */
export const getLocalIssue = createServerFn({ method: "GET" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid issue request.");
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueDetail | null> => {
    const app = getApp();
    const issue = app.planning.getIssue(data.id);
    if (!issue) return null;
    return {
      issue: toView(issue, loadRepositories()),
      limits: issueLimits(),
      // Archived ones cannot be chosen, but the issue's own project and milestone are kept so the page can name them.
      projects: projectOptions(issue.projectId),
      milestones:
        issue.projectId === null
          ? []
          : app
              .listMilestones(issue.projectId, { includeArchived: true })
              .filter((milestone) => milestone.archivedAt === null || milestone.id === issue.milestoneId)
              .map(({ id, title, archivedAt }) => ({ id, title: archivedAt ? `${title} (archived)` : title })),
      epics:
        issue.projectId === null
          ? []
          : app
              .listEpics(issue.projectId, { includeArchived: true })
              .filter((epic) => epic.archivedAt === null || epic.id === issue.epicId)
              .map(({ id, title, archivedAt }) => ({ id, title: archivedAt ? `${title} (archived)` : title })),
    };
  });

/** Every planning issue filed against one repo (open and closed, archived too), most recently updated first. */
export const getRepoLocalIssues = createServerFn({ method: "GET" })
  .validator((input: { relativePath: string }) => {
    if (typeof input?.relativePath !== "string" || !input.relativePath) throw new Error("Invalid issues request.");
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueView[]> => {
    const repos = loadRepositories();
    return getApp()
      .listLocalIssues({ repoPath: data.relativePath, includeArchived: true })
      .map((issue) => toView(issue, repos));
  });

export const createLocalIssue = createServerFn({ method: "POST" })
  .validator((input: { repo: string; title: string; body: string }) => {
    if (typeof input?.repo !== "string" || typeof input?.title !== "string" || typeof input?.body !== "string") {
      throw new Error("Invalid issue payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueView> => {
    const issue = getApp().createLocalIssue(data.repo, { title: data.title, body: data.body });
    return toView(issue, loadRepositories());
  });

export const updateLocalIssue = createServerFn({ method: "POST" })
  .validator((input: { id: number; title: string; body: string }) => {
    if (!isId(input?.id) || typeof input?.title !== "string" || typeof input?.body !== "string") {
      throw new Error("Invalid issue payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueView> => {
    const issue = getApp().updateLocalIssue(data.id, { title: data.title, body: data.body });
    return toView(issue, loadRepositories());
  });

export const setLocalIssueState = createServerFn({ method: "POST" })
  .validator((input: { id: number; state: LocalIssueState }) => {
    if (!isId(input?.id) || (input?.state !== "open" && input?.state !== "closed")) {
      throw new Error("Invalid issue state payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueView> => {
    const issue = getApp().setLocalIssueState(data.id, data.state);
    return toView(issue, loadRepositories());
  });

export const setLocalIssueStatus = createServerFn({ method: "POST" })
  .validator((input: { id: number; status: IssueStatus }) => {
    if (!isId(input?.id) || !isIssueStatus(input?.status)) throw new Error("Invalid issue status payload.");
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueView> => {
    const issue = getApp().setLocalIssueStatus(data.id, data.status);
    return toView(issue, loadRepositories());
  });
