import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "./errors.js";
import { resolvePath } from "./fsutil.js";
import type { DiscoveredRepo, RepoRecord } from "./models.js";
import { sortTechnologies } from "./scanner.js";

// Loaded via getBuiltinModule instead of a static import: bundlers (tsup/esbuild) rewrite
// `node:sqlite` to `sqlite`, which does not exist because the module is prefix-only.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

export class RepoSelectorError extends GitLibError {}

export class RepoNotFoundError extends RepoSelectorError {}

export class AmbiguousRepoSelectorError extends RepoSelectorError {
  constructor(
    readonly selector: string,
    readonly matches: string[],
  ) {
    super(`Repository selector '${selector}' is ambiguous. Matches: ${matches.join(", ")}`);
  }
}

interface RepoRow {
  id: number;
  root_path: string;
  relative_path: string;
  absolute_path: string;
  name: string;
  last_seen_at: string;
  last_scanned_at: string | null;
  is_missing: number;
  is_worktree: number;
  notes: string;
  description: string;
  is_favorite: number;
}

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS repos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    root_path TEXT NOT NULL,
    relative_path TEXT NOT NULL,
    absolute_path TEXT NOT NULL,
    name TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    last_scanned_at TEXT,
    is_missing INTEGER NOT NULL DEFAULT 0,
    UNIQUE(root_path, relative_path)
  );

  CREATE TABLE IF NOT EXISTS repo_notes (
    repo_id INTEGER PRIMARY KEY,
    notes TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repo_descriptions (
    repo_id INTEGER PRIMARY KEY,
    description TEXT NOT NULL DEFAULT '',
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repo_favorites (
    repo_id INTEGER PRIMARY KEY,
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS repo_technologies (
    repo_id INTEGER NOT NULL,
    technology TEXT NOT NULL,
    PRIMARY KEY (repo_id, technology),
    FOREIGN KEY (repo_id) REFERENCES repos(id) ON DELETE CASCADE
  );
`;

export class Store {
  constructor(readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.withConnection((db) => {
      db.exec(SCHEMA);
      this.migrate(db);
    });
  }

  /** Brings databases created by older versions up to the current schema. */
  private migrate(db: DatabaseSync): void {
    const columns = db.prepare("PRAGMA table_info(repos)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "is_worktree")) {
      db.exec("ALTER TABLE repos ADD COLUMN is_worktree INTEGER NOT NULL DEFAULT 0");
    }
  }

  /** Opens a short-lived connection, mirroring the one-connection-per-operation Python store. */
  private withConnection<T>(operation: (db: DatabaseSync) => T): T {
    const db = new DatabaseSync(this.dbPath);
    try {
      db.exec("PRAGMA foreign_keys = ON");
      return operation(db);
    } finally {
      db.close();
    }
  }

  private transaction<T>(operation: (db: DatabaseSync) => T): T {
    return this.withConnection((db) => {
      db.exec("BEGIN");
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

  syncRepositories(
    discovered: Iterable<DiscoveredRepo>,
    scannedRoots: Iterable<string>,
    seenAt: string,
  ): Map<string, number> {
    const discoveredList = [...discovered];
    const scannedRootValues = [...scannedRoots].map(resolvePath);
    const keyOf = (rootPath: string, relativePath: string) => JSON.stringify([rootPath, relativePath]);
    const seenKeys = new Set(discoveredList.map((repo) => keyOf(repo.rootPath, repo.relativePath)));
    const repoIds = new Map<string, number>();

    this.transaction((db) => {
      const upsert = db.prepare(`
        INSERT INTO repos (root_path, relative_path, absolute_path, name, last_seen_at, is_missing, is_worktree)
        VALUES (?, ?, ?, ?, ?, 0, ?)
        ON CONFLICT(root_path, relative_path) DO UPDATE SET
          absolute_path = excluded.absolute_path,
          name = excluded.name,
          last_seen_at = excluded.last_seen_at,
          is_missing = 0,
          is_worktree = excluded.is_worktree
      `);
      const selectId = db.prepare("SELECT id FROM repos WHERE root_path = ? AND relative_path = ?");
      const ensureNotes = db.prepare("INSERT OR IGNORE INTO repo_notes(repo_id, notes) VALUES (?, '')");

      for (const repo of discoveredList) {
        upsert.run(
          repo.rootPath,
          repo.relativePath,
          repo.absolutePath,
          repo.name,
          seenAt,
          repo.isWorktree ? 1 : 0,
        );
        const row = selectId.get(repo.rootPath, repo.relativePath) as { id: number } | undefined;
        if (!row) continue;
        repoIds.set(keyOf(repo.rootPath, repo.relativePath), Number(row.id));
        ensureNotes.run(row.id);
      }

      if (scannedRootValues.length > 0) {
        const placeholders = scannedRootValues.map(() => "?").join(",");
        const rows = db
          .prepare(`SELECT id, root_path, relative_path FROM repos WHERE root_path IN (${placeholders})`)
          .all(...scannedRootValues) as Pick<RepoRow, "id" | "root_path" | "relative_path">[];
        const markMissing = db.prepare("UPDATE repos SET is_missing = 1 WHERE id = ?");
        for (const row of rows) {
          if (!seenKeys.has(keyOf(row.root_path, row.relative_path))) markMissing.run(row.id);
        }
      }
    });

    return repoIds;
  }

  replaceTechnologies(repoId: number, technologies: Iterable<string>, scannedAt: string): void {
    const ordered = sortTechnologies(technologies);
    this.transaction((db) => {
      db.prepare("DELETE FROM repo_technologies WHERE repo_id = ?").run(repoId);
      const insert = db.prepare("INSERT INTO repo_technologies(repo_id, technology) VALUES (?, ?)");
      for (const technology of ordered) insert.run(repoId, technology);
      db.prepare("UPDATE repos SET last_scanned_at = ? WHERE id = ?").run(scannedAt, repoId);
    });
  }

  listRepositories(includeMissing = false): RepoRecord[] {
    const { rows, technologyRows } = this.withConnection((db) => {
      let query = `
        SELECT
          repos.id,
          repos.root_path,
          repos.relative_path,
          repos.absolute_path,
          repos.name,
          repos.last_seen_at,
          repos.last_scanned_at,
          repos.is_missing,
          repos.is_worktree,
          COALESCE(repo_notes.notes, '') AS notes,
          COALESCE(repo_descriptions.description, '') AS description,
          repo_favorites.repo_id IS NOT NULL AS is_favorite
        FROM repos
        LEFT JOIN repo_notes ON repo_notes.repo_id = repos.id
        LEFT JOIN repo_descriptions ON repo_descriptions.repo_id = repos.id
        LEFT JOIN repo_favorites ON repo_favorites.repo_id = repos.id
      `;
      if (!includeMissing) query += " WHERE repos.is_missing = 0";
      query += " ORDER BY repos.relative_path";
      return {
        rows: db.prepare(query).all() as unknown as RepoRow[],
        technologyRows: db
          .prepare("SELECT repo_id, technology FROM repo_technologies ORDER BY technology")
          .all() as { repo_id: number; technology: string }[],
      };
    });

    const technologies = new Map<number, string[]>();
    for (const row of technologyRows) {
      const list = technologies.get(row.repo_id) ?? [];
      list.push(row.technology);
      technologies.set(row.repo_id, list);
    }

    return rows.map((row) => ({
      id: row.id,
      rootPath: row.root_path,
      relativePath: row.relative_path,
      absolutePath: row.absolute_path,
      name: row.name,
      lastSeenAt: row.last_seen_at,
      lastScannedAt: row.last_scanned_at || null,
      isMissing: Boolean(row.is_missing),
      isWorktree: Boolean(row.is_worktree),
      isFavorite: Boolean(row.is_favorite),
      technologies: sortTechnologies(technologies.get(row.id) ?? []),
      notes: row.notes,
      hasNotes: row.notes.trim().length > 0,
      description: row.description,
    }));
  }

  resolveRepository(selector: string): RepoRecord {
    let normalized = selector.trim().replace(/^\/+|\/+$/g, "");
    if (normalized.startsWith("./")) normalized = normalized.slice(2);
    const repositories = this.listRepositories(false);

    const exact = repositories.find((repo) => repo.relativePath === normalized);
    if (exact) return exact;

    const matches = repositories.filter((repo) => repo.name === normalized);
    if (matches.length === 1) return matches[0]!;
    if (matches.length > 1) {
      throw new AmbiguousRepoSelectorError(
        normalized,
        matches.map((repo) => repo.relativePath),
      );
    }

    throw new RepoNotFoundError(`Repository '${selector}' was not found.`);
  }

  updateDescription(repoId: number, description: string): void {
    this.transaction((db) => {
      db.prepare(
        `INSERT INTO repo_descriptions(repo_id, description) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET description = excluded.description`,
      ).run(repoId, description);
    });
  }

  updateFavorite(repoId: number, favorite: boolean): void {
    this.transaction((db) => {
      if (favorite) db.prepare("INSERT OR IGNORE INTO repo_favorites(repo_id) VALUES (?)").run(repoId);
      else db.prepare("DELETE FROM repo_favorites WHERE repo_id = ?").run(repoId);
    });
  }

  updateNotes(repoId: number, notes: string): void {
    this.transaction((db) => {
      db.prepare(
        `INSERT INTO repo_notes(repo_id, notes) VALUES (?, ?)
         ON CONFLICT(repo_id) DO UPDATE SET notes = excluded.notes`,
      ).run(repoId, notes);
    });
  }
}
