import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "../errors.js";
import { MIGRATIONS, migrate, schemaVersion, type Migration } from "./migrations.js";
import type {
  ArchiveFilter,
  DependabotDismissal,
  DependabotSchedule,
  Epic,
  EpicChanges,
  StoredDependabotSchedule,
  IssueStatus,
  LocalIssue,
  LocalIssueChanges,
  LocalIssueQuery,
  LocalIssueState,
  Milestone,
  MilestoneChanges,
  NewLocalIssue,
  PlanningRepo,
  Project,
  ProjectRepo,
  ProjectRemote,
} from "./types.js";

// Loaded via getBuiltinModule for the same bundler reason as in store.ts.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/** How long a connection waits on another process's write lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

/** Off, on weekdays at 08:00, until the user chooses otherwise. */
export const DEFAULT_DEPENDABOT_SCHEDULE: DependabotSchedule = { enabled: false, days: [1, 2, 3, 4, 5], time: "08:00" };

export class LocalIssueNotFoundError extends GitLibError {}
export class ProjectNotFoundError extends GitLibError {}
export class ProjectNameTakenError extends GitLibError {}
export class MilestoneNotFoundError extends GitLibError {}
export class MilestoneTitleTakenError extends GitLibError {}
/** An issue was put in a milestone that belongs to a different project than the issue's own. */
export class MilestoneProjectMismatchError extends GitLibError {}
export class PlanningRepoNotFoundError extends GitLibError {}
/** A name that is one planning repo's slug and another's path. */
export class AmbiguousPlanningRepoError extends GitLibError {}
export class RepoSlugTakenError extends GitLibError {}
/** A planning repo was pointed at a path another planning repo already has. */
export class RepoPathTakenError extends GitLibError {}
export class EpicNotFoundError extends GitLibError {}
export class EpicTitleTakenError extends GitLibError {}
/** An issue was put in an epic that belongs to a different project than the issue's own. */
export class EpicProjectMismatchError extends GitLibError {}
/** Something new was linked to an archived repo, project, milestone or epic; restore it first. */
export class PlanningArchivedError extends GitLibError {}

