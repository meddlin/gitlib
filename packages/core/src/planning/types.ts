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
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface LocalIssueQuery {
  /** Only issues filed against this repo (its `relativePath`). */
  repoPath?: string;
  state?: LocalIssueState;
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
