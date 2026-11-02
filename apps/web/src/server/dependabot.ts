import { createServerFn } from "@tanstack/react-start";
import type { Bucket, DependabotDismissal, RunTrigger, StoredFinding, StoredReport } from "@gitlib/core";
import { attempt, buildBadge, buildView, ensureBackground, runCheck } from "./dependabot.server";
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
  /** Model-written notes by `owner/repo#number`, for the pull requests in `items` that have a current one. */
  notes: Record<string, { text: string; model: string; createdAt: string }>;
  /** The writer of those notes. The verdicts never depend on it. */
  explainer: {
    /** A model server is configured (`ollama.enabled`). */
    enabled: boolean;
    active: boolean;
    /** Pull requests that need a note and do not have a current one yet. */
    pending: number;
    lastError: string | null;
  };
  /** When the web server checks on its own. */
  schedule: {
    enabled: boolean;
    /** Weekdays, 0 (Sunday) to 6. */
    days: number[];
    /** `HH:MM` in the server's time zone. */
    time: string;
    /** The next slot (an ISO time), or null when the schedule is off. */
    nextRunAt: string | null;
    timeZone: string;
    /** The scheduler is running in this server. */
    active: boolean;
    lastAttemptAt: string | null;
    /** Why the last scheduled check failed, until one succeeds. */
    lastError: string | null;
  };
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

export const getDependabot = createServerFn({ method: "GET" }).handler(async (): Promise<DependabotView> => {
  ensureBackground();
  return buildView();
});

/** Counts for the NavBar badge; a cheap read of the saved check. Every page asks, so it also starts the scheduler. */
export const getDependabotBadge = createServerFn({ method: "GET" }).handler(async (): Promise<DependabotBadge> => {
  ensureBackground();
  return buildBadge();
});

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
    const error = attempt(() => void getApp().dismissDependabotPr(data.repo, data.number, data.until ?? null));
    return { error, view: buildView() };
  });

export const restoreDependabotPr = createServerFn({ method: "POST" })
  .validator(validatePr)
  .handler(async ({ data }): Promise<DependabotActionResult> => {
    const error = attempt(() => getApp().restoreDependabotPr(data.repo, data.number));
    return { error, view: buildView() };
  });

/** Turns the schedule on or off, or changes its days and time. The server's clock and zone decide when it fires. */
export const saveDependabotSchedule = createServerFn({ method: "POST" })
  .validator((input: { enabled: boolean; days: number[]; time: string }) => {
    if (typeof input?.enabled !== "boolean" || !Array.isArray(input?.days) || typeof input?.time !== "string") {
      throw new Error("Invalid schedule.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<DependabotActionResult> => {
    const error = attempt(() => void getApp().saveDependabotSchedule(data));
    return { error, view: buildView() };
  });
