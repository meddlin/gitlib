/**
 * Display helpers for the Dependabot page, free of server code so they are shared with the UI and unit-tested.
 * Only types come from @gitlib/core here: client bundles must not keep a runtime import of it.
 */
import type { Bucket, CiState, RunTrigger } from "@gitlib/core";

export const BUCKET_ORDER: readonly Bucket[] = ["ready", "review-first", "needs-work", "waiting"];

export const BUCKET_LABELS: Record<Bucket, string> = {
  ready: "Ready",
  "review-first": "Review first",
  "needs-work": "Needs work",
  waiting: "Waiting",
};

export const BUCKET_HELP: Record<Bucket, string> = {
  ready: "Mergeable, up to date, checks passing, and a patch or minor update. Merge it on GitHub.",
  "review-first": "Nothing is broken, but look first: a major bump, an unclear update type, a security fix, a pending review, or checks gitlib cannot read.",
  "needs-work": "Conflicts, behind the base branch, changes requested, or failing checks.",
  waiting: "Checks are still running, it is a draft, or GitHub is still working out mergeability. Check again later.",
};

/** Text and dot colours for each bucket; readable in light and dark. */
export const BUCKET_TONES: Record<Bucket, { dot: string; text: string }> = {
  ready: { dot: "bg-emerald-500", text: "text-emerald-700 dark:text-emerald-400" },
  "review-first": { dot: "bg-amber-500", text: "text-amber-700 dark:text-amber-400" },
  "needs-work": { dot: "bg-red-500", text: "text-red-700 dark:text-red-400" },
  waiting: { dot: "bg-slate-400", text: "text-muted-foreground" },
};

export const TRIGGER_NAMES: Record<RunTrigger, string> = { cli: "the CLI", web: "the web page", schedule: "the schedule" };

/** The lease holder is `<trigger>:<pid>`; this is the trigger in words, or "another process" for anything else. */
export function holderName(holder: string): string {
  const trigger = holder.split(":")[0] as RunTrigger;
  return TRIGGER_NAMES[trigger] ?? "another process";
}

/** One short phrase for a PR's CI; the long reason for "unknown" is in the PR's reasons. */
export function ciLabel(ci: CiState): string {
  switch (ci.state) {
    case "success":
      return "CI passing";
    case "failing":
      return ci.failed.length > 0 ? `CI failing (${ci.failed.join(", ")})` : "CI failing";
    case "pending":
      return ci.pending.length > 0 ? `CI pending (${ci.pending.join(", ")})` : "CI pending";
    case "unknown":
      return "CI unknown";
  }
}

/** A link target worth following: only https pages on github.com, whatever the stored value says. */
export function safeHref(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname === "github.com" ? parsed.href : null;
  } catch {
    return null;
  }
}

/** Splits text on `backticks` so the pieces in them can be drawn as code without any HTML being parsed. */
export function codeSegments(text: string): { text: string; code: boolean }[] {
  return text
    .split("`")
    .map((piece, index) => ({ text: piece, code: index % 2 === 1 }))
    .filter((segment) => segment.text !== "");
}

/** The ISO time `days` days after `now`, for a snooze. */
export function snoozeUntil(days: number, now: Date = new Date()): string {
  return new Date(now.getTime() + days * 86_400_000).toISOString();
}

/** `meddlin/gitlib#41`, the way the CLI prints a pull request. */
export const prKey = (pr: { repo: string; number: number }): string => `${pr.repo}#${pr.number}`;

export const WEEKDAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"] as const;
/** Monday first, the way a week is usually drawn. */
export const WEEKDAY_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;

/** A short phrase: "off", "every day at 08:00", "weekdays at 08:00", "Mon, Wed at 06:45". */
export function describeSchedule(schedule: { enabled: boolean; days: readonly number[]; time: string }): string {
  if (!schedule.enabled) return "off";
  const days = [...schedule.days].sort((a, b) => a - b);
  const which =
    days.length === 7
      ? "every day"
      : days.join() === "1,2,3,4,5"
        ? "weekdays"
        : days.join() === "0,6"
          ? "weekends"
          : WEEKDAY_ORDER.filter((day) => days.includes(day)).map((day) => WEEKDAY_NAMES[day]).join(", ");
  return `${which} at ${schedule.time}`;
}
