import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  LocalIssueNotFoundError,
  LocalIssueValidationError,
  MAX_ISSUE_BODY_LENGTH,
  MAX_ISSUE_TITLE_LENGTH,
  MAX_MILESTONE_TITLE_LENGTH,
  MIGRATIONS,
  MilestoneNotFoundError,
  MilestoneProjectMismatchError,
  MilestoneTitleTakenError,
  MilestoneValidationError,
  PlanningSchemaError,
  PlanningStore,
  ProjectNameTakenError,
  ProjectNotFoundError,
  ProjectValidationError,
  AmbiguousPlanningRepoError,
  EpicNotFoundError,
  EpicProjectMismatchError,
  EpicTitleTakenError,
  EpicValidationError,
  PlanningArchivedError,
  PlanningRepoNotFoundError,
  RepoNotFoundError,
  RepoPathTakenError,
  RepoSlugTakenError,
  RepoSlugValidationError,
  createApplication,
  rollUpStatus,
  loadConfig,
  type Migration,
} from "../src/index.js";
import { Fixture, insertLegacyIssue } from "./fixture.js";

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
    insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "before" });
    expect(old.schemaVersion()).toBe(1);

    const upgraded = new PlanningStore(planningDbPath(), [v1, v2]);

    expect(upgraded.schemaVersion()).toBe(2);
    const db = new DatabaseSync(planningDbPath());
    const titles = (db.prepare("SELECT title FROM local_issues").all() as { title: string }[]).map((row) => row.title);
    const columns = (db.prepare("PRAGMA table_info(local_issues)").all() as { name: string }[]).map((c) => c.name);
    db.close();
    expect(titles).toEqual(["before"]);
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

  it("starts issues at todo and keeps status and state in step", () => {
    const store = new PlanningStore(planningDbPath());
    const issue = store.createIssue({ repoPath: "alpha", title: "t", body: "" }, "2026-01-01T00:00:00+00:00");
    expect(issue).toMatchObject({ status: "todo", state: "open" });

    const moving = store.setIssueStatus(issue.id, "in_progress", "2026-01-02T00:00:00+00:00");
    expect(moving).toMatchObject({ status: "in_progress", state: "open", closedAt: null });

    const done = store.setIssueStatus(issue.id, "done", "2026-01-03T00:00:00+00:00");
    expect(done).toMatchObject({ status: "done", state: "closed", closedAt: "2026-01-03T00:00:00+00:00" });

    expect(store.setIssueStatus(issue.id, "done", "2026-01-04T00:00:00+00:00")).toEqual(done);

    const back = store.setIssueStatus(issue.id, "in_review", "2026-01-05T00:00:00+00:00");
    expect(back).toMatchObject({ status: "in_review", state: "open", closedAt: null });

    expect(store.setIssueState(issue.id, "closed", "2026-01-06T00:00:00+00:00")).toMatchObject({ status: "done" });
    expect(store.setIssueState(issue.id, "open", "2026-01-07T00:00:00+00:00")).toMatchObject({ status: "todo" });
  });

  it("backfills status from state when migrating an older database", () => {
    const v1 = MIGRATIONS[0]!;
    new PlanningStore(planningDbPath(), [v1]);
    const open = insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "open" });
    const closed = insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "closed" });
    const db = new DatabaseSync(planningDbPath());
    db.prepare("UPDATE local_issues SET state = 'closed', closed_at = ? WHERE id = ?").run("2026-01-02T00:00:00+00:00", closed);
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.getIssue(open)?.status).toBe("todo");
    expect(upgraded.getIssue(closed)?.status).toBe("done");
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
    expect(() => app.setLocalIssueStatus(999, "done")).toThrow(LocalIssueNotFoundError);
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

