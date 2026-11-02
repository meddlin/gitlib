import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import { getAppHome, type Env } from "./config.js";
import { GitLibError } from "./errors.js";
import { expandUser } from "./fsutil.js";
import { LATEST_SCHEMA_VERSION, schemaVersion } from "./planning/migrations.js";

// Loaded via getBuiltinModule for the same bundler reason as in store.ts.
const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
type DatabaseSync = DatabaseSyncType;

export class BackupError extends GitLibError {}

/** Bumped only for an incompatible change to the archive layout; restore refuses newer formats. */
export const BACKUP_FORMAT_VERSION = 1;

const MANIFEST_FILE = "manifest.json";
const CONFIG_FILE = "config.toml";
/** Both hold user data: `gitlib.db` has notes, descriptions and favorites next to the rebuildable scan tables. */
const DATABASE_FILES = ["gitlib.db", "planning.db"] as const;
/** Everything a backup captures. The search index is derived (`gitlib reindex`) and is not included. */
export const BACKUP_DATA_FILES: readonly string[] = [CONFIG_FILE, ...DATABASE_FILES];

const ARCHIVE_MEMBERS: ReadonlySet<string> = new Set([MANIFEST_FILE, ...BACKUP_DATA_FILES]);
const ARCHIVE_NAME = /^gitlib-backup-\d{8}T\d{6}Z\.tar\.gz$/;

export interface BackupFileEntry {
  name: string;
  bytes: number;
  sha256: string;
}

export interface BackupManifest {
  format: number;
  createdAt: string;
  /** Free-form producer, e.g. `gitlib 0.1.0`. */
  createdBy: string | null;
  hostname: string;
  /** Where the data lived when it was backed up; informational only. */
  appHome: string;
  /** `PRAGMA user_version` of the planning database, or null when it was not captured. */
  planningSchemaVersion: number | null;
  files: BackupFileEntry[];
  /** Row counts, so a restore can be eyeballed: `{ issues: 12, projects: 3, notes: 5, … }`. */
  summary: Record<string, number>;
}

export interface BackupOptions {
  /** Back up whichever data files exist instead of requiring all of them (used for the pre-restore safety copy). */
  partial?: boolean;
  createdBy?: string;
  now?: Date;
}

export interface BackupResult {
  path: string;
  bytes: number;
  manifest: BackupManifest;
}

export interface RestoreOptions {
  /** Where the safety copy of the data being replaced goes; default `<app home>/backups` (see `getBackupDir`). */
  safetyDir?: string;
  now?: Date;
}

export interface RestoreResult {
  manifest: BackupManifest;
  /** The archive holding what was there before, or null when the target was empty. */
  safetyBackup: string | null;
  restored: string[];
}

/** Where `gitlib backup create` writes and `restore` saves what it replaces: `GITLIB_BACKUP_DIR`, else `<app home>/backups`. */
export function getBackupDir(env: Env = process.env): string {
  const configured = env["GITLIB_BACKUP_DIR"];
  return configured ? path.resolve(expandUser(configured)) : path.join(getAppHome(env), "backups");
}

/** `gitlib-backup-20261102T031500Z.tar.gz`; the stamp sorts lexicographically, which `pruneBackups` relies on. */
export function backupFileName(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
  return `gitlib-backup-${stamp}.tar.gz`;
}

