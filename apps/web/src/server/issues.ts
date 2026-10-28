import { createServerFn } from "@tanstack/react-start";
import type { GitHubRepoRef } from "@gitlib/core";
import { githubGet, githubToken, groupReposByGitHubSlug, resolveGitHubSource } from "./github.server";
import type { Provider } from "./provider";

export interface IssueView {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  comments: number;
  labels: { name: string; color: string }[];
}

export interface IssuesView {
  /** Where the issues come from, or null when the repo has no supported remote. */
  provider: Provider | null;
  /** The repo's `owner/repo` path on that provider. */
  slug: string | null;
  /** Link to the issue tracker on the provider's site. */
  issuesUrl: string | null;
  /** Page of open issues, newest activity first. */
  issues: IssueView[];
  /** Whether GitHub has more open issues than were fetched. */
  hasMore: boolean;
  error: string | null;
}

const PAGE_SIZE = 50;

interface GitHubIssue {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  comments: number;
  user: { login: string } | null;
  labels: (string | { name?: string; color?: string })[];
  /** Present when the "issue" is really a pull request. */
  pull_request?: unknown;
}

type IssuesSource = Pick<IssuesView, "provider" | "slug" | "issuesUrl">;

const NO_SOURCE: IssuesSource = { provider: null, slug: null, issuesUrl: null };
const NO_ISSUES: Pick<IssuesView, "issues" | "hasMore"> = { issues: [], hasMore: false };

function failure(source: IssuesSource, error: string): IssuesView {
  return { ...source, ...NO_ISSUES, error };
}

/** Open issues for a repository gitlib knows about, read from the GitHub remote; never an arbitrary repo. */
export const getIssues = createServerFn({ method: "GET" })
  .validator((input: { relativePath: string }) => {
    if (typeof input?.relativePath !== "string" || !input.relativePath) {
      throw new Error("Invalid issues request.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<IssuesView> => {
    let view: IssuesSource = NO_SOURCE;
    try {
      const { source, error } = resolveGitHubSource(data.relativePath);
      if (error) return failure(view, error);
      if (!source) return { ...view, ...NO_ISSUES, error: null };
      view = { provider: source.provider, slug: source.slug, issuesUrl: `https://github.com/${source.slug}/issues` };

      // The issues endpoint also lists pull requests, so over-fetch a page and filter them out below.
      const result = await githubGet<GitHubIssue[]>(source, "/issues", {
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: String(PAGE_SIZE),
      });
      if (result.error !== null) return failure(view, result.error);

      const items = result.data;
      const issues = items
        .filter((item) => !item.pull_request)
        .map(
          (item): IssueView => ({
            number: item.number,
            title: item.title,
            url: item.html_url,
            author: item.user?.login ?? null,
            createdAt: item.created_at,
            updatedAt: item.updated_at,
            comments: item.comments,
            labels: item.labels.flatMap((label) =>
              typeof label === "string"
                ? [{ name: label, color: "888888" }]
                : label.name
                  ? [{ name: label.name, color: label.color ?? "888888" }]
                  : [],
            ),
          }),
        );
      return { ...view, issues, hasMore: items.length === PAGE_SIZE, error: null };
    } catch (caught) {
      return failure(view, caught instanceof Error ? caught.message : "Could not load issues.");
    }
  });

export interface IssueCountsView {
  /** "no-token" because GitHub's GraphQL API, which counts many repos per request, needs authentication. */
  status: "ok" | "no-token" | "error";
  /** Open GitHub issue count (pull requests excluded) by repo relativePath; repos without one are absent. */
  counts: Record<string, number>;
  error: string | null;
}

/** GraphQL aliases per request; keeps each query comfortably inside GitHub's cost limits. */
const COUNT_BATCH = 50;
const COUNTS_TTL_MS = 5 * 60_000;

async function fetchBatch(token: string, batch: GitHubRepoRef[]): Promise<(number | null)[]> {
  const variables: Record<string, string> = {};
  const declarations: string[] = [];
  const fields: string[] = [];
  batch.forEach((ref, i) => {
    variables[`o${i}`] = ref.owner;
    variables[`n${i}`] = ref.repo;
    declarations.push(`$o${i}: String!`, `$n${i}: String!`);
    fields.push(`r${i}: repository(owner: $o${i}, name: $n${i}) { issues(states: OPEN) { totalCount } }`);
  });

  const response = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "User-Agent": "gitlib" },
    body: JSON.stringify({ query: `query(${declarations.join(", ")}) { ${fields.join("\n")} }`, variables }),
    signal: AbortSignal.timeout(15_000),
  });
  if (response.status === 401) throw new Error("GitHub rejected the token (401).");
  if (!response.ok) throw new Error(`GitHub responded with ${response.status}.`);

  const body = (await response.json()) as {
    data?: Record<string, { issues: { totalCount: number } } | null> | null;
    errors?: { message: string }[];
  };
  // A repo that is missing or private to this token comes back as null with a per-repo error; the rest still count.
  if (!body.data) throw new Error(body.errors?.[0]?.message ?? "GitHub returned no data.");
  return batch.map((_, i) => body.data?.[`r${i}`]?.issues.totalCount ?? null);
}

async function fetchIssueCounts(): Promise<IssueCountsView> {
  const token = githubToken();
  if (!token) return { status: "no-token", counts: {}, error: null };

  const entries = await groupReposByGitHubSlug();
  const counts: Record<string, number> = {};
  try {
    for (let i = 0; i < entries.length; i += COUNT_BATCH) {
      const batch = entries.slice(i, i + COUNT_BATCH);
      const totals = await fetchBatch(token, batch.map((entry) => entry.ref));
      batch.forEach((entry, j) => {
        const total = totals[j];
        if (total !== null && total !== undefined) for (const path of entry.paths) counts[path] = total;
      });
    }
  } catch (caught) {
    return { status: "error", counts, error: caught instanceof Error ? caught.message : "Could not load issue counts." };
  }
  return { status: "ok", counts, error: null };
}

let cachedCounts: { at: number; result: Promise<IssueCountsView> } | undefined;

/** Drops cached counts so the next request asks GitHub again (a rescan does this). */
export function clearIssueCounts(): void {
  cachedCounts = undefined;
}

/** Open issue counts for every repo with a GitHub remote, fetched together and cached for a few minutes. */
export const getIssueCounts = createServerFn({ method: "GET" }).handler(async (): Promise<IssueCountsView> => {
  if (!cachedCounts || Date.now() - cachedCounts.at > COUNTS_TTL_MS) {
    const entry = { at: Date.now(), result: fetchIssueCounts() };
    cachedCounts = entry;
    // Only successful lookups are worth keeping; a failed one should be retried next time.
    void entry.result.then((result) => {
      if (result.status !== "ok" && cachedCounts === entry) cachedCounts = undefined;
    });
  }
  return cachedCounts.result;
});