describe("projects", () => {
  beforeEach(() => {
    fx.makeRepo("alpha");
    fx.makeRepo("group/beta");
  });

  const appWithRepos = () => {
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  };

  it("creates, renames, lists and deletes projects", () => {
    const app = appWithRepos();
    const project = app.createProject("  Launch  ");
    expect(project.name).toBe("Launch");
    expect(project.repoPaths).toEqual([]);

    expect(app.renameProject(project.id, "Relaunch").name).toBe("Relaunch");
    expect(app.listProjects().map((p) => p.name)).toEqual(["Relaunch"]);

    app.deleteProject(project.id);
    expect(app.listProjects()).toEqual([]);
    expect(() => app.getProject(project.id)).toThrow(ProjectNotFoundError);
  });

  it("rejects blank, overlong and duplicate names", () => {
    const app = appWithRepos();
    const first = app.createProject("Launch");
    const second = app.createProject("Other");
    expect(() => app.createProject("   ")).toThrow(ProjectValidationError);
    expect(() => app.createProject("x".repeat(101))).toThrow(ProjectValidationError);
    expect(() => app.createProject("launch")).toThrow(ProjectNameTakenError);
    expect(() => app.renameProject(second.id, "LAUNCH")).toThrow(ProjectNameTakenError);
    // Changing only the case of its own name is allowed.
    expect(app.renameProject(first.id, "LAUNCH").name).toBe("LAUNCH");
  });

  it("holds several repos, and a repo can be in several projects", () => {
    const app = appWithRepos();
    const a = app.createProject("A");
    const b = app.createProject("B");

    app.addRepoToProject(a.id, "alpha");
    app.addRepoToProject(a.id, "alpha");
    app.addRepoToProject(a.id, "group/beta");
    app.addRepoToProject(b.id, "alpha");

    expect(app.getProject(a.id).repoPaths).toEqual(["alpha", "group/beta"]);
    expect(app.getProject(b.id).repoPaths).toEqual(["alpha"]);
    expect(() => app.addRepoToProject(a.id, "missing")).toThrow(RepoNotFoundError);

    app.removeRepoFromProject(a.id, "alpha");
    expect(app.getProject(a.id).repoPaths).toEqual(["group/beta"]);
  });

  it("adds several repos at once, including hosted ones that are not cloned", () => {
    const app = appWithRepos();
    const project = app.createProject("A");

    const added = app.addReposToProject(
      project.id,
      ["alpha", "group/beta"],
      [
        { provider: "github", fullName: "octo/widgets" },
        { provider: "gitlab", fullName: "team/sub/service" },
      ],
    );
    expect(added.repoPaths).toEqual(["alpha", "group/beta"]);
    expect(added.remotes).toEqual([
      { provider: "github", fullName: "octo/widgets" },
      { provider: "gitlab", fullName: "team/sub/service" },
    ]);

    // Adding again, or in another case, changes nothing.
    app.addReposToProject(project.id, ["alpha"], [{ provider: "github", fullName: "Octo/Widgets" }]);
    expect(app.getProject(project.id).remotes).toHaveLength(2);
    expect(app.listProjects()[0]!.remotes).toHaveLength(2);

    app.removeRemoteFromProject(project.id, { provider: "github", fullName: "OCTO/widgets" });
    expect(app.getProject(project.id).remotes).toEqual([{ provider: "gitlab", fullName: "team/sub/service" }]);
  });

  it("adds nothing when one of several repos is unknown or malformed", () => {
    const app = appWithRepos();
    const project = app.createProject("A");

    expect(() => app.addReposToProject(project.id, ["alpha", "missing"])).toThrow(RepoNotFoundError);
    expect(() =>
      app.addReposToProject(project.id, ["alpha"], [{ provider: "github", fullName: "no-slash" }]),
    ).toThrow(ProjectValidationError);
    expect(() =>
      app.addReposToProject(project.id, [], [{ provider: "bitbucket" as "github", fullName: "a/b" }]),
    ).toThrow(ProjectValidationError);
    expect(app.getProject(project.id).repoPaths).toEqual([]);
    expect(() => app.addReposToProject(999, ["alpha"])).toThrow(ProjectNotFoundError);
  });

  it("files issues under a project and keeps them when the project is deleted", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    expect(issue.projectId).toBeNull();

    expect(app.setLocalIssueProject(issue.id, project.id).projectId).toBe(project.id);
    expect(app.listLocalIssues({ projectId: project.id }).map((i) => i.id)).toEqual([issue.id]);
    expect(app.getProject(project.id).repoPaths).toEqual(["alpha"]);
    expect(() => app.setLocalIssueProject(issue.id, 999)).toThrow(ProjectNotFoundError);

    app.deleteProject(project.id);
    expect(app.getLocalIssue(issue.id).projectId).toBeNull();
    expect(app.setLocalIssueProject(issue.id, null).projectId).toBeNull();
  });

  it("adds an issue's repo to the project it is filed under, and leaves the repo there when the issue leaves", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const other = app.createProject("Other");
    app.addRepoToProject(project.id, "group/beta");
    const first = app.createLocalIssue("alpha", { title: "first" });
    const second = app.createLocalIssue("alpha", { title: "second" });

    app.setLocalIssueProject(first.id, project.id);
    expect(app.getProject(project.id).repoPaths).toEqual(["alpha", "group/beta"]);
    // A repo already in the project is not added twice.
    app.setLocalIssueProject(second.id, project.id);
    expect(app.getProject(project.id).repos.map((repo) => repo.path)).toEqual(["alpha", "group/beta"]);
    expect(app.getProject(other.id).repoPaths).toEqual([]);

    // Taking the issues out (or moving them on) never takes the repo out.
    app.setLocalIssueProject(first.id, null);
    app.setLocalIssueProject(second.id, other.id);
    expect(app.getProject(project.id).repoPaths).toEqual(["alpha", "group/beta"]);
    expect(app.getProject(other.id).repoPaths).toEqual(["alpha"]);
  });

  it("brings back a repo that was taken out when one of its issues is filed under the project again", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const issue = app.createLocalIssue("alpha", { title: "comes back" });
    app.addRepoToProject(project.id, "alpha");
    app.removeRepoFromProject(project.id, "alpha");
    expect(app.getProject(project.id).removedRepos.map((repo) => repo.path)).toEqual(["alpha"]);

    app.setLocalIssueProject(issue.id, project.id);

    const restored = app.getProject(project.id);
    expect(restored.repoPaths).toEqual(["alpha"]);
    expect(restored.removedRepos).toEqual([]);
  });

  it("files nothing, and adds no repo, when the repo is archived or the project is", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const issue = app.createLocalIssue("alpha", { title: "stuck" });
    app.archivePlanningRepo("alpha");

    expect(() => app.setLocalIssueProject(issue.id, project.id)).toThrow(PlanningArchivedError);
    expect(app.getLocalIssue(issue.id).projectId).toBeNull();
    expect(app.getProject(project.id).repoPaths).toEqual([]);

    app.restorePlanningRepo("alpha");
    app.archiveProject(project.id);
    expect(() => app.setLocalIssueProject(issue.id, project.id)).toThrow(PlanningArchivedError);
    expect(app.getLocalIssue(issue.id).projectId).toBeNull();
    expect(app.getProject(project.id).repoPaths).toEqual([]);
  });

  it("moves an issue of an archived repo between projects that both hold the repo", () => {
    const app = appWithRepos();
    const from = app.createProject("From");
    const to = app.createProject("To");
    app.addRepoToProject(from.id, "alpha");
    app.addRepoToProject(to.id, "alpha");
    const issue = app.createLocalIssue("alpha", { title: "moving" });
    app.setLocalIssueProject(issue.id, from.id);
    app.archivePlanningRepo("alpha");

    expect(app.setLocalIssueProject(issue.id, to.id).projectId).toBe(to.id);
  });

  it("still shows and moves issues filed before a project had to hold their repo", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const other = app.createProject("Other");
    const issue = app.createLocalIssue("alpha", { title: "older" });
    // Filed directly, as could happen before issues brought their repo into the project.
    const db = new DatabaseSync(planningDbPath());
    try {
      db.prepare("UPDATE local_issues SET project_id = ? WHERE id = ?").run(project.id, issue.id);
    } finally {
      db.close();
    }

    expect(app.getProject(project.id).repoPaths).toEqual([]);
    expect(app.listLocalIssues({ projectId: project.id }).map((i) => i.id)).toEqual([issue.id]);
    expect(app.listProjects().find((p) => p.id === project.id)?.repoPaths).toEqual([]);

    expect(app.setLocalIssueProject(issue.id, other.id).projectId).toBe(other.id);
    expect(app.getProject(other.id).repoPaths).toEqual(["alpha"]);
    expect(app.getProject(project.id).repoPaths).toEqual([]);
  });

  it("drops repo memberships with the project", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "alpha");
    app.addReposToProject(project.id, [], [{ provider: "github", fullName: "octo/widgets" }]);
    app.deleteProject(project.id);
    expect(app.createProject("Launch").repoPaths).toEqual([]);
    expect(app.createProject("Launch 2").remotes).toEqual([]);
  });
});

