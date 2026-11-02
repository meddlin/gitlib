import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DependabotBusyError,
  DependabotStore,
  DependabotUnavailableError,
  GitLibError,
  KEEP_RUNS,
  LATEST_SCHEMA_VERSION,
  MIGRATIONS,
  PlanningStore,
  classify,
  createApplication,
  isDismissalActive,
  splitDismissed,
  type ClassifiedPr,
  type DependabotReport,
  type WatchedRepo,
} from "../src/index.js";
import { FakeBackend, commitMessage, pr } from "./dependabot-fixtures.js";
import { Fixture } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

const classified = (options: Parameters<typeof pr>[0] = {}): ClassifiedPr => {
  const parsed = pr(options);
  return { pr: parsed, ...classify(parsed) };
};

const watched = (slug: string, status: WatchedRepo["status"] = "checked", openPrs = 0): WatchedRepo => {
  const [owner, repo] = slug.split("/") as [string, string];
  return { ref: { owner, repo }, slug, paths: [repo], status, openPrs };
};

/** A report as `checkDependabot` would build it, with sensible empty parts. */
function report(items: ClassifiedPr[], overrides: Partial<DependabotReport> = {}): DependabotReport {
  return {
    checkedAt: "2026-11-02T08:00:00.000Z",
    watched: [watched("meddlin/gitlib", "checked", items.length)],
    skipped: [],
    items,
    errors: [],
    truncatedOwners: [],
    warnings: [],
    rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-11-02T13:00:00Z" },
    ...overrides,
  };
}

const times = (n: number) => ({ trigger: "web" as const, startedAt: `2026-11-02T08:0${n}:00.000Z`, finishedAt: `2026-11-02T08:0${n}:05.000Z` });