function sha256(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

function tar(args: string[], what: string): string {
  // COPYFILE_DISABLE stops macOS tar from adding `._*` AppleDouble members.
  const result = spawnSync("tar", args, { encoding: "utf-8", env: { ...process.env, COPYFILE_DISABLE: "1" } });
  if (result.error) throw new BackupError(`Could not run tar to ${what}: ${result.error.message}`, { cause: result.error });
  if (result.status !== 0) throw new BackupError(`tar failed to ${what}: ${(result.stderr || result.stdout).trim()}`);
  return result.stdout;
}

function withDatabase<T>(file: string, operation: (db: DatabaseSync) => T): T {
  const db = new DatabaseSync(file, { timeout: 5_000 });
  try {
    return operation(db);
  } finally {
    db.close();
  }
}

/** A consistent copy that is safe to take while the web app is using the database. */
function snapshotDatabase(source: string, destination: string): void {
  withDatabase(source, (db) => db.prepare("VACUUM INTO ?").run(destination));
}

function count(db: DatabaseSync, sql: string): number | undefined {
  try {
    return Number((db.prepare(sql).get() as { n: number }).n);
  } catch {
    return undefined; // table missing: an older or empty database
  }
}

function summarize(dir: string, present: ReadonlySet<string>): { summary: Record<string, number>; planningVersion: number | null } {
  const summary: Record<string, number> = {};
  const add = (key: string, value: number | undefined) => {
    if (value !== undefined) summary[key] = value;
  };
  let planningVersion: number | null = null;

  if (present.has("gitlib.db")) {
    withDatabase(path.join(dir, "gitlib.db"), (db) => {
      add("repos", count(db, "SELECT COUNT(*) AS n FROM repos WHERE is_missing = 0"));
      add("notes", count(db, "SELECT COUNT(*) AS n FROM repo_notes WHERE notes <> ''"));
      add("descriptions", count(db, "SELECT COUNT(*) AS n FROM repo_descriptions WHERE description <> ''"));
      add("favorites", count(db, "SELECT COUNT(*) AS n FROM repo_favorites"));
    });
  }
  if (present.has("planning.db")) {
    withDatabase(path.join(dir, "planning.db"), (db) => {
      planningVersion = schemaVersion(db);
      add("issues", count(db, "SELECT COUNT(*) AS n FROM local_issues"));
      add("projects", count(db, "SELECT COUNT(*) AS n FROM projects"));
    });
  }
  return { summary, planningVersion };
}

/**
 * Writes a verified `.tar.gz` of gitlib's user data (`config.toml`, `gitlib.db`, `planning.db`) plus a
 * `manifest.json` with checksums and row counts. The databases are snapshotted with SQLite's
 * `VACUUM INTO`, so this is safe while the web app is running. The finished archive is verified before it
 * is moved into place. Never overwrites an existing file.
 */
export function createBackup(appHome: string, destination: string, options: BackupOptions = {}): BackupResult {
  const target = path.resolve(destination);
  if (fs.existsSync(target)) throw new BackupError(`Cannot back up to ${target}: the file already exists.`);

  const present = BACKUP_DATA_FILES.filter((name) => fs.existsSync(path.join(appHome, name)));
  const missing = BACKUP_DATA_FILES.filter((name) => !present.includes(name));
  if (present.length === 0 || (missing.length > 0 && !options.partial)) {
    throw new BackupError(
      `Nothing to back up in ${appHome}: missing ${missing.join(", ")}. Is GITLIB_HOME pointing at the right place?`,
    );
  }

  const staging = fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-backup-"));
  const partialArchive = `${target}.partial`;
  try {
    for (const name of present) {
      const source = path.join(appHome, name);
      const staged = path.join(staging, name);
      if ((DATABASE_FILES as readonly string[]).includes(name)) snapshotDatabase(source, staged);
      else fs.copyFileSync(source, staged);
    }

    const { summary, planningVersion } = summarize(staging, new Set(present));
    const manifest: BackupManifest = {
      format: BACKUP_FORMAT_VERSION,
      createdAt: (options.now ?? new Date()).toISOString(),
      createdBy: options.createdBy ?? null,
      hostname: os.hostname(),
      appHome,
      planningSchemaVersion: planningVersion,
      files: present.map((name) => {
        const file = path.join(staging, name);
        return { name, bytes: fs.statSync(file).size, sha256: sha256(file) };
      }),
      summary,
    };
    fs.writeFileSync(path.join(staging, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, "utf-8");

    fs.mkdirSync(path.dirname(target), { recursive: true });
    tar(["-czf", partialArchive, "-C", staging, MANIFEST_FILE, ...present], "create the archive");
    fs.chmodSync(partialArchive, 0o600); // it holds notes and config
    // Read the archive back before reporting success: a backup nobody has opened is only a hope.
    openBackup(partialArchive, { checkSchema: false }).cleanup();
    fs.renameSync(partialArchive, target);
    return { path: target, bytes: fs.statSync(target).size, manifest };
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    fs.rmSync(partialArchive, { force: true });
  }
}

interface OpenedBackup {
  dir: string;
  manifest: BackupManifest;
  cleanup(): void;
}

function parseManifest(file: string): BackupManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf-8"));
  } catch (error) {
    throw new BackupError(`The backup's manifest.json is not valid JSON: ${error instanceof Error ? error.message : error}`);
  }
  const manifest = raw as Partial<BackupManifest> | null;
  if (!manifest || typeof manifest !== "object" || typeof manifest.format !== "number" || !Array.isArray(manifest.files)) {
    throw new BackupError("The backup's manifest.json is malformed.");
  }
  if (manifest.format > BACKUP_FORMAT_VERSION) {
    throw new BackupError(
      `This backup uses format ${manifest.format}, newer than this gitlib understands (${BACKUP_FORMAT_VERSION}). Upgrade gitlib first.`,
    );
  }
  for (const entry of manifest.files) {
    const known = entry && typeof entry.name === "string" && BACKUP_DATA_FILES.includes(entry.name);
    if (!known || typeof entry.sha256 !== "string" || typeof entry.bytes !== "number") {
      throw new BackupError(`The backup's manifest lists an unexpected file: ${JSON.stringify(entry?.name ?? entry)}.`);
    }
  }
  return manifest as BackupManifest;
}

