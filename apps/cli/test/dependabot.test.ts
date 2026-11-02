import {
  DependabotAuthError,
  DependabotUnavailableError,
  createApplication,
  type DependabotBackend,
  type DependabotPr,
  type OwnerPulls,
} from "@gitlib/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Fixture } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

/** A clean, green patch update unless an override says otherwise. */
function pr(overrides: Partial<DependabotPr> = {}): DependabotPr {
  const number = overrides.number ?? 41;
  const repo = overrides.repo ?? "meddlin/gitlib";
  return {
    repo,
    number,
    title: "build(deps): bump undici from 6.27.0 to 6.29.1",
    url: `https://github.com/${repo}/pull/${number}`,
    author: "dependabot",
    headRefName: "dependabot/npm_and_yarn/undici-6.29.1",
    ecosystem: "npm_and_yarn",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: ["dependencies"],
    commitCount: 1,
    updateType: "patch",
    dependencies: ["undici"],
    ci: { state: "success" },
    createdAt: "2026-10-26T06:00:00Z",
    updatedAt: "2026-10-30T06:00:00Z",
    ...overrides,
  };
}

class FakeBackend implements DependabotBackend {
  readonly label = "fake";
  calls: string[] = [];
  constructor(private readonly byOwner: Record<string, Partial<OwnerPulls> | Error>) {}

  async fetchOwner(owner: string): Promise<OwnerPulls> {
    this.calls.push(owner);
    const answer = this.byOwner[owner];
    if (answer instanceof Error) throw answer;
    return { owner, prs: [], truncated: false, unreachable: [], warnings: [], rateLimit: null, ...answer };
  }
}

/** Real repos with the given `origin` URLs, all starred. */
function starRepos(remotes: Record<string, string | null>, starred = Object.keys(remotes)): void {
  fx.writeConfig();
  for (const [relativePath, url] of Object.entries(remotes)) {
    const repoPath = fx.initRealGitRepo(relativePath);
    if (url) fx.git(repoPath, "remote", "add", "origin", url);
  }
  const app = createApplication(fx.env());
  app.refresh();
  for (const relativePath of starred) app.saveRepositoryFavorite(relativePath, true);
}

