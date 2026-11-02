import type { Classification, DependabotPr } from "./types.js";

/**
 * The merge-or-not verdict. It reads only fields GitHub returns, never the PR body: that text quotes release notes
 * written by whoever publishes the package, so it cannot be allowed to move a PR between buckets.
 *
 * Precedence is needs-work, then waiting, then review-first, then ready: a conflict has to be fixed whatever the
 * checks are doing, a PR whose checks or mergeability are still settling should be looked at again rather than judged,
 * and only a PR with nothing to say against it is ready. When in doubt it is not ready.
 *
 * Suggested actions are text for a person. `@dependabot merge` and its siblings stopped working on 2026-01-27, so
 * none is ever suggested; the PR's link is what takes you to the merge button.
 */
export function classify(pr: DependabotPr): Classification {
  const needsWork = new Findings();
  const waiting = new Findings();
  const review = new Findings();

  const extraCommits = pr.commitCount > 1;
  // Dependabot stops rebasing a branch someone else pushed to, so only `recreate` (which drops their commits) is left.
  const fixBranch = extraCommits
    ? "Dependabot no longer rebases a branch with extra commits: comment `@dependabot recreate` to rebuild it (this discards those commits), or rebase it yourself."
    : null;
  const rebase = fixBranch ?? "Comment `@dependabot rebase` on the PR to rebase it onto the base branch.";

  // --- Broken: someone has to do something before it can merge.
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    needsWork.add(
      "Merge conflicts with the base branch.",
      fixBranch ?? "Comment `@dependabot rebase` on the PR; if the conflict is still there afterwards, comment `@dependabot recreate`.",
    );
  }
  if (pr.mergeStateStatus === "BEHIND") needsWork.add("Behind the base branch.", rebase);
  if (pr.reviewDecision === "CHANGES_REQUESTED") {
    needsWork.add("A reviewer requested changes.", "Open the PR and respond to the requested changes.");
  }
  if (pr.ci.state === "failing") {
    needsWork.add(
      pr.ci.failed.length > 0 ? `Checks failing: ${pr.ci.failed.join(", ")}.` : "Checks failing.",
      "Open the failing check on the PR and read its log.",
    );
  } else if (pr.mergeStateStatus === "UNSTABLE") {
    needsWork.add(
      "GitHub's merge state is UNSTABLE: a commit status is not passing.",
      "Open the PR and look at its checks.",
    );
  }

  // --- Not settled: look again later.
  if (pr.isDraft || pr.mergeStateStatus === "DRAFT") {
    waiting.add("Still a draft.", "Mark it ready for review on GitHub when you want it merged.");
  }
  if (pr.mergeable === "UNKNOWN" || pr.mergeStateStatus === "UNKNOWN") {
    waiting.add(
      "GitHub is still working out whether it merges cleanly (mergeability UNKNOWN is transient).",
      "Run the check again in a minute or two.",
    );
  }
  if (pr.ci.state === "pending") {
    waiting.add(
      pr.ci.pending.length > 0 ? `Checks still running: ${pr.ci.pending.join(", ")}.` : "Checks still running.",
      "Run the check again once they finish.",
    );
  }

  // --- Clean as far as GitHub says, but a person should look first.
  if (pr.ci.state === "unknown") {
    review.add(
      `CI unknown: ${pr.ci.reason}`,
      "Open the PR and look at its checks yourself; gitlib cannot say whether they pass.",
    );
  }
  if (pr.reviewDecision === "REVIEW_REQUIRED") {
    review.add("Branch protection asks for a review and none has approved it.", "Review and approve it on GitHub.");
  }
  const blockedIsExplained =
    pr.reviewDecision === "REVIEW_REQUIRED" || pr.reviewDecision === "CHANGES_REQUESTED" || pr.ci.state === "pending" || pr.ci.state === "failing";
  if (pr.mergeStateStatus === "BLOCKED" && !blockedIsExplained) {
    review.add(
      "GitHub reports the merge as blocked (a required review or check, a ruleset, or a merge queue).",
      "Open the PR: the merge box says what is missing.",
    );
  }
  if (pr.updateType === "major") {
    review.add("Major version bump.", "Read the release notes and changelog linked in the PR before merging.");
  } else if (pr.updateType === "unknown") {
    review.add(
      "The commit message does not say how big the bump is.",
      "Read the title and the release notes linked in the PR.",
    );
  }
  if (pr.labels.some((label) => label.toLowerCase() === "security")) {
    review.add(
      "Labelled `security`: it addresses a vulnerability.",
      "Look at the advisory linked in the PR, and do not leave it open longer than it needs to be.",
    );
  }
  if (extraCommits) {
    review.add(
      `Has ${pr.commitCount} commits; Dependabot opens a PR with one, so someone pushed to the branch.`,
      "Check what was added before merging.",
    );
  }
  // A value this code has never seen must not slip through as ready.
  const unrecognised: [field: string, value: string | null, known: readonly string[]][] = [
    ["mergeable", pr.mergeable, ["MERGEABLE", "CONFLICTING", "UNKNOWN"]],
    ["mergeStateStatus", pr.mergeStateStatus, ["CLEAN", "UNSTABLE", "HAS_HOOKS", "BEHIND", "BLOCKED", "DIRTY", "DRAFT", "UNKNOWN"]],
    ["reviewDecision", pr.reviewDecision, ["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]],
  ];
  for (const [field, value, known] of unrecognised) {
    if (value !== null && !known.includes(value)) {
      review.add(`GitHub reported a ${field} this version of gitlib does not recognise: ${value}.`, "Open the PR and look at its merge box.");
    }
  }

  const byBucket = { "needs-work": needsWork, waiting, "review-first": review } as const;
  const bucket = (Object.keys(byBucket) as (keyof typeof byBucket)[]).find((name) => byBucket[name].reasons.length > 0);
  if (!bucket) return { bucket: "ready", reasons: readyReasons(pr), actions: ["Merge it from the PR page on GitHub."] };

  // The decisive bucket's findings come first, then whatever else was found, so nothing is hidden.
  const findings = [byBucket[bucket], needsWork, waiting, review];
  const actions = unique(findings.flatMap((finding) => finding.actions));
  if ((bucket === "needs-work" || bucket === "review-first") && pr.dependencies.length <= 1) {
    actions.push(`If you do not want this update, ${ignoreCommand(pr)}.`);
  }
  return { bucket, reasons: unique(findings.flatMap((finding) => finding.reasons)), actions };
}

function readyReasons(pr: DependabotPr): string[] {
  const reasons = [
    "All checks pass.",
    "No conflicts and up to date with the base branch.",
    `${pr.updateType === "minor" ? "Minor" : "Patch"} update.`,
  ];
  if (pr.reviewDecision === "APPROVED") reasons.push("Approved.");
  if (pr.mergeStateStatus === "HAS_HOOKS") reasons.push("Pre-receive hooks will run when it merges.");
  return reasons;
}

function ignoreCommand(pr: DependabotPr): string {
  const byType = { major: "this major version", minor: "this minor version", patch: "this patch version", unknown: "this dependency" } as const;
  return `comment \`@dependabot ignore ${byType[pr.updateType]}\``;
}

/** Reasons and the actions that go with them, kept in the order they were found. */
class Findings {
  readonly reasons: string[] = [];
  readonly actions: string[] = [];

  add(reason: string, ...actions: string[]): void {
    this.reasons.push(reason);
    this.actions.push(...actions);
  }
}

const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];
