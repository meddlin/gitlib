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
} from "./types.js";

// Loaded via getBuiltinModule for the same bundler reason as in store.ts.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/** How long a connection waits on another process's write lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;

export class LocalIssueNotFoundError extends GitLibError {}

interface LocalIssueRow {
  id: number;
  repo_path: string;
  number: number;
  title: string;
  body: string;
  state: LocalIssueState;
  status: IssueStatus;
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
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  closedAt: row.closed_at || null,
});

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
    const params: string[] = [];
    if (query.repoPath !== undefined) {
      conditions.push("repo_path = ?");
      params.push(query.repoPath);
    }
    if (query.state !== undefined) {
      conditions.push("state = ?");
      params.push(query.state);
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
}