describe("gitlib dependabot check", () => {
  it("groups the report by bucket, with reasons, suggestions and links", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git", web: "git@github.com:meddlin/web.git" });
    const backend = new FakeBackend({
      meddlin: {
        prs: [
          pr({ number: 41 }),
          pr({ number: 42, repo: "meddlin/web", title: "build(deps): bump left-pad from 1.0.0 to 2.0.0", updateType: "major" }),
          pr({ number: 43, mergeStateStatus: "BEHIND" }),
          pr({ number: 44, mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" }),
        ],
        rateLimit: { cost: 3, remaining: 4997, resetAt: "2026-11-02T13:00:00Z" },
      },
    });

    const result = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    expect(backend.calls).toEqual(["meddlin"]);
    expect(result.stdout.trimEnd().split("\n")).toEqual([
      expect.stringMatching(/^Dependabot pull requests on 2 starred repositories \(checked \d{4}-\d\d-\d\dT[\d:.]+Z\)$/),
      "1 ready, 1 review first, 1 needs work, 1 waiting",
      "",
      "READY (1)",
      "  meddlin/gitlib#41  build(deps): bump undici from 6.27.0 to 6.29.1",
      "    npm_and_yarn | patch update | CI passing",
      "    https://github.com/meddlin/gitlib/pull/41",
      "    - All checks pass.",
      "    - No conflicts and up to date with the base branch.",
      "    - Patch update.",
      "    Next: Merge it from the PR page on GitHub.",
      "",
      "REVIEW FIRST (1)",
      "  meddlin/web#42  build(deps): bump left-pad from 1.0.0 to 2.0.0",
      "    npm_and_yarn | major update | CI passing",
      "    https://github.com/meddlin/web/pull/42",
      "    - Major version bump.",
      "    Next: Read the release notes and changelog linked in the PR before merging.",
      "    Next: If you do not want this update, comment `@dependabot ignore this major version`.",
      "",
      "NEEDS WORK (1)",
      "  meddlin/gitlib#43  build(deps): bump undici from 6.27.0 to 6.29.1",
      "    npm_and_yarn | patch update | CI passing",
      "    https://github.com/meddlin/gitlib/pull/43",
      "    - Behind the base branch.",
      "    Next: Comment `@dependabot rebase` on the PR to rebase it onto the base branch.",
      "    Next: If you do not want this update, comment `@dependabot ignore this patch version`.",
      "",
      "WAITING (1)",
      "  meddlin/gitlib#44  build(deps): bump undici from 6.27.0 to 6.29.1",
      "    npm_and_yarn | patch update | CI passing",
      "    https://github.com/meddlin/gitlib/pull/44",
      "    - GitHub is still working out whether it merges cleanly (mergeability UNKNOWN is transient).",
      "    Next: Run the check again in a minute or two.",
      "",
      "GitHub quota: this check cost 3, 4997 left until 2026-11-02T13:00:00Z.",
      "",
      "Saved as run 1; read it again with `gitlib dependabot show`.",
    ]);
  });

  it("never suggests a retired Dependabot command", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const backend = new FakeBackend({
      meddlin: {
        prs: [pr({ number: 1 }), pr({ number: 2, mergeable: "CONFLICTING" }), pr({ number: 3, updateType: "major" }), pr({ number: 4, isDraft: true })],
      },
    });
    const { stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(stdout).not.toMatch(/@dependabot\s+(merge|squash|cancel|close|reopen)/i);
    expect(stdout).toContain("`@dependabot rebase`");
    expect(stdout).toContain("`@dependabot recreate`");
  });

  it("says CI unknown, with the reason, and does not call the PR green", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const backend = new FakeBackend({
      meddlin: {
        prs: [pr({ ci: { state: "unknown", reason: "GitHub would not return the checks (Resource not accessible by personal access token)." } })],
      },
    });

    const { code, stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });

    expect(code).toBe(0);
    expect(stdout).toContain("REVIEW FIRST (1)");
    expect(stdout).not.toContain("READY");
    expect(stdout).not.toContain("CI passing");
    expect(stdout).toContain("npm_and_yarn | patch update | CI unknown");
    expect(stdout).toContain("- CI unknown: GitHub would not return the checks (Resource not accessible by personal access token).");
  });

  it("names failing and pending checks", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const backend = new FakeBackend({
      meddlin: {
        prs: [
          pr({ number: 1, ci: { state: "failing", failed: ["lint", "test"] } }),
          pr({ number: 2, ci: { state: "pending", pending: ["build"] } }),
        ],
      },
    });
    const { stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(stdout).toContain("npm_and_yarn | patch update | CI failing (lint, test)");
    expect(stdout).toContain("- Checks failing: lint, test.");
    expect(stdout).toContain("npm_and_yarn | patch update | CI pending (build)");
    expect(stdout).toContain("- Checks still running: build.");
  });

  it("says how many starred repositories were skipped, and which", async () => {
    starRepos(
      {
        gitlib: "https://github.com/meddlin/gitlib.git",
        gitlab: "https://gitlab.com/meddlin/thing.git",
        lonely: null,
        unstarred: "https://github.com/meddlin/unstarred.git",
      },
      ["gitlib", "gitlab", "lonely"],
    );
    const backend = new FakeBackend({ meddlin: { prs: [pr()] } });

    const { code, stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });

    expect(code).toBe(0);
    // The unstarred repo is not asked about at all.
    expect(backend.calls).toEqual(["meddlin"]);
    expect(stdout).toContain("Skipped 2 starred repositories (no GitHub remote to ask about):");
    expect(stdout).toContain("  gitlab: no remote is on github.com (origin: gitlab.com)");
    expect(stdout).toContain("  lonely: it has no git remote");
    expect(stdout).not.toContain("unstarred");
  });

  it("lists watched repositories that have nothing open", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git", quiet: "https://github.com/meddlin/quiet.git" });
    const backend = new FakeBackend({ meddlin: { prs: [pr()] } });
    const { stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(stdout).toContain("No open Dependabot pull requests: meddlin/quiet.");
  });

  it("says plainly when there are no open PRs at all", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const { code, stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: new FakeBackend({ meddlin: {} }) });
    expect(code).toBe(0);
    expect(stdout).toContain("No open Dependabot pull requests.");
  });

  it("says what to do when no starred repository has a GitHub remote", async () => {
    starRepos({ gitlab: "https://gitlab.com/meddlin/thing.git" });
    const backend = new FakeBackend({});
    const { code, stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(code).toBe(0);
    expect(backend.calls).toEqual([]);
    expect(stdout).toContain("No starred repository has a GitHub remote");
    expect(stdout).toContain("  gitlab: no remote is on github.com (origin: gitlab.com)");
  });

  it("flags what it could not check, and exits 1 only when an owner failed", async () => {
    starRepos({
      secret: "https://github.com/meddlin/secret.git",
      big: "https://github.com/meddlin/big.git",
      down: "https://github.com/downorg/down.git",
    });
    const backend = new FakeBackend({
      meddlin: { unreachable: ["meddlin/secret"], truncated: true, warnings: ["labels exploded"] },
      downorg: new DependabotUnavailableError("Could not reach GitHub at api.github.com (ENOTFOUND)."),
    });

    const { code, stdout } = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });

    expect(code).toBe(1);
    expect(stdout).toContain("NOT CHECKED: GitHub does not show these to your token (private without access, renamed or deleted): meddlin/secret.");
    expect(stdout).toContain("NOT CHECKED: downorg: Could not reach GitHub at api.github.com (ENOTFOUND).");
    expect(stdout).toContain("INCOMPLETE: meddlin has more matching pull requests than GitHub search returns, so some are missing.");
    expect(stdout).toContain("GitHub warning: labels exploded");
    // An unreachable repository is not listed among the repositories with nothing open.
    expect(stdout).not.toContain("No open Dependabot pull requests: meddlin/secret");

    const withoutFailure = await fx.runCli(["dependabot", "check"], { dependabotBackend: new FakeBackend({ meddlin: { unreachable: ["meddlin/secret"] }, downorg: {} }) });
    expect(withoutFailure.code).toBe(0);
  });

  it("explains how to set a token when there is none, and stops", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const result = await fx.runCli(["dependabot", "check"], { dependabotBackend: null });
    expect(result.code).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr.trim()).toBe("Checking Dependabot pull requests needs a GitHub token: set GITLIB_GITHUB_TOKEN or GITHUB_TOKEN.");
  });

  it("reports a rejected token as an error, not a stack trace", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const backend = new FakeBackend({ meddlin: new DependabotAuthError("GitHub rejected the token (401).") });
    const result = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("GitHub rejected the token (401).");
  });

  it("never prints the token", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const token = "test-token-not-a-real-secret";
    const backend = new FakeBackend({ meddlin: { prs: [pr()] } });
    for (const args of [["dependabot", "check"], ["dependabot", "check", "--json"]]) {
      const result = await fx.runCli(args, { dependabotBackend: backend, env: { GITLIB_GITHUB_TOKEN: token } });
      expect(result.stdout + result.stderr).not.toContain(token);
    }
  });

  it("does not need GitHub for any other command", async () => {
    fx.writeConfig();
    fx.makeRepo("plain");
    const throwing: DependabotBackend = {
      label: "never",
      fetchOwner() {
        throw new Error("GitHub must not be contacted");
      },
    };
    for (const args of [["list", "--json"], ["show", "plain"], ["scan"]]) {
      const result = await fx.runCli(args, { dependabotBackend: throwing });
      expect(result.code, result.stderr).toBe(0);
    }
    expect((await fx.runCli(["list"], { env: { GITLIB_GITHUB_TOKEN: "", GITHUB_TOKEN: "" } })).code).toBe(0);
  });

  it("is listed in the help", async () => {
    const help = await fx.runCli(["dependabot", "--help"]);
    expect(help.stdout).toContain("check");
    expect((await fx.runCli(["--help"])).stdout).toContain("dependabot");
  });

  describe("--json", () => {
    it("emits a stable snake_case shape", async () => {
      starRepos({ gitlib: "https://github.com/meddlin/gitlib.git", lonely: null });
      const backend = new FakeBackend({
        meddlin: {
          prs: [
            pr({ number: 41 }),
            pr({ number: 42, ci: { state: "unknown", reason: "no rollup" }, labels: ["dependencies", "security"] }),
            pr({ number: 43, mergeStateStatus: "DIRTY", mergeable: "CONFLICTING" }),
          ],
          rateLimit: { cost: 2, remaining: 4998, resetAt: "2026-11-02T13:00:00Z" },
        },
      });

      const result = await fx.runCli(["dependabot", "check", "--json"], { dependabotBackend: backend });

      expect(result.code, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout);
      expect(Object.keys(report)).toEqual([
        "run",
        "checked_at",
        "summary",
        "pull_requests",
        "repositories",
        "skipped",
        "errors",
        "truncated_owners",
        "warnings",
        "rate_limit",
      ]);
      expect(report.run).toEqual({ id: 1, trigger: "cli" });
      expect(report.summary).toEqual({ ready: 1, "review-first": 1, "needs-work": 1, waiting: 0 });
      expect(report.pull_requests.map((p: { number: number; bucket: string }) => [p.number, p.bucket])).toEqual([
        [41, "ready"],
        [42, "review-first"],
        [43, "needs-work"],
      ]);
      expect(report.pull_requests[1]).toMatchObject({
        repo: "meddlin/gitlib",
        url: "https://github.com/meddlin/gitlib/pull/42",
        update_type: "patch",
        ecosystem: "npm_and_yarn",
        branch: "dependabot/npm_and_yarn/undici-6.29.1",
        merge_state_status: "CLEAN",
        review_decision: null,
        is_draft: false,
        commit_count: 1,
        labels: ["dependencies", "security"],
        ci: { state: "unknown", reason: "no rollup" },
        dismissed: null,
      });
      expect(report.pull_requests[1].observed_at).toBe(report.checked_at);
      expect(report.pull_requests[1].reasons[0]).toBe("CI unknown: no rollup");
      expect(report.pull_requests[2].actions.join("\n")).toContain("`@dependabot rebase`");
      expect(report.repositories).toEqual([{ repo: "meddlin/gitlib", status: "checked", open_pull_requests: 3, paths: ["gitlib"] }]);
      expect(report.skipped).toEqual([{ relative_path: "lonely", reason: "it has no git remote" }]);
      expect(report.rate_limit).toEqual({ cost: 2, remaining: 4998, reset_at: "2026-11-02T13:00:00Z" });
    });

    it("still prints the report, and exits 1, when an owner failed", async () => {
      starRepos({ down: "https://github.com/downorg/down.git" });
      const backend = new FakeBackend({ downorg: new DependabotUnavailableError("GitHub responded with 502.") });
      const result = await fx.runCli(["dependabot", "check", "--json"], { dependabotBackend: backend });
      expect(result.code).toBe(1);
      const report = JSON.parse(result.stdout);
      expect(report.errors).toEqual([{ owner: "downorg", message: "GitHub responded with 502." }]);
      expect(report.repositories[0].status).toBe("failed");
    });
  });
});

