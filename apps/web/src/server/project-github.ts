import { createServerFn } from "@tanstack/react-start";
import { getApp, loadRepositories } from "./gitlib.server";
import type { IssueView } from "./issues";
import type { PullRequestView } from "./pulls";
import { readProjectGitHub } from "./project-github.server";

/** One list read from GitHub: what came back, whether there is more, or why nothing did. */
export interface GitHubList<T> {
  items: T[];
  /** Whether GitHub has more than were fetched. */
  hasMore: boolean;
  error: string | null;
}

export interface CommitView {
  /** Abbreviated hash. */
  sha: string;
  /** First line of the commit message. */
  message: string;
  url: string;
  /** GitHub login when it knows one, else the name written into the commit. */
  author: string | null;
  committedAt: string;
}

/** What GitHub holds for one repo in a project. Read-only: gitlib never writes to GitHub or keeps this. */
export interface ProjectGitHubRepo {
  relativePath: string;
  /** `owner/repo`, or null when the repo has no GitHub remote or could not be resolved. */
  slug: string | null;
  /** The repo's page on GitHub. */
  url: string | null;
  /** Why this repo could not be looked up at all; each list below also carries its own error. */
  error: string | null;
  pulls: GitHubList<PullRequestView>;
  issues: GitHubList<IssueView>;
  commits: GitHubList<CommitView>;
}

export interface ProjectGitHubView {
  /** One entry per repo in the project, in the project's order. */
  repos: ProjectGitHubRepo[];
  /** When gitlib asked for this (a cached repo may be a few minutes older). */
  fetchedAt: string;
  /** Without a token GitHub allows few requests and hides private repos. */
  hasToken: boolean;
}

/**
 * A project's repos as GitHub sees them: open pull requests, open issues and recent commits. It is a
 * preview only; it never touches the planning database, so GitHub is not a source of truth for gitlib.
 */
export const getProjectGitHub = createServerFn({ method: "GET" })
  .validator((input: { id: number; refresh?: boolean }) => {
    if (!Number.isInteger(input?.id) || input.id <= 0) throw new Error("Invalid project request.");
    return { id: input.id, refresh: input.refresh === true };
  })
  .handler(async ({ data }): Promise<ProjectGitHubView> => {
    loadRepositories();
    const project = getApp().planning.getProject(data.id);
    if (!project) throw new Error("Gitlib doesn't have that project.");
    return readProjectGitHub(project.repoPaths, {
      refresh: data.refresh,
      remotes: project.remotes.filter((remote) => remote.provider === "github").map((remote) => remote.fullName),
    });
  });
