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

/** An issue that lives in gitlib's own planning database; nothing here is read from or sent to a forge. */
export interface LocalIssueView extends LocalIssue {
  /** The repo's display name, or the last segment of its path when gitlib no longer knows the repo. */
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
}

export interface LocalIssueDetail {
  issue: LocalIssueView;
  limits: IssueLimits;
}

// A function, not a constant: client bundles must not keep a runtime import of @gitlib/core.
const issueLimits = (): IssueLimits => ({ title: MAX_ISSUE_TITLE_LENGTH, body: MAX_ISSUE_BODY_LENGTH });

function toView(issue: LocalIssue, repos: readonly RepoRecord[]): LocalIssueView {
  const repo = repos.find((candidate) => candidate.relativePath === issue.repoPath);
  return {
    ...issue,
    repoName: repo?.name ?? issue.repoPath.split("/").pop() ?? issue.repoPath,
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
  };
});

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

/** One issue by id with the form limits, or null if there is none. */
export const getLocalIssue = createServerFn({ method: "GET" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid issue request.");
    return input;
  })
  .handler(async ({ data }): Promise<LocalIssueDetail | null> => {
    const issue = getApp().planning.getIssue(data.id);
    return issue ? { issue: toView(issue, loadRepositories()), limits: issueLimits() } : null;
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