describe("saving and showing", () => {
  const twoPrs = () => new FakeBackend({ meddlin: { prs: [pr({ number: 41 }), pr({ number: 43, mergeStateStatus: "BEHIND" })] } });

  it("saves each check, and show prints it again without contacting GitHub", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const backend = twoPrs();
    const check = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });
    expect(check.stdout).toContain("Saved as run 1; read it again with `gitlib dependabot show`.");

    const never: DependabotBackend = { label: "never", fetchOwner: () => Promise.reject(new Error("must not be called")) };
    const show = await fx.runCli(["dependabot", "show"], { dependabotBackend: never, env: { GITLIB_GITHUB_TOKEN: "" } });

    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout.split("\n").slice(0, 2)).toEqual(["Stored run 1, started by the CLI; GitHub was not contacted.", ""]);
    expect(show.stdout).toContain("READY (1)");
    expect(show.stdout).toContain("meddlin/gitlib#43");
    expect(show.stdout).not.toContain("Saved as run");
    // Same data as the check: compare the structured output.
    const fromCheck = JSON.parse((await fx.runCli(["dependabot", "show", "--json"])).stdout);
    expect(fromCheck.run).toEqual({ id: 1, trigger: "cli" });
    expect(fromCheck.pull_requests.map((p: { number: number }) => p.number)).toEqual([41, 43]);
  });

  it("show says so, and exits 1, when nothing has been saved", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const result = await fx.runCli(["dependabot", "show"]);
    expect(result.code).toBe(1);
    expect(result.stderr.trim()).toBe("No Dependabot check has been saved yet. Run `gitlib dependabot check` first.");
  });

  it("--no-save prints the report and stores nothing", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const check = await fx.runCli(["dependabot", "check", "--no-save"], { dependabotBackend: twoPrs() });
    expect(check.code, check.stderr).toBe(0);
    expect(check.stdout).not.toContain("Saved as run");
    expect(JSON.parse((await fx.runCli(["dependabot", "check", "--no-save", "--json"], { dependabotBackend: twoPrs() })).stdout).run).toBeNull();
    expect((await fx.runCli(["dependabot", "show"])).code).toBe(1);
  });

  it("leaves out pull requests the user put aside, and counts them", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const app = createApplication(fx.env());
    app.dismissDependabotPr("Meddlin/GitLib", 43);

    const text = await fx.runCli(["dependabot", "check"], { dependabotBackend: twoPrs() });
    expect(text.stdout).toContain("1 ready, 0 review first, 0 needs work, 0 waiting");
    expect(text.stdout).not.toContain("NEEDS WORK");
    expect(text.stdout).toContain("Put aside (1): meddlin/gitlib#43.");

    const json = JSON.parse((await fx.runCli(["dependabot", "show", "--json"])).stdout);
    expect(json.summary).toEqual({ ready: 1, "review-first": 0, "needs-work": 0, waiting: 0 });
    expect(json.pull_requests.map((p: { number: number; dismissed: unknown }) => [p.number, p.dismissed !== null])).toEqual([
      [41, false],
      [43, true],
    ]);

    app.restoreDependabotPr("meddlin/gitlib", 43);
    expect((await fx.runCli(["dependabot", "show"])).stdout).toContain("NEEDS WORK (1)");
  });

  it("brings a snoozed pull request back once the snooze has ended", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const app = createApplication(fx.env());
    app.dismissDependabotPr("meddlin/gitlib", 43, new Date(Date.now() + 3_600_000).toISOString());
    expect((await fx.runCli(["dependabot", "check"], { dependabotBackend: twoPrs() })).stdout).toContain("Put aside (1)");
    app.planning.dismissDependabotPr("meddlin/gitlib", 43, new Date(Date.now() - 1_000).toISOString(), new Date().toISOString());
    const after = await fx.runCli(["dependabot", "show"]);
    expect(after.stdout).toContain("NEEDS WORK (1)");
    expect(after.stdout).not.toContain("Put aside");
  });

  it("refuses to run while another check holds the lock", async () => {
    starRepos({ gitlib: "https://github.com/meddlin/gitlib.git" });
    const app = createApplication(fx.env());
    app.dependabotStore.acquireLease("web:4242", new Date(), 60_000);

    const backend = twoPrs();
    const result = await fx.runCli(["dependabot", "check"], { dependabotBackend: backend });

    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/^A Dependabot check is already running \(started \S+ by web\)\.$/m);
    expect(backend.calls).toEqual([]);
    // --no-save does not store anything, so it does not need the lock.
    expect((await fx.runCli(["dependabot", "check", "--no-save"], { dependabotBackend: twoPrs() })).code).toBe(0);
  });

  it("keeps what it last saw for an owner that could not be asked, and says when", async () => {
    starRepos({ a: "https://github.com/aaa/a.git", b: "https://github.com/bbb/b.git" });
    const ok = new FakeBackend({
      aaa: { prs: [pr({ repo: "aaa/a", number: 1 })] },
      bbb: { prs: [pr({ repo: "bbb/b", number: 2, mergeStateStatus: "BEHIND" })] },
    });
    const first = JSON.parse((await fx.runCli(["dependabot", "check", "--json"], { dependabotBackend: ok })).stdout);

    const flaky = new FakeBackend({
      aaa: { prs: [pr({ repo: "aaa/a", number: 1 })] },
      bbb: new DependabotUnavailableError("Could not reach GitHub at api.github.com (ENOTFOUND)."),
    });
    const second = await fx.runCli(["dependabot", "check"], { dependabotBackend: flaky });

    expect(second.code).toBe(1);
    expect(second.stdout).toContain("bbb/b#2");
    expect(second.stdout).toContain(`last seen ${first.checked_at}`);
    expect(second.stdout).toContain("NOT CHECKED: bbb: Could not reach GitHub");
    const lines = second.stdout.split("\n");
    const factsOf = (needle: string) => lines[lines.findIndex((line) => line.includes(needle)) + 1];
    expect(factsOf("aaa/a#1")).not.toContain("last seen");
    expect(factsOf("bbb/b#2")).toContain("last seen");
  });
});