describe("milestones", () => {
  beforeEach(() => {
    fx.makeRepo("alpha");
  });

  const appWithRepos = () => {
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  };

  it("creates, edits, lists and deletes milestones within a project", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const later = app.createMilestone(project.id, { title: "  Beta  ", dueDate: "2026-09-01" });
    const sooner = app.createMilestone(project.id, { title: "Alpha", description: " First cut ", dueDate: "2026-06-01" });
    const undated = app.createMilestone(project.id, { title: "Someday" });

    expect(later.title).toBe("Beta");
    expect(sooner.description).toBe("First cut");
    expect(undated.dueDate).toBeNull();
    // Soonest first, undated last.
    expect(app.listMilestones(project.id).map((m) => m.title)).toEqual(["Alpha", "Beta", "Someday"]);

    const edited = app.updateMilestone(later.id, { title: "Beta 2", dueDate: null });
    expect(edited).toMatchObject({ title: "Beta 2", dueDate: null, description: "" });
    expect(app.updateMilestone(sooner.id, { description: "Changed" })).toMatchObject({
      title: "Alpha",
      dueDate: "2026-06-01",
    });

    app.deleteMilestone(undated.id);
    expect(() => app.getMilestone(undated.id)).toThrow(MilestoneNotFoundError);
    expect(() => app.updateMilestone(undated.id, { title: "x" })).toThrow(MilestoneNotFoundError);
    expect(app.listMilestones().map((m) => m.title)).toEqual(["Alpha", "Beta 2"]);
  });

  it("validates titles, descriptions and due dates", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const milestone = app.createMilestone(project.id, { title: "Alpha" });

    expect(() => app.createMilestone(project.id, { title: "   " })).toThrow(MilestoneValidationError);
    expect(() => app.createMilestone(project.id, { title: "x".repeat(MAX_MILESTONE_TITLE_LENGTH + 1) })).toThrow(
      MilestoneValidationError,
    );
    for (const bad of ["2026-02-31", "2026-13-01", "06/01/2026", "2026-6-1", "tomorrow"]) {
      expect(() => app.createMilestone(project.id, { title: "Bad", dueDate: bad })).toThrow(MilestoneValidationError);
      expect(() => app.updateMilestone(milestone.id, { dueDate: bad })).toThrow(MilestoneValidationError);
    }
    expect(app.createMilestone(project.id, { title: "Leap", dueDate: "2028-02-29" }).dueDate).toBe("2028-02-29");
    expect(app.createMilestone(project.id, { title: "Blank", dueDate: "  " }).dueDate).toBeNull();
    expect(() => app.createMilestone(999, { title: "Orphan" })).toThrow(ProjectNotFoundError);
  });

  it("keeps titles unique per project, ignoring case", () => {
    const app = appWithRepos();
    const a = app.createProject("A");
    const b = app.createProject("B");
    const first = app.createMilestone(a.id, { title: "v1" });
    const second = app.createMilestone(a.id, { title: "v2" });

    expect(() => app.createMilestone(a.id, { title: "V1" })).toThrow(MilestoneTitleTakenError);
    expect(() => app.updateMilestone(second.id, { title: "V1" })).toThrow(MilestoneTitleTakenError);
    // Changing only the case of its own title is allowed, and another project may reuse a title.
    expect(app.updateMilestone(first.id, { title: "V1" }).title).toBe("V1");
    expect(app.createMilestone(b.id, { title: "v1" }).projectId).toBe(b.id);
  });

  it("puts an issue in a milestone of its own project only", () => {
    const app = appWithRepos();
    const launch = app.createProject("Launch");
    const other = app.createProject("Other");
    const milestone = app.createMilestone(launch.id, { title: "Alpha" });
    const foreign = app.createMilestone(other.id, { title: "Elsewhere" });
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    expect(issue.milestoneId).toBeNull();

    // No project yet, so no milestone.
    expect(() => app.setLocalIssueMilestone(issue.id, milestone.id)).toThrow(MilestoneProjectMismatchError);
    app.setLocalIssueProject(issue.id, launch.id);
    expect(() => app.setLocalIssueMilestone(issue.id, foreign.id)).toThrow(MilestoneProjectMismatchError);
    expect(() => app.setLocalIssueMilestone(issue.id, 999)).toThrow(MilestoneNotFoundError);

    expect(app.setLocalIssueMilestone(issue.id, milestone.id).milestoneId).toBe(milestone.id);
    expect(app.listLocalIssues({ milestoneId: milestone.id }).map((i) => i.id)).toEqual([issue.id]);
    expect(app.setLocalIssueMilestone(issue.id, null).milestoneId).toBeNull();
    expect(app.listLocalIssues({ milestoneId: milestone.id })).toEqual([]);
  });

  it("leaves an issue untouched when its milestone is set to what it already is", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const milestone = app.createMilestone(project.id, { title: "Alpha" });
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    app.setLocalIssueProject(issue.id, project.id);
    const assigned = app.setLocalIssueMilestone(issue.id, milestone.id);

    expect(app.setLocalIssueMilestone(issue.id, milestone.id)).toEqual(assigned);
  });

  it("clears the milestone when the issue changes project or leaves its project", () => {
    const app = appWithRepos();
    const launch = app.createProject("Launch");
    const other = app.createProject("Other");
    const milestone = app.createMilestone(launch.id, { title: "Alpha" });
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    app.setLocalIssueProject(issue.id, launch.id);

    app.setLocalIssueMilestone(issue.id, milestone.id);
    expect(app.setLocalIssueProject(issue.id, other.id)).toMatchObject({ projectId: other.id, milestoneId: null });

    app.setLocalIssueProject(issue.id, launch.id);
    app.setLocalIssueMilestone(issue.id, milestone.id);
    expect(app.setLocalIssueProject(issue.id, null)).toMatchObject({ projectId: null, milestoneId: null });

    // Re-filing under the project it is already in keeps the milestone.
    app.setLocalIssueProject(issue.id, launch.id);
    app.setLocalIssueMilestone(issue.id, milestone.id);
    expect(app.setLocalIssueProject(issue.id, launch.id).milestoneId).toBe(milestone.id);
  });

  it("keeps issues in their project when a milestone is deleted", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const milestone = app.createMilestone(project.id, { title: "Alpha" });
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    app.setLocalIssueProject(issue.id, project.id);
    app.setLocalIssueMilestone(issue.id, milestone.id);

    app.deleteMilestone(milestone.id);

    expect(app.getLocalIssue(issue.id)).toMatchObject({ projectId: project.id, milestoneId: null });
  });

  it("deletes a project's milestones with it and frees their issues", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const milestone = app.createMilestone(project.id, { title: "Alpha" });
    const issue = app.createLocalIssue("alpha", { title: "Ship it" });
    app.setLocalIssueProject(issue.id, project.id);
    app.setLocalIssueMilestone(issue.id, milestone.id);

    app.deleteProject(project.id);

    expect(app.listMilestones()).toEqual([]);
    expect(app.getLocalIssue(issue.id)).toMatchObject({ projectId: null, milestoneId: null });
  });

  it("migrates an older database forward, keeping issues and projects", () => {
    const before = MIGRATIONS.slice(0, 5);
    new PlanningStore(planningDbPath(), before);
    // The store only knows the newest schema, so file the issue the way a version-5 gitlib would have.
    const issue = insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "Ship it" });
    const db = new DatabaseSync(planningDbPath());
    const project = { id: Number(db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Launch', '', '')").run().lastInsertRowid) };
    db.prepare("UPDATE local_issues SET project_id = ? WHERE id = ?").run(project.id, issue);
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(upgraded.getIssue(issue)).toMatchObject({ projectId: project.id, milestoneId: null });
    expect(upgraded.listMilestones()).toEqual([]);
    expect(upgraded.getProject(project.id)).toMatchObject({ name: "Launch", repoPaths: [], remotes: [] });
  });
});

