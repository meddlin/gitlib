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
  /** The planning repo it is filed against (see `PlanningRepo`); stays the same when the repo moves. */
  repoId: number;
  /** The repo's short name, so the issue reads as `slug#3`. */
  repoSlug: string;
  /** The repo's `relativePath` where gitlib last found it. Follows the repo when it moves. */
  repoPath: string;
  /** Sequence within the repo, so issues read as `slug#3`. */
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
  /**
   * The milestone this issue counts toward, or null. It is always one of `projectId`'s milestones, so
   * an issue with no project has none, and moving an issue to another project clears it. Deleting the
   * milestone sets this back to null.
   */
  milestoneId: number | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
}

export interface LocalIssueQuery {
  /** Only issues filed against the repo now at this `relativePath`. */
  repoPath?: string;
  /** Only issues filed against this planning repo. */
  repoId?: number;
  state?: LocalIssueState;
  /** Only issues in this project. */
  projectId?: number;
  /** Only issues in this milestone. */
  milestoneId?: number;
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
 * A repository as gitlib's planning data knows it. Issues and projects point at its `id`, which never
 * changes, so they follow the repo when it moves or is renamed on disk. It lives in `planning.db`
 * rather than `gitlib.db` because that database can be rebuilt by rescanning and planning data cannot.
 * A planning repo is created the first time an issue or project refers to a repo.
 */
export interface PlanningRepo {
  id: number;
  /** Short name issues are shown under (`slug#3`). Unique, ignoring case; the user can change it. */
  slug: string;
  /** `relativePath` where gitlib last found the repo. */
  path: string;
  /** The repo's first commit, used to recognize it at a new path after a move; null until it is known. */
  rootCommit: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A planning repo plus whether the last scan found it at `path`. */
export interface PlanningRepoStatus extends PlanningRepo {
  /** False when nothing is at `path` any more; its issues stay, and it can be relinked to the repo's new path. */
  found: boolean;
}

/** A repo in a project, as listed on the project. */
export interface ProjectRepo {
  id: number;
  slug: string;
  path: string;
}

/**
 * A named group of repositories and issues. Repos are planning repos (see `PlanningRepo`), so a project
 * keeps a repo gitlib has since lost track of.
 */
export interface Project {
  id: number;
  name: string;
  /** Every repo in the project, sorted by path. */
  repos: ProjectRepo[];
  /** `relativePath` of every repo in the project, sorted; the same repos as `repos`. */
  repoPaths: string[];
  createdAt: string;
  updatedAt: string;
}

/** A target within a project that issues are grouped under, optionally with a due date. */
export interface Milestone {
  id: number;
  projectId: number;
  /** Unique within the project, ignoring case. */
  title: string;
  /** Markdown. */
  description: string;
  /** A calendar date, `YYYY-MM-DD`, with no time zone; null when the milestone has no deadline. */
  dueDate: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface NewMilestone {
  title: string;
  description?: string;
  dueDate?: string | null;
}

export interface MilestoneChanges {
  title?: string;
  description?: string;
  /** `null` clears the due date. */
  dueDate?: string | null;
}

/**
 * A Dependabot pull request the user has put aside. With `snoozedUntil` it comes back at that time; without it,
 * it stays hidden until the pull request goes away.
 */
export interface DependabotDismissal {
  /** Lowercased `owner/repo`. */
  repo: string;
  number: number;
  /** ISO-8601 time the snooze ends, or null for "until closed". */
  snoozedUntil: string | null;
  createdAt: string;
}

/** When the web server checks Dependabot on its own: on these weekdays, at this time of day. */
export interface DependabotSchedule {
  enabled: boolean;
  /** Weekdays it runs on, 0 (Sunday) to 6, sorted and without repeats. */
  days: number[];
  /** `HH:MM`, 24-hour, in the server's time zone. */
  time: string;
}

export interface StoredDependabotSchedule extends DependabotSchedule {
  /** When the user last saved it; null while it is still the default. A slot before this is never "missed". */
  updatedAt: string | null;
}
