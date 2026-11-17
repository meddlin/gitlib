import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

const profileBody = (slug: string, score: number) => ({
  health_percentage: score,
  description: "Lives on GitHub",
  files: {
    code_of_conduct: null,
    code_of_conduct_file: null,
    contributing: null,
    issue_template: null,
    pull_request_template: null,
    license: { html_url: `https://github.com/${slug}/blob/main/LICENSE` },
    readme: { html_url: `https://github.com/${slug}/blob/main/README.md` },
  },
});

/** A GitHub that lists `me/app` (cloned below) and `me/remote-only` (not), and answers community profile requests. */
function fakeGitHub() {
  const listing = [
    { full_name: "me/app", name: "app", description: "Cloned", html_url: "https://github.com/me/app", private: false, fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", updated_at: null, language: "TypeScript" },
    { full_name: "me/remote-only", name: "remote-only", description: "Lives on GitHub", html_url: "https://github.com/me/remote-only", private: true, fork: false, archived: false, pushed_at: "2026-01-02T00:00:00Z", updated_at: null, language: "TypeScript" },
  ];
  /** `gate`, while set, holds every community profile request until it resolves. */
  const control = { status: 200, score: 57, gate: null as Promise<void> | null };
  /** Every community profile request, by path. */
  const calls: string[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/repos") return json(listing);
    const match = /^\/repos\/(.+)\/community\/profile$/.exec(url.pathname);
    if (!match) return json({ message: "Not Found" }, 404);
    calls.push(url.pathname);
    if (control.gate) await control.gate;
    return control.status === 200 ? json(profileBody(match[1]!, control.score)) : json({ message: "nope" }, control.status);
  });
  return { control, calls, fetchMock };
}

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-remote-community-")));
  const gitRoot = path.join(base, "git");
  const clone = path.join(gitRoot, "app");
  fs.mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/me/app.git"]);
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(path.join(base, "home", "config.toml"), `roots = ["${gitRoot}"]\n\n[search]\nenabled = false\n`);

  vi.stubEnv("GITLIB_HOME", path.join(base, "home"));
  vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
  vi.stubEnv("GITLIB_GITLAB_USERNAME", "");
  vi.stubEnv("GITLIB_GITLAB_URL", "");
  vi.stubEnv("GITLIB_REPO_REFRESH_HOURS", "");
  vi.stubEnv("GITLIB_COMMUNITY_REFRESH_HOURS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

/** The community module on a fresh server, once GitHub's repository listing has been stored. */
async function startServer(github: ReturnType<typeof fakeGitHub>) {
  vi.stubGlobal("fetch", github.fetchMock);
  const shared = globalThis as Record<string, unknown>;
  for (const key of ["__gitlib", "__gitlibCatalog", "__gitlibCommunity"]) delete shared[key];
  vi.resetModules();
  const { buildCatalog } = await import("../src/server/catalog.server");
  await buildCatalog();
  await vi.waitFor(async () => expect((await buildCatalog()).github.refreshing).toBe(false));
  return import("../src/server/community.server");
}

/** Moves the clock forward without touching timers. */
const hoursLater = (hours: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + hours * 3_600_000);
};

const REMOTE_PATH = "/repos/me/remote-only/community/profile";

