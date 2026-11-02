import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DependabotUnavailableError,
  LlmUnavailableError,
  createApplication,
  parsePullRequest,
  type ChatBackend,
  type ChatEvent,
  type ChatRequest,
  type DependabotBackend,
  type DependabotPr,
  type GitLibApp,
  type OwnerPulls,
} from "@gitlib/core";
import { BUCKET_ORDER, ciLabel, codeSegments, describeSchedule, holderName, prKey, safeHref, snoozeUntil } from "../src/lib/dependabot";
import { attempt, buildBadge, buildView, ensureBackground, runCheck, stopBackground } from "../src/server/dependabot.server";

// --- lib/dependabot.ts -------------------------------------------------------------------------------------------

describe("display helpers", () => {
  it("words each CI state, naming what failed or is running", () => {
    expect(ciLabel({ state: "success" })).toBe("CI passing");
    expect(ciLabel({ state: "failing", failed: ["lint", "test"] })).toBe("CI failing (lint, test)");
    expect(ciLabel({ state: "failing", failed: [] })).toBe("CI failing");
    expect(ciLabel({ state: "pending", pending: ["build"] })).toBe("CI pending (build)");
    expect(ciLabel({ state: "unknown", reason: "long reason" })).toBe("CI unknown");
  });

  it("only links to https pages on github.com", () => {
    expect(safeHref("https://github.com/meddlin/gitlib/pull/41")).toBe("https://github.com/meddlin/gitlib/pull/41");
    for (const bad of ["javascript:alert(1)", "http://github.com/a/b/pull/1", "https://evil.example/github.com", "https://github.com.evil.example/x", "//github.com/x", "not a url", ""]) {
      expect(safeHref(bad)).toBeNull();
    }
  });

  it("splits text on backticks without interpreting anything else", () => {
    expect(codeSegments("Comment `@dependabot rebase` on the PR.")).toEqual([
      { text: "Comment ", code: false },
      { text: "@dependabot rebase", code: true },
      { text: " on the PR.", code: false },
    ]);
    expect(codeSegments("<img src=x onerror=alert(1)>")).toEqual([{ text: "<img src=x onerror=alert(1)>", code: false }]);
    expect(codeSegments("")).toEqual([]);
    expect(codeSegments("dangling `tick")).toEqual([
      { text: "dangling ", code: false },
      { text: "tick", code: true },
    ]);
  });

  it("describes a schedule in a few words", () => {
    expect(describeSchedule({ enabled: false, days: [1, 2], time: "08:00" })).toBe("off");
    expect(describeSchedule({ enabled: true, days: [1, 2, 3, 4, 5], time: "08:00" })).toBe("weekdays at 08:00");
    expect(describeSchedule({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "06:30" })).toBe("every day at 06:30");
    expect(describeSchedule({ enabled: true, days: [6, 0], time: "10:00" })).toBe("weekends at 10:00");
    // Monday first, even though Sunday is day 0.
    expect(describeSchedule({ enabled: true, days: [0, 3, 1], time: "06:45" })).toBe("Mon, Wed, Sun at 06:45");
  });

  it("names who holds the lock, and a snooze end a number of days away", () => {
    expect(holderName("web:123")).toBe("the web page");
    expect(holderName("schedule:9")).toBe("the schedule");
    expect(holderName("cli:1")).toBe("the CLI");
    expect(holderName("mystery")).toBe("another process");
    expect(snoozeUntil(7, new Date("2026-11-02T08:00:00Z"))).toBe("2026-11-09T08:00:00.000Z");
    expect(prKey({ repo: "a/b", number: 4 })).toBe("a/b#4");
    expect(BUCKET_ORDER).toEqual(["ready", "review-first", "needs-work", "waiting"]);
  });
});

// --- server/dependabot.server.ts ---------------------------------------------------------------------------------

function pr(overrides: Partial<DependabotPr> = {}): DependabotPr {
  const number = overrides.number ?? 1;
  const repo = overrides.repo ?? "meddlin/gitlib";
  const node = {
    number,
    title: `bump thing (#${number})`,
    url: `https://github.com/${repo}/pull/${number}`,
    headRefName: "dependabot/npm_and_yarn/thing-1.0.1",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    author: { login: "dependabot" },
    repository: { nameWithOwner: repo },
    labels: { nodes: [{ name: "dependencies" }] },
    commits: {
      totalCount: 1,
      nodes: [
        {
          commit: {
            message: "bump\n\n---\nupdated-dependencies:\n- dependency-name: thing\n  update-type: version-update:semver-patch\n...\n",
            statusCheckRollup: { state: "SUCCESS", contexts: { nodes: [] } },
          },
        },
      ],
    },
  };
  return { ...parsePullRequest(node)!, ...overrides };
}

