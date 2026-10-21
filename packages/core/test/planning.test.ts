import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  LocalIssueNotFoundError,
  LocalIssueValidationError,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MIGRATIONS,
  PlanningSchemaError,
  PlanningStore,
  RepoNotFoundError,
  createApplication,
  loadConfig,
  type Migration,
} from "../src/index.js";
import { Fixture } from "./fixture.js";

const { DatabaseSync } = process.getBuiltinModule("node:sqlite");

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
  fx.writeConfig();
});
afterEach(() => fx.cleanup());

const tableNames = (dbPath: string): string[] => {
  const db = new DatabaseSync(dbPath);
  try {
    return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as { name: string }[]).map(
      (row) => row.name,
    );
  } finally {
    db.close();
  }
};

const planningDbPath = () => path.join(fx.appHome, "planning.db");

describe("planning database", () => {
  it("is created at the latest schema version in a fresh home", () => {
    const config = loadConfig(fx.env());
    expect(config.planningDbPath).toBe(planningDbPath());
    expect(fs.existsSync(config.planningDbPath)).toBe(false);

    const app = createApplication(fx.env());

    expect(fs.existsSync(planningDbPath())).toBe(true);
    expect(app.planning.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(tableNames(planningDbPath())).toContain("local_issues");
  });

  it("keeps planning tables out of gitlib.db and scan tables out of planning.db", () => {
    createApplication(fx.env());

    expect(tableNames(path.join(fx.appHome, "gitlib.db"))).not.toContain("local_issues");
    expect(tableNames(planningDbPath())).not.toContain("repos");
  });

  it("is reopened without reapplying migrations", () => {
    const first = createApplication(fx.env());
    fx.makeRepo("alpha");
    first.refresh();
    first.createLocalIssue("alpha", { title: "kept" });

    const second = createApplication(fx.env());

    expect(second.planning.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(second.listLocalIssues().map((issue) => issue.title)).toEqual(["kept"]);
  });
});

describe("planning migrations", () => {
  const v1 = MIGRATIONS[0]!;
  const v2: Migration = {
    version: 2,
    name: "issue priority",
    sql: "ALTER TABLE local_issues ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;",
  };

  it("migrates an older database forward without losing data", () => {
    const old = new PlanningStore(planningDbPath(), [v1]);
    old.createIssue({ repoPath: "alpha", title: "before", body: "" }, "2026-01-01T00:00:00+00:00");
    expect(old.schemaVersion()).toBe(1);

    const upgraded = new PlanningStore(planningDbPath(), [v1, v2]);

    expect(upgraded.schemaVersion()).toBe(2);
    expect(upgraded.listIssues().map((issue) => issue.title)).toEqual(["before"]);
    const db = new DatabaseSync(planningDbPath());
    const columns = (db.prepare("PRAGMA table_info(local_issues)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(columns).toContain("priority");
  });

  it("rolls a failing migration back and leaves the version where it was", () => {
    new PlanningStore(planningDbPath(), [v1]);
    const broken: Migration = {
      version: 2,
      name: "broken",
      sql: "CREATE TABLE half_done (id INTEGER); THIS IS NOT SQL;",
    };

    expect(() => new PlanningStore(planningDbPath(), [v1, broken])).toThrow(PlanningSchemaError);

    expect(new PlanningStore(planningDbPath(), [v1]).schemaVersion()).toBe(1);
    expect(tableNames(planningDbPath())).not.toContain("half_done");
  });

  it("refuses a database written by a newer gitlib", () => {
    new PlanningStore(planningDbPath(), [v1, v2]);

    expect(() => new PlanningStore(planningDbPath(), [v1])).toThrow(/newer than this gitlib/);
  });

  it("requires migrations to be numbered in order", () => {
    expect(() => new PlanningStore(planningDbPath(), [{ ...v1, version: 2 }])).toThrow(/numbered 1, 2, 3/);
  });
});

describe("local issues", () => {
  beforeEach(() => {
    fx.makeRepo("alpha");
    fx.makeRepo("group/beta");
  });

  const appWithRepos = () => {
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  };

  it("numbers issues per repo and stores the repo's relative path", () => {
    const app = appWithRepos();

    const first = app.createLocalIssue("alpha", { title: "First", body: "Details" });
    const second = app.createLocalIssue("alpha", { title: "Second" });
    // A repo can be addressed by name as well as by path.
    const other = app.createLocalIssue("beta", { title: "Elsewhere" });

    expect([first.number, second.number]).toEqual([1, 2]);
    expect(other).toMatchObject({ repoPath: "group/beta", number: 1, state: "open", body: "" });
    expect(first).toMatchObject({ repoPath: "alpha", title: "First", body: "Details", closedAt: null });
  });

  it("rejects an unknown repo without storing anything", () => {
    const app = appWithRepos();

    expect(() => app.createLocalIssue("nope", { title: "Lost" })).toThrow(RepoNotFoundError);
    expect(app.listLocalIssues()).toEqual([]);
  });

  it("trims text and enforces limits", () => {
    const app = appWithRepos();

    expect(app.createLocalIssue("alpha", { title: "  padded  ", body: "\n body \n" })).toMatchObject({
      title: "padded",
      body: "body",
    });
    expect(() => app.createLocalIssue("alpha", { title: "   " })).toThrow(LocalIssueValidationError);
    expect(() => app.createLocalIssue("alpha", { title: "x".repeat(MAX_ISSUE_TITLE_LENGTH + 1) })).toThrow(
      LocalIssueValidationError,
    );
    expect(() =>
      app.createLocalIssue("alpha", { title: "ok", body: "x".repeat(MAX_ISSUE_BODY_LENGTH + 1) }),
    ).toThrow(LocalIssueValidationError);
    expect(app.listLocalIssues()).toHaveLength(1);
  });

  it("lists most recently updated first and filters by repo and state", () => {
    const store = new PlanningStore(planningDbPath());
    const a = store.createIssue({ repoPath: "alpha", title: "a", body: "" }, "2026-01-01T00:00:00+00:00");
    const b = store.createIssue({ repoPath: "alpha", title: "b", body: "" }, "2026-01-02T00:00:00+00:00");
    const c = store.createIssue({ repoPath: "group/beta", title: "c", body: "" }, "2026-01-03T00:00:00+00:00");
    store.setIssueState(a.id, "closed", "2026-01-04T00:00:00+00:00");

    expect(store.listIssues().map((issue) => issue.title)).toEqual(["a", "c", "b"]);
    expect(store.listIssues({ repoPath: "alpha" }).map((issue) => issue.title)).toEqual(["a", "b"]);
    expect(store.listIssues({ state: "open" }).map((issue) => issue.id)).toEqual([c.id, b.id]);
    expect(store.listIssues({ repoPath: "alpha", state: "closed" }).map((issue) => issue.id)).toEqual([a.id]);
    expect(store.listIssues({ repoPath: "missing" })).toEqual([]);
  });

  it("edits title and body and bumps updatedAt", () => {
    const store = new PlanningStore(planningDbPath());
    const issue = store.createIssue({ repoPath: "alpha", title: "old", body: "old body" }, "2026-01-01T00:00:00+00:00");

    const edited = store.updateIssue(issue.id, { title: "new" }, "2026-01-02T00:00:00+00:00");

    expect(edited).toMatchObject({
      title: "new",
      body: "old body",
      createdAt: "2026-01-01T00:00:00+00:00",
      updatedAt: "2026-01-02T00:00:00+00:00",
    });
  });

  it("closes and reopens, recording when it was closed", () => {
    const store = new PlanningStore(planningDbPath());
    const issue = store.createIssue({ repoPath: "alpha", title: "t", body: "" }, "2026-01-01T00:00:00+00:00");

    const closed = store.setIssueState(issue.id, "closed", "2026-01-02T00:00:00+00:00");
    expect(closed).toMatchObject({ state: "closed", closedAt: "2026-01-02T00:00:00+00:00" });

    // Closing an already-closed issue is a no-op, so it keeps its original close time.
    expect(store.setIssueState(issue.id, "closed", "2026-01-03T00:00:00+00:00")).toEqual(closed);

    const reopened = store.setIssueState(issue.id, "open", "2026-01-04T00:00:00+00:00");
    expect(reopened).toMatchObject({ state: "open", closedAt: null, updatedAt: "2026-01-04T00:00:00+00:00" });
  });

  it("reports an issue that does not exist", () => {
    const app = appWithRepos();

    expect(() => app.getLocalIssue(999)).toThrow(LocalIssueNotFoundError);
    expect(() => app.updateLocalIssue(999, { title: "x" })).toThrow(LocalIssueNotFoundError);
    expect(() => app.setLocalIssueState(999, "closed")).toThrow(LocalIssueNotFoundError);
  });

  it("survives a restart, a rebuilt scan database, and the repo going missing", () => {
    const app = appWithRepos();
    const issue = app.createLocalIssue("alpha", { title: "durable" });

    // Rescanning is how gitlib.db is rebuilt; planning data must not depend on its row ids.
    fs.rmSync(path.join(fx.appHome, "gitlib.db"));
    fs.rmSync(path.join(fx.gitRoot, "alpha"), { recursive: true });
    const restarted = createApplication(fx.env());
    restarted.refresh();

    expect(restarted.loadRepositories().map((repo) => repo.relativePath)).toEqual(["group/beta"]);
    expect(restarted.getLocalIssue(issue.id)).toMatchObject({ repoPath: "alpha", title: "durable" });
    // New issues cannot be filed against a repo that is gone, but its existing ones stay readable.
    expect(() => restarted.createLocalIssue("alpha", { title: "late" })).toThrow(RepoNotFoundError);
  });
});

describe("planning backup", () => {
  it("writes a readable snapshot without touching the original", () => {
    fx.makeRepo("alpha");
    const app = createApplication(fx.env());
    app.refresh();
    app.createLocalIssue("alpha", { title: "backed up", body: "with a body" });

    const target = path.join(fx.base, "snap", "planning-copy.db");
    expect(app.backupPlanning(target)).toBe(target);

    const copy = new PlanningStore(target);
    expect(copy.listIssues().map((issue) => issue.title)).toEqual(["backed up"]);
    expect(copy.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(app.listLocalIssues()).toHaveLength(1);
  });

  it("never overwrites an existing file", () => {
    const app = createApplication(fx.env());
    const target = path.join(fx.base, "existing.db");
    fs.writeFileSync(target, "precious");

    expect(() => app.backupPlanning(target)).toThrow(/already exists/);
    expect(fs.readFileSync(target, "utf-8")).toBe("precious");
  });

  it("defaults to a timestamped file under the app home", () => {
    const app = createApplication(fx.env());

    const written = app.backupPlanning();

    expect(path.dirname(written)).toBe(path.join(fx.appHome, "backups"));
    expect(path.basename(written)).toMatch(/^planning-.*\.db$/);
    expect(fs.existsSync(written)).toBe(true);
  });
});
