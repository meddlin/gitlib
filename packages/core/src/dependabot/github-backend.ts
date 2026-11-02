import type { Env } from "../config.js";
import { parseBranchEcosystem, parseCommitMetadata } from "./metadata.js";
import {
  DependabotAuthError,
  DependabotUnavailableError,
  type CiState,
  type DependabotBackend,
  type DependabotPr,
  type OwnerPulls,
  type RateLimitInfo,
} from "./types.js";

export const GITHUB_GRAPHQL_URL = "https://api.github.com/graphql";
/** GitHub's guidance is to keep a request well under the 10 s it enforces, so pages stay small. */
const PAGE_SIZE = 50;
/** GitHub search never returns more than 1,000 results, which is 20 pages of 50. */
const MAX_PAGES = 20;
const PROBE_BATCH = 50;
const REQUEST_TIMEOUT_MS = 30_000;

/** Fields documented in docs/dependabot-watch.md sections 2 and 6; the commit message carries the `update-type` block. */
const SEARCH_QUERY = `
query($q: String!, $first: Int!, $after: String) {
  rateLimit { cost remaining resetAt }
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    issueCount
    pageInfo { hasNextPage endCursor }
    nodes {
      ... on PullRequest {
        number
        title
        url
        createdAt
        updatedAt
        headRefName
        isDraft
        mergeable
        mergeStateStatus
        reviewDecision
        author { __typename login }
        repository { nameWithOwner }
        labels(first: 20) { nodes { name } }
        commits(last: 1) {
          totalCount
          nodes {
            commit {
              message
              statusCheckRollup {
                state
                contexts(first: 50) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion }
                    ... on StatusContext { context state }
                  }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const asString = (value: unknown): string | null => (typeof value === "string" ? value : null);
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

interface GraphQlError {
  message: string;
  type: string | null;
  path: unknown[];
}

function readErrors(body: Record<string, unknown>): GraphQlError[] {
  return asArray(body["errors"]).flatMap((error) =>
    isRecord(error)
      ? [{ message: asString(error["message"]) ?? "unspecified error", type: asString(error["type"]), path: asArray(error["path"]) }]
      : [],
  );
}

function readRateLimit(data: Record<string, unknown>): RateLimitInfo | null {
  const limit = data["rateLimit"];
  if (!isRecord(limit)) return null;
  const { cost, remaining, resetAt } = limit;
  return typeof cost === "number" && typeof remaining === "number" && typeof resetAt === "string" ? { cost, remaining, resetAt } : null;
}

/** The `data` object of a GraphQL response, or a readable error when GitHub sent none. */
function requireData(body: unknown): { data: Record<string, unknown>; errors: GraphQlError[] } {
  if (!isRecord(body)) throw new DependabotUnavailableError("GitHub sent a response that is not a GraphQL result.");
  const errors = readErrors(body);
  const data = body["data"];
  if (!isRecord(data)) {
    const why = errors[0]?.message ?? asString(body["message"]) ?? "no data";
    throw new DependabotUnavailableError(`GitHub's GraphQL API returned no data (${why}).`);
  }
  return { data, errors };
}

const CHECK_FAILED = new Set(["FAILURE", "TIMED_OUT", "CANCELLED", "STARTUP_FAILURE", "ACTION_REQUIRED"]);
const STATUS_FAILED = new Set(["FAILURE", "ERROR"]);
const STATUS_PENDING = new Set(["PENDING", "EXPECTED"]);

const NO_ROLLUP =
  "GitHub returned no check results for the head commit. A repository without CI looks like this, and so may a token " +
  "that cannot read checks (see docs/dependabot-watch.md, \"Verify with your own token\").";

