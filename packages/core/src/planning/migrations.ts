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
  {
    version: 3,
    name: "projects",
    sql: `
      CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL COLLATE NOCASE UNIQUE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE project_repos (
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        repo_path TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repo_path)
      );
      CREATE INDEX project_repos_by_repo ON project_repos (repo_path);
      ALTER TABLE local_issues ADD COLUMN project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL;
      CREATE INDEX local_issues_by_project ON local_issues (project_id);
    `,
  },
  {
    version: 4,
    name: "dependabot dismissals",
    sql: `
      -- A Dependabot PR the user has put aside. The findings themselves are derived from GitHub and live in
      -- gitlib.db; this is the user's decision, which cannot be derived. repo is the lowercased owner/repo.
      CREATE TABLE dependabot_dismissals (
        repo TEXT NOT NULL,
        number INTEGER NOT NULL,
        snoozed_until TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (repo, number)
      );
    `,
  },
  {
    version: 5,
    name: "dependabot schedule",
    sql: `
      -- When the web server should check Dependabot on its own. One row, written by the user from the page.
      -- days is a comma-separated list of weekdays (0 = Sunday); time is HH:MM in the server's time zone.
      CREATE TABLE dependabot_schedule (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL,
        days TEXT NOT NULL,
        time TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `,
  },
  {
    version: 6,
    name: "milestones",
    sql: `
      -- A milestone belongs to one project; deleting the project deletes its milestones. due_date is a
      -- calendar date (YYYY-MM-DD) with no time zone, or NULL.
      CREATE TABLE milestones (
        id INTEGER PRIMARY KEY,
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        title TEXT NOT NULL COLLATE NOCASE,
        description TEXT NOT NULL DEFAULT '',
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, title)
      );
      -- Deleting a milestone takes its issues out of it; the issues stay.
      ALTER TABLE local_issues ADD COLUMN milestone_id INTEGER REFERENCES milestones (id) ON DELETE SET NULL;
      CREATE INDEX local_issues_by_milestone ON local_issues (milestone_id);
    `,
  },
  {
    version: 7,
    name: "planning repos",
    sql: `
      -- A repository as planning data knows it. id never changes, so issues and projects keep pointing at the
      -- repo when it moves; path is its relativePath where gitlib last found it; slug is the short name issues
      -- are shown under (slug#3). root_commit is the repo's first commit, used to recognize it after a move.
      CREATE TABLE planning_repos (
        id INTEGER PRIMARY KEY,
        slug TEXT NOT NULL COLLATE NOCASE UNIQUE,
        path TEXT NOT NULL UNIQUE,
        root_commit TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      -- One row per path already in use. The slug is the path's last segment, or the whole path when two
      -- paths end the same way; a path that still collides (paths differing only in case) gets a suffix.
      CREATE TEMP TABLE used_paths AS
        WITH used (path, first_at) AS (
          SELECT repo_path, created_at FROM local_issues
          UNION ALL
          SELECT repo_path, added_at FROM project_repos
        ),
        paths AS (SELECT path, MIN(first_at) AS first_at FROM used GROUP BY path)
        SELECT path, first_at, substr(path, length(rtrim(path, replace(path, '/', ''))) + 1) AS base FROM paths;
      INSERT OR IGNORE INTO planning_repos (slug, path, created_at, updated_at)
        SELECT
          CASE
            WHEN base = '' OR (SELECT COUNT(*) FROM used_paths other WHERE other.base = used_paths.base COLLATE NOCASE) > 1
            THEN path ELSE base
          END,
          path, first_at, first_at
        FROM used_paths ORDER BY first_at, path;
      INSERT INTO planning_repos (slug, path, created_at, updated_at)
        SELECT path || '-' || ((SELECT COUNT(*) FROM planning_repos) + ROW_NUMBER() OVER (ORDER BY path)), path, first_at, first_at
        FROM used_paths WHERE path NOT IN (SELECT path FROM planning_repos);
      DROP TABLE used_paths;

      -- Issues point at the planning repo instead of a path. RESTRICT: a repo with issues cannot be deleted.
      CREATE TABLE local_issues_v7 (
        id INTEGER PRIMARY KEY,
        repo_id INTEGER NOT NULL REFERENCES planning_repos (id) ON DELETE RESTRICT,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL DEFAULT '',
        state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
        status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done')),
        project_id INTEGER REFERENCES projects (id) ON DELETE SET NULL,
        milestone_id INTEGER REFERENCES milestones (id) ON DELETE SET NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        UNIQUE (repo_id, number)
      );
      INSERT INTO local_issues_v7
        (id, repo_id, number, title, body, state, status, project_id, milestone_id, created_at, updated_at, closed_at)
        SELECT issue.id, repo.id, issue.number, issue.title, issue.body, issue.state, issue.status, issue.project_id,
               issue.milestone_id, issue.created_at, issue.updated_at, issue.closed_at
        FROM local_issues issue JOIN planning_repos repo ON repo.path = issue.repo_path;
      DROP TABLE local_issues;
      ALTER TABLE local_issues_v7 RENAME TO local_issues;
      CREATE INDEX local_issues_by_state ON local_issues (state, updated_at DESC);
      CREATE INDEX local_issues_by_status ON local_issues (status, updated_at DESC);
      CREATE INDEX local_issues_by_project ON local_issues (project_id);
      CREATE INDEX local_issues_by_milestone ON local_issues (milestone_id);

      CREATE TABLE project_repos_v7 (
        project_id INTEGER NOT NULL REFERENCES projects (id) ON DELETE CASCADE,
        repo_id INTEGER NOT NULL REFERENCES planning_repos (id) ON DELETE RESTRICT,
        added_at TEXT NOT NULL,
        PRIMARY KEY (project_id, repo_id)
      );
      INSERT INTO project_repos_v7 (project_id, repo_id, added_at)
        SELECT member.project_id, repo.id, member.added_at
        FROM project_repos member JOIN planning_repos repo ON repo.path = member.repo_path;
      DROP TABLE project_repos;
      ALTER TABLE project_repos_v7 RENAME TO project_repos;
      CREATE INDEX project_repos_by_repo ON project_repos (repo_id);
    `,
  },
  {
    version: 8,
    name: "archiving",
    sql: `
      -- When the user put it away, or NULL while it is in use. Archiving hides without deleting: an archived
      -- repo or project hides its issues from the default lists, an archived milestone hides only itself, and
      -- an archived membership is a repo taken out of a project whose issues stay filed under the project.
      -- Everything archived can be restored.
      ALTER TABLE planning_repos ADD COLUMN archived_at TEXT;
      ALTER TABLE project_repos ADD COLUMN archived_at TEXT;
      ALTER TABLE projects ADD COLUMN archived_at TEXT;
      ALTER TABLE milestones ADD COLUMN archived_at TEXT;
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