describe("DependabotStore runs", () => {
  let store: DependabotStore;
  beforeEach(() => {
    store = new DependabotStore(path.join(fx.base, "nested", "gitlib.db"));
  });

  it("has nothing before the first run", () => {
    expect(store.latestRun()).toBeNull();
    expect(store.runCount()).toBe(0);
  });

  it("round-trips a report, its verdicts and where it came from", () => {
    const items = [classified({ number: 1 }), classified({ number: 2, mergeStateStatus: "BEHIND" })];
    const saved = store.saveRun(report(items, { warnings: ["careful"], truncatedOwners: ["meddlin"], skipped: [{ relativePath: "x", reason: "it has no git remote" }] }), times(1));

    expect(saved).toMatchObject({ id: 1, trigger: "web", startedAt: "2026-11-02T08:01:00.000Z", finishedAt: "2026-11-02T08:01:05.000Z" });
    expect(store.latestRun()).toEqual(saved);
    expect(saved.report).toMatchObject({
      checkedAt: "2026-11-02T08:00:00.000Z",
      warnings: ["careful"],
      truncatedOwners: ["meddlin"],
      skipped: [{ relativePath: "x", reason: "it has no git remote" }],
      rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-11-02T13:00:00Z" },
    });
    expect(saved.report.watched[0]).toMatchObject({ slug: "meddlin/gitlib", status: "checked", openPrs: 2 });
    // Verdicts come back whole, stamped with when GitHub was asked.
    expect(saved.report.items).toHaveLength(2);
    expect(saved.report.items[0]).toEqual({ ...items[0], observedAt: "2026-11-02T08:00:00.000Z" });
    expect(saved.report.items[1]!.reasons).toEqual(["Behind the base branch."]);
  });

  it("returns the newest run and keeps the older ones apart", () => {
    store.saveRun(report([classified({ number: 1 })]), times(1));
    const second = store.saveRun(report([classified({ number: 2 }), classified({ number: 3 })], { checkedAt: "2026-11-02T08:02:00.000Z" }), times(2));
    expect(store.latestRun()?.id).toBe(second.id);
    expect(store.latestRun()?.report.items.map((item) => item.pr.number)).toEqual([2, 3]);
    expect(store.runCount()).toBe(2);
  });

  it("orders findings by bucket, then repository, then number", () => {
    const saved = store.saveRun(
      report([
        classified({ number: 9, mergeStateStatus: "BEHIND" }),
        classified({ number: 5, repo: "zeta/z" }),
        classified({ number: 7 }),
        classified({ number: 3 }),
      ]),
      times(1),
    );
    expect(saved.report.items.map((item) => [item.bucket, item.pr.repo, item.pr.number])).toEqual([
      ["ready", "meddlin/gitlib", 3],
      ["ready", "meddlin/gitlib", 7],
      ["ready", "zeta/z", 5],
      ["needs-work", "meddlin/gitlib", 9],
    ]);
  });

  describe("when an owner could not be asked", () => {
    const watchedBoth = (bStatus: WatchedRepo["status"]) => [watched("aaa/a", "checked", 1), watched("bbb/b", bStatus, 0)];

    it("carries that repository's last findings forward with their old observation time", () => {
      store.saveRun(
        report([classified({ repo: "aaa/a", number: 1 }), classified({ repo: "bbb/b", number: 2, mergeStateStatus: "BEHIND" })], {
          watched: watchedBoth("checked"),
          checkedAt: "2026-11-01T08:00:00.000Z",
        }),
        times(1),
      );

      const second = store.saveRun(
        report([classified({ repo: "aaa/a", number: 1 })], { watched: watchedBoth("failed"), checkedAt: "2026-11-02T08:00:00.000Z", errors: [{ owner: "bbb", message: "down" }] }),
        times(2),
      );

      expect(second.report.items.map((item) => [item.pr.repo, item.pr.number, item.observedAt])).toEqual([
        ["aaa/a", 1, "2026-11-02T08:00:00.000Z"],
        ["bbb/b", 2, "2026-11-01T08:00:00.000Z"],
      ]);
      expect(second.report.items[1]!.bucket).toBe("needs-work");

      // And again: the original time sticks rather than moving to the run that merely copied it.
      const third = store.saveRun(report([classified({ repo: "aaa/a", number: 1 })], { watched: watchedBoth("failed"), checkedAt: "2026-11-03T08:00:00.000Z" }), times(3));
      expect(third.report.items.find((item) => item.pr.repo === "bbb/b")?.observedAt).toBe("2026-11-01T08:00:00.000Z");
    });

    it("does not carry anything forward for a repository that was asked and has no PRs now, or one the token cannot see", () => {
      store.saveRun(report([classified({ repo: "bbb/b", number: 2 })], { watched: [watched("bbb/b", "checked", 1)] }), times(1));
      const merged = store.saveRun(report([], { watched: [watched("bbb/b", "checked", 0)] }), times(2));
      expect(merged.report.items).toEqual([]);

      store.saveRun(report([classified({ repo: "bbb/b", number: 2 })], { watched: [watched("bbb/b", "checked", 1)] }), times(3));
      const hidden = store.saveRun(report([], { watched: [watched("bbb/b", "unreachable", 0)] }), times(4));
      expect(hidden.report.items).toEqual([]);
    });
  });

  it("keeps only the newest runs", () => {
    for (let i = 0; i < KEEP_RUNS + 3; i += 1) {
      store.saveRun(report([classified({ number: i + 1 })]), { trigger: "schedule", startedAt: `t${i}`, finishedAt: `t${i}` });
    }
    expect(store.runCount()).toBe(KEEP_RUNS);
    expect(store.latestRun()?.id).toBe(KEEP_RUNS + 3);
    // The findings of deleted runs go with them.
    const db = new (process.getBuiltinModule("node:sqlite").DatabaseSync)(store.dbPath);
    expect((db.prepare("SELECT COUNT(DISTINCT run_id) AS n FROM dependabot_findings").get() as { n: number }).n).toBe(KEEP_RUNS);
    db.close();
  });

  it("skips findings it cannot read and treats an unreadable summary as no run", () => {
    store.saveRun(report([classified({ number: 1 }), classified({ number: 2 })]), times(1));
    const { DatabaseSync } = process.getBuiltinModule("node:sqlite");
    const db = new DatabaseSync(store.dbPath);
    db.prepare("UPDATE dependabot_findings SET payload = 'not json' WHERE number = 2").run();
    db.prepare("UPDATE dependabot_findings SET payload = '{\"pr\":{\"repo\":\"a/b\",\"number\":1},\"bucket\":\"sideways\",\"reasons\":[],\"actions\":[]}' WHERE number = 1").run();
    db.close();
    expect(store.latestRun()?.report.items).toEqual([]);

    const damaged = new DatabaseSync(store.dbPath);
    damaged.prepare("UPDATE dependabot_runs SET summary = '{'").run();
    damaged.close();
    expect(store.latestRun()).toBeNull();
  });
});

