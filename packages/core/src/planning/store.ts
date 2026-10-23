import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "../errors.js";
import { MIGRATIONS, migrate, schemaVersion, type Migration } from "./migrations.js";
import type {
  IssueStatus,
  LocalIssue,
  LocalIssueChanges,
  LocalIssueQuery,
  LocalIssueState,
  NewLocalIssue,
  Project,
} from "./types.js";

// Loaded via getBuiltinModule for the same bundler reason as in store.ts.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/** How long a connection waits on another process's write lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

export class LocalIssueNotFoundError extends GitLibError {}
export class ProjectNotFoundError extends GitLibError {}
export class ProjectNameTakenError extends GitLibError {}

interface LocalIssueRow {
  id: number;
  repo_path: string;
  number: number;
  title: string;
  body: string;
  state: LocalIssueState;
  status: IssueStatus;
  project_id: number | null;
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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at || null,
});

interface ProjectRow {
  id: number;
  name: string;
  created_at: string;
  updated_at: string;
}

const toProject = (row: ProjectRow, repoPaths: string[]): Project => ({
  id: Number(row.id),
  name: row.name,
  repoPaths,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
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

  /** Files an issue under a project, or takes it out of its project with `null`. */
  setIssueProject(id: number, projectId: number | null, now: string): LocalIssue {
    return this.transaction((db) => {
      const current = this.requireIssue(db, id);
      if (projectId !== null) this.requireProject(db, projectId);
      if (current.projectId === projectId) return current;
      db.prepare("UPDATE local_issues SET project_id = ?, updated_at = ? WHERE id = ?").run(projectId, now, id);
      return this.requireIssue(db, id);
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
      return rows.map((row) => toProject(row, members.get(Number(row.id)) ?? []));
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
    return toProject(row, repos.map((repo) => repo.repo_path));
  }

  private requireProject(db: DatabaseSync, id: number): Project {
    const project = this.findProject(db, id);
    if (!project) throw new ProjectNotFoundError(`Project ${id} was not found.`);
    return project;
  }

  private nameTaken(error: unknown, name: string): unknown {
    return isUniqueViolation(error) ? new ProjectNameTakenError(`A project named "${name}" already exists.`) : error;
  }
}