class FakeBackend implements DependabotBackend {
  readonly label = "fake";
  calls = 0;
  constructor(public answer: Partial<OwnerPulls> | Error) {}
  async fetchOwner(owner: string): Promise<OwnerPulls> {
    this.calls += 1;
    if (this.answer instanceof Error) throw this.answer;
    return { owner, prs: [], truncated: false, unreachable: [], warnings: [], rateLimit: null, ...this.answer };
  }
}

let base: string;
beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-web-dependabot-")));
});
afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

/** An app over a starred clone of meddlin/gitlib, with the given GitHub behind it (null = no token). */
function makeApp(backend: DependabotBackend | null, chat: ChatBackend | null = null): GitLibApp {
  const home = path.join(base, "home");
  const clone = path.join(base, "git", "gitlib");
  if (!fs.existsSync(clone)) {
    fs.mkdirSync(clone, { recursive: true });
    execFileSync("git", ["init", "-q", clone]);
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/meddlin/gitlib.git"]);
    fs.mkdirSync(home);
    fs.writeFileSync(path.join(home, "config.toml"), `roots = ["${path.join(base, "git")}"]\n\n[search]\nenabled = false\n`);
  }
  const app = createApplication({ GITLIB_HOME: home }, undefined, null, chat, backend);
  app.refresh();
  app.saveRepositoryFavorite("gitlib", true);
  return app;
}

describe("buildView", () => {
  it("is empty before the first check, and says a check needs a token when there is none", () => {
    const view = buildView(new Date(), makeApp(null));
    expect(view).toMatchObject({
      canCheck: false,
      running: null,
      run: null,
      items: [],
      dismissed: [],
      report: null,
      counts: { ready: 0, "review-first": 0, "needs-work": 0, waiting: 0 },
    });
    expect(view.unavailableReason).toContain("GITLIB_GITHUB_TOKEN");
    expect(buildView(new Date(), makeApp(new FakeBackend({}))).unavailableReason).toBeNull();
  });

  it("shows the saved check with counts, setting aside what the user dismissed or snoozed", async () => {
    const backend = new FakeBackend({
      prs: [pr({ number: 1 }), pr({ number: 2, mergeStateStatus: "BEHIND" }), pr({ number: 3, mergeable: "UNKNOWN" }), pr({ number: 4, updateType: "major" })],
    });
    const app = makeApp(backend);
    expect(await runCheck(app)).toBeNull();

    const view = buildView(new Date(), app);
    expect(view.canCheck).toBe(true);
    expect(view.run).toMatchObject({ id: 1, trigger: "web" });
    expect(view.items.map((item) => [item.pr.number, item.bucket])).toEqual([
      [1, "ready"],
      [4, "review-first"],
      [2, "needs-work"],
      [3, "waiting"],
    ]);
    expect(view.counts).toEqual({ ready: 1, "review-first": 1, "needs-work": 1, waiting: 1 });
    expect(view.report?.watched).toMatchObject([{ slug: "meddlin/gitlib", status: "checked", openPrs: 4 }]);
    // The PR list is the page's to show; it is not repeated inside the report part.
    expect(view.report).not.toHaveProperty("items");

    expect(attempt(() => void app.dismissDependabotPr("meddlin/gitlib", 2))).toBeNull();
    const week = new Date(Date.now() + 7 * 86_400_000).toISOString();
    expect(attempt(() => void app.dismissDependabotPr("meddlin/gitlib", 4, week))).toBeNull();
    const after = buildView(new Date(), app);
    expect(after.items.map((item) => item.pr.number)).toEqual([1, 3]);
    // Set-aside rows keep the buckets' order.
    expect(after.dismissed.map((item) => [item.pr.number, item.dismissal.snoozedUntil])).toEqual([
      [4, week],
      [2, null],
    ]);
    expect(after.counts).toEqual({ ready: 1, "review-first": 0, "needs-work": 0, waiting: 1 });

    // The snooze ends: the PR comes back without anyone doing anything.
    expect(buildView(new Date(Date.now() + 8 * 86_400_000), app).items.map((item) => item.pr.number)).toEqual([1, 4, 3]);
  });

  it("shows a check that is running right now", () => {
    const app = makeApp(new FakeBackend({}));
    app.dependabotStore.acquireLease("schedule:77", new Date(), 60_000);
    expect(buildView(new Date(), app).running).toMatchObject({ by: "schedule:77" });
    expect(buildView(new Date(Date.now() + 120_000), app).running).toBeNull();
  });
});

