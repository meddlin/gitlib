import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Shaped like real responses for `GET /repos/{owner}/{repo}/pulls`, `/issues` and `/commits`. */
const pull = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Pull ${number}`,
  html_url: `https://github.com/me/app/pull/${number}`,
  created_at: "2026-11-01T00:00:00Z",
  updated_at: "2026-11-02T00:00:00Z",
  user: { login: "octo" },
  labels: [{ name: "bug", color: "d73a4a" }],
  head: { ref: "feature", repo: { full_name: "me/app" } },
  base: { ref: "main", repo: { full_name: "me/app" } },
  ...extra,
});
const issue = (number: number, extra: Record<string, unknown> = {}) => ({
  number,
  title: `Issue ${number}`,
  html_url: `https://github.com/me/app/issues/${number}`,
  created_at: "2026-10-01T00:00:00Z",
  updated_at: "2026-10-02T00:00:00Z",
  comments: 2,
  user: { login: "octo" },
  labels: ["help wanted"],
  ...extra,
});
const commit = (sha: string, message: string) => ({
  sha,
  html_url: `https://github.com/me/app/commit/${sha}`,
  commit: { message, author: { name: "Octo Cat", date: "2026-11-03T00:00:00Z" }, committer: { date: "2026-11-03T01:00:00Z" } },
  author: null,
});

/** A GitHub that knows `me/app` and `me/api`; `control` makes parts of it fail. */
function fakeGitHub() {
  const control = { failIssuesFor: "" as string, rateLimited: false, emptyRepo: "" as string };
  const requests: { method: string; path: string }[] = [];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
    const url = new URL(String(input));
    requests.push({ method: init?.method ?? "GET", path: url.pathname });
    if (control.rateLimited) return json({ message: "rate limited" }, 403);
    const match = /^\/repos\/me\/([^/]+)\/(pulls|issues|commits)$/.exec(url.pathname);
    if (!match) return json({ message: "Not Found" }, 404);
    const [, repo, kind] = match;
    if (kind === "issues" && control.failIssuesFor === repo) return json({ message: "boom" }, 500);
    if (kind === "commits" && control.emptyRepo === repo) return json({ message: "Git Repository is empty." }, 409);
    switch (kind) {
      case "pulls":
        return json([pull(7, { draft: true }), pull(6, { head: { ref: "patch", label: "fork:patch", repo: { full_name: "fork/app" } } })]);
      case "issues":
        // GitHub lists pull requests among issues; one is mixed in here.
        return json([issue(3), issue(7, { pull_request: {} }), issue(2)]);
      default:
        return json([commit("abcdef1234567890", "Fix the thing\n\nLonger explanation."), commit("1234567abcdef", "Earlier")]);
    }
  });
  return { control, requests, fetchMock };
}

let base: string;

function gitClone(name: string, remote?: string) {
  const dir = path.join(base, "git", name);
  fs.mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  if (remote) execFileSync("git", ["-C", dir, "remote", "add", "origin", remote]);
}

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-project-github-")));
  gitClone("app", "https://github.com/me/app.git");
  gitClone("api", "git@github.com:me/api.git");
  gitClone("local-only");
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(path.join(base, "home", "config.toml"), `roots = ["${path.join(base, "git")}"]\n\n[search]\nenabled = false\n`);

  vi.stubEnv("GITLIB_HOME", path.join(base, "home"));
  vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
  vi.stubEnv("GITHUB_TOKEN", "");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

/** A fresh server over the scanned clones, with GitHub faked. */
async function start(github: ReturnType<typeof fakeGitHub>) {
  vi.stubGlobal("fetch", github.fetchMock);
  delete (globalThis as Record<string, unknown>)["__gitlib"];
  vi.resetModules();
  const { loadRepositories, getApp } = await import("../src/server/gitlib.server");
  loadRepositories();
  const server = await import("../src/server/project-github.server");
  server.clearProjectGitHubCache();
  return { app: getApp(), ...server };
}

