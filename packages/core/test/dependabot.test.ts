import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BUCKETS,
  DependabotAuthError,
  DependabotUnavailableError,
  GitHubDependabotBackend,
  checkDependabot,
  classify,
  createApplication,
  groupReposByGitHubSlug,
  isGitLibError,
  parseBranchEcosystem,
  parseCommitMetadata,
  parsePullRequest,
  parseSearchPage,
  resolveGitHubToken,
  type Bucket,
  type CiState,
  type DependabotBackend,
  type DependabotPr,
  type OwnerPulls,
  type UpdateType,
} from "../src/index.js";
import { FakeBackend, checkRun, commitMessage, green, node, pr, rollup, searchResponse, statusContext, type NodeOptions } from "./dependabot-fixtures.js";
import { Fixture } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

// --- Commit message and branch ---------------------------------------------------------------------------------

describe("parseCommitMetadata", () => {
  it("reads the update type and dependency of a single bump", () => {
    expect(parseCommitMetadata(commitMessage({ name: "undici", type: "patch" }))).toEqual({
      updateType: "patch",
      dependencies: ["undici"],
    });
  });

  it("keeps the biggest bump in a group", () => {
    const message = commitMessage({ name: "a", type: "patch" }, { name: "b", type: "major" }, { name: "c", type: "minor" });
    expect(parseCommitMetadata(message)).toEqual({ updateType: "major", dependencies: ["a", "b", "c"] });
    expect(parseCommitMetadata(commitMessage({ name: "a", type: "patch" }, { name: "c", type: "minor" })).updateType).toBe("minor");
  });

  it("cannot call a group minor or patch when one dependency states no type (indirect updates)", () => {
    expect(parseCommitMetadata(commitMessage({ name: "a", type: "patch" }, { name: "indirect", type: null })).updateType).toBe("unknown");
    // ...but a major elsewhere in the group still decides it.
    expect(parseCommitMetadata(commitMessage({ name: "a", type: "major" }, { name: "indirect", type: null })).updateType).toBe("major");
  });

  it("answers unknown for a missing block, an unrecognised value, or an unterminated block", () => {
    expect(parseCommitMetadata("build(deps): bump x from 1 to 2\n\nNo block here.").updateType).toBe("unknown");
    expect(parseCommitMetadata("---\nupdated-dependencies:\n- dependency-name: x\n  update-type: version-update:semver-prerelease\n...").updateType).toBe("unknown");
    expect(parseCommitMetadata("---\nupdated-dependencies:\n- dependency-name: x\n  update-type: version-update:semver-patch\n").updateType).toBe("unknown");
    expect(parseCommitMetadata("").updateType).toBe("unknown");
  });

  it("copes with CRLF line endings and quoted values", () => {
    const message = "title\r\n\r\n---\r\nupdated-dependencies:\r\n- dependency-name: \"@types/node\"\r\n  update-type: 'version-update:semver-minor'\r\n...\r\n";
    expect(parseCommitMetadata(message)).toEqual({ updateType: "minor", dependencies: ["@types/node"] });
  });
});

describe("parseBranchEcosystem", () => {
  it("reads the ecosystem from the default layout and nothing from a custom one", () => {
    expect(parseBranchEcosystem("dependabot/npm_and_yarn/undici-6.29.1")).toBe("npm_and_yarn");
    expect(parseBranchEcosystem("dependabot/github_actions/actions/checkout-6")).toBe("github_actions");
    expect(parseBranchEcosystem("deps-npm_and_yarn-undici")).toBeNull();
    expect(parseBranchEcosystem("dependabot-npm_and_yarn-undici")).toBeNull();
    expect(parseBranchEcosystem("dependabot/")).toBeNull();
  });
});

// --- Parsing GitHub's response ---------------------------------------------------------------------------------

