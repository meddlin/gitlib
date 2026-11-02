import type { RepoRecord } from "../models.js";
import { loadGitRemotes, selectGitHubRepo, type GitHubRepoRef } from "../remotes.js";
import { defaultSystemDeps, type SystemDeps } from "../system.js";
import { classify } from "./classify.js";
import { isValidOwner, isValidRepoName } from "./github-backend.js";
import {
  BUCKETS,
  DependabotAuthError,
  DependabotUnavailableError,
  type ClassifiedPr,
  type DependabotBackend,
  type DependabotPr,
  type RateLimitInfo,
} from "./types.js";

/** One GitHub repository and every local checkout (clone or linked worktree) that points at it. */
export interface GitHubRepoGroup {
  ref: GitHubRepoRef;
  /** `owner/repo` as the first checkout spelled it. */
  slug: string;
  /** `relativePath` of each checkout. */
  paths: string[];
}

/** A repository that could not be mapped to a GitHub slug, and why, in words fit for the report. */
export interface UnresolvedRepo {
  relativePath: string;
  reason: string;
}

/**
 * The GitHub repositories behind `repos`, once each: linked worktrees share a remote with their main repo, so they
 * collapse into one group, and the slug is compared without regard to case. Repos with no usable GitHub remote are
 * returned separately with the reason, never dropped silently.
 */
export function groupReposByGitHubSlug(
  repos: readonly RepoRecord[],
  system: SystemDeps = defaultSystemDeps,
): { groups: GitHubRepoGroup[]; unresolved: UnresolvedRepo[] } {
  const bySlug = new Map<string, GitHubRepoGroup>();
  const unresolved: UnresolvedRepo[] = [];

  for (const repo of repos) {
    const skip = (reason: string) => void unresolved.push({ relativePath: repo.relativePath, reason });
    if (repo.isMissing) {
      skip("its folder is missing");
      continue;
    }
    const { remotes, error } = loadGitRemotes(repo.absolutePath, system);
    if (error) {
      skip(`git could not list its remotes (${error.split("\n")[0]})`);
      continue;
    }
    if (remotes.length === 0) {
      skip("it has no git remote");
      continue;
    }
    const ref = selectGitHubRepo(remotes);
    if (!ref) {
      skip(`no remote is on github.com (${remotes.map((remote) => `${remote.name}: ${remote.host || "unknown host"}`).join(", ")})`);
      continue;
    }
    if (!isValidOwner(ref.owner) || !isValidRepoName(ref.repo)) {
      skip(`"${ref.owner}/${ref.repo}" is not a valid GitHub name`);
      continue;
    }
    const key = `${ref.owner}/${ref.repo}`.toLowerCase();
    const group = bySlug.get(key) ?? { ref, slug: `${ref.owner}/${ref.repo}`, paths: [] };
    group.paths.push(repo.relativePath);
    bySlug.set(key, group);
  }

  return { groups: [...bySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)), unresolved };
}

export interface WatchedRepo extends GitHubRepoGroup {
  /**
   * "checked": GitHub was asked and could see it. "unreachable": the token cannot see it, so an empty list would be
   * meaningless. "failed": the request for its owner failed (see the report's `errors`).
   */
  status: "checked" | "unreachable" | "failed";
  openPrs: number;
}

export interface DependabotReport {
  /** ISO-8601 UTC time the check started. */
  checkedAt: string;
  /** Every favorite with a GitHub remote, once per GitHub repository. */
  watched: WatchedRepo[];
  /** Favorites that were left out, with why. */
  skipped: UnresolvedRepo[];
  /** Open Dependabot PRs of the watched repositories, by bucket, then repo, then number. */
  items: ClassifiedPr[];
  /** Owners whose request failed; nothing about their repositories was checked. */
  errors: { owner: string; message: string }[];
  /** Owners with more matching PRs than GitHub search will return, so some are missing. */
  truncatedOwners: string[];
  /** Problems GitHub reported that did not stop the check. */
  warnings: string[];
  /** Points this check spent and what is left; null when GitHub did not say. */
  rateLimit: RateLimitInfo | null;
}

export interface DependabotCheckOptions {
  /** Every repository gitlib knows; only the favorites are watched. */
  repositories: readonly RepoRecord[];
  backend: DependabotBackend;
  system?: SystemDeps;
  now?: Date;
  signal?: AbortSignal;
}

/**
 * Asks GitHub about the open Dependabot PRs of every favorite repository (one request set per owner, not per
 * repository) and sorts them into buckets. Reports only; nothing is written to GitHub or to disk.
 *
 * A failed owner does not stop the others. A rejected token does, because every other owner would fail the same way.
 */
export async function checkDependabot(options: DependabotCheckOptions): Promise<DependabotReport> {
  const { backend, signal } = options;
  const { groups, unresolved } = groupReposByGitHubSlug(
    options.repositories.filter((repo) => repo.isFavorite),
    options.system,
  );

  const byOwner = new Map<string, GitHubRepoGroup[]>();
  for (const group of groups) {
    const owner = group.ref.owner.toLowerCase();
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), group]);
  }

  const watched: WatchedRepo[] = [];
  const prs: DependabotPr[] = [];
  const errors: DependabotReport["errors"] = [];
  const truncatedOwners: string[] = [];
  const warnings: string[] = [];
  const quota: { cost: number; last: RateLimitInfo | null } = { cost: 0, last: null };

  for (const [, ownerGroups] of byOwner) {
    const owner = ownerGroups[0]!.ref.owner;
    let result;
    try {
      result = await backend.fetchOwner(
        owner,
        ownerGroups.map((group) => group.ref.repo),
        signal,
      );
    } catch (error) {
      if (error instanceof DependabotAuthError || !(error instanceof DependabotUnavailableError)) throw error;
      errors.push({ owner, message: error.message });
      watched.push(...ownerGroups.map((group): WatchedRepo => ({ ...group, status: "failed", openPrs: 0 })));
      continue;
    }

    const unreachable = new Set(result.unreachable.map((slug) => slug.toLowerCase()));
    const open = new Map<string, DependabotPr[]>();
    for (const pr of result.prs) open.set(pr.repo.toLowerCase(), [...(open.get(pr.repo.toLowerCase()) ?? []), pr]);

    for (const group of ownerGroups) {
      const key = group.slug.toLowerCase();
      const found = open.get(key) ?? [];
      prs.push(...found);
      watched.push({ ...group, status: unreachable.has(key) ? "unreachable" : "checked", openPrs: found.length });
    }
    if (result.truncated) truncatedOwners.push(owner);
    warnings.push(...result.warnings);
    if (result.rateLimit) {
      quota.cost += result.rateLimit.cost;
      quota.last = result.rateLimit;
    }
  }

  const items = prs
    .map((pr): ClassifiedPr => ({ pr, ...classify(pr) }))
    .sort(
      (a, b) =>
        BUCKETS.indexOf(a.bucket) - BUCKETS.indexOf(b.bucket) || a.pr.repo.localeCompare(b.pr.repo) || a.pr.number - b.pr.number,
    );

  return {
    checkedAt: (options.now ?? new Date()).toISOString(),
    watched: watched.sort((a, b) => a.slug.localeCompare(b.slug)),
    skipped: unresolved,
    items,
    errors,
    truncatedOwners,
    warnings: [...new Set(warnings)],
    rateLimit: quota.last ? { ...quota.last, cost: quota.cost } : null,
  };
}