describe("a project's GitHub preview", () => {
  it("reads open pull requests, open issues and recent commits for each repo, in the order given", async () => {
    const github = fakeGitHub();
    const { readProjectGitHub } = await start(github);

    const view = await readProjectGitHub(["app", "api"]);

    expect(view.hasToken).toBe(true);
    expect(view.repos.map((repo) => [repo.relativePath, repo.slug])).toEqual([
      ["app", "me/app"],
      ["api", "me/api"],
    ]);
    const [app] = view.repos;
    expect(app?.url).toBe("https://github.com/me/app");
    expect(app?.pulls).toMatchObject({ hasMore: false, error: null });
    expect(app?.pulls.items.map((p) => [p.number, p.draft, p.head])).toEqual([
      [7, true, "feature"],
      [6, false, "fork:patch"],
    ]);
    // The pull request that GitHub also lists as an issue is left out.
    expect(app?.issues.items.map((i) => i.number)).toEqual([3, 2]);
    expect(app?.commits.items[0]).toEqual({
      sha: "abcdef1",
      message: "Fix the thing",
      url: "https://github.com/me/app/commit/abcdef1234567890",
      author: "Octo Cat",
      committedAt: "2026-11-03T01:00:00Z",
    });
  });

  it("only reads: every request is a GET to api.github.com", async () => {
    const github = fakeGitHub();
    const { readProjectGitHub } = await start(github);
    await readProjectGitHub(["app", "api"]);
    expect(github.requests).toHaveLength(6);
    expect(new Set(github.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
    for (const [url] of github.fetchMock.mock.calls) expect(new URL(String(url)).origin).toBe("https://api.github.com");
  });

  it("leaves gitlib's planning data exactly as it was", async () => {
    const github = fakeGitHub();
    const { app, readProjectGitHub } = await start(github);
    const project = app.createProject("Platform");
    app.addRepoToProject(project.id, "app");
    const local = app.createLocalIssue("app", { title: "Mine", body: "Only in gitlib" });
    const before = { projects: app.listProjects(), issues: app.listLocalIssues() };

    await readProjectGitHub(["app"]);

    expect(app.listProjects()).toEqual(before.projects);
    expect(app.listLocalIssues()).toEqual(before.issues);
    // GitHub issue #3 and gitlib's own issue #1 on the same repo stay two unrelated things.
    expect(app.listLocalIssues()).toHaveLength(1);
    expect(app.listLocalIssues()[0]).toMatchObject({ id: local.id, number: 1, title: "Mine" });
  });

  it("reports a repo with no GitHub remote or no longer known on its own, without asking GitHub", async () => {
    const github = fakeGitHub();
    const { readProjectGitHub } = await start(github);

    const view = await readProjectGitHub(["local-only", "vanished", "app"]);

    expect(view.repos[0]).toMatchObject({ relativePath: "local-only", slug: null, url: null, error: null });
    expect(view.repos[1]).toMatchObject({ relativePath: "vanished", slug: null, error: "Gitlib no longer finds this repository." });
    expect(view.repos[2]).toMatchObject({ slug: "me/app", error: null });
    expect(github.requests.every((request) => request.path.startsWith("/repos/me/app/"))).toBe(true);
  });

  it("also reads GitHub repos a project holds without a clone, skipping any a clone already covers", async () => {
    const github = fakeGitHub();
    const { readProjectGitHub } = await start(github);

    const view = await readProjectGitHub(["app"], { remotes: ["me/api", "ME/app", "not-a-repo"] });

    expect(view.repos.map((repo) => [repo.relativePath, repo.slug])).toEqual([
      ["app", "me/app"],
      ["me/api", "me/api"],
      ["not-a-repo", null],
    ]);
    expect(view.repos[1]).toMatchObject({ url: "https://github.com/me/api", error: null });
    expect(view.repos[1]?.pulls.items).toHaveLength(2);
    expect(view.repos[2]?.error).toBe("That is not a GitHub repository name.");
    expect(new Set(github.requests.map((request) => request.method))).toEqual(new Set(["GET"]));
  });

  it("keeps one failing list from spoiling the rest", async () => {
    const github = fakeGitHub();
    github.control.failIssuesFor = "api";
    const { readProjectGitHub } = await start(github);

    const [app, api] = (await readProjectGitHub(["app", "api"])).repos;

    expect(app?.issues.error).toBeNull();
    expect(api?.issues).toEqual({ items: [], hasMore: false, error: "GitHub responded with 500." });
    expect(api?.pulls.items).toHaveLength(2);
    expect(api?.commits.items).toHaveLength(2);
  });

  it("treats an empty repository as having no commits rather than as an error", async () => {
    const github = fakeGitHub();
    github.control.emptyRepo = "app";
    const { readProjectGitHub } = await start(github);
    const [app] = (await readProjectGitHub(["app"])).repos;
    expect(app?.commits).toEqual({ items: [], hasMore: false, error: null });
  });

  it("reuses what it read for a few minutes, and reads again on refresh", async () => {
    const github = fakeGitHub();
    const { readProjectGitHub } = await start(github);

    await readProjectGitHub(["app"]);
    await readProjectGitHub(["app"]);
    expect(github.requests).toHaveLength(3);

    await readProjectGitHub(["app"], { refresh: true });
    expect(github.requests).toHaveLength(6);
  });

  it("does not keep a lookup that failed outright", async () => {
    const github = fakeGitHub();
    github.control.rateLimited = true;
    const { readProjectGitHub } = await start(github);

    const [limited] = (await readProjectGitHub(["app"])).repos;
    expect(limited?.pulls.error).toMatch(/rate limit/i);

    github.control.rateLimited = false;
    const [recovered] = (await readProjectGitHub(["app"])).repos;
    expect(recovered?.pulls.items).toHaveLength(2);
  });

  it("asks GitHub about a repository once when two paths share it", async () => {
    const github = fakeGitHub();
    gitClone("app-copy", "https://github.com/me/app.git");
    const { readProjectGitHub } = await start(github);

    const view = await readProjectGitHub(["app", "app-copy"]);

    expect(view.repos.map((repo) => repo.slug)).toEqual(["me/app", "me/app"]);
    expect(github.requests).toHaveLength(3);
  });
});
