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
    const old = new PlanningStore(planningDbPath(), [v1]);
    const open = old.createIssue({ repoPath: "alpha", title: "open", body: "" }, "2026-01-01T00:00:00+00:00");
    const closed = old.createIssue({ repoPath: "alpha", title: "closed", body: "" }, "2026-01-01T00:00:00+00:00");
    const db = new DatabaseSync(planningDbPath());
    db.prepare("UPDATE local_issues SET state = 'closed', closed_at = ? WHERE id = ?").run("2026-01-02T00:00:00+00:00", closed.id);
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.getIssue(open.id)?.status).toBe("todo");
    expect(upgraded.getIssue(closed.id)?.status).toBe("done");
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
    expect(() => app.setLocalIssueProject(issue.id, 999)).toThrow(ProjectNotFoundError);

    app.deleteProject(project.id);
    expect(app.getLocalIssue(issue.id).projectId).toBeNull();
    expect(app.setLocalIssueProject(issue.id, null).projectId).toBeNull();
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
    const old = new PlanningStore(planningDbPath(), before);
    const issue = old.createIssue({ repoPath: "alpha", title: "Ship it", body: "" }, "2026-01-01T00:00:00+00:00");
    // The store only knows the newest schema, so make the project and file the issue the way a version-5 gitlib would.
    const db = new DatabaseSync(planningDbPath());
    const { lastInsertRowid } = db
      .prepare("INSERT INTO projects (name, created_at, updated_at) VALUES ('Launch', '2026-01-01T00:00:00+00:00', '2026-01-01T00:00:00+00:00')")
      .run();
    const project = { id: Number(lastInsertRowid) };
    db.prepare("UPDATE local_issues SET project_id = ? WHERE id = ?").run(project.id, issue.id);
    db.close();

    const upgraded = new PlanningStore(planningDbPath());

    expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    expect(upgraded.getIssue(issue.id)).toMatchObject({ projectId: project.id, milestoneId: null });
    expect(upgraded.listMilestones()).toEqual([]);
    expect(upgraded.getProject(project.id)).toMatchObject({ name: "Launch", repoPaths: [], remotes: [] });
  });
});
