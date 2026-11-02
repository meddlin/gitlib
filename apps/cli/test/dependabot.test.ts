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
      });
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