describe("the lease", () => {
  const T0 = new Date("2026-11-02T08:00:00Z");
  const after = (ms: number) => new Date(T0.getTime() + ms);
  let dbPath: string;
  beforeEach(() => {
    dbPath = path.join(fx.base, "gitlib.db");
  });

  it("is granted once, refused while held, and says who holds it", () => {
    const first = new DependabotStore(dbPath);
    const second = new DependabotStore(dbPath);

    expect(first.acquireLease("web:1", T0, 60_000)).toEqual({ acquired: true });
    const refused = second.acquireLease("cli:2", after(1_000), 60_000);
    expect(refused).toEqual({ acquired: false, heldBy: { holder: "web:1", takenAt: T0.toISOString(), expiresAt: after(60_000).toISOString() } });
    expect(second.currentLease(after(1_000))?.holder).toBe("web:1");
  });

  it("lapses, so a crashed holder cannot block checks forever", () => {
    const store = new DependabotStore(dbPath);
    store.acquireLease("web:1", T0, 60_000);
    expect(store.currentLease(after(59_999))?.holder).toBe("web:1");
    expect(store.currentLease(after(60_000))).toBeNull();
    expect(store.acquireLease("cli:2", after(60_000), 60_000)).toEqual({ acquired: true });
    expect(store.currentLease(after(61_000))?.holder).toBe("cli:2");
  });

  it("is released only by the holder", () => {
    const store = new DependabotStore(dbPath);
    store.acquireLease("web:1", T0, 60_000);
    store.releaseLease("cli:2");
    expect(store.currentLease(after(1))?.holder).toBe("web:1");
    store.releaseLease("web:1");
    expect(store.currentLease(after(1))).toBeNull();
    expect(store.acquireLease("cli:2", after(2), 60_000)).toEqual({ acquired: true });
  });

  it("does not take a lease back that lapsed and was claimed by someone else", () => {
    const store = new DependabotStore(dbPath);
    store.acquireLease("web:1", T0, 1_000);
    store.acquireLease("cli:2", after(2_000), 60_000);
    store.releaseLease("web:1");
    expect(store.currentLease(after(3_000))?.holder).toBe("cli:2");
  });
});

