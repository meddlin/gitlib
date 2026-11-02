import fs from "node:fs";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { GitLibError } from "../errors.js";
import type { DependabotReport } from "./check.js";
import { BUCKETS, type Bucket, type ClassifiedPr } from "./types.js";

// Loaded via getBuiltinModule for the same bundler reason as in ../store.ts.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

/** How long a connection waits on another process's write lock before giving up. */
const BUSY_TIMEOUT_MS = 5_000;
/** Older runs (and their findings) are deleted when a new one is saved. */
export const KEEP_RUNS = 60;

/** Tables live in `gitlib.db` next to the scan data: everything here can be fetched from GitHub again. */
const SCHEMA = `
  -- One row per check of GitHub. \`summary\` is the report without its pull requests.
  CREATE TABLE IF NOT EXISTS dependabot_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    finished_at TEXT NOT NULL,
    trigger TEXT NOT NULL,
    summary TEXT NOT NULL
  );

  -- The verdict for each pull request in a run. \`repo\` is the lowercased owner/repo; \`observed_at\` is when GitHub
  -- was actually asked, which is older than the run for a finding carried over from an earlier run.
  CREATE TABLE IF NOT EXISTS dependabot_findings (
    run_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    repo TEXT NOT NULL,
    number INTEGER NOT NULL,
    bucket TEXT NOT NULL,
    observed_at TEXT NOT NULL,
    payload TEXT NOT NULL,
    PRIMARY KEY (run_id, position),
    FOREIGN KEY (run_id) REFERENCES dependabot_runs(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS dependabot_findings_by_pr ON dependabot_findings (repo, number);

  -- At most one row: who is checking GitHub now, and when that claim lapses if they crashed.
  CREATE TABLE IF NOT EXISTS dependabot_lease (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    holder TEXT NOT NULL,
    taken_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );
`;

/** Who started a check. */
export type RunTrigger = "cli" | "web" | "schedule";

/** A classified PR plus when GitHub was last asked about it. */
export interface StoredFinding extends ClassifiedPr {
  observedAt: string;
}

export interface StoredReport extends Omit<DependabotReport, "items"> {
  items: StoredFinding[];
}

export interface StoredRun {
  id: number;
  trigger: RunTrigger;
  startedAt: string;
  finishedAt: string;
  report: StoredReport;
}

export interface Lease {
  holder: string;
  takenAt: string;
  expiresAt: string;
}

export type LeaseResult = { acquired: true } | { acquired: false; heldBy: Lease };

/** Another check is already talking to GitHub. */
export class DependabotBusyError extends GitLibError {}

interface RunRow {
  id: number;
  started_at: string;
  finished_at: string;
  trigger: RunTrigger;
  summary: string;
}

interface FindingRow {
  observed_at: string;
  payload: string;
}

