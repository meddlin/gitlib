import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupError,
  backupFileName,
  createApplication,
  createBackup,
  pruneBackups,
  restoreBackup,
  verifyBackup,
} from "../src/index.js";
import { Fixture } from "./fixture.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
  fx.writeConfig();
});
afterEach(() => fx.cleanup());

/** Populates fx.appHome the way real use does: a scanned repo with notes, plus planning data. */
function seed(): void {
  fx.makeRepo("tomato-planner", { "package.json": "{}" });
  const app = createApplication({ GITLIB_HOME: fx.appHome });
  app.refresh();
  app.saveRepositoryNotes("tomato-planner", "water on Tuesdays");
  app.saveRepositoryDescription("tomato-planner", "Garden planning");
  app.saveRepositoryFavorite("tomato-planner", true);
  const project = app.createProject("Garden");
  const issue = app.createLocalIssue("tomato-planner", { title: "Add frost warnings", body: "see forecast" });
  app.setLocalIssueProject(issue.id, project.id);
}

const archivePath = (name = backupFileName()) => path.join(fx.base, "out", name);

/** Rewrites one member of an archive without updating the manifest, simulating tampering. */
function tamper(archive: string, member: string, contents: Buffer): string {
  const dir = fs.mkdtempSync(path.join(fx.base, "tamper-"));
  execFileSync("tar", ["-xzf", archive, "-C", dir]);
  fs.writeFileSync(path.join(dir, member), contents);
  const out = path.join(fx.base, "tampered.tar.gz");
  execFileSync("tar", ["-czf", out, "-C", dir, ...fs.readdirSync(dir)]);
  return out;
}

describe("createBackup", () => {
  it("archives config and both databases with a manifest of checksums and counts", () => {
    seed();
    const result = createBackup(fx.appHome, archivePath());

    expect(result.manifest.files.map((file) => file.name).sort()).toEqual(["config.toml", "gitlib.db", "planning.db"]);
    expect(result.manifest.summary).toMatchObject({ repos: 1, notes: 1, descriptions: 1, favorites: 1, issues: 1, projects: 1 });
    expect(result.manifest.planningSchemaVersion).toBeGreaterThanOrEqual(3);
    expect(fs.statSync(result.path).mode & 0o077).toBe(0); // private: it contains notes and config
    expect(verifyBackup(result.path).summary).toEqual(result.manifest.summary);
  });

  it("refuses to overwrite an existing archive", () => {
    seed();
    const target = archivePath();
    createBackup(fx.appHome, target);
    expect(() => createBackup(fx.appHome, target)).toThrow(/already exists/);
  });

  it("refuses when the app home has no data, which usually means GITLIB_HOME is wrong", () => {
    fs.rmSync(fx.appHome, { recursive: true });
    expect(() => createBackup(fx.appHome, archivePath())).toThrow(/Nothing to back up/);
  });

  it("leaves no staging files or half-written archives behind on failure", () => {
    seed();
    fs.rmSync(path.join(fx.appHome, "planning.db"));
    expect(() => createBackup(fx.appHome, archivePath())).toThrow(BackupError);
    expect(fs.existsSync(path.join(fx.base, "out"))).toBe(false);
  });
});