describe("planning repos", () => {
  const appWithRepos = () => {
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  };

  /** A real repository with one commit, so it has a first commit to be recognized by. */
  const committedRepo = (relativePath: string): string => {
    const repoPath = fx.initRealGitRepo(relativePath);
    fx.git(repoPath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
    return repoPath;
  };

  it("gives a repo an id and a short name the first time planning refers to it", () => {
    fx.makeRepo("alpha");
    fx.makeRepo("work/api");
    fx.makeRepo("personal/api");
    const app = appWithRepos();

    const first = app.createLocalIssue("alpha", { title: "One" });
    const work = app.createLocalIssue("work/api", { title: "Two" });
    const personal = app.createLocalIssue("personal/api", { title: "Three" });

    expect(first).toMatchObject({ repoSlug: "alpha", repoPath: "alpha", number: 1 });
    // The folder name is taken, so the second "api" falls back to its whole path.
    expect(work.repoSlug).toBe("api");
    expect(personal.repoSlug).toBe("personal/api");
    expect(app.listPlanningRepos().map((repo) => [repo.slug, repo.path, repo.found])).toEqual([
      ["alpha", "alpha", true],
      ["api", "work/api", true],
      ["personal/api", "personal/api", true],
    ]);
    // Filing another issue reuses the repo rather than creating a second one.
    expect(app.createLocalIssue("alpha", { title: "Again" })).toMatchObject({ repoId: first.repoId, number: 2 });
    expect(app.listLocalIssues({ repoId: work.repoId }).map((issue) => issue.title)).toEqual(["Two"]);
  });

  it("renames a repo's short name without touching its issues", () => {
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
    const app = appWithRepos();
    const issue = app.createLocalIssue("alpha", { title: "One" });
    app.createLocalIssue("beta", { title: "Two" });

    expect(app.renamePlanningRepo("alpha", "core").slug).toBe("core");
    expect(app.getLocalIssue(issue.id)).toMatchObject({ repoSlug: "core", repoPath: "alpha", repoId: issue.repoId });
    // Found by its new name or its path, ignoring case.
    expect(app.resolvePlanningRepo("CORE").id).toBe(issue.repoId);
    expect(app.resolvePlanningRepo("alpha").id).toBe(issue.repoId);

    expect(() => app.renamePlanningRepo("core", "BETA")).toThrow(RepoSlugTakenError);
    expect(() => app.renamePlanningRepo("core", "has space")).toThrow(RepoSlugValidationError);
    expect(() => app.renamePlanningRepo("core", "a#b")).toThrow(RepoSlugValidationError);
    expect(() => app.renamePlanningRepo("nope", "x")).toThrow(PlanningRepoNotFoundError);
  });

  it("keeps a moved repo's issues and projects, and relinks them by hand", () => {
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
    const app = appWithRepos();
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "alpha");
    const issue = app.createLocalIssue("alpha", { title: "Follow me" });
    app.setLocalIssueProject(issue.id, project.id);

    fs.renameSync(path.join(fx.gitRoot, "alpha"), path.join(fx.gitRoot, "moved"));
    app.refresh();

    // Nothing is lost: the issue still points at its repo, which is reported as not found.
    expect(app.getLocalIssue(issue.id)).toMatchObject({ repoPath: "alpha", projectId: project.id });
    expect(app.listPlanningRepos().find((repo) => repo.slug === "alpha")?.found).toBe(false);

    const relinked = app.relinkPlanningRepo("alpha", "moved");

    expect(relinked).toMatchObject({ id: issue.repoId, slug: "alpha", path: "moved" });
    expect(app.getLocalIssue(issue.id)).toMatchObject({ repoPath: "moved", repoSlug: "alpha", projectId: project.id });
    expect(app.getProject(project.id).repoPaths).toEqual(["moved"]);
    expect(app.listLocalIssues({ repoPath: "moved" }).map((i) => i.id)).toEqual([issue.id]);
    // Numbering carries on where it left off.
    expect(app.createLocalIssue("moved", { title: "Next" }).number).toBe(2);

    // A path another planning repo already has cannot be taken.
    app.createLocalIssue("beta", { title: "Mine" });
    expect(() => app.relinkPlanningRepo("alpha", "beta")).toThrow(RepoPathTakenError);
  });

  it("follows a moved repo on its own when its first commit identifies it", () => {
    committedRepo("alpha");
    const app = appWithRepos();
    const issue = app.createLocalIssue("alpha", { title: "Follow me" });
    expect(app.resolvePlanningRepo("alpha").rootCommit).toMatch(/^[0-9a-f]{40}$/);

    fs.mkdirSync(path.join(fx.gitRoot, "archive"));
    fs.renameSync(path.join(fx.gitRoot, "alpha"), path.join(fx.gitRoot, "archive", "alpha"));
    app.refresh();

    expect(app.getLocalIssue(issue.id)).toMatchObject({ repoPath: "archive/alpha", repoSlug: "alpha" });
    expect(app.listPlanningRepos().map((repo) => repo.found)).toEqual([true]);
  });

  it("leaves a move alone when two repos could be the one that moved", () => {
    const original = committedRepo("alpha");
    const app = appWithRepos();
    const issue = app.createLocalIssue("alpha", { title: "Which one?" });

    // Two copies share the first commit, as a fork or a second clone would.
    fs.cpSync(original, path.join(fx.gitRoot, "copy-one"), { recursive: true });
    fs.renameSync(original, path.join(fx.gitRoot, "copy-two"));
    app.refresh();

    expect(app.getLocalIssue(issue.id).repoPath).toBe("alpha");
    expect(app.listPlanningRepos().map((repo) => repo.found)).toEqual([false]);
    expect(app.relinkPlanningRepo("alpha", "copy-two").path).toBe("copy-two");
  });

  it("takes a repo out of a project by short name, even one gitlib no longer finds", () => {
    fx.makeRepo("alpha");
    const app = appWithRepos();
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "alpha");
    app.renamePlanningRepo("alpha", "core");
    fs.rmSync(path.join(fx.gitRoot, "alpha"), { recursive: true });
    app.refresh();

    expect(app.getProject(project.id).repos).toEqual([{ id: expect.any(Number), slug: "core", path: "alpha", archived: false }]);
    expect(app.removeRepoFromProject(project.id, "core").repos).toEqual([]);
    expect(() => app.removeRepoFromProject(project.id, "nope")).toThrow(PlanningRepoNotFoundError);
  });

  it("refuses to delete a repo that still has issues", () => {
    fx.makeRepo("alpha");
    const app = appWithRepos();
    const issue = app.createLocalIssue("alpha", { title: "Anchor" });

    const db = new DatabaseSync(planningDbPath());
    db.exec("PRAGMA foreign_keys = ON");
    expect(() => db.prepare("DELETE FROM planning_repos WHERE id = ?").run(issue.repoId)).toThrow(/FOREIGN KEY/);
    db.close();
  });

  it("migrates repo paths to planning repos, keeping every issue and project membership", () => {
    const before = MIGRATIONS.slice(0, 7);
    expect(before.at(-1)?.name).toBe("project remote repos");
    new PlanningStore(planningDbPath(), before);
    const alpha1 = insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "a1", createdAt: "2026-01-01T00:00:00+00:00" });
    const alpha2 = insertLegacyIssue(planningDbPath(), { repoPath: "alpha", title: "a2" });
    const work = insertLegacyIssue(planningDbPath(), { repoPath: "work/api", title: "w1" });
    const personal = insertLegacyIssue(planningDbPath(), { repoPath: "personal/api", title: "p1" });
    const db = new DatabaseSync(planningDbPath());
    const projectId = Number(db.prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Launch', '', '')").run().lastInsertRowid);
    const milestoneId = Number(
      db.prepare("INSERT INTO milestones (project_id, title, created_at, updated_at) VALUES (?, 'v1', '', '')").run(projectId).lastInsertRowid,
    );
    db.prepare("UPDATE local_issues SET project_id = ?, milestone_id = ?, status = 'in_review' WHERE id = ?").run(projectId, milestoneId, alpha2);
    const addRepo = db.prepare("INSERT INTO project_repos (project_id, repo_path, added_at) VALUES (?, ?, '2026-02-01T00:00:00+00:00')");
    addRepo.run(projectId, "alpha");
    // A member with no issues still gets a planning repo.
    addRepo.run(projectId, "tools/gone");
    db.prepare("INSERT INTO project_remotes (project_id, provider, full_name, added_at) VALUES (?, 'github', 'octo/widgets', '')").run(projectId);
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(upgraded.listRepos().map((repo) => [repo.slug, repo.path])).toEqual([
      ["alpha", "alpha"],
      ["gone", "tools/gone"],
      ["personal/api", "personal/api"],
      ["work/api", "work/api"],
    ]);
    expect(upgraded.getIssue(alpha1)).toMatchObject({ repoSlug: "alpha", repoPath: "alpha", number: 1 });
    expect(upgraded.getIssue(alpha2)).toMatchObject({
      repoSlug: "alpha",
      number: 2,
      status: "in_review",
      projectId,
      milestoneId,
    });
    expect(upgraded.getIssue(work)).toMatchObject({ repoSlug: "work/api", number: 1 });
    expect(upgraded.getProject(projectId)).toMatchObject({
      repoPaths: ["alpha", "tools/gone"],
      remotes: [{ provider: "github", fullName: "octo/widgets" }],
    });
    expect(upgraded.getIssue(personal)).toMatchObject({ repoSlug: "personal/api", number: 1 });
    expect(upgraded.getProject(projectId)?.repoPaths).toEqual(["alpha", "tools/gone"]);
    expect(upgraded.listIssues()).toHaveLength(4);
  });
});

