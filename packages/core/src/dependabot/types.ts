import { GitLibError } from "../errors.js";

/**
 * How big a bump is, from the `update-type` lines in Dependabot's commit message. "unknown" covers a missing block,
 * a missing line (observed on indirect updates), a value outside semver-major/minor/patch, and a group in which any
 * dependency lacks one without another being major.
 */
export type UpdateType = "major" | "minor" | "patch" | "unknown";

/** What CI said about the PR's head commit, from GraphQL `statusCheckRollup`. "unknown" is never read as green. */
export type CiState =
  | { state: "success" }
  | { state: "pending"; pending: string[] }
  | { state: "failing"; failed: string[] }
  /** The rollup was missing, refused or unrecognised; `reason` says which, in words fit for the report. */
  | { state: "unknown"; reason: string };

/**
 * One open Dependabot pull request, reduced to the fields the verdict reads. The merge fields are GitHub's own
 * strings (`mergeable`: MERGEABLE, CONFLICTING, UNKNOWN; `mergeStateStatus`: CLEAN, UNSTABLE, HAS_HOOKS, BEHIND,
 * BLOCKED, DIRTY, DRAFT, UNKNOWN) and anything else GitHub adds later is kept as it came and treated as unrecognised.
 */
export interface DependabotPr {
  /** `owner/repo` as GitHub spells it. */
  repo: string;
  number: number;
  title: string;
  url: string;
  author: string | null;
  headRefName: string;
  /** The second segment of a default-layout `dependabot/ECOSYSTEM/...` branch; null for a custom prefix or separator. */
  ecosystem: string | null;
  isDraft: boolean;
  mergeable: string;
  mergeStateStatus: string;
  /** APPROVED, CHANGES_REQUESTED, REVIEW_REQUIRED, or null (no review is required, or none has happened). */
  reviewDecision: string | null;
  labels: string[];
  /** Dependabot opens a PR with one commit; more means someone pushed to the branch. */
  commitCount: number;
  updateType: UpdateType;
  /** `dependency-name` of each dependency the commit message lists; more than one means a grouped or multi-dependency PR. */
  dependencies: string[];
  ci: CiState;
  createdAt: string | null;
  updatedAt: string | null;
}

export type Bucket = "ready" | "review-first" | "needs-work" | "waiting";

/** Display order: what can be acted on soonest first. */
export const BUCKETS: readonly Bucket[] = ["ready", "review-first", "needs-work", "waiting"];

export interface Classification {
  bucket: Bucket;
  /** Why, most decisive first. For "ready" these are the facts that were checked. */
  reasons: string[];
  /** Suggestions as text for a person to act on; nothing here is ever run. */
  actions: string[];
}

export interface ClassifiedPr extends Classification {
  pr: DependabotPr;
}

/** GitHub's GraphQL rate-limit block; `cost` is what the query just spent. */
export interface RateLimitInfo {
  cost: number;
  remaining: number;
  resetAt: string;
}

/** Everything one GraphQL search per owner found. */
export interface OwnerPulls {
  owner: string;
  /** Every open Dependabot PR in the owner's repositories, not only the watched ones. */
  prs: DependabotPr[];
  /** More PRs matched than were fetched (GitHub search stops at 1,000 results), so some are missing. */
  truncated: boolean;
  /** Requested repositories the token cannot see, as `owner/repo`; their PRs could not be checked. */
  unreachable: string[];
  /** Problems that did not stop the fetch, e.g. GraphQL errors for individual fields. */
  warnings: string[];
  rateLimit: RateLimitInfo | null;
}

/** The only thing the rest of gitlib knows about where Dependabot PRs come from. */
export interface DependabotBackend {
  /** Human-readable location, used in error messages. */
  readonly label: string;
  /**
   * Open Dependabot PRs across `owner`'s repositories, and which of `repoNames` (without the owner) the token cannot
   * see at all, so that an invisible private repository is not reported as having no PRs.
   */
  fetchOwner(owner: string, repoNames: readonly string[], signal?: AbortSignal): Promise<OwnerPulls>;
  /**
   * The text of one pull request's description, which quotes release notes written by whoever publishes the package.
   * Fetched only to be shown to a model, never stored with the findings and never read by `classify`. A backend
   * without it just leaves the explanation to the facts alone.
   */
  fetchPullBody?(repo: string, number: number, signal?: AbortSignal): Promise<string | null>;
}

/** The check cannot run at all: no token, a refused token, GitHub unreachable. The message is safe to show. */
export class DependabotUnavailableError extends GitLibError {}

/** The token was rejected, so every other owner would fail the same way and the run stops. */
export class DependabotAuthError extends DependabotUnavailableError {}