const parseJson = (text: string): unknown => {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isStringArray = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

/** A stored finding, or null when the row is unreadable (written by something else, or damaged). */
function parseFinding(row: FindingRow): StoredFinding | null {
  const value = parseJson(row.payload);
  if (!isRecord(value) || !isRecord(value["pr"])) return null;
  const { pr, bucket, reasons, actions } = value;
  if (typeof pr["repo"] !== "string" || typeof pr["number"] !== "number") return null;
  if (!BUCKETS.includes(bucket as Bucket) || !isStringArray(reasons) || !isStringArray(actions)) return null;
  return { ...(value as unknown as ClassifiedPr), observedAt: row.observed_at };
}

const lowerRepo = (repo: string): string => repo.toLowerCase();

/** Dependabot runs and findings in `gitlib.db`. Timestamps are passed in by the caller, as with `Store`. */
export class DependabotStore {
  constructor(readonly dbPath: string) {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.withConnection((db) => db.exec(SCHEMA));
  }

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
      // IMMEDIATE takes the write lock up front, so two processes cannot both read-then-write the same state.
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

  /**
   * Saves a report as the newest run and deletes runs beyond `KEEP_RUNS`. A repository whose owner could not be
   * asked this time keeps the findings it had in the previous run, with their old `observedAt`, so one network
   * failure does not empty the page.
   */
  saveRun(report: DependabotReport, options: { trigger: RunTrigger; startedAt: string; finishedAt: string }): StoredRun {
    return this.transaction((db) => {
      const previous = this.latestRunRow(db);
      const failed = new Set(report.watched.filter((repo) => repo.status === "failed").map((repo) => lowerRepo(repo.slug)));

      const findings: StoredFinding[] = report.items.map((item) => ({ ...item, observedAt: report.checkedAt }));
      if (previous && failed.size > 0) {
        for (const row of this.findingRows(db, previous.id)) {
          const carried = parseFinding(row);
          if (carried && failed.has(lowerRepo(carried.pr.repo))) findings.push(carried);
        }
      }
      findings.sort(
        (a, b) =>
          BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || a.pr.repo.localeCompare(b.pr.repo) || a.pr.number - b.pr.number,
      );

      const { items: _items, ...summary } = report;
      const { lastInsertRowid } = db
        .prepare("INSERT INTO dependabot_runs (started_at, finished_at, trigger, summary) VALUES (?, ?, ?, ?)")
        .run(options.startedAt, options.finishedAt, options.trigger, JSON.stringify(summary));
      const runId = Number(lastInsertRowid);

      const insert = db.prepare(
        "INSERT INTO dependabot_findings (run_id, position, repo, number, bucket, observed_at, payload) VALUES (?, ?, ?, ?, ?, ?, ?)",
      );
      findings.forEach(({ observedAt, ...classified }, position) => {
        insert.run(runId, position, lowerRepo(classified.pr.repo), classified.pr.number, classified.bucket, observedAt, JSON.stringify(classified));
      });

      db.prepare("DELETE FROM dependabot_runs WHERE id NOT IN (SELECT id FROM dependabot_runs ORDER BY id DESC LIMIT ?)").run(KEEP_RUNS);
      return this.readRun(db, runId)!;
    });
  }

  /** The newest run, or null when nothing has been checked yet (or its summary cannot be read). */
  latestRun(): StoredRun | null {
    return this.withConnection((db) => {
      const row = this.latestRunRow(db);
      return row ? this.readRun(db, row.id) : null;
    });
  }

  /** How many runs are kept; for tests and the status line. */
  runCount(): number {
    return this.withConnection((db) => Number((db.prepare("SELECT COUNT(*) AS n FROM dependabot_runs").get() as { n: number }).n));
  }

  /**
   * Claims the right to talk to GitHub. A claim lapses after `ttlMs`, so a crashed holder cannot block checks
   * forever. Returns who holds it when it is taken.
   */
  acquireLease(holder: string, now: Date, ttlMs: number): LeaseResult {
    return this.transaction((db) => {
      const current = db.prepare("SELECT holder, taken_at, expires_at FROM dependabot_lease WHERE id = 1").get() as
        | { holder: string; taken_at: string; expires_at: string }
        | undefined;
      if (current && Date.parse(current.expires_at) > now.getTime()) {
        return { acquired: false, heldBy: { holder: current.holder, takenAt: current.taken_at, expiresAt: current.expires_at } };
      }
      db.prepare(
        `INSERT INTO dependabot_lease (id, holder, taken_at, expires_at) VALUES (1, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET holder = excluded.holder, taken_at = excluded.taken_at, expires_at = excluded.expires_at`,
      ).run(holder, now.toISOString(), new Date(now.getTime() + ttlMs).toISOString());
      return { acquired: true };
    });
  }

  /** Gives the claim back. Does nothing if it already lapsed and someone else took it. */
  releaseLease(holder: string): void {
    this.transaction((db) => void db.prepare("DELETE FROM dependabot_lease WHERE id = 1 AND holder = ?").run(holder));
  }

  /** The live claim, or null when nobody holds one or it has lapsed. */
  currentLease(now: Date): Lease | null {
    return this.withConnection((db) => {
      const row = db.prepare("SELECT holder, taken_at, expires_at FROM dependabot_lease WHERE id = 1").get() as
        | { holder: string; taken_at: string; expires_at: string }
        | undefined;
      return row && Date.parse(row.expires_at) > now.getTime()
        ? { holder: row.holder, takenAt: row.taken_at, expiresAt: row.expires_at }
        : null;
    });
  }

  private latestRunRow(db: DatabaseSync): RunRow | undefined {
    return db.prepare("SELECT * FROM dependabot_runs ORDER BY id DESC LIMIT 1").get() as unknown as RunRow | undefined;
  }

  private findingRows(db: DatabaseSync, runId: number): FindingRow[] {
    return db
      .prepare("SELECT observed_at, payload FROM dependabot_findings WHERE run_id = ? ORDER BY position")
      .all(runId) as unknown as FindingRow[];
  }

  private readRun(db: DatabaseSync, runId: number): StoredRun | null {
    const row = db.prepare("SELECT * FROM dependabot_runs WHERE id = ?").get(runId) as unknown as RunRow | undefined;
    const summary = row ? parseJson(row.summary) : null;
    if (!row || !isRecord(summary)) return null;
    const items = this.findingRows(db, runId).flatMap((finding) => parseFinding(finding) ?? []);
    return {
      id: Number(row.id),
      trigger: row.trigger,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      report: { ...(summary as unknown as Omit<StoredReport, "items">), items },
    };
  }
}