/** Names of the checks and statuses on a rollup that satisfy `pick`, in order and without repeats. */
function contextNames(rollup: Record<string, unknown>, pick: (kind: "check" | "status", context: Record<string, unknown>) => boolean): string[] {
  const contexts = rollup["contexts"];
  const nodes = isRecord(contexts) ? asArray(contexts["nodes"]) : [];
  const names = nodes.flatMap((node) => {
    if (!isRecord(node)) return [];
    const kind = node["__typename"] === "StatusContext" ? "status" : node["__typename"] === "CheckRun" ? "check" : null;
    const name = asString(kind === "status" ? node["context"] : node["name"]);
    return kind && name && pick(kind, node) ? [name] : [];
  });
  return [...new Set(names)];
}

/** `problem` is GitHub's own message when it refused to resolve the rollup field (GraphQL reports that as an error). */
function parseCi(commits: unknown, problem: string | null): CiState {
  const commit = isRecord(commits) ? asArray(commits["nodes"]).map((node) => (isRecord(node) ? node["commit"] : null)).find(isRecord) : undefined;
  if (!commit) return { state: "unknown", reason: "GitHub returned no head commit for the pull request." };

  const rollup = commit["statusCheckRollup"];
  if (!isRecord(rollup)) {
    return { state: "unknown", reason: problem ? `GitHub would not return the checks (${problem}).` : NO_ROLLUP };
  }
  switch (rollup["state"]) {
    case "SUCCESS":
      return { state: "success" };
    case "FAILURE":
    case "ERROR":
      return {
        state: "failing",
        failed: contextNames(rollup, (kind, context) => (kind === "check" ? CHECK_FAILED.has(String(context["conclusion"])) : STATUS_FAILED.has(String(context["state"])))),
      };
    case "PENDING":
    case "EXPECTED":
      return {
        state: "pending",
        pending: contextNames(rollup, (kind, context) => (kind === "check" ? context["status"] !== "COMPLETED" : STATUS_PENDING.has(String(context["state"])))),
      };
    default:
      return { state: "unknown", reason: `GitHub reported a check state this version of gitlib does not recognise: ${String(rollup["state"])}.` };
  }
}

/** One element of `search.nodes`; null when it is not a pull request (an inline fragment that did not match gives `{}`). */
export function parsePullRequest(node: unknown, ciProblem: string | null = null): DependabotPr | null {
  if (!isRecord(node)) return null;
  const number = node["number"];
  const repository = isRecord(node["repository"]) ? asString(node["repository"]["nameWithOwner"]) : null;
  if (typeof number !== "number" || !repository) return null;

  const headRefName = asString(node["headRefName"]) ?? "";
  const commits = isRecord(node["commits"]) ? node["commits"] : {};
  const lastCommit = asArray(commits["nodes"]).map((entry) => (isRecord(entry) ? entry["commit"] : null)).find(isRecord);
  const metadata = parseCommitMetadata(asString(lastCommit?.["message"]) ?? "");
  const labels = (isRecord(node["labels"]) ? asArray(node["labels"]["nodes"]) : []).flatMap((label) => {
    const name = isRecord(label) ? asString(label["name"]) : null;
    return name ? [name] : [];
  });

  return {
    repo: repository,
    number,
    title: asString(node["title"]) ?? "",
    url: asString(node["url"]) ?? `https://github.com/${repository}/pull/${number}`,
    author: isRecord(node["author"]) ? asString(node["author"]["login"]) : null,
    headRefName,
    ecosystem: parseBranchEcosystem(headRefName),
    isDraft: node["isDraft"] === true,
    mergeable: asString(node["mergeable"]) ?? "UNKNOWN",
    mergeStateStatus: asString(node["mergeStateStatus"]) ?? "UNKNOWN",
    reviewDecision: asString(node["reviewDecision"]),
    labels,
    commitCount: typeof commits["totalCount"] === "number" ? commits["totalCount"] : 1,
    updateType: metadata.updateType,
    dependencies: metadata.dependencies,
    ci: parseCi(commits, ciProblem),
    createdAt: asString(node["createdAt"]),
    updatedAt: asString(node["updatedAt"]),
  };
}