describe("parseSearchPage", () => {
  it("turns a search response into PRs plus paging and quota information", () => {
    const page = parseSearchPage(
      searchResponse({
        nodes: [node({ number: 7, labels: ["dependencies", "security"], commitCount: 3 })],
        issueCount: 120,
        hasNextPage: true,
        endCursor: "Y3Vyc29y",
        cost: 2,
      }),
    );
    expect(page).toMatchObject({
      issueCount: 120,
      nodeCount: 1,
      hasNextPage: true,
      endCursor: "Y3Vyc29y",
      rateLimit: { cost: 2, remaining: 4990, resetAt: "2026-11-02T13:00:00Z" },
      warnings: [],
    });
    expect(page.prs).toHaveLength(1);
    expect(page.prs[0]).toMatchObject({
      repo: "meddlin/gitlib",
      number: 7,
      url: "https://github.com/meddlin/gitlib/pull/7",
      author: "dependabot",
      headRefName: "dependabot/npm_and_yarn/undici-6.29.1",
      ecosystem: "npm_and_yarn",
      isDraft: false,
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      reviewDecision: null,
      labels: ["dependencies", "security"],
      commitCount: 3,
      updateType: "patch",
      dependencies: ["undici"],
      ci: { state: "success" },
    });
  });

  it("skips nodes that are not pull requests", () => {
    // An inline fragment that does not match comes back as an empty object; a hidden result can be null.
    const page = parseSearchPage(searchResponse({ nodes: [{}, null, node({ number: 2 })] }));
    expect(page.prs.map((p) => p.number)).toEqual([2]);
    expect(page.nodeCount).toBe(3);
  });

  describe("CI", () => {
    const ciOf = (statusCheckRollup: object | null): CiState => parseSearchPage(searchResponse({ nodes: [node({ rollup: statusCheckRollup })] })).prs[0]!.ci;

    it("is success only when the rollup says SUCCESS", () => {
      expect(ciOf(green())).toEqual({ state: "success" });
    });

    it("names the checks and statuses that failed", () => {
      const failing = rollup(
        "FAILURE",
        checkRun("build"),
        checkRun("lint", "COMPLETED", "FAILURE"),
        checkRun("e2e", "COMPLETED", "TIMED_OUT"),
        checkRun("lint", "COMPLETED", "FAILURE"),
        statusContext("ci/legacy", "ERROR"),
        statusContext("codecov", "SUCCESS"),
      );
      expect(ciOf(failing)).toEqual({ state: "failing", failed: ["lint", "e2e", "ci/legacy"] });
      expect(ciOf(rollup("ERROR"))).toEqual({ state: "failing", failed: [] });
    });

    it("names the checks still running", () => {
      expect(ciOf(rollup("PENDING", checkRun("build", "IN_PROGRESS", null), checkRun("test", "QUEUED", null), checkRun("lint"), statusContext("ci/legacy", "PENDING")))).toEqual({
        state: "pending",
        pending: ["build", "test", "ci/legacy"],
      });
      expect(ciOf(rollup("EXPECTED"))).toEqual({ state: "pending", pending: [] });
    });

    it("is unknown, never green, when GitHub returns no rollup at all", () => {
      const ci = ciOf(null);
      expect(ci.state).toBe("unknown");
      expect(ci).toMatchObject({ reason: expect.stringContaining("no check results") });
      // The reason must point at the open question rather than claim there is no CI.
      expect(ci).toMatchObject({ reason: expect.stringContaining("token that cannot read checks") });
    });

    it("is unknown, with GitHub's own words, when it refused to resolve the rollup field", () => {
      const response = searchResponse({
        nodes: [node({ number: 1, rollup: null }), node({ number: 2 })],
        errors: [
          {
            type: "FORBIDDEN",
            path: ["search", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup"],
            message: "Resource not accessible by personal access token",
          },
        ],
      });
      const page = parseSearchPage(response);
      expect(page.prs[0]!.ci).toEqual({
        state: "unknown",
        reason: "GitHub would not return the checks (Resource not accessible by personal access token).",
      });
      // The error belongs to the first PR only.
      expect(page.prs[1]!.ci).toEqual({ state: "success" });
      expect(page.warnings).toEqual([]);
    });

    it("is unknown for a state it has never seen", () => {
      expect(ciOf(rollup("SOMETHING_NEW"))).toMatchObject({ state: "unknown", reason: expect.stringContaining("SOMETHING_NEW") });
    });

    it("is unknown when the head commit is missing", () => {
      const broken = node();
      broken["commits"] = { totalCount: 0, nodes: [] };
      expect(parseSearchPage(searchResponse({ nodes: [broken] })).prs[0]!.ci.state).toBe("unknown");
    });
  });

  it("keeps errors that do not concern a check rollup as warnings", () => {
    const page = parseSearchPage(searchResponse({ errors: [{ type: "SOMETHING", path: ["search", "nodes", 0, "labels"], message: "labels exploded" }] }));
    expect(page.warnings).toEqual(["labels exploded"]);
    expect(page.prs).toHaveLength(1);
  });

  it("throws a GitLibError with GitHub's message when there is no search result", () => {
    expect(() => parseSearchPage({ errors: [{ type: "RATE_LIMITED", message: "API rate limit exceeded" }] })).toThrow(/API rate limit exceeded/);
    expect(() => parseSearchPage({ data: { search: null }, errors: [{ message: "nope" }] })).toThrow(DependabotUnavailableError);
    expect(() => parseSearchPage("<html>")).toThrow(DependabotUnavailableError);
    try {
      parseSearchPage({});
    } catch (error) {
      expect(isGitLibError(error)).toBe(true);
    }
  });

  it("falls back to UNKNOWN for merge fields GitHub leaves out", () => {
    const bare = node();
    delete bare["mergeable"];
    delete bare["mergeStateStatus"];
    expect(parseSearchPage(searchResponse({ nodes: [bare] })).prs[0]).toMatchObject({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
  });
});

// --- The verdict -----------------------------------------------------------------------------------------------

describe("classify", () => {
  const verdict = (options: NodeOptions = {}) => classify(pr(options));
  const text = (strings: string[]) => strings.join("\n");

  describe("ready", () => {
    it("is a clean, green patch update", () => {
      const result = verdict();
      expect(result.bucket).toBe("ready");
      expect(result.reasons).toEqual(["All checks pass.", "No conflicts and up to date with the base branch.", "Patch update."]);
      expect(text(result.actions)).toContain("Merge it from the PR page");
    });

    it("accepts a minor update, an approval, and a merge state with hooks", () => {
      const result = verdict({
        message: commitMessage({ name: "undici", type: "minor" }),
        reviewDecision: "APPROVED",
        mergeStateStatus: "HAS_HOOKS",
      });
      expect(result.bucket).toBe("ready");
      expect(result.reasons).toEqual([
        "All checks pass.",
        "No conflicts and up to date with the base branch.",
        "Minor update.",
        "Approved.",
        "Pre-receive hooks will run when it merges.",
      ]);
    });
  });

  describe("needs work", () => {
    it("flags conflicts and suggests rebase, then recreate", () => {
      for (const options of [{ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" }, { mergeStateStatus: "DIRTY" }, { mergeable: "CONFLICTING" }]) {
        const result = verdict(options);
        expect(result.bucket).toBe("needs-work");
        expect(result.reasons[0]).toBe("Merge conflicts with the base branch.");
        expect(text(result.actions)).toContain("`@dependabot rebase`");
        expect(text(result.actions)).toContain("`@dependabot recreate`");
      }
    });

    it("flags a branch that is behind and suggests rebase", () => {
      const result = verdict({ mergeStateStatus: "BEHIND" });
      expect(result.bucket).toBe("needs-work");
      expect(result.reasons).toEqual(["Behind the base branch."]);
      expect(result.actions[0]).toContain("`@dependabot rebase`");
    });

    it("suggests recreate instead of rebase when someone pushed to the branch", () => {
      const result = verdict({ mergeStateStatus: "BEHIND", commitCount: 2 });
      expect(result.bucket).toBe("needs-work");
      expect(text(result.actions)).toContain("`@dependabot recreate`");
      expect(text(result.actions)).not.toContain("`@dependabot rebase`");
      // And the extra commits are a reason to look, whichever bucket it lands in.
      expect(text(result.reasons)).toContain("Has 2 commits");
    });

    it("flags requested changes", () => {
      const result = verdict({ reviewDecision: "CHANGES_REQUESTED" });
      expect(result.bucket).toBe("needs-work");
      expect(result.reasons).toEqual(["A reviewer requested changes."]);
    });

    it("flags failing checks by name", () => {
      const result = verdict({ mergeStateStatus: "BLOCKED", rollup: rollup("FAILURE", checkRun("build"), checkRun("test", "COMPLETED", "FAILURE")) });
      expect(result.bucket).toBe("needs-work");
      expect(result.reasons).toEqual(["Checks failing: test."]);
      // A blocked merge state is explained by the failing check and not repeated.
      expect(text(result.reasons)).not.toContain("blocked");
    });

    it("flags an UNSTABLE merge state even when the rollup claims success", () => {
      const result = verdict({ mergeStateStatus: "UNSTABLE" });
      expect(result.bucket).toBe("needs-work");
      expect(result.reasons[0]).toContain("UNSTABLE");
    });

    it("lists the other findings after the decisive one", () => {
      const result = verdict({ mergeable: "CONFLICTING", message: commitMessage({ name: "undici", type: "major" }) });
      expect(result.bucket).toBe("needs-work");
      expect(result.reasons).toEqual(["Merge conflicts with the base branch.", "Major version bump."]);
    });
  });

  describe("waiting", () => {
    it("treats UNKNOWN mergeability as transient: not ready, not broken, look again", () => {
      // GitHub answers UNKNOWN for both fields right after a push, while it computes the test merge.
      const result = verdict({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN" });
      expect(result.bucket).toBe("waiting");
      expect(result.reasons[0]).toContain("UNKNOWN");
      expect(result.reasons[0]).toContain("transient");
      expect(text(result.actions)).toContain("Run the check again");
      // One field alone is enough.
      expect(verdict({ mergeable: "UNKNOWN" }).bucket).toBe("waiting");
      expect(verdict({ mergeStateStatus: "UNKNOWN" }).bucket).toBe("waiting");
    });

    it("does not let UNKNOWN hide a failure that is already certain", () => {
      expect(verdict({ mergeable: "UNKNOWN", mergeStateStatus: "UNKNOWN", reviewDecision: "CHANGES_REQUESTED" }).bucket).toBe("needs-work");
      expect(verdict({ mergeable: "UNKNOWN", rollup: rollup("FAILURE", checkRun("test", "COMPLETED", "FAILURE")) }).bucket).toBe("needs-work");
    });

    it("waits for checks that are still running", () => {
      const result = verdict({ mergeStateStatus: "BLOCKED", rollup: rollup("PENDING", checkRun("build", "IN_PROGRESS", null)) });
      expect(result.bucket).toBe("waiting");
      expect(result.reasons).toEqual(["Checks still running: build."]);
    });

    it("waits on a draft", () => {
      expect(verdict({ isDraft: true }).bucket).toBe("waiting");
      expect(verdict({ mergeStateStatus: "DRAFT" }).bucket).toBe("waiting");
    });

    it("still reports a major bump it is waiting on", () => {
      const result = verdict({ mergeable: "UNKNOWN", message: commitMessage({ name: "undici", type: "major" }) });
      expect(result.bucket).toBe("waiting");
      expect(result.reasons).toContain("Major version bump.");
    });
  });

  describe("review first", () => {
    it("holds back a major bump even when everything is green", () => {
      const result = verdict({ message: commitMessage({ name: "undici", type: "major" }) });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons).toEqual(["Major version bump."]);
      expect(text(result.actions)).toContain("release notes");
      expect(text(result.actions)).toContain("`@dependabot ignore this major version`");
    });

    it("holds back an update whose type the commit message does not state", () => {
      const result = verdict({ message: "build(deps): bump x from 1 to 2" });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons).toEqual(["The commit message does not say how big the bump is."]);
      expect(text(result.actions)).toContain("`@dependabot ignore this dependency`");
    });

    it("holds back a security update", () => {
      const result = verdict({ labels: ["dependencies", "Security"] });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons[0]).toContain("security");
    });

    it("holds back a PR nobody has reviewed when branch protection asks for one", () => {
      const result = verdict({ reviewDecision: "REVIEW_REQUIRED", mergeStateStatus: "BLOCKED" });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons).toEqual(["Branch protection asks for a review and none has approved it."]);
    });

    it("holds back a blocked merge that nothing else explains", () => {
      const result = verdict({ mergeStateStatus: "BLOCKED" });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons[0]).toContain("blocked");
    });

    it("holds back a PR someone pushed extra commits to", () => {
      const result = verdict({ commitCount: 2 });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons[0]).toContain("Has 2 commits");
    });

    it("holds back a value it has never seen", () => {
      expect(verdict({ mergeStateStatus: "SHINY_NEW" }).bucket).toBe("review-first");
      expect(verdict({ mergeable: "SHINY_NEW" }).bucket).toBe("review-first");
      expect(verdict({ reviewDecision: "SHINY_NEW" }).bucket).toBe("review-first");
    });

    it("says CI unknown, with the reason, instead of calling a PR with no readable checks green", () => {
      const result = verdict({ rollup: null });
      expect(result.bucket).toBe("review-first");
      expect(result.reasons).toHaveLength(1);
      expect(result.reasons[0]).toMatch(/^CI unknown: GitHub returned no check results/);
      expect(text(result.actions)).toContain("gitlib cannot say whether they pass");
    });

    it("quotes GitHub's refusal when checks could not be read", () => {
      const refused = parseSearchPage(
        searchResponse({
          nodes: [node({ rollup: null })],
          errors: [{ type: "FORBIDDEN", path: ["search", "nodes", 0, "commits", "nodes", 0, "commit", "statusCheckRollup"], message: "Resource not accessible by personal access token" }],
        }),
      ).prs[0]!;
      expect(classify(refused).reasons[0]).toBe("CI unknown: GitHub would not return the checks (Resource not accessible by personal access token).");
    });
  });

  it("does not offer to ignore a grouped update (the commands differ for groups)", () => {
    const group = verdict({ message: commitMessage({ name: "a", type: "major" }, { name: "b", type: "patch" }) });
    expect(group.bucket).toBe("review-first");
    expect(text(group.actions)).not.toContain("ignore");
  });

  it("matches the ignore command to the size of the bump", () => {
    expect(text(verdict({ mergeable: "CONFLICTING", message: commitMessage({ name: "a", type: "minor" }) }).actions)).toContain("`@dependabot ignore this minor version`");
    expect(text(verdict({ mergeable: "CONFLICTING", message: commitMessage({ name: "a", type: "patch" }) }).actions)).toContain("`@dependabot ignore this patch version`");
  });

  // Every combination of the fields the verdict reads. Two properties must hold for all of them, whatever GitHub sends.
  describe("for every combination of inputs", () => {
    const ci: CiState[] = [
      { state: "success" },
      { state: "pending", pending: ["build"] },
      { state: "failing", failed: ["test"] },
      { state: "unknown", reason: "no rollup" },
    ];
    const base = pr();
    const combinations: DependabotPr[] = [];
    for (const mergeable of ["MERGEABLE", "CONFLICTING", "UNKNOWN", "OTHER"]) {
      for (const mergeStateStatus of ["CLEAN", "UNSTABLE", "HAS_HOOKS", "BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN", "OTHER"]) {
        for (const reviewDecision of [null, "APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED", "OTHER"]) {
          for (const isDraft of [false, true]) {
            for (const state of ci) {
              for (const updateType of ["major", "minor", "patch", "unknown"] as UpdateType[]) {
                for (const labels of [[], ["security"]]) {
                  for (const commitCount of [1, 3]) {
                    combinations.push({ ...base, mergeable, mergeStateStatus, reviewDecision, isDraft, ci: state, updateType, labels, commitCount });
                  }
                }
              }
            }
          }
        }
      }
    }

    it("only calls a PR ready when nothing stands against it", () => {
      let ready = 0;
      for (const candidate of combinations) {
        if (classify(candidate).bucket !== "ready") continue;
        ready += 1;
        expect(candidate).toMatchObject({ mergeable: "MERGEABLE", isDraft: false, commitCount: 1, ci: { state: "success" }, labels: [] });
        expect(["CLEAN", "HAS_HOOKS"]).toContain(candidate.mergeStateStatus);
        expect([null, "APPROVED"]).toContain(candidate.reviewDecision);
        expect(["minor", "patch"]).toContain(candidate.updateType);
      }
      // Guard against a vacuous pass.
      expect(ready).toBeGreaterThan(0);
      expect(ready).toBeLessThan(combinations.length / 10);
    });

    it("always returns a bucket with at least one reason, and never suggests a retired Dependabot command", () => {
      const retired = /@dependabot\s+(merge|squash|cancel|close|reopen)/i;
      const seen = new Set<Bucket>();
      for (const candidate of combinations) {
        const result = classify(candidate);
        seen.add(result.bucket);
        expect(result.reasons.length).toBeGreaterThan(0);
        for (const action of result.actions) expect(action).not.toMatch(retired);
        for (const reason of result.reasons) expect(reason).not.toMatch(retired);
      }
      expect([...seen].sort()).toEqual([...BUCKETS].sort());
    });
  });
});

// --- GitHub transport ------------------------------------------------------------------------------------------

interface SentRequest {
  url: string;
  headers: Record<string, string>;
  body: { query: string; variables: Record<string, unknown> };
}

/** A `fetch` that answers from a queue of canned responses and records what was sent. */
function fakeFetch(...responses: (Response | Error)[]): { fetch: typeof fetch; sent: SentRequest[] } {
  const sent: SentRequest[] = [];
  const queue = [...responses];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      url: String(input),
      headers: Object.fromEntries(new Headers(init?.headers).entries()),
      body: JSON.parse(String(init?.body)),
    });
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch ran out of responses");
    if (next instanceof Error) throw next;
    return next;
  }) as typeof fetch;
  return { fetch: fetchImpl, sent };
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" }, ...init });