/** Unpacks into a private temp directory and checks everything before anyone relies on it. */
function openBackup(archive: string, { checkSchema = true } = {}): OpenedBackup {
  const archivePath = path.resolve(archive);
  if (!fs.existsSync(archivePath) || !fs.statSync(archivePath).isFile()) {
    throw new BackupError(`Backup archive not found: ${archivePath}`);
  }

  // Check the member list before extracting anything, so a crafted archive cannot write elsewhere.
  const members = tar(["-tzf", archivePath], "read the archive")
    .split("\n")
    .map((line) => line.trim().replace(/^\.\//, ""))
    .filter((line) => line !== "" && line !== ".");
  const unexpected = members.filter((member) => !ARCHIVE_MEMBERS.has(member));
  if (unexpected.length > 0) throw new BackupError(`The archive contains unexpected entries: ${unexpected.join(", ")}.`);
  if (!members.includes(MANIFEST_FILE)) throw new BackupError("This is not a gitlib backup: manifest.json is missing.");

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-restore-"));
  const cleanup = () => fs.rmSync(dir, { recursive: true, force: true });
  try {
    tar(["-xzf", archivePath, "-C", dir], "extract the archive");
    for (const member of members) {
      if (!fs.lstatSync(path.join(dir, member)).isFile()) throw new BackupError(`Archive entry ${member} is not a regular file.`);
    }

    const manifest = parseManifest(path.join(dir, MANIFEST_FILE));
    const listed = new Set(manifest.files.map((entry) => entry.name));
    const stray = members.filter((member) => member !== MANIFEST_FILE && !listed.has(member));
    if (stray.length > 0) throw new BackupError(`The archive holds files its manifest does not list: ${stray.join(", ")}.`);

    for (const entry of manifest.files) {
      const file = path.join(dir, entry.name);
      if (!fs.existsSync(file)) throw new BackupError(`The archive is missing ${entry.name}.`);
      if (fs.statSync(file).size !== entry.bytes || sha256(file) !== entry.sha256) {
        throw new BackupError(`${entry.name} does not match its checksum; the archive is corrupt or was modified.`);
      }
      if ((DATABASE_FILES as readonly string[]).includes(entry.name)) {
        const result = withDatabase(file, (db) => (db.prepare("PRAGMA integrity_check").get() as { integrity_check: string }).integrity_check);
        if (result !== "ok") throw new BackupError(`${entry.name} failed SQLite's integrity check: ${result}`);
      }
    }

    // Creating a backup must work for data this build cannot restore (say, before a downgrade); restoring must not.
    const planningVersion = checkSchema && listed.has("planning.db") ? withDatabase(path.join(dir, "planning.db"), schemaVersion) : null;
    if (planningVersion !== null && planningVersion > LATEST_SCHEMA_VERSION) {
      throw new BackupError(
        `planning.db is at schema version ${planningVersion}, newer than this gitlib understands (${LATEST_SCHEMA_VERSION}). Upgrade gitlib before restoring this backup.`,
      );
    }
    return { dir, manifest, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

/** Fully checks an archive (member list, checksums, SQLite integrity, schema version) without touching any data. */
export function verifyBackup(archive: string): BackupManifest {
  const opened = openBackup(archive);
  opened.cleanup();
  return opened.manifest;
}

/**
 * Replaces the data in `appHome` with the contents of `archive`. The archive is fully verified first,
 * and whatever was there is saved to a `pre-restore-*.tar.gz` safety copy, so a restore can be undone.
 * Stop the web app first: it may hold the databases open while they are swapped.
 */
export function restoreBackup(archive: string, appHome: string, options: RestoreOptions = {}): RestoreResult {
  const opened = openBackup(archive);
  try {
    const now = options.now ?? new Date();
    let safetyBackup: string | null = null;

    if (BACKUP_DATA_FILES.some((name) => fs.existsSync(path.join(appHome, name)))) {
      const safetyDir = options.safetyDir ?? path.join(appHome, "backups");
      const name = backupFileName(now).replace(/^gitlib-backup-/, "pre-restore-");
      try {
        safetyBackup = createBackup(appHome, path.join(safetyDir, name), { partial: true, now, createdBy: "gitlib restore" }).path;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        throw new BackupError(
          `Could not save the existing data before restoring (${reason}). Nothing was changed; move the files in ${appHome} aside by hand if you want to restore over them anyway.`,
          { cause: error },
        );
      }
    }

    fs.mkdirSync(appHome, { recursive: true });
    const restored: string[] = [];
    for (const { name } of opened.manifest.files) {
      const staged = path.join(appHome, `.${name}.restoring`);
      fs.copyFileSync(path.join(opened.dir, name), staged);
      if ((DATABASE_FILES as readonly string[]).includes(name)) {
        // A leftover journal from the old database must never be replayed into the new one.
        for (const suffix of ["-wal", "-shm", "-journal"]) fs.rmSync(path.join(appHome, `${name}${suffix}`), { force: true });
      }
      fs.renameSync(staged, path.join(appHome, name));
      restored.push(name);
    }
    return { manifest: opened.manifest, safetyBackup, restored };
  } finally {
    opened.cleanup();
  }
}

/** Deletes all but the newest `keep` archives named by `backupFileName` in `directory`; returns what it removed. */
export function pruneBackups(directory: string, keep: number): string[] {
  if (!fs.existsSync(directory)) return [];
  const archives = fs.readdirSync(directory).filter((name) => ARCHIVE_NAME.test(name)).sort();
  const doomed = archives.slice(0, Math.max(0, archives.length - keep)).map((name) => path.join(directory, name));
  for (const file of doomed) fs.rmSync(file);
  return doomed;
}