describe("restoreBackup", () => {
  it("carries all user data to a fresh app home", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());

    const target = path.join(fx.base, "prod-home");
    const result = restoreBackup(archive, target);
    expect(result.safetyBackup).toBeNull();
    expect(result.restored.sort()).toEqual(["config.toml", "gitlib.db", "planning.db"]);

    const app = createApplication({ GITLIB_HOME: target });
    const repo = app.loadRepositories().find((candidate) => candidate.relativePath === "tomato-planner")!;
    expect(repo).toMatchObject({ notes: "water on Tuesdays", description: "Garden planning", isFavorite: true });
    expect(app.listLocalIssues().map((issue) => issue.title)).toEqual(["Add frost warnings"]);
    expect(app.listProjects().map((project) => project.name)).toEqual(["Garden"]);
  });

  it("saves what it replaces to a pre-restore archive that can undo the restore", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());

    createApplication({ GITLIB_HOME: fx.appHome }).createProject("Added after the backup");
    const result = restoreBackup(archive, fx.appHome);

    expect(result.safetyBackup).toMatch(/pre-restore-\d{8}T\d{6}Z\.tar\.gz$/);
    expect(createApplication({ GITLIB_HOME: fx.appHome }).listProjects().map((p) => p.name)).toEqual(["Garden"]);

    restoreBackup(result.safetyBackup!, fx.appHome, { now: new Date(Date.now() + 5_000) });
    expect(
      createApplication({ GITLIB_HOME: fx.appHome })
        .listProjects()
        .map((p) => p.name)
        .sort(),
    ).toEqual(["Added after the backup", "Garden"]);
  });

  it("never replays a stale journal from the database it replaced", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());
    fs.writeFileSync(path.join(fx.appHome, "planning.db-journal"), "stale");
    fs.writeFileSync(path.join(fx.appHome, "planning.db-wal"), "stale");

    restoreBackup(archive, fx.appHome);

    expect(fs.existsSync(path.join(fx.appHome, "planning.db-journal"))).toBe(false);
    expect(fs.existsSync(path.join(fx.appHome, "planning.db-wal"))).toBe(false);
    expect(createApplication({ GITLIB_HOME: fx.appHome }).listProjects()).toHaveLength(1);
  });

  it("refuses a backup whose planning schema is newer than this gitlib", () => {
    seed();
    const db = new DatabaseSync(path.join(fx.appHome, "planning.db"));
    db.exec("PRAGMA user_version = 999");
    db.close();
    const { path: archive } = createBackup(fx.appHome, archivePath());

    const target = path.join(fx.base, "old-gitlib-home");
    expect(() => restoreBackup(archive, target)).toThrow(/newer than this gitlib understands/);
    expect(fs.existsSync(target)).toBe(false);
  });
});

describe("verifyBackup", () => {
  it("rejects a member whose contents changed after the manifest was written", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());
    const tampered = tamper(archive, "config.toml", Buffer.from("roots = ['/etc']\n"));
    expect(() => verifyBackup(tampered)).toThrow(/does not match its checksum/);
  });

  it("rejects archives with members outside the expected set, before extracting anything", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());
    const tampered = tamper(archive, "authorized_keys", Buffer.from("ssh-ed25519 AAAA"));
    expect(() => verifyBackup(tampered)).toThrow(/unexpected entries: authorized_keys/);
  });

  it("rejects files that are not gitlib backups", () => {
    const bogus = path.join(fx.base, "bogus.tar.gz");
    fs.writeFileSync(bogus, "not an archive");
    expect(() => verifyBackup(bogus)).toThrow(BackupError);
    expect(() => verifyBackup(path.join(fx.base, "missing.tar.gz"))).toThrow(/not found/);
  });

  it("rejects a database that is not valid SQLite", () => {
    seed();
    const { path: archive } = createBackup(fx.appHome, archivePath());
    const dir = fs.mkdtempSync(path.join(fx.base, "rebuild-"));
    execFileSync("tar", ["-xzf", archive, "-C", dir]);
    const garbage = Buffer.from("this is not a database".repeat(200));
    fs.writeFileSync(path.join(dir, "gitlib.db"), garbage);
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, "manifest.json"), "utf-8"));
    const entry = manifest.files.find((file: { name: string }) => file.name === "gitlib.db");
    entry.bytes = garbage.length;
    entry.sha256 = createHash("sha256").update(garbage).digest("hex");
    fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(manifest));
    const out = path.join(fx.base, "garbage.tar.gz");
    execFileSync("tar", ["-czf", out, "-C", dir, ...fs.readdirSync(dir)]);

    expect(() => verifyBackup(out)).toThrow();
  });
});

describe("pruneBackups", () => {
  it("keeps the newest N gitlib archives and ignores everything else", () => {
    const dir = path.join(fx.base, "backups");
    fs.mkdirSync(dir);
    const names = [1, 2, 3, 4].map((n) => backupFileName(new Date(n * 86_400_000)));
    for (const name of [...names, "notes.txt", "pre-restore-19700101T000000Z.tar.gz"]) fs.writeFileSync(path.join(dir, name), "x");

    const removed = pruneBackups(dir, 2);

    expect(removed.map((file) => path.basename(file))).toEqual(names.slice(0, 2));
    expect(fs.readdirSync(dir).sort()).toEqual([...names.slice(2), "notes.txt", "pre-restore-19700101T000000Z.tar.gz"].sort());
  });

  it("is a no-op for a missing directory", () => {
    expect(pruneBackups(path.join(fx.base, "nope"), 3)).toEqual([]);
  });
});