export interface SearchPage {
  prs: DependabotPr[];
  /** How many results GitHub says match in total, across all pages. */
  issueCount: number;
  /** How many nodes this page held. */
  nodeCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
  rateLimit: RateLimitInfo | null;
  warnings: string[];
}

/** One page of the search query's response. Problems with a single PR's checks become that PR's "CI unknown". */
export function parseSearchPage(body: unknown): SearchPage {
  const { data, errors } = requireData(body);
  const search = data["search"];
  if (!isRecord(search)) {
    throw new DependabotUnavailableError(`GitHub's GraphQL API returned no search results (${errors[0]?.message ?? "no error given"}).`);
  }

  // A field GitHub refuses to resolve comes back as null plus an error whose path names it.
  const rollupProblems = new Map<number, string>();
  const warnings: string[] = [];
  for (const error of errors) {
    const [root, list, index] = error.path;
    if (root === "search" && list === "nodes" && typeof index === "number" && error.path.includes("statusCheckRollup")) {
      rollupProblems.set(index, error.message);
    } else {
      warnings.push(error.message);
    }
  }

  const nodes = asArray(search["nodes"]);
  const pageInfo = isRecord(search["pageInfo"]) ? search["pageInfo"] : {};
  return {
    prs: nodes.flatMap((node, index) => parsePullRequest(node, rollupProblems.get(index) ?? null) ?? []),
    issueCount: typeof search["issueCount"] === "number" ? search["issueCount"] : nodes.length,
    nodeCount: nodes.length,
    hasNextPage: pageInfo["hasNextPage"] === true,
    endCursor: asString(pageInfo["endCursor"]),
    rateLimit: readRateLimit(data),
    warnings,
  };
}

/** `owner/repo` of every repository the aliased `repository(...)` lookups could see. */
export function parseVisibleRepositories(body: unknown): { visible: Set<string>; rateLimit: RateLimitInfo | null } {
  const { data } = requireData(body);
  const visible = new Set<string>();
  for (const [alias, value] of Object.entries(data)) {
    if (/^r\d+$/.test(alias) && isRecord(value)) {
      const name = asString(value["nameWithOwner"]);
      if (name) visible.add(name.toLowerCase());
    }
  }
  return { visible, rateLimit: readRateLimit(data) };
}

/** The token the web app uses too: `GITLIB_GITHUB_TOKEN`, else `GITHUB_TOKEN`; null when neither is set. */
export function resolveGitHubToken(env: Env): string | null {
  return env["GITLIB_GITHUB_TOKEN"]?.trim() || env["GITHUB_TOKEN"]?.trim() || null;
}

/** GitHub user and organisation logins; checked before one goes into a search query. */
export const isValidOwner = (owner: string): boolean => /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/.test(owner);
/** GitHub repository names. `.` and `..` are not allowed. */
export const isValidRepoName = (name: string): boolean => /^[A-Za-z0-9._-]{1,100}$/.test(name) && name !== "." && name !== "..";

/** Why a `fetch` failed, in words: undici hides the useful part (ECONNREFUSED, ENOTFOUND, ...) in `cause`. */
function describeFetchError(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
}

export interface GitHubDependabotBackendOptions {
  fetch?: typeof fetch;
  endpoint?: string;
  timeoutMs?: number;
}

/**
 * Reads Dependabot PRs from GitHub's GraphQL API: one paginated search per owner, plus one small request that
 * asks which of the owner's watched repositories the token can see at all.
 */
export class GitHubDependabotBackend implements DependabotBackend {
  readonly label: string;
  private readonly fetchImpl: typeof fetch;
  private readonly endpoint: string;
  private readonly timeoutMs: number;

  /** `token` is sent as a bearer token and appears in no message or error this class produces. */
  constructor(private readonly token: string, options: GitHubDependabotBackendOptions = {}) {
    this.fetchImpl = options.fetch ?? fetch;
    this.endpoint = options.endpoint ?? GITHUB_GRAPHQL_URL;
    this.timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
    this.label = new URL(this.endpoint).host;
  }

