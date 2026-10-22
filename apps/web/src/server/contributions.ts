import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServerFn } from "@tanstack/react-start";
import { githubToken } from "./github.server";
import { loadAndIndexRepositories } from "./gitlib.server";

const run = promisify(execFile);

export interface ContributionsView {
  /** Commits per local calendar day (`YYYY-MM-DD`) over the last year; days without commits are absent. */
  days: Record<string, number>;
  total: number;
  /** Repositories that had at least one commit in the window. */
  repoCount: number;
  /** Why GitHub or GitLab activity is missing from an "all sources" view (not configured, request failed). */
  notices: string[];
}

export type ContributionSource = "local" | "all";

const DAYS = 371;
const CONCURRENCY = 8;
const TTL_MS = 5 * 60_000;

async function git(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await run("git", ["-C", repoPath, ...args], {
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30_000,
  });
  return stdout;
}

/** Commits by the repo's configured user on any branch since `since`, as `[hash, day]` pairs. */
async function commitsIn(repoPath: string, since: string): Promise<[string, string][]> {
  const email = (await git(repoPath, ["config", "user.email"]).catch(() => "")).trim();
  const args = ["log", "--all", `--since=${since}`, "--date=format-local:%Y-%m-%d", "--format=%H %ad"];
  if (email) args.push("--fixed-strings", `--author=<${email}>`);
  const out = await git(repoPath, args).catch(() => "");
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" ") as [string, string]);
}

async function computeLocal(): Promise<ContributionsView> {
  const repos = (await loadAndIndexRepositories()).filter((repo) => !repo.isWorktree && !repo.isMissing);
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString().slice(0, 10);

  const seen = new Set<string>(); // clones of one project share commits; count each once
  const days: Record<string, number> = {};
  let repoCount = 0;
  let next = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (next < repos.length) {
        const repo = repos[next++]!;
        let any = false;
        for (const [hash, day] of await commitsIn(repo.absolutePath, since)) {
          if (seen.has(hash)) continue;
          seen.add(hash);
          days[day] = (days[day] ?? 0) + 1;
          any = true;
        }
        if (any) repoCount += 1;
      }
    }),
  );
  return { days, total: seen.size, repoCount, notices: [] };
}

const gitlabUsername = (): string | undefined => process.env["GITLIB_GITLAB_USERNAME"] || undefined;
const gitlabBase = (): string => (process.env["GITLIB_GITLAB_URL"] || "https://gitlab.com").replace(/\/+$/, "");

interface Remote {
  days: Record<string, number>;
  notice: string | null;
}

/** The token owner's GitHub contribution calendar (commits, PRs, issues and reviews) for the last year. */
async function githubCalendar(): Promise<Remote> {
  const token = githubToken();
  if (!token)
    return {
      days: {},
      notice: "GitHub is not included: set GITLIB_GITHUB_TOKEN.",
    };
  const to = new Date();
  const from = new Date(to.getTime() - 364 * 86_400_000);
  const query = `query($from: DateTime!, $to: DateTime!) { viewer { contributionsCollection(from: $from, to: $to) {
    contributionCalendar { weeks { contributionDays { date contributionCount } } } } } }`;
  try {
    const response = await fetch("https://api.github.com/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "User-Agent": "gitlib",
      },
      body: JSON.stringify({
        query,
        variables: { from: from.toISOString(), to: to.toISOString() },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { days: {}, notice: `GitHub responded with ${response.status}.` };
    const body = (await response.json()) as {
      data?: {
        viewer: {
          contributionsCollection: {
            contributionCalendar: {
              weeks: {
                contributionDays: { date: string; contributionCount: number }[];
              }[];
            };
          };
        };
      };
      errors?: { message: string }[];
    };
    if (!body.data)
      return {
        days: {},
        notice: `GitHub: ${body.errors?.[0]?.message ?? "no data returned."}`,
      };
    const days: Record<string, number> = {};
    for (const week of body.data.viewer.contributionsCollection.contributionCalendar.weeks)
      for (const day of week.contributionDays) if (day.contributionCount > 0) days[day.date] = day.contributionCount;
    return { days, notice: null };
  } catch (caught) {
    return {
      days: {},
      notice: `GitHub: ${caught instanceof Error ? caught.message : "request failed."}`,
    };
  }
}

/** A GitLab user's public contribution calendar for the last year. */
async function gitlabCalendar(): Promise<Remote> {
  const username = gitlabUsername();
  if (!username)
    return {
      days: {},
      notice: "GitLab is not included: set GITLIB_GITLAB_USERNAME (and GITLIB_GITLAB_URL if self-hosted).",
    };
  try {
    const response = await fetch(`${gitlabBase()}/users/${encodeURIComponent(username)}/calendar.json`, {
      headers: { Accept: "application/json", "User-Agent": "gitlib" },
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return { days: {}, notice: `GitLab responded with ${response.status}.` };
    return {
      days: (await response.json()) as Record<string, number>,
      notice: null,
    };
  } catch (caught) {
    return {
      days: {},
      notice: `GitLab: ${caught instanceof Error ? caught.message : "request failed."}`,
    };
  }
}

/**
 * Local commits plus GitHub and GitLab activity. A pushed commit shows up both locally and on the host, so each
 * day takes the larger of the local and remote counts instead of adding them.
 */
async function computeAll(): Promise<ContributionsView> {
  const [local, github, gitlab] = await Promise.all([localResult(), githubCalendar(), gitlabCalendar()]);
  // The two hosts are different work, so they add up before being compared with local.
  const remoteSum: Record<string, number> = {};
  for (const remote of [github.days, gitlab.days])
    for (const [day, count] of Object.entries(remote)) remoteSum[day] = (remoteSum[day] ?? 0) + count;
  const merged: Record<string, number> = { ...local.days };
  for (const [day, count] of Object.entries(remoteSum)) merged[day] = Math.max(merged[day] ?? 0, count);
  const total = Object.values(merged).reduce((sum, n) => sum + n, 0);
  return {
    days: merged,
    total,
    repoCount: local.repoCount,
    notices: [github.notice, gitlab.notice].filter((n): n is string => n !== null),
  };
}

const cache = new Map<ContributionSource, { at: number; result: Promise<ContributionsView> }>();

const localResult = () => cachedFor("local", computeLocal);

function cachedFor(source: ContributionSource, compute: () => Promise<ContributionsView>): Promise<ContributionsView> {
  const hit = cache.get(source);
  if (hit && Date.now() - hit.at <= TTL_MS) return hit.result;
  const entry = { at: Date.now(), result: compute() };
  cache.set(source, entry);
  entry.result.catch(() => {
    if (cache.get(source) === entry) cache.delete(source);
  });
  return entry.result;
}

export function clearContributions(): void {
  cache.clear();
}

/** Commit activity across every local repository, optionally merged with GitHub and GitLab; cached for a few minutes. */
export const getContributions = createServerFn({ method: "GET" })
  .validator((input: { source: ContributionSource }) => {
    if (input?.source !== "local" && input?.source !== "all") throw new Error("Invalid contributions request.");
    return input;
  })
  .handler(({ data }) => cachedFor(data.source, data.source === "all" ? computeAll : computeLocal));
