import { githubGet, type GitHubSource } from "./github.server";
import type { IssueView } from "./issues";
import type { PullRequestView } from "./pulls";
import type { CommitView, GitHubList } from "./project-github";

export const LIST_PAGE_SIZE = 50;
export const COMMIT_COUNT = 5;

const failed = <T>(error: string): GitHubList<T> => ({ items: [], hasMore: false, error });

interface GitHubPull {
  number: number;
  title: string;
  html_url: string;
  created_at: string;
  updated_at: string;
  draft?: boolean;
  user: { login: string } | null;
  labels: { name?: string; color?: string }[];
  head: { ref: string; label?: string; repo: { full_name: string } | null };
  base: { ref: string; repo: { full_name: string } | null };
}

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

interface GitHubCommit {
  sha: string;
  html_url: string;
  commit: { message: string; author: { name?: string; date?: string } | null; committer: { date?: string } | null };
  author: { login: string } | null;
}

/** Open pull requests, newest activity first. Throws on a network failure; a GitHub error comes back in the list. */
export async function fetchOpenPulls(source: GitHubSource): Promise<GitHubList<PullRequestView>> {
  const result = await githubGet<GitHubPull[]>(source, "/pulls", {
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: String(LIST_PAGE_SIZE),
  });
  if (result.error !== null) return failed(result.error);

  const items = result.data.map(
    (item): PullRequestView => ({
      number: item.number,
      title: item.title,
      url: item.html_url,
      author: item.user?.login ?? null,
      createdAt: item.created_at,
      updatedAt: item.updated_at,
      draft: item.draft === true,
      head: item.head.repo?.full_name === item.base.repo?.full_name ? item.head.ref : (item.head.label ?? item.head.ref),
      base: item.base.ref,
      labels: item.labels.flatMap((label) => (label.name ? [{ name: label.name, color: label.color ?? "888888" }] : [])),
    }),
  );
  return { items, hasMore: result.data.length === LIST_PAGE_SIZE, error: null };
}

/** Open issues (pull requests excluded), newest activity first. Throws on a network failure. */
export async function fetchOpenIssues(source: GitHubSource): Promise<GitHubList<IssueView>> {
  // The issues endpoint also lists pull requests, so a page is fetched and they are filtered out below.
  const result = await githubGet<GitHubIssue[]>(source, "/issues", {
    state: "open",
    sort: "updated",
    direction: "desc",
    per_page: String(LIST_PAGE_SIZE),
  });
  if (result.error !== null) return failed(result.error);

  const items = result.data
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
  return { items, hasMore: result.data.length === LIST_PAGE_SIZE, error: null };
}

/** The latest commits on the default branch. Throws on a network failure. */
export async function fetchRecentCommits(source: GitHubSource): Promise<GitHubList<CommitView>> {
  const result = await githubGet<GitHubCommit[]>(source, "/commits", { per_page: String(COMMIT_COUNT) });
  if (result.error !== null) {
    // GitHub answers 409 for a repository with no commits yet, which is an empty list rather than a failure.
    return result.status === 409 ? { items: [], hasMore: false, error: null } : failed(result.error);
  }

  const items = result.data.map(
    (item): CommitView => ({
      sha: item.sha.slice(0, 7),
      message: item.commit.message.split("\n", 1)[0] ?? "",
      url: item.html_url,
      author: item.author?.login ?? item.commit.author?.name ?? null,
      committedAt: item.commit.committer?.date ?? item.commit.author?.date ?? "",
    }),
  );
  return { items, hasMore: false, error: null };
}
