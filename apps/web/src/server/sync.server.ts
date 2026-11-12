import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Whether a clone's current branch has fallen behind the remote branch it tracks.
 *
 * The remote's tip is read with `git ls-remote`, which writes nothing, so this works on the read-only mount the
 * Docker image uses; `git fetch` would fail there, and a local-only comparison would only ever see commits
 * somebody had already fetched.
 */
export type RepoSync =
  // "behind": the upstream branch has commits this checkout lacks, so `git pull` has something to bring in.
  // `upstream` is the branch being tracked, e.g. `origin/main`.
  | { state: "behind" | "current"; upstream: string }
  // Nothing to compare: detached HEAD, no commits yet, no upstream, or the upstream branch is gone from the remote.
  | { state: "none" }
  // The branch has an upstream, but the remote could not be asked (offline, no credentials, timed out).
  | { state: "failed"; upstream: string; error: string };

const NONE: RepoSync = { state: "none" };

/** A repo that is slow to answer shouldn't hold up the rest; git gives up on it after this long. */
const GIT_TIMEOUT_MS = 20_000;
/** Remotes asked at once; the same politeness as the contribution graph's git calls. */
const CONCURRENCY = 8;

interface GitError {
  code?: number | string;
  stderr?: string;
  message?: string;
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
    // Never prompt for a password, as with cloning: a remote that needs one is reported as unreachable instead.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

const exitCode = (error: unknown): number | string | undefined => (error as GitError).code;

/** The most useful line of what git said, falling back to the error's own message. */
function describe(error: unknown): string {
  const { stderr, message } = error as GitError;
  const lines = (stderr ?? "").split("\n").map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => /^(fatal|error):/i.test(line))?.replace(/^(fatal|error):\s*/i, "") ?? lines[0] ?? message ?? "git failed.";
}

/** The sha `ref` points to on `remote`, or null if the remote has no such branch. */
async function remoteTip(repoPath: string, remote: string, ref: string): Promise<string | null> {
  const out = await git(repoPath, ["ls-remote", remote, ref]);
  // The pattern also matches refs that merely end with it (`refs/heads/x/refs/heads/main`), so insist on the exact one.
  for (const line of out.split("\n")) {
    const [sha, name] = line.split("\t");
    if (sha && name?.trim() === ref) return sha;
  }
  return null;
}

/** Whether `sha` is already part of HEAD's history. A commit this clone has never fetched can't be. */
async function isInHistory(repoPath: string, sha: string): Promise<boolean> {
  try {
    await git(repoPath, ["merge-base", "--is-ancestor", sha, "HEAD"]);
    return true;
  } catch (error) {
    if (exitCode(error) === 1) return false;
    if (exitCode(error) === 128 && /not a valid (commit|object) name/i.test((error as GitError).stderr ?? "")) return false;
    throw error;
  }
}

/** Checks one clone's current branch against its upstream. Never rejects. */
export async function checkRepoSync(repoPath: string): Promise<RepoSync> {
  let ref: string;
  try {
    ref = (await git(repoPath, ["symbolic-ref", "--quiet", "HEAD"])).trim();
  } catch (error) {
    // `symbolic-ref --quiet` exits 1, silently, for a detached HEAD; anything else means git could not read the repo.
    if (exitCode(error) === 1) return NONE;
    return { state: "failed", upstream: "", error: describe(error) };
  }

  let remote = "";
  let remoteRef = "";
  let head = "";
  try {
    const out = await git(repoPath, ["for-each-ref", "--format=%(upstream:remotename)%09%(upstream:remoteref)%09%(objectname)", ref]);
    [remote = "", remoteRef = "", head = ""] = out.trim().split("\t");
  } catch (error) {
    return { state: "failed", upstream: "", error: describe(error) };
  }
  // No upstream configured, or the branch tracks another local branch (its remote is "."): nothing to ask.
  if (!remote || remote === "." || !remoteRef || !head) return NONE;

  const upstream = `${remote}/${remoteRef.replace(/^refs\/heads\//, "")}`;
  try {
    const tip = await remoteTip(repoPath, remote, remoteRef);
    if (tip === null) return NONE;
    return { state: tip === head || (await isInHistory(repoPath, tip)) ? "current" : "behind", upstream };
  } catch (error) {
    return { state: "failed", upstream, error: describe(error) };
  }
}

/** Checks every repo, a few at a time, keyed by `relativePath`. */
export async function checkRepos(repos: readonly { relativePath: string; absolutePath: string }[]): Promise<Map<string, RepoSync>> {
  const results = new Map<string, RepoSync>();
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, repos.length) }, async () => {
      while (next < repos.length) {
        const repo = repos[next++]!;
        results.set(repo.relativePath, await checkRepoSync(repo.absolutePath));
      }
    }),
  );
  return results;
}