  async fetchOwner(owner: string, repoNames: readonly string[], signal?: AbortSignal): Promise<OwnerPulls> {
    if (!isValidOwner(owner)) throw new DependabotUnavailableError(`"${owner}" is not a valid GitHub owner name.`);

    // Each response reports its own cost; the owner's total is their sum, and what is left is the latest figure.
    const spent: { cost: number; latest: RateLimitInfo | null } = { cost: 0, latest: null };
    const track = (rateLimit: RateLimitInfo | null) => {
      if (!rateLimit) return;
      spent.cost += rateLimit.cost;
      spent.latest = rateLimit;
    };

    const unreachable: string[] = [];
    const names = repoNames.filter(isValidRepoName);
    for (let start = 0; start < names.length; start += PROBE_BATCH) {
      const batch = names.slice(start, start + PROBE_BATCH);
      const lookups = batch.map((name, index) => `r${index}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { nameWithOwner }`);
      const { visible, rateLimit } = parseVisibleRepositories(
        await this.post(`query { rateLimit { cost remaining resetAt } ${lookups.join(" ")} }`, {}, signal),
      );
      track(rateLimit);
      for (const name of batch) if (!visible.has(`${owner}/${name}`.toLowerCase())) unreachable.push(`${owner}/${name}`);
    }

    const query = `is:pr is:open author:app/dependabot user:${owner} archived:false`;
    const prs: DependabotPr[] = [];
    const warnings: string[] = [];
    let fetched = 0;
    let total = 0;
    let more = false;
    let after: string | null = null;
    for (let page = 0; page < MAX_PAGES; page++) {
      const result = parseSearchPage(await this.post(SEARCH_QUERY, { q: query, first: PAGE_SIZE, after }, signal));
      prs.push(...result.prs);
      warnings.push(...result.warnings);
      track(result.rateLimit);
      fetched += result.nodeCount;
      total = result.issueCount;
      more = result.hasNextPage && result.endCursor !== null;
      if (!more) break;
      after = result.endCursor;
    }

    return {
      owner,
      prs,
      truncated: more || total > fetched,
      unreachable,
      warnings: [...new Set(warnings)],
      rateLimit: spent.latest ? { ...spent.latest, cost: spent.cost } : null,
    };
  }

  private async post(query: string, variables: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const timeout = AbortSignal.timeout(this.timeoutMs);
    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/vnd.github+json",
          "content-type": "application/json",
          "user-agent": "gitlib",
        },
        body: JSON.stringify({ query, variables }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
    } catch (error) {
      if (signal?.aborted) throw error;
      const why = timeout.aborted ? `no answer within ${this.timeoutMs / 1000} seconds` : describeFetchError(error);
      throw new DependabotUnavailableError(`Could not reach GitHub at ${this.label} (${why}).`, { cause: error });
    }

    if (response.status === 401) {
      throw new DependabotAuthError("GitHub rejected the token (401). Check GITLIB_GITHUB_TOKEN or GITHUB_TOKEN: it may be mistyped, expired or revoked.");
    }
    if (response.status === 403 || response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const reset = Number(response.headers.get("x-ratelimit-reset"));
      const exhausted = response.headers.get("x-ratelimit-remaining") === "0" && Number.isFinite(reset);
      throw new DependabotUnavailableError(
        retryAfter
          ? `GitHub asked for a pause (rate limit); try again in ${retryAfter} seconds.`
          : exhausted
            ? `GitHub rate limit reached; it resets at ${new Date(reset * 1000).toISOString()}.`
            : `GitHub refused the request (${response.status}). The token may lack access, or a rate limit applies.`,
      );
    }
    if (!response.ok) throw new DependabotUnavailableError(`GitHub responded with ${response.status}.`);

    try {
      return await response.json();
    } catch (error) {
      throw new DependabotUnavailableError("GitHub sent a response that is not JSON.", { cause: error });
    }
  }
}