describe("running a check", () => {
  let repoCreated = false;
  beforeEach(() => {
    repoCreated = false;
  });
  /** A starred clone of meddlin/gitlib; calling it again gives another app over the same data. */
  function setUp(backend: FakeBackend | null) {
    if (!repoCreated) {
      fx.writeConfig();
      const repoPath = fx.initRealGitRepo("gitlib");
      fx.git(repoPath, "remote", "add", "origin", "https://github.com/meddlin/gitlib.git");
      repoCreated = true;
    }
    const app = createApplication(fx.env(), undefined, null, null, backend);
    app.refresh();
    app.saveRepositoryFavorite("gitlib", true);
    return app;
  }

  it("saves the run with who started it, and lets go of the lock", async () => {
    const backend = new FakeBackend({ meddlin: { prs: [pr({ number: 1 }), pr({ number: 2, message: commitMessage({ name: "x", type: "major" }) })] } });
    const app = setUp(backend);

    const run = await app.runDependabotCheck({ trigger: "schedule", now: new Date("2026-11-02T08:00:00Z") });

    expect(run).toMatchObject({ id: 1, trigger: "schedule", startedAt: "2026-11-02T08:00:00.000Z" });
    expect(run.report.items.map((item) => [item.pr.number, item.bucket])).toEqual([
      [1, "ready"],
      [2, "review-first"],
    ]);
    expect(app.latestDependabotRun()).toEqual(run);
    expect(app.dependabotStore.currentLease(new Date())).toBeNull();
  });

  it("refuses to start while another check holds the lock, without asking GitHub", async () => {
    const backend = new FakeBackend({ meddlin: {} });
    const app = setUp(backend);
    app.dependabotStore.acquireLease("web:4242", new Date(), 60_000);

    const error = await app.runDependabotCheck({ trigger: "cli" }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(DependabotBusyError);
    expect(error).toBeInstanceOf(GitLibError);
    expect((error as Error).message).toMatch(/already running \(started \S+ by web\)/);
    expect(backend.calls).toEqual([]);
    expect(app.latestDependabotRun()).toBeNull();
  });

  it("lets go of the lock when the check fails, and saves nothing", async () => {
    const boom = new TypeError("a bug");
    const app = setUp(new FakeBackend({ meddlin: boom }));
    await expect(app.runDependabotCheck({ trigger: "web" })).rejects.toBe(boom);
    expect(app.dependabotStore.currentLease(new Date())).toBeNull();
    expect(app.latestDependabotRun()).toBeNull();

    const noToken = setUp(null);
    await expect(noToken.runDependabotCheck({ trigger: "web" })).rejects.toBeInstanceOf(DependabotUnavailableError);
    expect(noToken.dependabotStore.currentLease(new Date())).toBeNull();
  });

  it("saves a run in which an owner failed, so the page can show what could not be checked", async () => {
    const app = setUp(new FakeBackend({ meddlin: new DependabotUnavailableError("Could not reach GitHub") }));
    const run = await app.runDependabotCheck({ trigger: "web" });
    expect(run.report.errors).toEqual([{ owner: "meddlin", message: "Could not reach GitHub" }]);
    expect(run.report.watched[0]!.status).toBe("failed");
  });

  it("uses the same database file as the scan data", () => {
    const app = setUp(null);
    expect(app.dependabotStore.dbPath).toBe(app.store.dbPath);
    expect(fs.existsSync(app.store.dbPath)).toBe(true);
  });
});

describe("dismissals", () => {
  const NOW = new Date("2026-11-02T08:00:00Z");
  const dismissal = (snoozedUntil: string | null, repo = "meddlin/gitlib", number = 1) => ({ repo, number, snoozedUntil, createdAt: "2026-11-01T00:00:00Z" });

  describe("isDismissalActive", () => {
    it("hides until closed when there is no end, and until the end otherwise", () => {
      expect(isDismissalActive(dismissal(null), NOW)).toBe(true);
      expect(isDismissalActive(dismissal("2026-11-02T08:00:01Z"), NOW)).toBe(true);
      expect(isDismissalActive(dismissal("2026-11-02T08:00:00Z"), NOW)).toBe(false);
      expect(isDismissalActive(dismissal("2026-11-01T08:00:00Z"), NOW)).toBe(false);
    });
  });

  describe("splitDismissed", () => {
    const items = [classified({ number: 1 }), classified({ number: 2 }), classified({ number: 3, repo: "other/thing" })];

    it("separates what is put aside, matching the repository without regard to case", () => {
      const { active, dismissed } = splitDismissed(items, [dismissal(null, "Meddlin/GitLib", 2)], NOW);
      expect(active.map((item) => item.pr.number)).toEqual([1, 3]);
      expect(dismissed.map((item) => [item.pr.number, item.dismissal.snoozedUntil])).toEqual([[2, null]]);
    });

    it("ignores ended snoozes, other repositories and other numbers", () => {
      const { active, dismissed } = splitDismissed(
        items,
        [dismissal("2026-11-01T00:00:00Z", "meddlin/gitlib", 1), dismissal(null, "other/thing", 2), dismissal(null, "meddlin/gitlib", 99)],
        NOW,
      );
      expect(dismissed).toEqual([]);
      expect(active).toHaveLength(3);
    });
  });

  describe("in planning.db", () => {
    it("is stored, replaced, listed and removed", () => {
      fx.writeConfig();
      const app = createApplication(fx.env());

      const first = app.dismissDependabotPr("Meddlin/GitLib", 7);
      expect(first).toMatchObject({ repo: "meddlin/gitlib", number: 7, snoozedUntil: null });
      app.dismissDependabotPr("meddlin/gitlib", 7, "2030-01-01T00:00:00Z");
      app.dismissDependabotPr("zeta/z", 1);

      expect(app.listDependabotDismissals().map((d) => [d.repo, d.number, d.snoozedUntil])).toEqual([
        ["meddlin/gitlib", 7, "2030-01-01T00:00:00.000Z"],
        ["zeta/z", 1, null],
      ]);

      app.restoreDependabotPr("MEDDLIN/gitlib", 7);
      app.restoreDependabotPr("nobody/home", 1);
      expect(app.listDependabotDismissals().map((d) => d.repo)).toEqual(["zeta/z"]);
    });

    it("refuses what is not a repository, a pull request number or a date", () => {
      fx.writeConfig();
      const app = createApplication(fx.env());
      for (const repo of ["gitlib", "a/b/c", "bad owner/x", "/x", 'x/y"z']) {
        expect(() => app.dismissDependabotPr(repo, 1)).toThrow(GitLibError);
      }
      expect(() => app.dismissDependabotPr("a/b", 0)).toThrow("not a pull request number");
      expect(() => app.dismissDependabotPr("a/b", 1.5)).toThrow(GitLibError);
      expect(() => app.dismissDependabotPr("a/b", 1, "tomorrow-ish")).toThrow("not a date");
      expect(app.listDependabotDismissals()).toEqual([]);
    });

    it("arrives through an append-only migration that leaves older data alone", () => {
      expect(MIGRATIONS[3]).toMatchObject({ version: 4, name: "dependabot dismissals" });
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(4);

      const planningDb = path.join(fx.base, "planning.db");
      const old = new PlanningStore(planningDb, MIGRATIONS.slice(0, 3));
      const issue = old.createIssue({ repoPath: "gitlib", title: "Keep me", body: "" }, "2026-11-01T00:00:00Z");
      expect(old.schemaVersion()).toBe(3);

      const upgraded = new PlanningStore(planningDb);
      expect(upgraded.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      expect(upgraded.getIssue(issue.id)?.title).toBe("Keep me");
      upgraded.dismissDependabotPr("a/b", 1, null, "2026-11-02T00:00:00Z");
      expect(upgraded.listDependabotDismissals()).toHaveLength(1);
    });
  });
});