interface LocalIssueRow {
  id: number;
  repo_id: number;
  repo_slug: string;
  repo_path: string;
  number: number;
  title: string;
  body: string;
  state: LocalIssueState;
  status: IssueStatus;
  project_id: number | null;
  milestone_id: number | null;
  epic_id: number | null;
  archived: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

const toLocalIssue = (row: LocalIssueRow): LocalIssue => ({
  id: Number(row.id),
  repoId: Number(row.repo_id),
  repoSlug: row.repo_slug,
  repoPath: row.repo_path,
  number: Number(row.number),
  title: row.title,
  body: row.body,
  state: row.state,
  status: row.status,
  projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
  milestoneId: row.milestone_id === null || row.milestone_id === undefined ? null : Number(row.milestone_id),
  epicId: row.epic_id === null || row.epic_id === undefined ? null : Number(row.epic_id),
  archived: Boolean(row.archived),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at || null,
});

/** An issue is hidden by archiving when its repo or its project is archived. */
const ISSUE_ARCHIVED = "(planning_repos.archived_at IS NOT NULL OR projects.archived_at IS NOT NULL)";

/** Issues with their repo's current slug and path, and whether archiving hides them. */
const ISSUE_SELECT = `
  SELECT local_issues.*, planning_repos.slug AS repo_slug, planning_repos.path AS repo_path, ${ISSUE_ARCHIVED} AS archived
  FROM local_issues
  JOIN planning_repos ON planning_repos.id = local_issues.repo_id
  LEFT JOIN projects ON projects.id = local_issues.project_id`;

interface PlanningRepoRow {
  id: number;
  slug: string;
  path: string;
  root_commit: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const toPlanningRepo = (row: PlanningRepoRow): PlanningRepo => ({
  id: Number(row.id),
  slug: row.slug,
  path: row.path,
  rootCommit: row.root_commit || null,
  archivedAt: row.archived_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

/** What a new planning repo is called: its folder name, with anything a slug cannot hold replaced. */
const slugCandidates = function* (repoPath: string): Generator<string> {
  const clean = (text: string) => text.replace(/[\s#]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100);
  const base = clean(repoPath.split("/").filter(Boolean).pop() ?? "") || "repo";
  yield base;
  const whole = clean(repoPath);
  if (whole && whole !== base) yield whole;
  for (let n = 2; ; n++) yield `${base}-${n}`;
};

interface MilestoneRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  due_date: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const toMilestone = (row: MilestoneRow): Milestone => ({
  id: Number(row.id),
  projectId: Number(row.project_id),
  title: row.title,
  description: row.description,
  dueDate: row.due_date || null,
  archivedAt: row.archived_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface EpicRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

const toEpic = (row: EpicRow): Epic => ({
  id: Number(row.id),
  projectId: Number(row.project_id),
  title: row.title,
  description: row.description,
  archivedAt: row.archived_at || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface ProjectRow {
  id: number;
  name: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

/** A membership row: the repo, and whether it was taken out of the project. */
type Membership = ProjectRepo & { projectId: number; removed: boolean };

const toProject = (row: ProjectRow, members: Membership[], remotes: ProjectRemote[]): Project => {
  const strip = ({ projectId: _, removed: __, ...repo }: Membership): ProjectRepo => repo;
  const repos = members.filter((member) => !member.removed).map(strip);
  return {
    id: Number(row.id),
    name: row.name,
    repos,
    repoPaths: repos.map((repo) => repo.path),
    removedRepos: members.filter((member) => member.removed).map(strip),
    remotes,
    archivedAt: row.archived_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
};

/** Where each archivable thing lives, and what to call it in messages. */
const ARCHIVABLE = {
  repo: { table: "planning_repos", noun: "repo", name: "slug" },
  project: { table: "projects", noun: "project", name: "name" },
  milestone: { table: "milestones", noun: "milestone", name: "title" },
  epic: { table: "epics", noun: "epic", name: "title" },
} as const;
export type Archivable = keyof typeof ARCHIVABLE;

interface RemoteRow {
  project_id: number;
  provider: string;
  full_name: string;
}

const toRemote = (row: RemoteRow): ProjectRemote => ({
  provider: row.provider === "gitlab" ? "gitlab" : "github",
  fullName: row.full_name,
});

const isUniqueViolation = (error: unknown): boolean =>
  error instanceof Error && /UNIQUE constraint failed/i.test(error.message);

/**
 * gitlib's own planning data (`planning.db`). Unlike `gitlib.db` this cannot be rebuilt by rescanning,
 * so its schema is versioned with append-only migrations and it can be backed up with `backup()`.
 * Timestamps are passed in by the caller, as with `Store`.
 */
export class PlanningStore {
  constructor(
    readonly dbPath: string,
    migrations: readonly Migration[] = MIGRATIONS,
  ) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.withConnection((db) => migrate(db, migrations));
  }

  /** One short-lived connection per operation, like `Store`. */
  private withConnection<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath, { timeout: BUSY_TIMEOUT_MS });
    try {
      db.exec("PRAGMA foreign_keys = ON");
      return operation(db);
    } finally {
      db.close();
    }
  }

  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.withConnection((db) => {
      db.exec("BEGIN IMMEDIATE");
      try {
        const result = operation(db);
        db.exec("COMMIT");
        return result;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    });
  }

  schemaVersion(): number {
    return this.withConnection(schemaVersion);
  }

  /** Files an issue against the repo at `input.repoPath`, creating its planning repo if this is the first time. */
  createIssue(input: NewLocalIssue, now: string): LocalIssue {
    return this.transaction((db) => {
      const repo = this.ensureRepo(db, input.repoPath, now);
      if (repo.archivedAt) {
        throw new PlanningArchivedError(`The repo "${repo.slug}" is archived. Restore it before filing new issues against it.`);
      }
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO local_issues (repo_id, number, title, body, state, created_at, updated_at)
           VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM local_issues WHERE repo_id = ?), ?, ?, 'open', ?, ?)`,
        )
        .run(repo.id, repo.id, input.title, input.body, now, now);
      return this.requireIssue(db, Number(lastInsertRowid));
    });
  }

  getIssue(id: number): LocalIssue | null {
    return this.withConnection((db) => this.findIssue(db, id));
  }

  /** Most recently updated first. */
  listIssues(query: LocalIssueQuery = {}): LocalIssue[] {
    const conditions: string[] = [];
    const params: (string | number)[] = [];
    if (query.repoPath !== undefined) {
      conditions.push("planning_repos.path = ?");
      params.push(query.repoPath);
    }
    if (query.repoId !== undefined) {
      conditions.push("local_issues.repo_id = ?");
      params.push(query.repoId);
    }
    if (query.state !== undefined) {
      conditions.push("local_issues.state = ?");
      params.push(query.state);
    }
    if (query.projectId !== undefined) {
      conditions.push("local_issues.project_id = ?");
      params.push(query.projectId);
    }
    if (query.milestoneId !== undefined) {
      conditions.push("local_issues.milestone_id = ?");
      params.push(query.milestoneId);
    }
    if (query.epicId !== undefined) {
      conditions.push("local_issues.epic_id = ?");
      params.push(query.epicId);
    }
    if (!query.includeArchived) conditions.push(`NOT ${ISSUE_ARCHIVED}`);
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.withConnection((db) => {
      const rows = db
        .prepare(`${ISSUE_SELECT} ${where} ORDER BY local_issues.updated_at DESC, local_issues.id DESC`)
        .all(...params) as unknown as LocalIssueRow[];
      return rows.map(toLocalIssue);
    });
  }

  updateIssue(id: number, changes: LocalIssueChanges, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      db.prepare("UPDATE local_issues SET title = ?, body = ?, updated_at = ? WHERE id = ?").run(
        changes.title ?? current.title,
        changes.body ?? current.body,
        now,
        id,
      );
      return this.requireIssue(db, id);
    });
  }

  setIssueState(id: number, state: LocalIssueState, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      // Setting the state an issue already has changes nothing, including its timestamps.
      if (current.state === state) return current;
      // Closing finishes the issue; reopening puts it back at the start of the board.
      db.prepare("UPDATE local_issues SET state = ?, status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(
        state,
        state === "closed" ? "done" : "todo",
        state === "closed" ? now : null,
        now,
        id,
      );
      return this.requireIssue(db, id);
    });
  }

  /** Moves an issue to a board column. `done` closes it and any other status reopens it. */
  setIssueStatus(id: number, status: IssueStatus, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (current.status === status) return current;
      const closing = status === "done";
      db.prepare("UPDATE local_issues SET state = ?, status = ?, closed_at = ?, updated_at = ? WHERE id = ?").run(
        closing ? "closed" : "open",
        status,
        closing ? (current.closedAt ?? now) : null,
        now,
        id,
      );
      return this.requireIssue(db, id);
    });
  }

  /**
   * Files an issue under a project, or takes it out of its project with `null`. Milestones and epics belong to
   * one project, so changing the project takes the issue out of its milestone and its epic.
   */
  setIssueProject(id: number, projectId: number | null, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (current.projectId === projectId) return current;
      if (projectId !== null) this.requireLive(db, "project", projectId, "file issues under it");
      db.prepare("UPDATE local_issues SET project_id = ?, milestone_id = NULL, epic_id = NULL, updated_at = ? WHERE id = ?").run(
        projectId,
        now,
        id,
      );
      return this.requireIssue(db, id);
    });
  }

  /**
   * Puts an issue in a milestone, or takes it out with `null`. The milestone must belong to the issue's
   * project, so the issue has to be filed under that project first.
   */
  setIssueMilestone(id: number, milestoneId: number | null, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (milestoneId !== null) {
        const milestone = this.requireMilestone(db, milestoneId);
        if (current.milestoneId !== milestoneId) this.requireLive(db, "milestone", milestoneId, "put issues in it");
        if (current.projectId !== milestone.projectId) {
          throw new MilestoneProjectMismatchError(
            `Milestone "${milestone.title}" belongs to a different project. Put the issue in that project first.`,
          );
        }
      }
      if (current.milestoneId === milestoneId) return current;
      db.prepare("UPDATE local_issues SET milestone_id = ?, updated_at = ? WHERE id = ?").run(milestoneId, now, id);
      return this.requireIssue(db, id);
    });
  }

  /**
   * Puts an issue in an epic, or takes it out with `null`. The epic must belong to the issue's project, so the
   * issue has to be filed under that project first.
   */
  setIssueEpic(id: number, epicId: number | null, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (epicId !== null) {
        const epic = this.requireEpic(db, epicId);
        if (current.epicId !== epicId) this.requireLive(db, "epic", epicId, "put issues in it");
        if (current.projectId !== epic.projectId) {
          throw new EpicProjectMismatchError(
            `Epic "${epic.title}" belongs to a different project. Put the issue in that project first.`,
          );
        }
      }
      if (current.epicId === epicId) return current;
      db.prepare("UPDATE local_issues SET epic_id = ?, updated_at = ? WHERE id = ?").run(epicId, now, id);
      return this.requireIssue(db, id);
    });
  }

  createEpic(projectId: number, input: { title: string; description: string }, now: string): Epic {
    return this.transaction((db) => {
      this.requireLive(db, "project", projectId, "add epics to it");
      try {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO epics (project_id, title, description, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
          .run(projectId, input.title, input.description, now, now);
        return this.requireEpic(db, Number(lastInsertRowid));
      } catch (error) {
        throw this.epicTitleTaken(error, input.title);
      }
    });
  }

  getEpic(id: number): Epic | null {
    return this.withConnection((db) => this.findEpic(db, id));
  }

  /** By title within each project. Leaves archived ones out unless asked. */
  listEpics(projectId?: number, { includeArchived = false }: ArchiveFilter = {}): Epic[] {
    return this.withConnection((db) => {
      const conditions = [
        ...(projectId === undefined ? [] : ["project_id = ?"]),
        ...(includeArchived ? [] : ["archived_at IS NULL"]),
      ];
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM epics ${where} ORDER BY project_id, title, id`)
        .all(...(projectId === undefined ? [] : [projectId])) as unknown as EpicRow[];
      return rows.map(toEpic);
    });
  }

  updateEpic(id: number, changes: EpicChanges, now: string): Epic {
    return this.transaction((db) => {
      const current = this.requireEpic(db, id);
      try {
        db.prepare("UPDATE epics SET title = ?, description = ?, updated_at = ? WHERE id = ?").run(
          changes.title ?? current.title,
          changes.description ?? current.description,
          now,
          id,
        );
      } catch (error) {
        throw this.epicTitleTaken(error, changes.title ?? current.title);
      }
      return this.requireEpic(db, id);
    });
  }

  /** Removes the epic. Its issues stay in the project, no longer in any epic. */
  deleteEpic(id: number): void {
    this.transaction((db) => {
      this.requireEpic(db, id);
      db.prepare("DELETE FROM epics WHERE id = ?").run(id);
    });
  }

  createMilestone(projectId: number, input: { title: string; description: string; dueDate: string | null }, now: string): Milestone {
    return this.transaction((db) => {
      this.requireLive(db, "project", projectId, "add milestones to it");
      try {
        const { lastInsertRowid } = db
          .prepare(
            "INSERT INTO milestones (project_id, title, description, due_date, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(projectId, input.title, input.description, input.dueDate, now, now);
        return this.requireMilestone(db, Number(lastInsertRowid));
      } catch (error) {
        throw this.titleTaken(error, input.title);
      }
    });
  }

  getMilestone(id: number): Milestone | null {
    return this.withConnection((db) => this.findMilestone(db, id));
  }

  /** Soonest due date first, then milestones with no due date; ties by title. Leaves archived ones out unless asked. */
  listMilestones(projectId?: number, { includeArchived = false }: ArchiveFilter = {}): Milestone[] {
    return this.withConnection((db) => {
      const conditions = [
        ...(projectId === undefined ? [] : ["project_id = ?"]),
        ...(includeArchived ? [] : ["archived_at IS NULL"]),
      ];
      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      const rows = db
        .prepare(`SELECT * FROM milestones ${where} ORDER BY due_date IS NULL, due_date, title, id`)
        .all(...(projectId === undefined ? [] : [projectId])) as unknown as MilestoneRow[];
      return rows.map(toMilestone);
    });
  }

  updateMilestone(id: number, changes: MilestoneChanges, now: string): Milestone {
    return this.transaction((db) => {
      const current = this.requireMilestone(db, id);
      try {
        db.prepare("UPDATE milestones SET title = ?, description = ?, due_date = ?, updated_at = ? WHERE id = ?").run(
          changes.title ?? current.title,
          changes.description ?? current.description,
          changes.dueDate === undefined ? current.dueDate : changes.dueDate,
          now,
          id,
        );
      } catch (error) {
        throw this.titleTaken(error, changes.title ?? current.title);
      }
      return this.requireMilestone(db, id);
    });
  }

  /** Removes the milestone. Its issues stay in the project, no longer in any milestone. */
  deleteMilestone(id: number): void {
    this.transaction((db) => {
      this.requireMilestone(db, id);
      db.prepare("DELETE FROM milestones WHERE id = ?").run(id);
    });
  }

  createProject(name: string, now: string): Project {
    return this.transaction((db) => {
      try {
        const { lastInsertRowid } = db
          .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES (?, ?, ?)")
          .run(name, now, now);
        return this.requireProject(db, Number(lastInsertRowid));
      } catch (error) {
        throw this.nameTaken(error, name);
      }
    });
  }

  getProject(id: number): Project | null {
    return this.withConnection((db) => this.findProject(db, id));
  }

  /** By name, A to Z. Leaves archived projects out unless asked. */
  listProjects({ includeArchived = false }: ArchiveFilter = {}): Project[] {
    return this.withConnection((db) => {
      const where = includeArchived ? "" : "WHERE archived_at IS NULL";
      const rows = db.prepare(`SELECT * FROM projects ${where} ORDER BY name`).all() as unknown as ProjectRow[];
      const members = new Map<number, Membership[]>();
      for (const member of this.memberships(db)) {
        const list = members.get(member.projectId) ?? [];
        list.push(member);
        members.set(member.projectId, list);
      }
      const hosted = new Map<number, ProjectRemote[]>();
      const remoteRows = db
        .prepare("SELECT project_id, provider, full_name FROM project_remotes ORDER BY provider, full_name")
        .all() as unknown as RemoteRow[];
      for (const row of remoteRows) {
        const list = hosted.get(Number(row.project_id)) ?? [];
        list.push(toRemote(row));
        hosted.set(Number(row.project_id), list);
      }
      return rows.map((row) => toProject(row, members.get(Number(row.id)) ?? [], hosted.get(Number(row.id)) ?? []));
    });
  }

  renameProject(id: number, name: string, now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      try {
        db.prepare("UPDATE projects SET name = ?, updated_at = ? WHERE id = ?").run(name, now, id);
      } catch (error) {
        throw this.nameTaken(error, name);
      }
      return this.requireProject(db, id);
    });
  }

  /** Removes the project and its repo memberships. Its issues stay, no longer in any project. */
  deleteProject(id: number): void {
    this.transaction((db) => {
      this.requireProject(db, id);
      db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  }

  /**
   * Adds the repo at `repoPath`, creating its planning repo if this is the first time it is used. A repo that
   * was taken out of the project before comes back with its old membership.
   */
  addRepoToProject(id: number, repoPath: string, now: string): Project {
    return this.transaction((db) => {
      this.requireLive(db, "project", id, "add repos to it");
      if (this.addMember(db, id, repoPath, now) > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

  /** Puts the repo at `repoPath` in the project, or brings it back if it was taken out; 1 when anything changed. */
  private addMember(db: DatabaseSync, id: number, repoPath: string, now: string): number {
    const repo = this.ensureRepo(db, repoPath, now);
    if (repo.archivedAt) {
      throw new PlanningArchivedError(`The repo "${repo.slug}" is archived. Restore it before adding it to a project.`);
    }
    const { changes } = db
      .prepare(
        `INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (?, ?, ?)
         ON CONFLICT (project_id, repo_id) DO UPDATE SET archived_at = NULL WHERE project_repos.archived_at IS NOT NULL`,
      )
      .run(id, repo.id, now);
    return Number(changes);
  }

  /**
   * Adds several clones (by `relativePath`) and hosted repos in one step. Clones already in the project are skipped,
   * and ones taken out before come back, as with `addRepoToProject`.
   */
  addReposToProject(id: number, repoPaths: readonly string[], remotes: readonly ProjectRemote[], now: string): Project {
    return this.transaction((db) => {
      this.requireLive(db, "project", id, "add repos to it");
      let changed = 0;
      for (const repoPath of repoPaths) changed += this.addMember(db, id, repoPath, now);
      const insertRemote = db.prepare(
        "INSERT OR IGNORE INTO project_remotes (project_id, provider, full_name, added_at) VALUES (?, ?, ?, ?)",
      );
      for (const remote of remotes) changed += Number(insertRemote.run(id, remote.provider, remote.fullName, now).changes);
      if (changed > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

  /** Takes a hosted repo that has no clone out of the project. It has no issues of its own, so it is simply removed. */
  removeRemoteFromProject(id: number, remote: ProjectRemote, now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      const { changes } = db
        .prepare("DELETE FROM project_remotes WHERE project_id = ? AND provider = ? AND full_name = ?")
        .run(id, remote.provider, remote.fullName);
      if (Number(changes) > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

  /**
   * Takes a repo out of the project by archiving the membership, never deleting it: the repo's issues stay filed
   * under the project, and the repo is listed in `removedRepos` until it is added again.
   */
  removeRepoFromProject(id: number, repoId: number, now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      const { changes } = db
        .prepare("UPDATE project_repos SET archived_at = ? WHERE project_id = ? AND repo_id = ? AND archived_at IS NULL")
        .run(now, id, repoId);
      if (Number(changes) > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

  /**
   * Archives (`archived` true) or restores a repo, project or milestone. Nothing linked to it changes; see the
   * `archivedAt` fields for what archiving hides. Archiving twice keeps the first time.
   */
  setArchived(kind: Archivable, id: number, archived: boolean, now: string): void {
    const { table } = ARCHIVABLE[kind];
    this.transaction((db) => {
      const row = db.prepare(`SELECT archived_at FROM ${table} WHERE id = ?`).get(id) as { archived_at: string | null } | undefined;
      if (!row) throw this.notFound(kind, id);
      if ((row.archived_at !== null) === archived) return;
      db.prepare(`UPDATE ${table} SET archived_at = ?, updated_at = ? WHERE id = ?`).run(archived ? now : null, now, id);
    });
  }

  /** Every planning repo, by slug. */
  listRepos(): PlanningRepo[] {
    return this.withConnection((db) =>
      (db.prepare("SELECT * FROM planning_repos ORDER BY slug, id").all() as unknown as PlanningRepoRow[]).map(toPlanningRepo),
    );
  }

  getRepo(id: number): PlanningRepo | null {
    return this.withConnection((db) => this.findRepo(db, id));
  }

  /** The planning repo with this slug, ignoring case. */
  findRepoBySlug(slug: string): PlanningRepo | null {
    return this.withConnection((db) => {
      const row = db.prepare("SELECT * FROM planning_repos WHERE slug = ?").get(slug) as unknown as PlanningRepoRow | undefined;
      return row ? toPlanningRepo(row) : null;
    });
  }

  /** The planning repo last found at this `relativePath`. */
  findRepoByPath(repoPath: string): PlanningRepo | null {
    return this.withConnection((db) => {
      const row = db.prepare("SELECT * FROM planning_repos WHERE path = ?").get(repoPath) as unknown as PlanningRepoRow | undefined;
      return row ? toPlanningRepo(row) : null;
    });
  }

  /** The planning repo for the repo at `repoPath`, creating it if this is the first time it is used. */
  ensureRepoAt(repoPath: string, now: string): PlanningRepo {
    return this.transaction((db) => this.ensureRepo(db, repoPath, now));
  }

  /** Changes the short name issues are shown under. Their links are by id, so nothing else changes. */
  renameRepo(id: number, slug: string, now: string): PlanningRepo {
    return this.transaction((db) => {
      this.requireRepo(db, id);
      try {
        db.prepare("UPDATE planning_repos SET slug = ?, updated_at = ? WHERE id = ?").run(slug, now, id);
      } catch (error) {
        throw isUniqueViolation(error) ? new RepoSlugTakenError(`Another repo is already called "${slug}".`) : error;
      }
      return this.requireRepo(db, id);
    });
  }

  /**
   * Points a planning repo at the path the repo now lives at, with its first commit if known. Its issues and
   * project memberships follow it. Throws `RepoPathTakenError` if another planning repo has that path.
   */
  moveRepo(id: number, repoPath: string, rootCommit: string | null, now: string): PlanningRepo {
    return this.transaction((db) => {
      const current = this.requireRepo(db, id);
      if (current.path === repoPath && (rootCommit === null || current.rootCommit === rootCommit)) return current;
      try {
        db.prepare("UPDATE planning_repos SET path = ?, root_commit = COALESCE(?, root_commit), updated_at = ? WHERE id = ?").run(
          repoPath,
          rootCommit,
          now,
          id,
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
        const holder = db.prepare("SELECT slug FROM planning_repos WHERE path = ?").get(repoPath) as { slug: string } | undefined;
        throw new RepoPathTakenError(`${repoPath} is already linked to the repo "${holder?.slug ?? repoPath}".`);
      }
      return this.requireRepo(db, id);
    });
  }

  /** Records the repo's first commit, which is how it is recognized after a move. Not a user edit, so no timestamp. */
  setRepoRootCommit(id: number, rootCommit: string): void {
    this.transaction((db) => {
      this.requireRepo(db, id);
      db.prepare("UPDATE planning_repos SET root_commit = ? WHERE id = ?").run(rootCommit, id);
    });
  }

  /** Puts a Dependabot PR aside (or changes how long). `repo` is `owner/repo`, in any case. */
  dismissDependabotPr(repo: string, number: number, snoozedUntil: string | null, now: string): DependabotDismissal {
    const entry: DependabotDismissal = { repo: repo.toLowerCase(), number, snoozedUntil, createdAt: now };
    this.transaction(
      (db) =>
        void db
          .prepare(
            `INSERT INTO dependabot_dismissals (repo, number, snoozed_until, created_at) VALUES (?, ?, ?, ?)
             ON CONFLICT(repo, number) DO UPDATE SET snoozed_until = excluded.snoozed_until, created_at = excluded.created_at`,
          )
          .run(entry.repo, number, snoozedUntil, now),
    );
    return entry;
  }

  /** Brings a dismissed Dependabot PR back. Does nothing if it was not dismissed. */
  restoreDependabotPr(repo: string, number: number): void {
    this.transaction((db) => void db.prepare("DELETE FROM dependabot_dismissals WHERE repo = ? AND number = ?").run(repo.toLowerCase(), number));
  }

  /** Every dismissal, including snoozes that have ended; callers compare `snoozedUntil` with the time. */
  listDependabotDismissals(): DependabotDismissal[] {
    return this.withConnection((db) =>
      (
        db.prepare("SELECT repo, number, snoozed_until, created_at FROM dependabot_dismissals ORDER BY repo, number").all() as unknown as {
          repo: string;
          number: number;
          snoozed_until: string | null;
          created_at: string;
        }[]
      ).map((row) => ({ repo: row.repo, number: Number(row.number), snoozedUntil: row.snoozed_until, createdAt: row.created_at })),
    );
  }

  /** The saved schedule, or the default (off) until the user saves one. */
  getDependabotSchedule(): StoredDependabotSchedule {
    return this.withConnection((db) => {
      const row = db.prepare("SELECT enabled, days, time, updated_at FROM dependabot_schedule WHERE id = 1").get() as unknown as
        | { enabled: number; days: string; time: string; updated_at: string }
        | undefined;
      if (!row) return { ...DEFAULT_DEPENDABOT_SCHEDULE, days: [...DEFAULT_DEPENDABOT_SCHEDULE.days], updatedAt: null };
      const days = row.days.split(",").flatMap((day) => (/^[0-6]$/.test(day) ? [Number(day)] : []));
      return { enabled: Boolean(row.enabled), days, time: row.time, updatedAt: row.updated_at };
    });
  }

  /** Saves the schedule. The caller has validated it (see `normalizeSchedule`). */
  saveDependabotSchedule(schedule: DependabotSchedule, now: string): StoredDependabotSchedule {
    this.transaction(
      (db) =>
        void db
          .prepare(
            `INSERT INTO dependabot_schedule (id, enabled, days, time, updated_at) VALUES (1, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET enabled = excluded.enabled, days = excluded.days, time = excluded.time, updated_at = excluded.updated_at`,
          )
          .run(schedule.enabled ? 1 : 0, schedule.days.join(","), schedule.time, now),
    );
    return { ...schedule, days: [...schedule.days], updatedAt: now };
  }

  /**
   * Writes a consistent snapshot of the database to `destination` (SQLite `VACUUM INTO`), which is
   * safe to run while the web app is using the database. Never overwrites an existing file.
   */
  backup(destination: string): string {
    const target = path.resolve(destination);
    if (fs.existsSync(target)) {
      throw new GitLibError(`Cannot back up to ${target}: the file already exists.`);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    this.withConnection((db) => db.prepare("VACUUM INTO ?").run(target));
    return target;
  }

  private findIssue(db: DatabaseSync, id: number): LocalIssue | null {
    const row = db.prepare(`${ISSUE_SELECT} WHERE local_issues.id = ?`).get(id) as unknown as
      | LocalIssueRow
      | undefined;
    return row ? toLocalIssue(row) : null;
  }

  private requireIssue(db: DatabaseSync, id: number): LocalIssue {
    const issue = this.findIssue(db, id);
    if (!issue) throw new LocalIssueNotFoundError(`Issue ${id} was not found.`);
    return issue;
  }

  private findProject(db: DatabaseSync, id: number): Project | null {
    const row = db.prepare("SELECT * FROM projects WHERE id = ?").get(id) as unknown as ProjectRow | undefined;
    if (!row) return null;
    const remotes = db
      .prepare("SELECT project_id, provider, full_name FROM project_remotes WHERE project_id = ? ORDER BY provider, full_name")
      .all(id) as unknown as RemoteRow[];
    return toProject(row, this.memberships(db, id), remotes.map(toRemote));
  }

  /** Repo memberships of one project, or of all of them, sorted by path, including repos taken out. */
  private memberships(db: DatabaseSync, projectId?: number): Membership[] {
    const where = projectId === undefined ? "" : "WHERE member.project_id = ?";
    const rows = db
      .prepare(
        `SELECT member.project_id, member.archived_at AS removed_at, repo.id, repo.slug, repo.path, repo.archived_at
         FROM project_repos member JOIN planning_repos repo ON repo.id = member.repo_id
         ${where} ORDER BY repo.path`,
      )
      .all(...(projectId === undefined ? [] : [projectId])) as unknown as {
      project_id: number;
      removed_at: string | null;
      id: number;
      slug: string;
      path: string;
      archived_at: string | null;
    }[];
    return rows.map((row) => ({
      projectId: Number(row.project_id),
      removed: row.removed_at !== null,
      id: Number(row.id),
      slug: row.slug,
      path: row.path,
      archived: row.archived_at !== null,
    }));
  }

  /** Throws unless the repo, project or milestone exists and is not archived; `doing` finishes the sentence. */
  private requireLive(db: DatabaseSync, kind: Archivable, id: number, doing: string): void {
    const { table, noun, name } = ARCHIVABLE[kind];
    const row = db.prepare(`SELECT ${name} AS name, archived_at FROM ${table} WHERE id = ?`).get(id) as
      | { name: string; archived_at: string | null }
      | undefined;
    if (!row) throw this.notFound(kind, id);
    if (row.archived_at !== null) throw new PlanningArchivedError(`The ${noun} "${row.name}" is archived. Restore it to ${doing}.`);
  }

  private notFound(kind: Archivable, id: number): GitLibError {
    if (kind === "project") return new ProjectNotFoundError(`Project ${id} was not found.`);
    if (kind === "milestone") return new MilestoneNotFoundError(`Milestone ${id} was not found.`);
    if (kind === "epic") return new EpicNotFoundError(`Epic ${id} was not found.`);
    return new PlanningRepoNotFoundError(`Repo ${id} is not in the planning data.`);
  }

  private findRepo(db: DatabaseSync, id: number): PlanningRepo | null {
    const row = db.prepare("SELECT * FROM planning_repos WHERE id = ?").get(id) as unknown as PlanningRepoRow | undefined;
    return row ? toPlanningRepo(row) : null;
  }

  private requireRepo(db: DatabaseSync, id: number): PlanningRepo {
    const repo = this.findRepo(db, id);
    if (!repo) throw new PlanningRepoNotFoundError(`Repo ${id} is not in the planning data.`);
    return repo;
  }

  /** The planning repo at `repoPath`, created (with a free slug) if there is none yet. */
  private ensureRepo(db: DatabaseSync, repoPath: string, now: string): PlanningRepo {
    const existing = db.prepare("SELECT * FROM planning_repos WHERE path = ?").get(repoPath) as unknown as PlanningRepoRow | undefined;
    if (existing) return toPlanningRepo(existing);
    const taken = db.prepare("SELECT 1 FROM planning_repos WHERE slug = ?");
    let slug = "";
    for (const candidate of slugCandidates(repoPath)) {
      if (!taken.get(candidate)) {
        slug = candidate;
        break;
      }
    }
    const { lastInsertRowid } = db
      .prepare("INSERT INTO planning_repos (slug, path, created_at, updated_at) VALUES (?, ?, ?, ?)")
      .run(slug, repoPath, now, now);
    return this.requireRepo(db, Number(lastInsertRowid));
  }

  private requireProject(db: DatabaseSync, id: number): Project {
    const project = this.findProject(db, id);
    if (!project) throw new ProjectNotFoundError(`Project ${id} was not found.`);
    return project;
  }

  private findMilestone(db: DatabaseSync, id: number): Milestone | null {
    const row = db.prepare("SELECT * FROM milestones WHERE id = ?").get(id) as unknown as MilestoneRow | undefined;
    return row ? toMilestone(row) : null;
  }

  private requireMilestone(db: DatabaseSync, id: number): Milestone {
    const milestone = this.findMilestone(db, id);
    if (!milestone) throw new MilestoneNotFoundError(`Milestone ${id} was not found.`);
    return milestone;
  }

  private findEpic(db: DatabaseSync, id: number): Epic | null {
    const row = db.prepare("SELECT * FROM epics WHERE id = ?").get(id) as unknown as EpicRow | undefined;
    return row ? toEpic(row) : null;
  }

  private requireEpic(db: DatabaseSync, id: number): Epic {
    const epic = this.findEpic(db, id);
    if (!epic) throw new EpicNotFoundError(`Epic ${id} was not found.`);
    return epic;
  }

  private epicTitleTaken(error: unknown, title: string): unknown {
    return isUniqueViolation(error) ? new EpicTitleTakenError(`This project already has an epic named "${title}".`) : error;
  }

  private titleTaken(error: unknown, title: string): unknown {
    return isUniqueViolation(error)
      ? new MilestoneTitleTakenError(`This project already has a milestone named "${title}".`)
      : error;
  }

  private nameTaken(error: unknown, name: string): unknown {
    return isUniqueViolation(error) ? new ProjectNameTakenError(`A project named "${name}" already exists.`) : error;
  }
}
