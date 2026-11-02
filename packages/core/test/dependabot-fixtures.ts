import {
  parsePullRequest,
  type DependabotBackend,
  type DependabotPr,
  type OwnerPulls,
} from "../src/index.js";

// Fixtures shaped like the GraphQL response of the search query in src/dependabot/github-backend.ts.

export const checkRun = (name: string, status = "COMPLETED", conclusion: string | null = "SUCCESS") => ({
  __typename: "CheckRun",
  name,
  status,
  conclusion,
});
export const statusContext = (context: string, state: string) => ({ __typename: "StatusContext", context, state });
export const rollup = (state: string, ...contexts: object[]) => ({ state, contexts: { nodes: contexts } });
export const green = () => rollup("SUCCESS", checkRun("build"), checkRun("test"), statusContext("codecov/patch", "SUCCESS"));

/** Dependabot's commit message, ending in the YAML block between `---` and `...`. */
export function commitMessage(...updates: { name: string; type?: string | null }[]): string {
  const items = updates.flatMap(({ name, type }) => [
    `- dependency-name: ${name}`,
    "  dependency-version: 6.29.1",
    "  dependency-type: direct:production",
    ...(type ? [`  update-type: version-update:semver-${type}`] : []),
  ]);
  return [
    "build(deps): bump undici from 6.27.0 to 6.29.1",
    "",
    "Bumps [undici](https://github.com/nodejs/undici) from 6.27.0 to 6.29.1.",
    "",
    "---",
    "updated-dependencies:",
    ...items,
    "...",
    "",
    "Signed-off-by: dependabot[bot] <support@github.com>",
  ].join("\n");
}

export interface NodeOptions {
  number?: number;
  repo?: string;
  title?: string;
  headRefName?: string;
  isDraft?: boolean;
  mergeable?: string;
  mergeStateStatus?: string;
  reviewDecision?: string | null;
  labels?: string[];
  commitCount?: number;
  message?: string;
  rollup?: object | null;
}

/** One element of `data.search.nodes`, clean and green unless an override says otherwise. */
export function node(options: NodeOptions = {}): Record<string, unknown> {
  const o = {
    number: 41,
    repo: "meddlin/gitlib",
    title: "build(deps): bump undici from 6.27.0 to 6.29.1",
    headRefName: "dependabot/npm_and_yarn/undici-6.29.1",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    labels: ["dependencies", "javascript"],
    commitCount: 1,
    message: commitMessage({ name: "undici", type: "patch" }),
    rollup: green() as object | null,
    ...options,
  };
  return {
    number: o.number,
    title: o.title,
    url: `https://github.com/${o.repo}/pull/${o.number}`,
    createdAt: "2026-10-26T06:00:00Z",
    updatedAt: "2026-10-30T06:00:00Z",
    headRefName: o.headRefName,
    isDraft: o.isDraft,
    mergeable: o.mergeable,
    mergeStateStatus: o.mergeStateStatus,
    reviewDecision: o.reviewDecision,
    author: { __typename: "Bot", login: "dependabot" },
    repository: { nameWithOwner: o.repo },
    labels: { nodes: o.labels.map((name) => ({ name })) },
    commits: { totalCount: o.commitCount, nodes: [{ commit: { message: o.message, statusCheckRollup: o.rollup } }] },
  };
}

export interface PageOptions {
  nodes?: unknown[];
  issueCount?: number;
  hasNextPage?: boolean;
  endCursor?: string | null;
  cost?: number;
  errors?: object[];
}

/** A whole GraphQL response body for one page of the search. */
export function searchResponse(options: PageOptions = {}): Record<string, unknown> {
  const nodes = options.nodes ?? [node()];
  return {
    data: {
      rateLimit: { cost: options.cost ?? 1, remaining: 4990, resetAt: "2026-11-02T13:00:00Z" },
      search: {
        issueCount: options.issueCount ?? nodes.length,
        pageInfo: { hasNextPage: options.hasNextPage ?? false, endCursor: options.endCursor ?? null },
        nodes,
      },
    },
    ...(options.errors ? { errors: options.errors } : {}),
  };
}

/** A PR as the classifier sees it, parsed from a fixture node. */
export const pr = (options: NodeOptions = {}): DependabotPr => {
  const parsed = parsePullRequest(node(options));
  if (!parsed) throw new Error("fixture did not parse");
  return parsed;
};

/** Lets a test script what GitHub says per owner. */
export class FakeBackend implements DependabotBackend {
  readonly label = "fake";
  calls: { owner: string; repoNames: string[] }[] = [];
  constructor(private readonly byOwner: Record<string, Partial<OwnerPulls> | Error>) {}

  async fetchOwner(owner: string, repoNames: readonly string[]): Promise<OwnerPulls> {
    this.calls.push({ owner, repoNames: [...repoNames] });
    const answer = this.byOwner[owner];
    if (answer instanceof Error) throw answer;
    return { owner, prs: [], truncated: false, unreachable: [], warnings: [], rateLimit: null, ...answer };
  }
}
