import { createServerFn } from "@tanstack/react-start";
import type { Bucket, DependabotDismissal, RunTrigger, StoredFinding, StoredReport } from "@gitlib/core";
import { applyDismissal, buildBadge, buildView, runCheck } from "./dependabot.server";
import { getApp } from "./gitlib.server";

/** A finding the user has put aside, with how. */
export type DismissedFinding = StoredFinding & { dismissal: DependabotDismissal };

export interface DependabotView {
  /** False without a GitHub token: the page can show what was stored but cannot check. */
  canCheck: boolean;
  /** Why a check cannot run, in words fit for the page. */
  unavailableReason: string | null;
  /** Someone (this page, the CLI, the schedule) is asking GitHub right now. `by` is `<trigger>:<pid>`. */
  running: { by: string; since: string } | null;
  /** The newest saved check, or null before the first. */
  run: { id: number; trigger: RunTrigger; checkedAt: string; finishedAt: string } | null;
  /** Pull requests to act on, by bucket then repository. */
  items: StoredFinding[];
  dismissed: DismissedFinding[];
  /** What the check covered and what it could not; null before the first check. */
  report: Omit<StoredReport, "items"> | null;
  counts: Record<Bucket, number>;
}

export interface DependabotBadge {
  /** Pull requests that need a person: everything except those waiting on checks or GitHub. */
  actionable: number;
  counts: Record<Bucket, number>;
  checkedAt: string | null;
}

/** The result of an action on the page: what went wrong, if anything, and the page's data as it is now. */
export interface DependabotActionResult {
  error: string | null;
  view: DependabotView;
}

export const getDependabot = createServerFn({ method: "GET" }).handler(async (): Promise<DependabotView> => buildView());

/** Counts for the NavBar badge; a cheap read of the saved check. */
export const getDependabotBadge = createServerFn({ method: "GET" }).handler(async (): Promise<DependabotBadge> => buildBadge());

/** Asks GitHub now, saving the result. Takes the same lock as the CLI and the schedule, so it can say "busy". */
export const checkDependabotNow = createServerFn({ method: "POST" }).handler(async (): Promise<DependabotActionResult> => {
  const error = await runCheck();
  return { error, view: buildView() };
});

interface PrInput {
  repo: string;
  number: number;
}

const validatePr = (input: PrInput & { until?: string | null }) => {
  if (typeof input?.repo !== "string" || !input.repo || !Number.isInteger(input?.number)) throw new Error("Invalid pull request.");
  if (input.until !== undefined && input.until !== null && typeof input.until !== "string") throw new Error("Invalid date.");
  return input;
};

/** Puts a PR aside until `until` (an ISO time), or until it closes when `until` is absent. */
export const dismissDependabotPr = createServerFn({ method: "POST" })
  .validator(validatePr)
  .handler(async ({ data }): Promise<DependabotActionResult> => {
    const error = applyDismissal(() => void getApp().dismissDependabotPr(data.repo, data.number, data.until ?? null));
    return { error, view: buildView() };
  });

export const restoreDependabotPr = createServerFn({ method: "POST" })
  .validator(validatePr)
  .handler(async ({ data }): Promise<DependabotActionResult> => {
    const error = applyDismissal(() => getApp().restoreDependabotPr(data.repo, data.number));
    return { error, view: buildView() };
  });