describe("buildBadge", () => {
  it("counts what needs a person: everything except what is waiting", async () => {
    const app = makeApp(new FakeBackend({ prs: [pr({ number: 1 }), pr({ number: 2 }), pr({ number: 3, mergeStateStatus: "BEHIND" }), pr({ number: 4, mergeable: "UNKNOWN" })] }));
    expect(buildBadge(new Date(), app)).toEqual({ actionable: 0, counts: { ready: 0, "review-first": 0, "needs-work": 0, waiting: 0 }, checkedAt: null });

    await runCheck(app);
    const badge = buildBadge(new Date(), app);
    expect(badge.actionable).toBe(3);
    expect(badge.counts).toEqual({ ready: 2, "review-first": 0, "needs-work": 1, waiting: 1 });
    expect(badge.checkedAt).toMatch(/^\d{4}-\d\d-\d\dT/);

    app.dismissDependabotPr("meddlin/gitlib", 3);
    expect(buildBadge(new Date(), app).actionable).toBe(2);
  });
});

describe("runCheck", () => {
  it("answers with the reason, not an exception, when a check cannot run", async () => {
    expect(await runCheck(makeApp(null))).toContain("needs a GitHub token");

    const app = makeApp(new FakeBackend({}));
    app.dependabotStore.acquireLease("cli:5", new Date(), 60_000);
    expect(await runCheck(app)).toMatch(/already running \(started \S+ by cli\)/);
  });

  it("saves a check in which GitHub could not be reached, so the page can say so", async () => {
    const app = makeApp(new FakeBackend(new DependabotUnavailableError("Could not reach GitHub at api.github.com (ENOTFOUND).")));
    expect(await runCheck(app)).toBeNull();
    expect(buildView(new Date(), app).report?.errors).toEqual([{ owner: "meddlin", message: "Could not reach GitHub at api.github.com (ENOTFOUND)." }]);
  });

  it("lets a bug through instead of hiding it as a message", async () => {
    const boom = new TypeError("a bug");
    await expect(runCheck(makeApp(new FakeBackend(boom)))).rejects.toBe(boom);
  });
});

describe("attempt", () => {
  it("answers with the reason when the request is refused", () => {
    const app = makeApp(null);
    expect(attempt(() => void app.dismissDependabotPr("not a repo", 1))).toContain("is not a GitHub repository");
    expect(attempt(() => void app.dismissDependabotPr("a/b", 1, "someday"))).toContain("is not a date");
    expect(attempt(() => app.restoreDependabotPr("a/b", 1))).toBeNull();
    expect(() => attempt(() => { throw new TypeError("bug"); })).toThrow("bug");
  });
});

describe("the schedule on the page", () => {
  it("is off until saved, and then says when the next check is", () => {
    const app = makeApp(null);
    expect(buildView(new Date(), app).schedule).toMatchObject({ enabled: false, days: [1, 2, 3, 4, 5], time: "08:00", nextRunAt: null, active: false, lastAttemptAt: null, lastError: null });

    expect(attempt(() => void app.saveDependabotSchedule({ enabled: true, days: [0, 1, 2, 3, 4, 5, 6], time: "09:30" }))).toBeNull();
    const view = buildView(new Date("2026-11-02T08:00:00"), app);
    expect(view.schedule).toMatchObject({ enabled: true, time: "09:30", timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone });
    // The next slot is today at 09:30 on the server's wall clock.
    expect(new Date(view.schedule.nextRunAt!).getTime()).toBe(new Date("2026-11-02T09:30:00").getTime());
  });

  it("refuses a schedule the server could not follow, with the reason", () => {
    const app = makeApp(null);
    expect(attempt(() => void app.saveDependabotSchedule({ enabled: true, days: [], time: "08:00" }))).toBe("Pick at least one day, or turn the schedule off.");
    expect(attempt(() => void app.saveDependabotSchedule({ enabled: true, days: [1], time: "8am" }))).toContain("08:00");
    expect(buildView(new Date(), app).schedule.enabled).toBe(false);
  });

  it("shows the scheduler's state: running, and what went wrong last", () => {
    const app = makeApp(null);
    const scheduler = app.createDependabotScheduler();
    expect(buildView(new Date(), app, scheduler).schedule.active).toBe(false);
    scheduler.start(3_600_000);
    try {
      expect(buildView(new Date(), app, scheduler).schedule).toMatchObject({ active: true, lastError: null });
    } finally {
      scheduler.stop();
    }
  });

  it("starts one scheduler and one note writer per server, however often it is asked", () => {
    stopBackground();
    try {
      const app = makeApp(null);
      const first = ensureBackground(app);
      expect(first.scheduler.started).toBe(true);
      expect(first.explainer.started).toBe(true);
      const again = ensureBackground(app);
      expect(again.scheduler).toBe(first.scheduler);
      expect(again.explainer).toBe(first.explainer);
    } finally {
      stopBackground();
    }
  });
});

