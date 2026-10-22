import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "../errors.js";

type DatabaseSync = DatabaseSyncType;

export class PlanningSchemaError extends GitLibError {}

export interface Migration {
  /** 1-based and contiguous; stored in `PRAGMA user_version` once applied. */
  version: number;
  name: string;
  sql: string;
}

/**
 * Append-only. A migration that has shipped is never edited: fix a mistake with a new one, because
 * planning data cannot be rebuilt the way the scan database can.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "local issues",
    sql: `
      CREATE TABLE local_issues (
        id INTEGER PRIMARY KEY,
        repo_path TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (repo_path, number)
      );
      CREATE INDEX local_issues_by_state ON local_issues (state, updated_at DESC);
    `,
  },
  {
    version: 2,
    name: "issue status",
    sql: `
      ALTER TABLE local_issues ADD COLUMN status TEXT NOT NULL DEFAULT 'todo'
        CHECK (status IN ('todo', 'in_progress', 'in_review', 'done'));
      UPDATE local_issues SET status = 'done' WHERE state = 'closed';
      CREATE INDEX local_issues_by_status ON local_issues (status, updated_at DESC);
    `,
  },
];

export const LATEST_SCHEMA_VERSION = MIGRATIONS[MIGRATIONS.length - 1]!.version;

export function schemaVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  return Number(row.user_version);
}

/** Brings the database up to the newest migration, one transaction per migration. */
export function migrate(db: DatabaseSync, migrations: readonly Migration[] = MIGRATIONS): void {
  migrations.forEach((migration, index) => {
    if (migration.version !== index + 1) {
      throw new PlanningSchemaError(
        `Planning migrations must be numbered 1, 2, 3, … in order; found ${migration.version} at position ${index + 1}.`,
      );
    }
  });

  const latest = migrations.length;
  const current = schemaVersion(db);
  if (current > latest) {
    throw new PlanningSchemaError(
      `The planning database is at schema version ${current}, newer than this gitlib understands (${latest}). Upgrade gitlib rather than opening it with an older build.`,
    );
  }

  for (const migration of migrations.slice(current)) {
    // IMMEDIATE takes the write lock up front, so the CLI and the web app starting at the same time
    // cannot both apply the same migration; the loser re-checks the version once it has the lock.
    db.exec("BEGIN IMMEDIATE");
    try {
      if (schemaVersion(db) < migration.version) {
        db.exec(migration.sql);
        db.exec(`PRAGMA user_version = ${migration.version}`);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      const reason = error instanceof Error ? error.message : String(error);
      throw new PlanningSchemaError(
        `Planning migration ${migration.version} (${migration.name}) failed: ${reason}`,
        { cause: error },
      );
    }
  }
}