describe("planning repo names", () => {
  it("refuses a name that is one repo's short name and another's path", () => {
    fx.makeRepo("work/api");
    fx.makeRepo("api");
    const app = createApplication(fx.env());
    app.refresh();
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "work/api");
    app.addRepoToProject(project.id, "api");

    // work/api took "api"; the top-level api repo could not, and fell back to "api-2".
    expect(app.getProject(project.id).repos.map((repo) => [repo.slug, repo.path])).toEqual([
      ["api-2", "api"],
      ["api", "work/api"],
    ]);
    expect(() => app.resolvePlanningRepo("api")).toThrow(AmbiguousPlanningRepoError);

    // An id is never ambiguous, which is how the web app removes a repo.
    const topLevel = app.resolvePlanningRepo("api-2");
    expect(app.removeRepoFromProject(project.id, topLevel.id).repoPaths).toEqual(["work/api"]);
  });
});

describe("archiving", () => {
  beforeEach(() => {
    fx.makeRepo("alpha");
    fx.makeRepo("beta");
  });

  const appWithRepos = () => {
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  };
  const titles = (issues: { title: string }[]) => issues.map((issue) => issue.title).sort();

  it("hides an archived repo's issues without losing them, and brings them back on restore", () => {
    const app = appWithRepos();
    const kept = app.createLocalIssue("alpha", { title: "kept" });
    app.createLocalIssue("beta", { title: "other" });
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "alpha");
    app.setLocalIssueProject(kept.id, project.id);

    const archived = app.archivePlanningRepo("alpha");

    expect(archived.archivedAt).not.toBeNull();
    expect(titles(app.listLocalIssues())).toEqual(["other"]);
    expect(app.listLocalIssues({ includeArchived: true }).find((i) => i.id === kept.id)).toMatchObject({ archived: true });
    expect(app.getLocalIssue(kept.id)).toMatchObject({ title: "kept", projectId: project.id, archived: true });
    // The membership stays, flagged so the project page can say why.
    expect(app.getProject(project.id).repos).toEqual([expect.objectContaining({ slug: "alpha", archived: true })]);
    expect(() => app.createLocalIssue("alpha", { title: "late" })).toThrow(PlanningArchivedError);
    expect(() => app.addRepoToProject(app.createProject("Other").id, "alpha")).toThrow(PlanningArchivedError);
    expect(app.listPlanningRepos().find((repo) => repo.slug === "alpha")?.archivedAt).not.toBeNull();

    expect(app.restorePlanningRepo("alpha").archivedAt).toBeNull();
    expect(titles(app.listLocalIssues())).toEqual(["kept", "other"]);
    expect(app.createLocalIssue("alpha", { title: "late" }).number).toBe(2);
  });

  it("takes a repo out of a project by archiving the membership, and restores it when added again", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    app.addRepoToProject(project.id, "alpha");
    app.addRepoToProject(project.id, "beta");
    const issue = app.createLocalIssue("alpha", { title: "stays filed" });
    app.setLocalIssueProject(issue.id, project.id);

    const removed = app.removeRepoFromProject(project.id, "alpha");

    expect(removed.repoPaths).toEqual(["beta"]);
    expect(removed.removedRepos.map((repo) => repo.path)).toEqual(["alpha"]);
    expect(app.getLocalIssue(issue.id)).toMatchObject({ projectId: project.id, archived: false });
    expect(app.listLocalIssues({ projectId: project.id }).map((i) => i.id)).toEqual([issue.id]);

    const readded = app.addRepoToProject(project.id, "alpha");
    expect(readded.repoPaths).toEqual(["alpha", "beta"]);
    expect(readded.removedRepos).toEqual([]);
  });

  it("archives a finished project: it and its issues leave the lists, and nothing new goes in", () => {
    const app = appWithRepos();
    const project = app.createProject("Done");
    const milestone = app.createMilestone(project.id, { title: "v1" });
    const inProject = app.createLocalIssue("alpha", { title: "in project" });
    const loose = app.createLocalIssue("alpha", { title: "loose" });
    app.setLocalIssueProject(inProject.id, project.id);

    expect(app.archiveProject(project.id).archivedAt).not.toBeNull();

    expect(app.listProjects()).toEqual([]);
    expect(app.listProjects({ includeArchived: true }).map((p) => p.name)).toEqual(["Done"]);
    expect(titles(app.listLocalIssues())).toEqual(["loose"]);
    expect(app.listLocalIssues({ projectId: project.id, includeArchived: true }).map((i) => i.id)).toEqual([inProject.id]);
    expect(() => app.setLocalIssueProject(loose.id, project.id)).toThrow('The project "Done" is archived');
    expect(() => app.createMilestone(project.id, { title: "v2" })).toThrow(PlanningArchivedError);
    expect(() => app.addRepoToProject(project.id, "beta")).toThrow(PlanningArchivedError);
    // Its own issues can still be moved out, and it can still be renamed.
    expect(app.renameProject(project.id, "Shipped").name).toBe("Shipped");
    expect(app.getMilestone(milestone.id).archivedAt).toBeNull();

    expect(app.restoreProject(project.id).archivedAt).toBeNull();
    expect(titles(app.listLocalIssues())).toEqual(["in project", "loose"]);
    expect(app.setLocalIssueProject(loose.id, project.id).projectId).toBe(project.id);
  });

  it("archives a milestone: its issues keep it, but no other issue can join it", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    const milestone = app.createMilestone(project.id, { title: "v1" });
    const done = app.createLocalIssue("alpha", { title: "done" });
    const other = app.createLocalIssue("alpha", { title: "other" });
    for (const issue of [done, other]) app.setLocalIssueProject(issue.id, project.id);
    app.setLocalIssueMilestone(done.id, milestone.id);

    app.archiveMilestone(milestone.id);

    expect(app.listMilestones(project.id)).toEqual([]);
    expect(app.listMilestones(project.id, { includeArchived: true }).map((m) => m.title)).toEqual(["v1"]);
    expect(app.getLocalIssue(done.id)).toMatchObject({ milestoneId: milestone.id, archived: false });
    expect(titles(app.listLocalIssues())).toEqual(["done", "other"]);
    // Setting what it already is changes nothing; joining is refused.
    expect(app.setLocalIssueMilestone(done.id, milestone.id).milestoneId).toBe(milestone.id);
    expect(() => app.setLocalIssueMilestone(other.id, milestone.id)).toThrow(PlanningArchivedError);
    expect(app.setLocalIssueMilestone(done.id, null).milestoneId).toBeNull();

    app.restoreMilestone(milestone.id);
    expect(app.setLocalIssueMilestone(other.id, milestone.id).milestoneId).toBe(milestone.id);
  });

  it("reports archiving something that does not exist", () => {
    const app = appWithRepos();
    expect(() => app.archiveProject(999)).toThrow(ProjectNotFoundError);
    expect(() => app.archiveMilestone(999)).toThrow(MilestoneNotFoundError);
    expect(() => app.archivePlanningRepo("nope")).toThrow(PlanningRepoNotFoundError);
  });

  it("does not follow an archived repo when it moves", () => {
    fs.rmSync(path.join(fx.gitRoot, "alpha"), { recursive: true });
    const repoPath = fx.initRealGitRepo("alpha");
    fx.git(repoPath, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "init");
    const app = appWithRepos();
    app.createLocalIssue("alpha", { title: "parked" });
    app.archivePlanningRepo("alpha");

    fs.renameSync(repoPath, path.join(fx.gitRoot, "elsewhere"));
    app.refresh();

    expect(app.resolvePlanningRepo("alpha").path).toBe("alpha");
  });

  it("adds several repos with the same archive rules as one", () => {
    const app = appWithRepos();
    const project = app.createProject("Launch");
    app.addReposToProject(project.id, ["alpha", "beta"], [{ provider: "github", fullName: "octo/widgets" }]);
    app.removeRepoFromProject(project.id, "alpha");

    // Adding a repo that was taken out brings its membership back.
    const restored = app.addReposToProject(project.id, ["alpha"]);
    expect(restored.repoPaths).toEqual(["alpha", "beta"]);
    expect(restored.removedRepos).toEqual([]);

    // An archived repo stops the whole batch.
    const other = app.createProject("Other");
    app.archivePlanningRepo("alpha");
    expect(() => app.addReposToProject(other.id, ["beta", "alpha"])).toThrow(PlanningArchivedError);
    expect(app.getProject(other.id).repoPaths).toEqual([]);

    // An archived project takes neither clones nor hosted repos, but keeps the ones it has.
    app.archiveProject(project.id);
    expect(() => app.addReposToProject(project.id, [], [{ provider: "gitlab", fullName: "team/api" }])).toThrow(
      PlanningArchivedError,
    );
    expect(app.getProject(project.id).remotes).toEqual([{ provider: "github", fullName: "octo/widgets" }]);
  });

  it("arrives through migration 9 with nothing archived", () => {
    const before = MIGRATIONS.slice(0, 8);
    expect(before.at(-1)?.name).toBe("planning repos");
    new PlanningStore(planningDbPath(), before);
    const db = new DatabaseSync(planningDbPath());
    db.exec("INSERT INTO planning_repos (slug, path, created_at, updated_at) VALUES ('alpha', 'alpha', '', '')");
    db.exec("INSERT INTO projects (name, created_at, updated_at) VALUES ('Launch', '', '')");
    db.exec("INSERT INTO project_repos (project_id, repo_id, added_at) VALUES (1, 1, '')");
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.listRepos()[0]?.archivedAt).toBeNull();
    expect(upgraded.listProjects()[0]).toMatchObject({ archivedAt: null, repoPaths: ["alpha"], removedRepos: [] });
  });
});