class FakeChat implements ChatBackend {
  readonly label = "fake-ollama";
  numCtx = 8192;
  failWith: Error | null = null;
  async listModels() {
    return ["qwen3:8b"];
  }
  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    if (this.failWith) throw this.failWith;
    void request;
    yield { type: "delta", text: "Behind the base branch; a rebase should fix it." };
    yield { type: "done", promptTokens: 1, replyTokens: 1, doneReason: "stop" };
  }
}

describe("notes on the page", () => {
  const behind = (number: number, extra: Partial<DependabotPr> = {}) => pr({ number, mergeStateStatus: "BEHIND", ...extra });

  it("shows a current note beside its pull request, and counts what is still to write", async () => {
    const backend = new FakeBackend({ prs: [pr({ number: 1 }), behind(2)] });
    const app = makeApp(backend, new FakeChat());
    await runCheck(app);

    expect(buildView(new Date(), app).explainer).toEqual({ enabled: true, active: false, pending: 1, lastError: null });
    expect(buildView(new Date(), app).notes).toEqual({});

    const explainer = app.createDependabotExplainer();
    await explainer.drain(new Date());
    const view = buildView(new Date(), app, null, explainer);
    expect(view.notes).toEqual({ "meddlin/gitlib#2": { text: "Behind the base branch; a rebase should fix it.", model: "qwen3:8b", createdAt: expect.any(String) } });
    expect(view.explainer.pending).toBe(0);
    // The ready PR has no note, and the verdicts are exactly what the check found.
    expect(view.items.map((item) => [item.pr.number, item.bucket])).toEqual([
      [1, "ready"],
      [2, "needs-work"],
    ]);
  });

  it("hides a note whose facts have changed until it has been written again", async () => {
    const backend = new FakeBackend({ prs: [behind(2)] });
    const app = makeApp(backend, new FakeChat());
    await runCheck(app);
    await app.createDependabotExplainer().drain(new Date());
    expect(Object.keys(buildView(new Date(), app).notes)).toEqual(["meddlin/gitlib#2"]);

    backend.answer = { prs: [pr({ number: 2, mergeable: "CONFLICTING" })] };
    await runCheck(app);
    const view = buildView(new Date(), app);
    expect(view.notes).toEqual({});
    expect(view.explainer.pending).toBe(1);
  });

  it("does not show notes of pull requests that were put aside", async () => {
    const app = makeApp(new FakeBackend({ prs: [behind(2)] }), new FakeChat());
    await runCheck(app);
    await app.createDependabotExplainer().drain(new Date());
    app.dismissDependabotPr("meddlin/gitlib", 2);
    const view = buildView(new Date(), app);
    expect(view.notes).toEqual({});
    expect(view.explainer.pending).toBe(0);
  });

  it("has nothing to write and nothing pending without a model server", async () => {
    const app = makeApp(new FakeBackend({ prs: [behind(2)] }));
    await runCheck(app);
    expect(buildView(new Date(), app).explainer).toEqual({ enabled: false, active: false, pending: 0, lastError: null });
  });

  it("says why the notes are paused when the model server fails", async () => {
    const chat = new FakeChat();
    chat.failWith = new LlmUnavailableError("Cannot reach Ollama at fake-ollama: ECONNREFUSED");
    const app = makeApp(new FakeBackend({ prs: [behind(2)] }), chat);
    await runCheck(app);
    const explainer = app.createDependabotExplainer();
    await explainer.drain(new Date());
    expect(buildView(new Date(), app, null, explainer).explainer).toMatchObject({ pending: 1, lastError: "Cannot reach Ollama at fake-ollama: ECONNREFUSED" });
  });
});
