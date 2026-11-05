import { createServerFn } from "@tanstack/react-start";
import { resolveGitHubSource } from "./github.server";
import { fetchOpenPulls } from "./github-lists.server";
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

      const result = await fetchOpenPulls(source);
      if (result.error !== null) return failure(view, result.error);
      return { ...view, pulls: result.items, hasMore: result.hasMore, error: null };
    } catch (caught) {
      return failure(view, caught instanceof Error ? caught.message : "Could not load pull requests.");
    }
  });