/** The response to the request that asks which repositories the token can see. */
const probeResponse = (visible: (string | null)[], cost = 1) => ({
  data: {
    rateLimit: { cost, remaining: 4999, resetAt: "2026-11-02T13:00:00Z" },
    ...Object.fromEntries(visible.map((name, index) => [`r${index}`, name ? { nameWithOwner: name } : null])),
  },
  ...(visible.includes(null) ? { errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository", path: ["r1"] }] } : {}),
});

describe("GitHubDependabotBackend", () => {
  const TOKEN = "test-token-not-a-real-secret";
  const backendFor = (...responses: (Response | Error)[]) => {
    const faked = fakeFetch(...responses);
    return { backend: new GitHubDependabotBackend(TOKEN, { fetch: faked.fetch }), sent: faked.sent };
  };

  it("asks which repositories are visible, then runs one search for the owner", async () => {
    const { backend, sent } = backendFor(
      json(probeResponse(["meddlin/gitlib", "meddlin/other"])),
      json(searchResponse({ nodes: [node({ number: 1 }), node({ number: 2, repo: "meddlin/other" })], cost: 2 })),
    );

    const result = await backend.fetchOwner("meddlin", ["gitlib", "other"]);

    expect(sent).toHaveLength(2);
    expect(sent.every((request) => request.url === "https://api.github.com/graphql")).toBe(true);
    expect(sent[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(sent[0]!.body.query).toContain('r0: repository(owner: "meddlin", name: "gitlib")');
    expect(sent[1]!.body.variables).toEqual({ q: "is:pr is:open author:app/dependabot user:meddlin archived:false", first: 50, after: null });
    expect(sent[1]!.body.query).toMatch(/search\(query: \$q, type: ISSUE/);
    // The fields the verdict reads are all asked for.
    for (const field of ["isDraft", "mergeable", "mergeStateStatus", "reviewDecision", "headRefName", "labels", "statusCheckRollup", "message"]) {
      expect(sent[1]!.body.query).toContain(field);
    }

    expect(result.owner).toBe("meddlin");
    expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(result.unreachable).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(result.rateLimit).toEqual({ cost: 3, remaining: 4990, resetAt: "2026-11-02T13:00:00Z" });
  });

  it("reports repositories the token cannot see instead of letting them look empty", async () => {
    const { backend } = backendFor(json(probeResponse(["meddlin/gitlib", null])), json(searchResponse({ nodes: [] })));
    const result = await backend.fetchOwner("meddlin", ["gitlib", "private-thing"]);
    expect(result.unreachable).toEqual(["meddlin/private-thing"]);
  });

  it("follows the cursor to the next page and says when GitHub's 1,000-result cap cut the list short", async () => {
    const { backend, sent } = backendFor(
      json(searchResponse({ nodes: [node({ number: 1 })], issueCount: 1500, hasNextPage: true, endCursor: "c1" })),
      json(searchResponse({ nodes: [node({ number: 2 })], issueCount: 1500, hasNextPage: false })),
    );
    const result = await backend.fetchOwner("meddlin", []);
    expect(sent.map((request) => request.body.variables["after"])).toEqual([null, "c1"]);
    expect(result.prs.map((p) => p.number)).toEqual([1, 2]);
    expect(result.truncated).toBe(true);
  });

  it("does not call a complete listing truncated", async () => {
    const { backend } = backendFor(json(searchResponse({ nodes: [node()], issueCount: 1 })));
    expect((await backend.fetchOwner("meddlin", [])).truncated).toBe(false);
  });

  it("passes on warnings once", async () => {
    const warning = { type: "X", path: ["search", "nodes", 0, "labels"], message: "labels exploded" };
    const { backend } = backendFor(json(searchResponse({ errors: [warning, warning] })));
    expect((await backend.fetchOwner("meddlin", [])).warnings).toEqual(["labels exploded"]);
  });

  it("refuses names that could change the search or the lookup, without calling GitHub", async () => {
    const { backend, sent } = backendFor();
    await expect(backend.fetchOwner("meddlin repo:other/thing", [])).rejects.toThrow(DependabotUnavailableError);
    expect(sent).toEqual([]);

    // A repository name is only ever interpolated after it matches GitHub's own alphabet.
    const withSearch = backendFor(json(searchResponse({ nodes: [] })));
    await withSearch.backend.fetchOwner("meddlin", ['x") { id } evil: repository(owner: "a']);
    expect(withSearch.sent).toHaveLength(1);
    expect(withSearch.sent[0]!.body.query).not.toContain("evil");
  });

  it("stops the whole run on a rejected token, without echoing it", async () => {
    const { backend } = backendFor(json({ message: "Bad credentials" }, { status: 401 }));
    const error = await backend.fetchOwner("meddlin", []).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DependabotAuthError);
    expect(isGitLibError(error)).toBe(true);
    expect((error as Error).message).not.toContain(TOKEN);
  });

  it("explains an exhausted rate limit and a polite pause", async () => {
    const reset = Math.floor(Date.UTC(2026, 10, 2, 13, 0, 0) / 1000);
    const exhausted = backendFor(json({}, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(reset) } }));
    await expect(exhausted.backend.fetchOwner("meddlin", [])).rejects.toThrow("resets at 2026-11-02T13:00:00.000Z");

    const paused = backendFor(json({}, { status: 403, headers: { "retry-after": "60" } }));
    await expect(paused.backend.fetchOwner("meddlin", [])).rejects.toThrow("try again in 60 seconds");

    const plain = backendFor(json({}, { status: 403 }));
    await expect(plain.backend.fetchOwner("meddlin", [])).rejects.toThrow(/refused the request \(403\)/);
  });

  it("turns network failures, server errors and garbage into readable errors", async () => {
    const down = new TypeError("fetch failed", { cause: Object.assign(new Error("connect failed"), { code: "ENOTFOUND" }) });
    await expect(backendFor(down).backend.fetchOwner("meddlin", [])).rejects.toThrow("Could not reach GitHub at api.github.com (ENOTFOUND)");
    await expect(backendFor(new Response("", { status: 502 })).backend.fetchOwner("meddlin", [])).rejects.toThrow("GitHub responded with 502");
    await expect(backendFor(new Response("<html>", { status: 200 })).backend.fetchOwner("meddlin", [])).rejects.toThrow("not JSON");
  });

  it("fetches one pull request's description on demand, and only for a real pull request", async () => {
    const { backend, sent } = backendFor(
      json({ data: { repository: { pullRequest: { body: "Bumps undici.\n\nRelease notes..." } } } }),
      json({ data: { repository: { pullRequest: null } } }),
      json({ data: { repository: { pullRequest: { body: null } } } }),
    );

    expect(await backend.fetchPullBody("meddlin/gitlib", 41)).toBe("Bumps undici.\n\nRelease notes...");
    expect(sent[0]!.body.variables).toEqual({ owner: "meddlin", name: "gitlib", number: 41 });
    expect(sent[0]!.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(await backend.fetchPullBody("meddlin/gitlib", 999)).toBeNull();
    expect(await backend.fetchPullBody("meddlin/gitlib", 5)).toBeNull();

    for (const bad of ["gitlib", "a/b/c", 'x") { y } (z/w']) {
      await expect(backend.fetchPullBody(bad, 1)).rejects.toThrow(DependabotUnavailableError);
    }
    await expect(backend.fetchPullBody("meddlin/gitlib", 1.5)).rejects.toThrow(DependabotUnavailableError);
    expect(sent).toHaveLength(3); // nothing was sent for the bad ones
  });

  it("lets a caller's abort through unchanged", async () => {
    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("aborted", "AbortError");
    const { backend } = backendFor(abort);
    await expect(backend.fetchOwner("meddlin", [], controller.signal)).rejects.toBe(abort);
  });
});

describe("resolveGitHubToken", () => {
  it("prefers GITLIB_GITHUB_TOKEN, falls back to GITHUB_TOKEN, and ignores blanks", () => {
    expect(resolveGitHubToken({ GITLIB_GITHUB_TOKEN: " a ", GITHUB_TOKEN: "b" })).toBe("a");
    expect(resolveGitHubToken({ GITLIB_GITHUB_TOKEN: "", GITHUB_TOKEN: "b" })).toBe("b");
    expect(resolveGitHubToken({ GITLIB_GITHUB_TOKEN: "  " })).toBeNull();
    expect(resolveGitHubToken({})).toBeNull();
  });
});

// --- Which repositories are watched ----------------------------------------------------------------------------

describe("watching favorites", () => {
  function setUp(remotes: Record<string, string | null>) {
    fx.writeConfig();
    for (const [relativePath, url] of Object.entries(remotes)) {
      const repoPath = fx.initRealGitRepo(relativePath);
      if (url) fx.git(repoPath, "remote", "add", "origin", url);
    }
  }
  const appWith = (backend: DependabotBackend | null) => createApplication(fx.env(), undefined, null, null, backend);
  const star = (app: ReturnType<typeof appWith>, ...paths: string[]) => {
    app.refresh();
    for (const relativePath of paths) app.saveRepositoryFavorite(relativePath, true);
  };

  describe("groupReposByGitHubSlug", () => {
    it("collapses clones and linked worktrees of one GitHub repository, ignoring case", () => {
      setUp({ gitlib: "https://github.com/Meddlin/gitlib.git", "gitlib-copy": "git@github.com:meddlin/GitLib.git", other: "https://github.com/meddlin/other" });
      fx.addWorktree("gitlib", "gitlib/.claude/worktrees/feature");
      const app = appWith(null);
      app.refresh();

      const { groups, unresolved } = groupReposByGitHubSlug(app.loadRepositories(), app.system);

      expect(unresolved).toEqual([]);
      expect(groups.map((group) => group.slug)).toEqual(["Meddlin/gitlib", "meddlin/other"]);
      expect(groups[0]!.paths.sort()).toEqual(["gitlib", "gitlib-copy", "gitlib/.claude/worktrees/feature"]);
    });

    it("returns repositories it cannot map, with the reason, instead of dropping them", () => {
      setUp({
        lonely: null,
        gitlab: "https://gitlab.com/meddlin/thing.git",
        selfhosted: "git@git.example.com:team/thing.git",
      });
      const app = appWith(null);
      app.refresh();

      const { groups, unresolved } = groupReposByGitHubSlug(app.loadRepositories(), app.system);

      expect(groups).toEqual([]);
      expect(Object.fromEntries(unresolved.map((repo) => [repo.relativePath, repo.reason]))).toEqual({
        lonely: "it has no git remote",
        gitlab: "no remote is on github.com (origin: gitlab.com)",
        selfhosted: "no remote is on github.com (origin: git.example.com)",
      });
    });

    it("skips an owner or repository name that GitHub would not allow", () => {
      setUp({ odd: "https://github.com/me%20repo:evil/thing" });
      const app = appWith(null);
      app.refresh();
      const { groups, unresolved } = groupReposByGitHubSlug(app.loadRepositories(), app.system);
      expect(groups).toEqual([]);
      expect(unresolved).toHaveLength(1);
    });

    it("reports a repo whose git cannot be run", () => {
      setUp({ broken: "https://github.com/meddlin/broken" });
      const app = appWith(null);
      app.refresh();
      const system = { ...app.system, runCommand: () => ({ status: 128, stdout: "", stderr: "fatal: not a git repository\nsecond line" }) };
      const { unresolved } = groupReposByGitHubSlug(app.loadRepositories(), system);
      expect(unresolved).toEqual([{ relativePath: "broken", reason: "git could not list its remotes (fatal: not a git repository)" }]);
    });
  });

  describe("checkDependabot", () => {
    it("asks once per owner about favorites only, and keeps only PRs of watched repositories", async () => {
      setUp({
        gitlib: "https://github.com/meddlin/gitlib.git",
        unstarred: "https://github.com/meddlin/unstarred.git",
        zeta: "https://github.com/zeta-org/zeta.git",
        gitlab: "https://gitlab.com/meddlin/thing.git",
        lonely: null,
      });
      const backend = new FakeBackend({
        meddlin: {
          prs: [
            pr({ number: 2, repo: "meddlin/gitlib", mergeable: "CONFLICTING" }),
            pr({ number: 1, repo: "meddlin/gitlib" }),
            pr({ number: 9, repo: "meddlin/unstarred" }),
          ],
          rateLimit: { cost: 3, remaining: 4900, resetAt: "2026-11-02T13:00:00Z" },
        },
        "zeta-org": {
          prs: [pr({ number: 5, repo: "zeta-org/zeta", message: commitMessage({ name: "x", type: "major" }) })],
          rateLimit: { cost: 2, remaining: 4898, resetAt: "2026-11-02T13:00:00Z" },
        },
      });
      const app = appWith(backend);
      star(app, "gitlib", "zeta", "gitlab", "lonely");

      const report = await app.checkDependabot({ now: new Date("2026-11-02T08:00:00Z") });

      expect(backend.calls).toEqual([
        { owner: "meddlin", repoNames: ["gitlib"] },
        { owner: "zeta-org", repoNames: ["zeta"] },
      ]);
      expect(report.checkedAt).toBe("2026-11-02T08:00:00.000Z");
      expect(report.items.map((item) => [item.pr.repo, item.pr.number, item.bucket])).toEqual([
        ["meddlin/gitlib", 1, "ready"],
        ["zeta-org/zeta", 5, "review-first"],
        ["meddlin/gitlib", 2, "needs-work"],
      ]);
      expect(report.watched.map((repo) => [repo.slug, repo.status, repo.openPrs])).toEqual([
        ["meddlin/gitlib", "checked", 2],
        ["zeta-org/zeta", "checked", 1],
      ]);
      expect(report.skipped).toEqual([
        { relativePath: "gitlab", reason: "no remote is on github.com (origin: gitlab.com)" },
        { relativePath: "lonely", reason: "it has no git remote" },
      ]);
      expect(report.rateLimit).toEqual({ cost: 5, remaining: 4898, resetAt: "2026-11-02T13:00:00Z" });
      expect(report.errors).toEqual([]);
    });

    it("matches the PR's repository to the watched one without regard to case", async () => {
      setUp({ gitlib: "https://github.com/Meddlin/GitLib.git" });
      const backend = new FakeBackend({ Meddlin: { prs: [pr({ repo: "meddlin/gitlib" })] } });
      const app = appWith(backend);
      star(app, "gitlib");
      expect((await app.checkDependabot()).items).toHaveLength(1);
    });

    it("marks a repository the token cannot see, rather than reporting it empty", async () => {
      setUp({ secret: "https://github.com/meddlin/secret.git", open: "https://github.com/meddlin/open.git" });
      const backend = new FakeBackend({ meddlin: { unreachable: ["meddlin/secret"], truncated: true, warnings: ["careful"] } });
      const app = appWith(backend);
      star(app, "secret", "open");

      const report = await app.checkDependabot();

      expect(report.watched.map((repo) => [repo.slug, repo.status])).toEqual([
        ["meddlin/open", "checked"],
        ["meddlin/secret", "unreachable"],
      ]);
      expect(report.truncatedOwners).toEqual(["meddlin"]);
      expect(report.warnings).toEqual(["careful"]);
    });

    it("records a failed owner and carries on with the rest", async () => {
      setUp({ a: "https://github.com/aaa/a.git", b: "https://github.com/bbb/b.git" });
      const backend = new FakeBackend({
        aaa: new DependabotUnavailableError("Could not reach GitHub at api.github.com (ENOTFOUND)."),
        bbb: { prs: [pr({ repo: "bbb/b" })] },
      });
      const app = appWith(backend);
      star(app, "a", "b");

      const report = await app.checkDependabot();

      expect(report.errors).toEqual([{ owner: "aaa", message: "Could not reach GitHub at api.github.com (ENOTFOUND)." }]);
      expect(report.watched.map((repo) => [repo.slug, repo.status])).toEqual([
        ["aaa/a", "failed"],
        ["bbb/b", "checked"],
      ]);
      expect(report.items).toHaveLength(1);
    });

    it("stops on a rejected token and on a bug, but not on an ordinary failure", async () => {
      setUp({ a: "https://github.com/aaa/a.git", b: "https://github.com/bbb/b.git" });
      for (const failure of [new DependabotAuthError("GitHub rejected the token"), new TypeError("a bug")]) {
        const backend = new FakeBackend({ aaa: failure, bbb: {} });
        const app = appWith(backend);
        star(app, "a", "b");
        await expect(app.checkDependabot()).rejects.toBe(failure);
        expect(backend.calls).toHaveLength(1);
      }
    });

    it("says there is nothing to check when no favorite has a GitHub remote", async () => {
      setUp({ gitlab: "https://gitlab.com/meddlin/thing.git", notstarred: "https://github.com/meddlin/x.git" });
      const backend = new FakeBackend({});
      const app = appWith(backend);
      star(app, "gitlab");
      const report = await app.checkDependabot();
      expect(backend.calls).toEqual([]);
      expect(report.watched).toEqual([]);
      expect(report.skipped).toHaveLength(1);
    });

    it("works on its own, without a GitLibApp", async () => {
      setUp({ gitlib: "https://github.com/meddlin/gitlib.git" });
      const app = appWith(null);
      star(app, "gitlib");
      const backend = new FakeBackend({ meddlin: { prs: [pr()] } });
      const report = await checkDependabot({ repositories: app.loadRepositories(), backend, system: app.system });
      expect(report.items).toHaveLength(1);
    });
  });

  describe("the token", () => {
    it("is read from GITLIB_GITHUB_TOKEN or GITHUB_TOKEN; without either the check explains what to set", async () => {
      fx.writeConfig();
      expect(createApplication(fx.env()).dependabot).toBeNull();
      expect(createApplication(fx.env({ GITLIB_GITHUB_TOKEN: "x" })).dependabot?.label).toBe("api.github.com");
      expect(createApplication(fx.env({ GITHUB_TOKEN: "x" })).dependabot?.label).toBe("api.github.com");

      const error = await createApplication(fx.env()).checkDependabot().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(DependabotUnavailableError);
      expect(isGitLibError(error)).toBe(true);
      expect((error as Error).message).toContain("GITLIB_GITHUB_TOKEN");
    });
  });
});
