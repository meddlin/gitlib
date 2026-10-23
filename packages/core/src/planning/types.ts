export type LocalIssueState = "open" | "closed";

/** Workflow statuses, in board order. Each one is a column on the planning board. */
export const ISSUE_STATUSES = ["todo", "in_progress", "in_review", "done"] as const;
export type IssueStatus = (typeof ISSUE_STATUSES)[number];

export const isIssueStatus = (value: unknown): value is IssueStatus =>
  typeof value === "string" && (ISSUE_STATUSES as readonly string[]).includes(value);

/**
 * An issue that lives only in gitlib's planning database. It is filed against a repository gitlib
 * knows about, but it is never read from or written to GitHub or GitLab.
 */
export interface LocalIssue {
  id: number;
  /**
   * The repo's `relativePath`, the same identifier the CLI and web app use. It is stored as text
   * rather than a `gitlib.db` row id because that database can be rebuilt by rescanning and
   * planning data cannot.
   */
  repoPath: string;
  /** Sequence within the repo, so issues read as `repo#3`. */
  number: number;
  title: string;
  /** Markdown. */
  body: string;
  /** Open or closed. Kept in step with `status`: an issue is closed exactly when its status is `done`. */
  state: LocalIssueState;
  /** Where the issue sits on the board. */
  status: IssueStatus;
  /** The project this issue is filed under, or null. Deleting a project sets this back to null. */
  projectId: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface LocalIssueQuery {
  /** Only issues filed against this repo (its `relativePath`). */
  repoPath?: string;
  state?: LocalIssueState;
  /** Only issues in this project. */
  projectId?: number;
}

export interface NewLocalIssue {
  repoPath: string;
  title: string;
  body: string;
}

export interface LocalIssueChanges {
  title?: string;
  body?: string;
}

/**
 * A named group of repositories and issues. Repos are referenced by `relativePath` (see
 * `LocalIssue.repoPath`), so a project can mention a repo gitlib has since lost track of.
 */
export interface Project {
  id: number;
  name: string;
  /** `relativePath` of every repo in the project, sorted. */
  repoPaths: string[];
  createdAt: string;
  updatedAt: string;
}
