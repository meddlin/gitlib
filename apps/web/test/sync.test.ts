import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { checkRepoSync, checkRepos } from "../src/server/sync.server";

const identity = {
  GIT_AUTHOR_NAME: "Test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "Test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, "-c", "commit.gpgsign=false", ...args], {
    encoding: "utf-8",
    env: { ...process.env, ...identity },
  });
}

/** A commit touching `file`, so every call makes a distinct commit. */
function commit(cwd: string, file: string, message: string): void {
  fs.writeFileSync(path.join(cwd, file), `${message}\n`);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", message);
}

let base: string;
let remote: string; // the bare repo both clones push to
let mine: string; // the clone gitlib looks at
let theirs: string; // somebody else's clone, used to put new commits on the remote

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-sync-")));
  remote = path.join(base, "remote.git");
  mine = path.join(base, "mine");
  theirs = path.join(base, "theirs");

  execFileSync("git", ["init", "-q", "--bare", "-b", "main", remote]);
  execFileSync("git", ["clone", "-q", remote, theirs], { stdio: "ignore" });
  commit(theirs, "readme.md", "first");
  git(theirs, "push", "-q", "-u", "origin", "HEAD:main");
  execFileSync("git", ["clone", "-q", remote, mine], { stdio: "ignore" });
});

afterEach(() => {
  // The read-only test leaves a tree that rmSync can't delete until it is writable again.
  execFileSync("chmod", ["-R", "u+w", base]);
  fs.rmSync(base, { recursive: true, force: true });
});

describe("checkRepoSync", () => {
  it("is current when the clone has everything the remote has", async () => {
    expect(await checkRepoSync(mine)).toEqual({ state: "current", upstream: "origin/main" });
  });

  it("is behind when the remote has commits this clone has never fetched", async () => {
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    expect(await checkRepoSync(mine)).toEqual({ state: "behind", upstream: "origin/main" });
  });

  it("stays behind after a fetch, because the commits are known but not merged", async () => {
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    git(mine, "fetch", "-q");
    expect(await checkRepoSync(mine)).toEqual({ state: "behind", upstream: "origin/main" });
  });

  it("is current again once the clone pulls", async () => {
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    git(mine, "pull", "-q");
    expect(await checkRepoSync(mine)).toEqual({ state: "current", upstream: "origin/main" });
  });

  it("is current when the clone is only ahead: an unpushed commit leaves nothing to pull", async () => {
    commit(mine, "local.md", "local only");
    expect(await checkRepoSync(mine)).toEqual({ state: "current", upstream: "origin/main" });
  });

  it("is behind when the clone has diverged, since a pull still has something to bring in", async () => {
    commit(mine, "local.md", "local only");
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    expect(await checkRepoSync(mine)).toEqual({ state: "behind", upstream: "origin/main" });
  });

  it("follows the branch that is checked out, not the default branch", async () => {
    git(theirs, "checkout", "-q", "-b", "feature");
    commit(theirs, "feature.md", "feature work");
    git(theirs, "push", "-q", "-u", "origin", "feature");
    git(mine, "fetch", "-q");
    git(mine, "checkout", "-q", "feature");
    expect(await checkRepoSync(mine)).toEqual({ state: "current", upstream: "origin/feature" });

    commit(theirs, "feature.md", "more feature work");
    git(theirs, "push", "-q");
    expect(await checkRepoSync(mine)).toEqual({ state: "behind", upstream: "origin/feature" });
  });

  it("works on a read-only checkout, as the Docker mount is, because it only reads", async () => {
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    execFileSync("chmod", ["-R", "a-w", mine]);
    expect(await checkRepoSync(mine)).toEqual({ state: "behind", upstream: "origin/main" });
  });

  it("has nothing to say about a detached HEAD", async () => {
    git(mine, "checkout", "-q", "--detach");
    expect(await checkRepoSync(mine)).toEqual({ state: "none" });
  });

  it("has nothing to say about a branch with no upstream, or a repo with no commits or remote", async () => {
    git(mine, "checkout", "-q", "-b", "scratch");
    expect(await checkRepoSync(mine)).toEqual({ state: "none" });

    const fresh = path.join(base, "fresh");
    execFileSync("git", ["init", "-q", "-b", "main", fresh]);
    expect(await checkRepoSync(fresh)).toEqual({ state: "none" });
  });

  it("has nothing to say about a branch that tracks another local branch", async () => {
    git(mine, "checkout", "-q", "-b", "local", "--track", "main");
    expect(await checkRepoSync(mine)).toEqual({ state: "none" });
  });

  it("has nothing to say once the upstream branch is deleted on the remote", async () => {
    git(theirs, "checkout", "-q", "-b", "gone");
    git(theirs, "push", "-q", "-u", "origin", "gone");
    git(mine, "fetch", "-q");
    git(mine, "checkout", "-q", "gone");
    git(theirs, "push", "-q", "origin", "--delete", "gone");
    expect(await checkRepoSync(mine)).toEqual({ state: "none" });
  });

  it("reports why when the remote cannot be reached, rather than guessing", async () => {
    fs.rmSync(remote, { recursive: true });
    const result = await checkRepoSync(mine);
    expect(result).toMatchObject({ state: "failed", upstream: "origin/main" });
    expect(result.state === "failed" && result.error).toMatch(/\S/);
  });

  it("reports a directory that is not a repository as a failure", async () => {
    const plain = path.join(base, "plain");
    fs.mkdirSync(plain);
    expect((await checkRepoSync(plain)).state).toBe("failed");
  });
});

describe("checkRepos", () => {
  it("checks every repo and keys the answers by relativePath", async () => {
    commit(theirs, "readme.md", "second");
    git(theirs, "push", "-q");
    const other = path.join(base, "other");
    execFileSync("git", ["clone", "-q", remote, other], { stdio: "ignore" });
    const detached = path.join(base, "detached");
    execFileSync("git", ["clone", "-q", remote, detached], { stdio: "ignore" });
    git(detached, "checkout", "-q", "--detach");

    const results = await checkRepos([
      { relativePath: "a/mine", absolutePath: mine },
      { relativePath: "a/other", absolutePath: other },
      { relativePath: "a/detached", absolutePath: detached },
    ]);

    // `mine` was cloned before the second commit; `other` was cloned after it.
    expect(Object.fromEntries(results)).toEqual({
      "a/mine": { state: "behind", upstream: "origin/main" },
      "a/other": { state: "current", upstream: "origin/main" },
      "a/detached": { state: "none" },
    });
  });

  it("answers an empty list", async () => {
    expect((await checkRepos([])).size).toBe(0);
  });
});
