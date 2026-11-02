import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** A GitHub that lists one repo and honours If-None-Match, counting how it is asked. */
function fakeGitHub() {
  const calls: { ifNoneMatch: string | null; status: number }[] = [];
  const listing = [
    {
      full_name: "me/app",
      name: "app",
      description: "The app",
      html_url: "https://github.com/me/app",
      private: false,
      fork: false,
      archived: false,
      pushed_at: "2026-01-01T00:00:00Z",
      updated_at: null,
      language: "TypeScript",
    },
    { ...{ full_name: "me/remote-only", name: "remote-only" }, description: null, html_url: "https://github.com/me/remote-only", private: true, fork: false, archived: false, pushed_at: null, updated_at: "2025-01-01T00:00:00Z", language: null },
  ];
  const control = { etag: '"v1"', failWith: 0 };
  const fetchMock = vi.fn<typeof fetch>(async (_url, init) => {
    const headers = init?.headers as Record<string, string>;
    const ifNoneMatch = headers["If-None-Match"] ?? null;
    if (control.failWith) {
      calls.push({ ifNoneMatch, status: control.failWith });
      return new Response("{}", { status: control.failWith });
    }
    if (ifNoneMatch === control.etag) {
      calls.push({ ifNoneMatch, status: 304 });
      return new Response(null, { status: 304 });
    }
    calls.push({ ifNoneMatch, status: 200 });
    return new Response(JSON.stringify(listing), { status: 200, headers: { ETag: control.etag } });
  });
  return { calls, control, fetchMock };
}

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-catalog-")));
  const gitRoot = path.join(base, "git");
  const clone = path.join(gitRoot, "app");
  fs.mkdirSync(clone, { recursive: true });
  execFileSync("git", ["init", "-q", clone]);
  execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/me/app.git"]);
  fs.mkdirSync(path.join(base, "home"));
  fs.writeFileSync(
    path.join(base, "home", "config.toml"),
    `roots = ["${gitRoot}"]\n\n[search]\nenabled = false\n`,
  );

  vi.stubEnv("GITLIB_HOME", path.join(base, "home"));
  vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
  vi.stubEnv("GITHUB_TOKEN", "");
  vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
  vi.stubEnv("GITLIB_GITLAB_USERNAME", "");
  vi.stubEnv("GITLIB_GITLAB_URL", "");
  vi.stubEnv("GITLIB_REPO_REFRESH_HOURS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

/** A fresh copy of the server modules and their shared state, like a restarted server. */
async function startServer() {
  const shared = globalThis as Record<string, unknown>;
  delete shared["__gitlib"];
  delete shared["__gitlibCatalog"];
  vi.resetModules();
  return (await import("../src/server/catalog.server")).buildCatalog;
}

/** Moves the clock forward without touching timers, so background checks still run on real time. */
const hoursLater = (hours: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + hours * 3_600_000);
};

const settled = (load: () => Promise<{ github: { refreshing: boolean } }>) =>
  vi.waitFor(async () => expect((await load()).github.refreshing).toBe(false));

describe("catalog listings", () => {
  it("lists in the background the first time, then serves the stored list without asking GitHub", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const load = await startServer();

    const first = await load();
    expect(first.github).toMatchObject({ status: "ok", fetchedAt: null, refreshing: true });
    // Until GitHub answers, the clone still shows, linked from its own remote.
    expect(first.entries.map((entry) => entry.fullName)).toEqual(["me/app"]);
    expect(first.entries[0]!.github?.listed).toBe(false);

    await settled(load);
    const second = await load();
    expect(second.github).toMatchObject({ status: "ok", count: 2, refreshing: false });
    expect(second.entries.map((entry) => [entry.fullName, entry.locals.length, entry.github?.listed])).toEqual([
      ["me/app", 1, true],
      ["me/remote-only", 0, true],
    ]);
    expect(second.entries[0]!.description).toBe("The app");

    await load();
    await load();
    expect(github.calls).toHaveLength(1);
  });

  it("serves the stored list after a restart without asking GitHub", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const first = await startServer();
    await first();
    await settled(first);
    expect(github.calls).toHaveLength(1);

    const restarted = await startServer();
    const view = await restarted();
    expect(view.github).toMatchObject({ count: 2, refreshing: false });
    expect(view.entries).toHaveLength(2);
    expect(github.calls).toHaveLength(1);
  });

  it("rechecks once the list is old, revalidating with the stored ETag", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const load = await startServer();
    await load();
    await settled(load);
    const before = (await load()).github.fetchedAt!;

    hoursLater(7); // past the 6 hour default
    await load(); // notices the list is due and starts a check
    await settled(load);

    expect(github.calls.map((call) => call.status)).toEqual([200, 304]);
    expect(github.calls[1]!.ifNoneMatch).toBe('"v1"');
    const after = await load();
    expect(after.github.count).toBe(2);
    expect(after.github.fetchedAt! > before).toBe(true);
  });

  it("checks nothing automatically when the interval is 0, but still fills an empty store", async () => {
    vi.stubEnv("GITLIB_REPO_REFRESH_HOURS", "0");
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const load = await startServer();
    await load();
    await settled(load);
    expect(github.calls).toHaveLength(1);

    hoursLater(1000);
    await load();
    await load();
    expect(github.calls).toHaveLength(1);
  });

  it("keeps the stored list when a check fails, and leaves GitHub alone for a while", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const load = await startServer();
    await load();
    await settled(load);

    github.control.failWith = 401;
    hoursLater(7);
    await load();
    await settled(load);

    const failed = await load();
    expect(failed.github.status).toBe("error");
    expect(failed.github.message).toContain("rejected the token");
    expect(failed.github.count).toBe(2);
    expect(failed.entries).toHaveLength(2);

    const attempts = github.calls.length;
    await load();
    await load();
    expect(github.calls).toHaveLength(attempts);
  });

  it("does not show a stored list once GitHub is no longer configured", async () => {
    const github = fakeGitHub();
    vi.stubGlobal("fetch", github.fetchMock);
    const load = await startServer();
    await load();
    await settled(load);

    vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "");
    const view = await load();
    expect(view.github).toMatchObject({ status: "not-configured", count: 0 });
    expect(view.entries.map((entry) => entry.fullName)).toEqual(["me/app"]);
  });
});
