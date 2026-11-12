import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "../errors.js";
import { MIGRATIONS, migrate, schemaVersion, type Migration } from "./migrations.js";
import type {
  DependabotDismissal,
  DependabotSchedule,
  StoredDependabotSchedule,
  IssueStatus,
  LocalIssue,
  LocalIssueChanges,
  LocalIssueQuery,
  LocalIssueState,
  Milestone,
  MilestoneChanges,
  NewLocalIssue,
  Project,
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

interface LocalIssueRow {
  id: number;
  repo_path: string;
  number: number;
  title: string;
  body: string;
  state: LocalIssueState;
  status: IssueStatus;
  project_id: number | null;
  milestone_id: number | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

const toLocalIssue = (row: LocalIssueRow): LocalIssue => ({
  id: Number(row.id),
  repoPath: row.repo_path,
  number: Number(row.number),
  title: row.title,
  body: row.body,
  state: row.state,
  status: row.status,
  projectId: row.project_id === null || row.project_id === undefined ? null : Number(row.project_id),
  milestoneId: row.milestone_id === null || row.milestone_id === undefined ? null : Number(row.milestone_id),
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at || null,
});

interface MilestoneRow {
  id: number;
  project_id: number;
  title: string;
  description: string;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

const toMilestone = (row: MilestoneRow): Milestone => ({
  id: Number(row.id),
  projectId: Number(row.project_id),
  title: row.title,
  description: row.description,
  dueDate: row.due_date || null,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

interface ProjectRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

const toProject = (row: ProjectRow, repoPaths: string[], remotes: ProjectRemote[]): Project => ({
  id: Number(row.id),
  name: row.name,
  repoPaths,
  remotes,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

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

  createIssue(input: NewLocalIssue, now: string): LocalIssue {
    return this.transaction((db) => {
      const { lastInsertRowid } = db
        .prepare(
          `INSERT INTO local_issues (repo_path, number, title, body, state, created_at, updated_at)
           VALUES (?, (SELECT COALESCE(MAX(number), 0) + 1 FROM local_issues WHERE repo_path = ?), ?, ?, 'open', ?, ?)`,
        )
        .run(input.repoPath, input.repoPath, input.title, input.body, now, now);
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
      conditions.push("repo_path = ?");
      params.push(query.repoPath);
    }
    if (query.state !== undefined) {
      conditions.push("state = ?");
      params.push(query.state);
    }
    if (query.projectId !== undefined) {
      conditions.push("project_id = ?");
      params.push(query.projectId);
    }
    if (query.milestoneId !== undefined) {
      conditions.push("milestone_id = ?");
      params.push(query.milestoneId);
    }
    const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

    return this.withConnection((db) => {
      const rows = db
        .prepare(`SELECT * FROM local_issues ${where} ORDER BY updated_at DESC, id DESC`)
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
   * Files an issue under a project, or takes it out of its project with `null`. A milestone belongs to
   * one project, so changing the project takes the issue out of its milestone.
   */
  setIssueProject(id: number, projectId: number | null, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (projectId !== null) this.requireProject(db, projectId);
      if (current.projectId === projectId) return current;
      db.prepare("UPDATE local_issues SET project_id = ?, milestone_id = NULL, updated_at = ? WHERE id = ?").run(
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

  createMilestone(projectId: number, input: { title: string; description: string; dueDate: string | null }, now: string): Milestone {
    return this.transaction((db) => {
      this.requireProject(db, projectId);
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

  /** Soonest due date first, then milestones with no due date; ties by title. */
  listMilestones(projectId?: number): Milestone[] {
    return this.withConnection((db) => {
      const where = projectId === undefined ? "" : "WHERE project_id = ?";
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

  /** By name, A to Z. */
  listProjects(): Project[] {
    return this.withConnection((db) => {
      const rows = db.prepare("SELECT * FROM projects ORDER BY name").all() as unknown as ProjectRow[];
      const members = new Map<number, string[]>();
      const memberRows = db
        .prepare("SELECT project_id, repo_path FROM project_repos ORDER BY repo_path")
        .all() as unknown as { project_id: number; repo_path: string }[];
      for (const { project_id, repo_path } of memberRows) {
        const list = members.get(Number(project_id)) ?? [];
        list.push(repo_path);
        members.set(Number(project_id), list);
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

  addRepoToProject(id: number, repoPath: string, now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      const { changes } = db
        .prepare("INSERT OR IGNORE INTO project_repos (project_id, repo_path, added_at) VALUES (?, ?, ?)")
        .run(id, repoPath, now);
      if (Number(changes) > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

  /** Adds several clones and hosted repos in one step; any already there are skipped. */
  addReposToProject(id: number, repoPaths: readonly string[], remotes: readonly ProjectRemote[], now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      let changed = 0;
      const insertRepo = db.prepare("INSERT OR IGNORE INTO project_repos (project_id, repo_path, added_at) VALUES (?, ?, ?)");
      for (const repoPath of repoPaths) changed += Number(insertRepo.run(id, repoPath, now).changes);
      const insertRemote = db.prepare(
        "INSERT OR IGNORE INTO project_remotes (project_id, provider, full_name, added_at) VALUES (?, ?, ?, ?)",
      );
      for (const remote of remotes) changed += Number(insertRemote.run(id, remote.provider, remote.fullName, now).changes);
      if (changed > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
    });
  }

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

  removeRepoFromProject(id: number, repoPath: string, now: string): Project {
    return this.transaction((db) => {
      this.requireProject(db, id);
      const { changes } = db
        .prepare("DELETE FROM project_repos WHERE project_id = ? AND repo_path = ?")
        .run(id, repoPath);
      if (Number(changes) > 0) db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(now, id);
      return this.requireProject(db, id);
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
    const row = db.prepare("SELECT * FROM local_issues WHERE id = ?").get(id) as unknown as
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
    const repos = db
      .prepare("SELECT repo_path FROM project_repos WHERE project_id = ? ORDER BY repo_path")
      .all(id) as unknown as { repo_path: string }[];
    const remotes = db
      .prepare("SELECT project_id, provider, full_name FROM project_remotes WHERE project_id = ? ORDER BY provider, full_name")
      .all(id) as unknown as RemoteRow[];
    return toProject(
      row,
      repos.map((repo) => repo.repo_path),
      remotes.map(toRemote),
    );
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

  private titleTaken(error: unknown, title: string): unknown {
    return isUniqueViolation(error)
      ? new MilestoneTitleTakenError(`This project already has a milestone named "${title}".`)
      : error;
  }

  private nameTaken(error: unknown, name: string): unknown {
    return isUniqueViolation(error) ? new ProjectNameTakenError(`A project named "${name}" already exists.`) : error;
  }
}