describe("community profile of a repo that is not cloned", () => {
  it("scores it from GitHub without a clone", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);

    const view = await remoteProfileView("me/remote-only", false);
    expect(view).toMatchObject({
      provider: "github",
      slug: "me/remote-only",
      communityUrl: "https://github.com/me/remote-only/community",
      fetchedAt: expect.any(String),
      error: null,
    });
    expect(view.profile?.score).toBe(57);
    expect(view.profile?.items.filter((item) => item.present).map((item) => item.id)).toEqual(["description", "readme", "license"]);
    expect(github.calls).toEqual([REMOTE_PATH]);
  });

  it("reuses the stored profile while it is fresh", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    const first = await remoteProfileView("me/remote-only", false);

    github.control.score = 99;
    const second = await remoteProfileView("me/remote-only", false);
    expect(github.calls).toHaveLength(1);
    expect(second.profile?.score).toBe(57);
    expect(second.fetchedAt).toBe(first.fetchedAt);
  });

  it("keeps the stored profile after a restart without asking GitHub", async () => {
    const github = fakeGitHub();
    const first = await startServer(github);
    await first.remoteProfileView("me/remote-only", false);

    const restarted = await startServer(github);
    expect((await restarted.remoteProfileView("me/remote-only", false)).profile?.score).toBe(57);
    expect(github.calls).toHaveLength(1);
  });

  it("asks GitHub again once the stored profile is old, since nothing else refreshes a repo that is not cloned", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    await remoteProfileView("me/remote-only", false);

    github.control.score = 85;
    hoursLater(25);
    const view = await remoteProfileView("me/remote-only", false);
    expect(github.calls).toHaveLength(2);
    expect(view.profile?.score).toBe(85);
  });

  it("only fetches for an empty store when automatic refreshing is off", async () => {
    vi.stubEnv("GITLIB_COMMUNITY_REFRESH_HOURS", "0");
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    await remoteProfileView("me/remote-only", false);
    expect(github.calls).toHaveLength(1);

    hoursLater(1000);
    await remoteProfileView("me/remote-only", false);
    expect(github.calls).toHaveLength(1);
  });

  it("refreshes on request even when the stored profile is fresh", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    await remoteProfileView("me/remote-only", false);

    github.control.score = 71;
    const view = await remoteProfileView("me/remote-only", true);
    expect(github.calls).toHaveLength(2);
    expect(view.profile?.score).toBe(71);
  });

  it("matches the name without regard to case and stores it under the listed name", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    const view = await remoteProfileView("ME/Remote-Only", false);
    expect(view.slug).toBe("me/remote-only");
    expect(github.calls).toEqual([REMOTE_PATH]);
  });

  it("refuses a repo that is cloned or that the account does not list, without asking GitHub", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);

    for (const name of ["me/app", "someone/else", "me", "me/remote-only/extra", "../etc"]) {
      const view = await remoteProfileView(name, false);
      expect(view.profile, name).toBeNull();
      expect(view.error, name).toMatch(/not a GitHub repository that gitlib lists without a clone/);
    }
    expect(github.calls).toHaveLength(0);
  });

  it("keeps the old profile, and says why, when GitHub cannot be asked again", async () => {
    const github = fakeGitHub();
    const { remoteProfileView } = await startServer(github);
    await remoteProfileView("me/remote-only", false);

    github.control.status = 429;
    hoursLater(25);
    const view = await remoteProfileView("me/remote-only", false);
    expect(view.profile?.score).toBe(57);
    expect(view.error).toMatch(/rate limit/);
  });

  it("reports the failure when nothing is stored and GitHub cannot be asked", async () => {
    const github = fakeGitHub();
    github.control.status = 404;
    const { remoteProfileView } = await startServer(github);
    const view = await remoteProfileView("me/remote-only", false);
    expect(view.profile).toBeNull();
    expect(view.fetchedAt).toBeNull();
    expect(view.error).toMatch(/me\/remote-only was not found on GitHub/);
  });
});

describe("community profile of a cloned repo", () => {
  async function cloned(github: ReturnType<typeof fakeGitHub>) {
    const server = await startServer(github);
    const { loadAndIndexRepositories } = await import("../src/server/gitlib.server");
    const repo = (await loadAndIndexRepositories()).find((candidate) => candidate.name === "app");
    return { ...server, relativePath: repo!.relativePath };
  }

  it("fetches once, then reads the stored profile however old it is, leaving upkeep to the background refresh", async () => {
    const github = fakeGitHub();
    const { localProfileView, relativePath } = await cloned(github);

    expect((await localProfileView(relativePath, false)).profile?.score).toBe(57);
    expect(github.calls).toEqual(["/repos/me/app/community/profile"]);

    hoursLater(1000);
    github.control.score = 10;
    expect((await localProfileView(relativePath, false)).profile?.score).toBe(57);
    expect(github.calls).toHaveLength(1);
  });

  it("fetches again on request", async () => {
    const github = fakeGitHub();
    const { localProfileView, relativePath } = await cloned(github);
    await localProfileView(relativePath, false);

    github.control.score = 10;
    expect((await localProfileView(relativePath, true)).profile?.score).toBe(10);
    expect(github.calls).toHaveLength(2);
  });

  it("reports an unknown repo as an error instead of throwing", async () => {
    const { localProfileView } = await cloned(fakeGitHub());
    const view = await localProfileView("nope/missing", false);
    expect(view.profile).toBeNull();
    expect(view.error).toEqual(expect.any(String));
  });
});

