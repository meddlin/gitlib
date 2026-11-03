import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isGitLibError } from "@gitlib/core";
import {
  SNAPSHOT_MAX_FILES,
  SNAPSHOT_README_CHARS,
  languageShares,
  parseSnapshot,
  parseStoredSnapshot,
  serializeSnapshot,
  toSnapshotContext,
} from "../src/lib/repo-snapshot";

/** Shaped like real responses for `GET /repos/acme/widgets`, `/languages` and `/contents`. */
const repo = {
  full_name: "acme/widgets",
  default_branch: "main",
  license: { key: "mit", name: "MIT License", spdx_id: "MIT" },
  topics: ["widgets", "cli"],
  stargazers_count: 7,
  size: 420,
};
const languages = { CSS: 900, TypeScript: 8100, Shell: 0 };
const contents = [
  { name: "package.json", type: "file" },
  { name: "src", type: "dir" },
  { name: ".github", type: "dir" },
  { name: "README.md", type: "file" },
];

describe("parseSnapshot", () => {
  it("keeps the facts the chat needs, with directories first", () => {
    const snapshot = parseSnapshot({ repo, languages, contents, readme: "# Widgets" });
    expect(snapshot).toEqual({
      defaultBranch: "main",
      license: "MIT",
      topics: ["widgets", "cli"],
      stars: 7,
      sizeKb: 420,
      languages: [
        { name: "TypeScript", bytes: 8100 },
        { name: "CSS", bytes: 900 },
      ],
      files: [
        { name: ".github", isDir: true },
        { name: "src", isDir: true },
        { name: "package.json", isDir: false },
        { name: "README.md", isDir: false },
      ],
      filesTruncated: false,
      readme: "# Widgets",
    });
  });

  it("copes with a repository that has no languages, files, README or license", () => {
    const snapshot = parseSnapshot({
      repo: { default_branch: "trunk", license: null, topics: null },
      languages: {},
      contents: { message: "This repository is empty." },
      readme: "",
    });
    expect(snapshot).toMatchObject({ defaultBranch: "trunk", license: null, topics: [], languages: [], files: [], readme: "" });
  });

  it("falls back to the license's name when GitHub could not identify it", () => {
    const snapshot = parseSnapshot({ repo: { license: { name: "Other", spdx_id: "NOASSERTION" } }, languages: {}, contents: [], readme: "" });
    expect(snapshot.license).toBe("Other");
  });

  it("cuts a huge README and a huge root listing", () => {
    const many = Array.from({ length: SNAPSHOT_MAX_FILES + 50 }, (_, i) => ({ name: `f${String(i).padStart(4, "0")}`, type: "file" }));
    const snapshot = parseSnapshot({ repo, languages, contents: many, readme: "r".repeat(SNAPSHOT_README_CHARS + 10) });
    expect(snapshot.files).toHaveLength(SNAPSHOT_MAX_FILES);
    expect(snapshot.filesTruncated).toBe(true);
    expect(snapshot.readme).toHaveLength(SNAPSHOT_README_CHARS);
  });

  it("survives being stored and read back, and refuses what is not a snapshot", () => {
    const snapshot = parseSnapshot({ repo, languages, contents, readme: "# Widgets" });
    expect(parseStoredSnapshot(serializeSnapshot(snapshot))).toEqual(snapshot);
    for (const payload of ["not json", "[]", "{}", JSON.stringify({ ...snapshot, readme: 5 })]) expect(parseStoredSnapshot(payload)).toBeNull();
  });
});

describe("language shares", () => {
  it("are percentages of the bytes GitHub attributes to a language", () => {
    const shares = languageShares([
      { name: "TypeScript", bytes: 8100 },
      { name: "CSS", bytes: 900 },
    ]);
    expect(shares.map((share) => [share.name, Math.round(share.percent)])).toEqual([
      ["TypeScript", 90],
      ["CSS", 10],
    ]);
  });

  it("are empty when nothing was counted", () => {
    expect(languageShares([])).toEqual([]);
  });

  it("go to the prompt with the time the snapshot was taken", () => {
    const context = toSnapshotContext(parseSnapshot({ repo, languages, contents, readme: "x" }), "2026-11-02T09:00:00Z");
    expect(context).toMatchObject({ fetchedAt: "2026-11-02T09:00:00Z", readme: "x", files: expect.any(Array) });
    expect(context.languages[0]).toMatchObject({ name: "TypeScript" });
  });
});

/** A GitHub that lists `me/app` (cloned here) and `me/remote-only` (not), and answers questions about the latter. */
function fakeGitHub() {
  const control = { snapshotStatus: 200, readmeStatus: 200, languages: { TypeScript: 3000, CSS: 1000 } as Record<string, number> };
  const calls: string[] = [];
  const listing = [
    { full_name: "me/app", name: "app", description: "The app", html_url: "https://github.com/me/app", private: false, fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", updated_at: null, language: "TypeScript" },
    { full_name: "me/remote-only", name: "remote-only", description: "Lives on GitHub", html_url: "https://github.com/me/remote-only", private: true, fork: false, archived: false, pushed_at: "2026-02-01T00:00:00Z", updated_at: null, language: "TypeScript" },
  ];
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ETag: '"v1"' } });
  const fetchMock = vi.fn<typeof fetch>(async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/user/repos") return json(listing);
    calls.push(url.pathname);
    if (control.snapshotStatus !== 200) return json({ message: "nope" }, control.snapshotStatus);
    switch (url.pathname) {
      case "/repos/me/remote-only":
        return json({ ...repo, full_name: "me/remote-only" });
      case "/repos/me/remote-only/languages":
        return json(control.languages);
      case "/repos/me/remote-only/contents":
        return json(contents);
      case "/repos/me/remote-only/readme":
        return control.readmeStatus === 200
          ? json({ encoding: "base64", content: Buffer.from("# Remote only\n\nHello from GitHub.").toString("base64") })
          : json({ message: "Not Found" }, control.readmeStatus);
      default:
        return json({ message: "Not Found" }, 404);
    }
  });
  return { control, calls, fetchMock };
}

