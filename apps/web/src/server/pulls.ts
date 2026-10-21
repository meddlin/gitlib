import { createServerFn } from "@tanstack/react-start";
import { githubGet, resolveGitHubSource } from "./github.server";
import type { Provider } from "./provider";

export interface PullRequestView {
  number: number;
  title: string;
  url: string;
  author: string | null;
  createdAt: string;
  updatedAt: string;
  draft: boolean;
  /** Source branch; `owner:branch` when the pull request comes from a fork. */
  head: string;
  /** Branch it would merge into. */
  base: string;
  labels: { name: string; color: string }[];
}

export interface PullRequestsView {
  /** Where the pull requests come from, or null when the repo has no supported remote. */
  provider: Provider | null;
  /** The repo's `owner/repo` path on that provider. */
  slug: string | null;
  /** Link to the pull request list on the provider's site. */
  pullsUrl: string | null;
  /** Page of open pull requests, newest activity first. */
  pulls: PullRequestView[];
  /** Whether GitHub has more open pull requests than were fetched. */
  hasMore: boolean;
  error: string | null;
}

const PAGE_SIZE = 50;

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

type PullsSource = Pick<PullRequestsView, "provider" | "slug" | "pullsUrl">;

const NO_SOURCE: PullsSource = { provider: null, slug: null, pullsUrl: null };
const NO_PULLS: Pick<PullRequestsView, "pulls" | "hasMore"> = { pulls: [], hasMore: false };

function failure(source: PullsSource, error: string): PullRequestsView {
  return { ...source, ...NO_PULLS, error };
}

/** Open pull requests for a repository gitlib knows about, read from the GitHub remote; never an arbitrary repo. */
export const getPullRequests = createServerFn({ method: "GET" })
  .validator((input: { relativePath: string }) => {
    if (typeof input?.relativePath !== "string" || !input.relativePath) {
      throw new Error("Invalid pull requests request.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<PullRequestsView> => {
    let view: PullsSource = NO_SOURCE;
    try {
      const { source, error } = resolveGitHubSource(data.relativePath);
      if (error) return failure(view, error);
      if (!source) return { ...view, ...NO_PULLS, error: null };
      view = { provider: source.provider, slug: source.slug, pullsUrl: `https://github.com/${source.slug}/pulls` };

      const result = await githubGet<GitHubPull[]>(source, "/pulls", {
        state: "open",
        sort: "updated",
        direction: "desc",
        per_page: String(PAGE_SIZE),
      });
      if (result.error !== null) return failure(view, result.error);

      const pulls = result.data.map(
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
      return { ...view, pulls, hasMore: result.data.length === PAGE_SIZE, error: null };
    } catch (caught) {
      return failure(view, caught instanceof Error ? caught.message : "Could not load pull requests.");
    }
  });