describe("dismiss and restore", () => {
  it("puts a pull request aside until it closes, or until a date, and brings it back", async () => {
    fx.writeConfig();
    const dismiss = await fx.runCli(["dependabot", "dismiss", "Meddlin/GitLib#43"]);
    expect(dismiss.code, dismiss.stderr).toBe(0);
    expect(dismiss.stdout.trim()).toBe(
      "Put Meddlin/GitLib#43 aside until it closes. Bring it back with `gitlib dependabot restore Meddlin/GitLib#43`.",
    );
    expect(createApplication(fx.env()).listDependabotDismissals()).toMatchObject([{ repo: "meddlin/gitlib", number: 43, snoozedUntil: null }]);

    const snooze = await fx.runCli(["dependabot", "dismiss", "meddlin/gitlib#43", "--until", "2030-01-02"]);
    expect(snooze.stdout.trim()).toBe("Put meddlin/gitlib#43 aside until 2030-01-02T00:00:00.000Z.");

    const restore = await fx.runCli(["dependabot", "restore", "meddlin/gitlib#43"]);
    expect(restore.code).toBe(0);
    expect(restore.stdout.trim()).toBe("meddlin/gitlib#43 is no longer put aside.");
    expect(createApplication(fx.env()).listDependabotDismissals()).toEqual([]);
  });

  it("explains a malformed reference or date", async () => {
    fx.writeConfig();
    const bad = await fx.runCli(["dependabot", "dismiss", "meddlin/gitlib"]);
    expect(bad.code).not.toBe(0);
    expect(bad.stderr).toContain("expected owner/repo#number");
    const date = await fx.runCli(["dependabot", "dismiss", "meddlin/gitlib#1", "--until", "someday"]);
    expect(date.code).toBe(1);
    expect(date.stderr).toContain('"someday" is not a date');
  });
});