let base: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-snapshot-")));
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
  vi.stubEnv("GITLIB_SNAPSHOT_REFRESH_HOURS", "");
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(base, { recursive: true, force: true });
});

/** The snapshot module on a fresh server, once GitHub's repository listing has been stored. */
async function startServer(github: ReturnType<typeof fakeGitHub>) {
  vi.stubGlobal("fetch", github.fetchMock);
  const shared = globalThis as Record<string, unknown>;
  delete shared["__gitlib"];
  delete shared["__gitlibCatalog"];
  vi.resetModules();
  const { buildCatalog } = await import("../src/server/catalog.server");
  await buildCatalog();
  await vi.waitFor(async () => expect((await buildCatalog()).github.refreshing).toBe(false));
  return import("../src/server/repo-snapshot.server");
}

const hoursLater = (hours: number) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(Date.now() + hours * 3_600_000);
};

describe("GitHub repositories in the chat", () => {
  it("lists only the repositories that are not cloned", async () => {
    const { githubChatSource } = await startServer(fakeGitHub());
    expect(await githubChatSource.list()).toEqual([{ fullName: "me/remote-only", description: "Lives on GitHub", language: "TypeScript" }]);
  });

  it("fetches a repository's details once and reuses them while they are fresh", async () => {
    const github = fakeGitHub();
    const { githubChatSource } = await startServer(github);

    const context = await githubChatSource.resolve("me/remote-only");
    expect(context).toMatchObject({
      fullName: "me/remote-only",
      description: "Lives on GitHub",
      isPrivate: true,
      primaryLanguage: "TypeScript",
      syncNote: null,
    });
    expect(context.snapshot?.languages.map((l) => [l.name, l.percent])).toEqual([
      ["TypeScript", 75],
      ["CSS", 25],
    ]);
    expect(context.snapshot?.files.map((f) => f.name)).toEqual([".github", "src", "package.json", "README.md"]);
    expect(context.snapshot?.readme).toContain("Hello from GitHub.");
    expect(github.calls).toHaveLength(4);

    await githubChatSource.resolve("me/remote-only");
    expect(github.calls).toHaveLength(4);
  });

  it("matches the repository name without regard to case", async () => {
    const { githubChatSource } = await startServer(fakeGitHub());
    expect((await githubChatSource.resolve("ME/Remote-Only")).fullName).toBe("me/remote-only");
  });

  it("refuses a repository the account does not list, without asking GitHub about it", async () => {
    const github = fakeGitHub();
    const { githubChatSource } = await startServer(github);
    const error = await githubChatSource.resolve("someone/else").catch((caught: unknown) => caught);
    expect(isGitLibError(error)).toBe(true);
    expect(github.calls).toHaveLength(0);
  });

  it("fetches again once the details are old", async () => {
    const github = fakeGitHub();
    const { githubChatSource } = await startServer(github);
    await githubChatSource.resolve("me/remote-only");
    github.control.languages = { Rust: 1 };

    hoursLater(25);
    const context = await githubChatSource.resolve("me/remote-only");
    expect(github.calls).toHaveLength(8);
    expect(context.snapshot?.languages.map((l) => l.name)).toEqual(["Rust"]);
  });

  it("refreshes on request even when the details are fresh", async () => {
    const github = fakeGitHub();
    const { syncRemote } = await startServer(github);
    expect(await syncRemote("me/remote-only", false)).toMatchObject({ error: null, fetchedAt: expect.any(String) });
    await syncRemote("me/remote-only", false);
    expect(github.calls).toHaveLength(4);
    await syncRemote("me/remote-only", true);
    expect(github.calls).toHaveLength(8);
  });

  it("shares one fetch between two askers at once", async () => {
    const github = fakeGitHub();
    const { githubChatSource, syncRemote } = await startServer(github);
    await Promise.all([syncRemote("me/remote-only", false), githubChatSource.resolve("me/remote-only")]);
    expect(github.calls).toHaveLength(4);
  });

  it("copes with a repository that has no README", async () => {
    const github = fakeGitHub();
    github.control.readmeStatus = 404;
    const { githubChatSource } = await startServer(github);
    const context = await githubChatSource.resolve("me/remote-only");
    expect(context.snapshot).toMatchObject({ readme: "" });
    expect(context.snapshot?.files.length).toBeGreaterThan(0);
    expect(context.syncNote).toBeNull();
  });

  it("keeps the old details, and says so, when GitHub cannot be asked again", async () => {
    const github = fakeGitHub();
    const { githubChatSource } = await startServer(github);
    await githubChatSource.resolve("me/remote-only");

    github.control.snapshotStatus = 429;
    hoursLater(25);
    const context = await githubChatSource.resolve("me/remote-only");
    expect(context.snapshot?.readme).toContain("Hello from GitHub.");
    expect(context.syncNote).toMatch(/rate limit.*may be out of date/);
  });

  it("falls back to what the listing says when there are no stored details and GitHub fails", async () => {
    const github = fakeGitHub();
    github.control.snapshotStatus = 429;
    const { githubChatSource } = await startServer(github);
    const context = await githubChatSource.resolve("me/remote-only");
    expect(context.snapshot).toBeNull();
    expect(context.description).toBe("Lives on GitHub");
    expect(context.syncNote).toMatch(/could not be asked.*rate limit/);
  });
});