describe("epics", () => {
  beforeEach(() => {
    fx.makeRepo("api");
    fx.makeRepo("web");
  });

  const setup = () => {
    const app = createApplication(fx.env());
    app.refresh();
    const project = app.createProject("Launch");
    const file = (repo: string, title: string) => {
      const issue = app.createLocalIssue(repo, { title });
      return app.setLocalIssueProject(issue.id, project.id);
    };
    return { app, project, file };
  };

  it("creates, edits, lists and deletes epics within a project", () => {
    const { app, project } = setup();

    const epic = app.createEpic(project.id, { title: "  Auth rewrite  ", description: " Sign-in, tokens " });
    expect(epic).toMatchObject({ projectId: project.id, title: "Auth rewrite", description: "Sign-in, tokens", archivedAt: null });
    app.createEpic(project.id, { title: "Billing" });

    expect(app.listEpics(project.id).map((e) => e.title)).toEqual(["Auth rewrite", "Billing"]);
    expect(app.updateEpic(epic.id, { title: "Auth" })).toMatchObject({ title: "Auth", description: "Sign-in, tokens" });

    app.deleteEpic(epic.id);
    expect(app.listEpics(project.id).map((e) => e.title)).toEqual(["Billing"]);
    expect(() => app.getEpic(epic.id)).toThrow(EpicNotFoundError);
    expect(() => app.createEpic(999, { title: "x" })).toThrow(ProjectNotFoundError);
  });

  it("validates titles and keeps them unique per project, ignoring case", () => {
    const { app, project } = setup();
    app.createEpic(project.id, { title: "Auth" });

    expect(() => app.createEpic(project.id, { title: "  " })).toThrow(EpicValidationError);
    expect(() => app.createEpic(project.id, { title: "x".repeat(101) })).toThrow(EpicValidationError);
    expect(() => app.createEpic(project.id, { title: "AUTH" })).toThrow(EpicTitleTakenError);
    // Another project can reuse the title.
    expect(app.createEpic(app.createProject("Other").id, { title: "Auth" }).title).toBe("Auth");
  });

  it("groups issues from several repos, alongside a milestone", () => {
    const { app, project, file } = setup();
    const epic = app.createEpic(project.id, { title: "Auth" });
    const milestone = app.createMilestone(project.id, { title: "v1" });
    const api = file("api", "Token endpoint");
    const web = file("web", "Sign-in page");

    app.setLocalIssueEpic(api.id, epic.id);
    app.setLocalIssueEpic(web.id, epic.id);
    // An epic and a milestone are independent: one issue can be in both.
    app.setLocalIssueMilestone(web.id, milestone.id);

    expect(app.listLocalIssues({ epicId: epic.id }).map((i) => i.repoPath).sort()).toEqual(["api", "web"]);
    expect(app.getLocalIssue(web.id)).toMatchObject({ epicId: epic.id, milestoneId: milestone.id });
    expect(app.getLocalIssue(api.id)).toMatchObject({ epicId: epic.id, milestoneId: null });
  });

  it("puts an issue only in an epic of its own project", () => {
    const { app, file } = setup();
    const other = app.createProject("Other");
    const foreign = app.createEpic(other.id, { title: "Elsewhere" });
    const issue = file("api", "Mine");
    const loose = app.createLocalIssue("api", { title: "Loose" });

    expect(() => app.setLocalIssueEpic(issue.id, foreign.id)).toThrow(EpicProjectMismatchError);
    expect(() => app.setLocalIssueEpic(loose.id, foreign.id)).toThrow(EpicProjectMismatchError);
    expect(() => app.setLocalIssueEpic(issue.id, 999)).toThrow(EpicNotFoundError);
    expect(app.getLocalIssue(issue.id).epicId).toBeNull();
  });

  it("clears the epic when the issue changes project, and frees issues when the epic or project goes", () => {
    const { app, project, file } = setup();
    const epic = app.createEpic(project.id, { title: "Auth" });
    const moved = file("api", "Moves");
    const stays = file("web", "Stays");
    for (const issue of [moved, stays]) app.setLocalIssueEpic(issue.id, epic.id);

    expect(app.setLocalIssueProject(moved.id, app.createProject("Other").id).epicId).toBeNull();

    app.deleteEpic(epic.id);
    expect(app.getLocalIssue(stays.id)).toMatchObject({ projectId: project.id, epicId: null });

    const again = app.createEpic(project.id, { title: "Again" });
    app.setLocalIssueEpic(stays.id, again.id);
    app.deleteProject(project.id);
    expect(app.listEpics(undefined, { includeArchived: true }).some((e) => e.projectId === project.id)).toBe(false);
    expect(app.getLocalIssue(stays.id)).toMatchObject({ projectId: null, epicId: null });
  });

  it("archives an epic: its issues keep it, but no other issue can join", () => {
    const { app, project, file } = setup();
    const epic = app.createEpic(project.id, { title: "Auth" });
    const inside = file("api", "Inside");
    const outside = file("web", "Outside");
    app.setLocalIssueEpic(inside.id, epic.id);

    app.archiveEpic(epic.id);

    expect(app.listEpics(project.id)).toEqual([]);
    expect(app.listEpics(project.id, { includeArchived: true }).map((e) => e.title)).toEqual(["Auth"]);
    expect(app.getLocalIssue(inside.id).epicId).toBe(epic.id);
    expect(() => app.setLocalIssueEpic(outside.id, epic.id)).toThrow(PlanningArchivedError);
    expect(() => app.createEpic(app.archiveProject(project.id).id, { title: "Late" })).toThrow(PlanningArchivedError);

    app.restoreProject(project.id);
    app.restoreEpic(epic.id);
    expect(app.setLocalIssueEpic(outside.id, epic.id).epicId).toBe(epic.id);
  });

  it("rolls issue statuses up into a status for the group", () => {
    expect(rollUpStatus([])).toBe("empty");
    expect(rollUpStatus(["todo", "todo"])).toBe("todo");
    expect(rollUpStatus(["todo", "in_review"])).toBe("in_progress");
    expect(rollUpStatus(["done", "todo"])).toBe("in_progress");
    expect(rollUpStatus(["done", "done"])).toBe("done");
  });

  it("arrives through migration 10 without touching existing issues", () => {
    const before = MIGRATIONS.slice(0, 9);
    expect(before.at(-1)?.name).toBe("archiving");
    new PlanningStore(planningDbPath(), before);
    const db = new DatabaseSync(planningDbPath());
    db.exec("INSERT INTO planning_repos (slug, path, created_at, updated_at) VALUES ('api', 'api', '', '')");
    db.exec("INSERT INTO local_issues (repo_id, number, title, created_at, updated_at) VALUES (1, 1, 'Before epics', '', '')");
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(upgraded.listIssues()).toEqual([expect.objectContaining({ title: "Before epics", epicId: null })]);
    expect(upgraded.listEpics()).toEqual([]);
  });
});