describe("which repositories get a score", () => {
  /** A fresh server with the one clone (`me/app`) and its favorite switch, plus the saved setting's reader and writer. */
  async function scoring(github: ReturnType<typeof fakeGitHub>) {
    const server = await startServer(github);
    const setting = await import("../src/server/community-scope.server");
    const { getApp, loadAndIndexRepositories } = await import("../src/server/gitlib.server");
    const { setCatalogFavorite } = await import("../src/server/catalog.server");
    const repo = (await loadAndIndexRepositories()).find((candidate) => candidate.name === "app")!;
    return {
      ...server,
      ...setting,
      relativePath: repo.relativePath,
      favorite: (on: boolean) => void getApp().saveRepositoryFavorite(repo.relativePath, on),
      /** Stars `me/remote-only`, the GitHub repo with no clone. */
      star: (on: boolean) => setCatalogFavorite({ provider: "github", fullName: "me/remote-only" }, on),
      /** Resolves once no refresh is running (looking may start one, as the page does). */
      idle: () => vi.waitFor(async () => expect((await server.readCommunityScores()).refreshing).toBe(false)),
      appHome: path.join(base, "home"),
    };
  }

  const APP_PATH = "/repos/me/app/community/profile";

  it("defaults to favorited repositories only", async () => {
    const { readCommunityScope } = await scoring(fakeGitHub());
    expect(readCommunityScope()).toBe("favorites");
  });

  it("keeps the choice on the server, and falls back to the default when the file is unusable", async () => {
    const { readCommunityScope, writeCommunityScope, appHome } = await scoring(fakeGitHub());
    writeCommunityScope("all");
    expect(readCommunityScope()).toBe("all");
    expect(JSON.parse(fs.readFileSync(path.join(appHome, "community-scope.json"), "utf-8"))).toEqual({ scope: "all" });

    fs.writeFileSync(path.join(appHome, "community-scope.json"), "{ not json");
    expect(readCommunityScope()).toBe("favorites");
    fs.writeFileSync(path.join(appHome, "community-scope.json"), JSON.stringify({ scope: "everyone" }));
    expect(readCommunityScope()).toBe("favorites");
  });

  it("neither fetches nor shows a score for a repository that is not a favorite", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, idle } = await scoring(github);

    const view = await readCommunityScores();
    expect(view).toMatchObject({ scope: "favorites", scores: {}, bySlug: {}, refreshing: false });
    await idle();
    expect(github.calls).toHaveLength(0);
  });

  it("fetches and shows a favorite's score, and nothing else", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, favorite, idle, relativePath } = await scoring(github);
    favorite(true);

    expect((await readCommunityScores()).refreshing).toBe(true); // a score is missing, so it starts a refresh
    await idle();
    expect(github.calls).toEqual([APP_PATH]);

    const view = await readCommunityScores();
    expect(view.scores[relativePath]).toEqual({ score: 57, missing: ["code_of_conduct", "contributing", "issue_template", "pull_request_template"] });
    expect(view.bySlug["me/app"]).toMatchObject({ score: 57, fetchedAt: expect.any(String) });
    expect(Object.keys(view.bySlug)).toEqual(["me/app"]);
    expect(view.updatedAt).toBe(view.bySlug["me/app"]!.fetchedAt);
  });

  it("starts scoring a repository once it is favorited, and hides it again once it is not", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, favorite, idle, relativePath } = await scoring(github);
    await readCommunityScores();
    await idle();
    expect(github.calls).toHaveLength(0);

    favorite(true);
    await readCommunityScores();
    await idle();
    expect(github.calls).toEqual([APP_PATH]);
    expect((await readCommunityScores()).scores[relativePath]?.score).toBe(57);

    favorite(false);
    const hidden = await readCommunityScores();
    expect(hidden.scores).toEqual({});
    expect(hidden.bySlug).toEqual({});
  });

  it("leaves a repository with no clone unscored until it is starred, even when the button asks for uncloned ones", async () => {
    const github = fakeGitHub();
    const { refreshAllCommunityScores, favorite, idle } = await scoring(github);
    favorite(true);

    // `uncloned` only means something under the "all" setting.
    await refreshAllCommunityScores(true);
    await idle();
    expect(github.calls).toEqual([APP_PATH]);
  });

  it("scores a starred repository with no clone like a favorite, and stops once it is unstarred", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, star, idle } = await scoring(github);
    await readCommunityScores();
    await idle();
    expect(github.calls).toHaveLength(0);

    await star(true);
    expect((await readCommunityScores()).refreshing).toBe(true); // its score is missing, so a refresh starts
    await idle();
    expect(github.calls).toEqual([REMOTE_PATH]);

    const view = await readCommunityScores();
    expect(view.scope).toBe("favorites");
    expect(Object.keys(view.bySlug)).toEqual(["me/remote-only"]);
    expect(view.bySlug["me/remote-only"]).toMatchObject({ score: 57, fetchedAt: expect.any(String) });
    // Scores by path are for clones only.
    expect(view.scores).toEqual({});

    await star(false);
    expect((await readCommunityScores()).bySlug).toEqual({});
  });

  it("keeps a starred repository with no clone current in the background under \"all\" too", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, writeCommunityScope, star, idle } = await scoring(github);
    writeCommunityScope("all");
    await star(true);

    await readCommunityScores();
    await idle();
    // The clone and the starred repo, but not the rest of the uncloned repos (there are none here besides it).
    expect([...github.calls].sort()).toEqual([APP_PATH, REMOTE_PATH]);
  });

  it("scores every clone under the \"all\" setting, but not the uncloned ones unless the button asks", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, refreshAllCommunityScores, writeCommunityScope, idle, relativePath } = await scoring(github);
    writeCommunityScope("all");

    // Nothing is a favorite, yet the background refresh covers the clone, and only the clone.
    expect((await readCommunityScores()).scope).toBe("all");
    await idle();
    expect(github.calls).toEqual([APP_PATH]);

    await refreshAllCommunityScores(false);
    await idle();
    expect(github.calls).toEqual([APP_PATH, APP_PATH]);

    await refreshAllCommunityScores(true);
    await idle();
    expect(github.calls.slice(2).sort()).toEqual([APP_PATH, REMOTE_PATH]);

    const view = await readCommunityScores();
    expect(Object.keys(view.bySlug).sort()).toEqual(["me/app", "me/remote-only"]);
    expect(view.bySlug["me/remote-only"]).toMatchObject({ score: 57 });
    // Scores by path are for clones only.
    expect(Object.keys(view.scores)).toEqual([relativePath]);
  });

  it("shows a stored profile of an uncloned repo only under \"all\"", async () => {
    const github = fakeGitHub();
    const { readCommunityScores, remoteProfileView, writeCommunityScope, favorite, idle } = await scoring(github);
    favorite(true);
    // Opening the repo's own page always fetches and stores its profile, whatever the setting.
    expect((await remoteProfileView("me/remote-only", false)).profile?.score).toBe(57);
    await readCommunityScores();
    await idle();

    expect(Object.keys((await readCommunityScores()).bySlug)).toEqual(["me/app"]);
    writeCommunityScope("all");
    expect(Object.keys((await readCommunityScores()).bySlug).sort()).toEqual(["me/app", "me/remote-only"]);
  });

  it("returns from the Refresh scores button at once and finishes in the background", async () => {
    const github = fakeGitHub();
    const { refreshAllCommunityScores, readCommunityScores, favorite, idle } = await scoring(github);
    favorite(true);
    let release!: () => void;
    github.control.gate = new Promise<void>((resolve) => (release = resolve));

    const started = await refreshAllCommunityScores(false);
    expect(started.refreshing).toBe(true);
    expect(started.bySlug).toEqual({});

    release();
    await idle();
    expect(Object.keys((await readCommunityScores()).bySlug)).toEqual(["me/app"]);
  });

  it("does not let a run over clones satisfy a request that includes uncloned repos", async () => {
    const github = fakeGitHub();
    const { refreshAllCommunityScores, writeCommunityScope, idle } = await scoring(github);
    writeCommunityScope("all");
    let release!: () => void;
    github.control.gate = new Promise<void>((resolve) => (release = resolve));

    await refreshAllCommunityScores(false); // held at GitHub
    await refreshAllCommunityScores(true); // must wait for it, then run in full
    release();
    await idle();
    expect(github.calls).toContain(REMOTE_PATH);
  });
});
