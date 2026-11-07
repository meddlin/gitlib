const dueDateFormat = new Intl.DateTimeFormat(undefined, { year: "numeric", month: "short", day: "numeric" });

/**
 * A due date is a calendar date (`YYYY-MM-DD`) with no time zone, so it is built from its parts in local
 * time. Parsing it as an ISO timestamp would read it as UTC midnight and show the day before in the Americas.
 */
export function formatDueDate(dueDate: string): string {
  const [year, month, day] = dueDate.split("-").map(Number);
  return dueDateFormat.format(new Date(year!, month! - 1, day));
}

/** Today's calendar date in local time, as `YYYY-MM-DD`. */
export function todayDate(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export interface MilestoneProgress {
  total: number;
  closed: number;
  /** Whole percent of issues closed; 0 when the milestone has no issues. */
  percent: number;
  /** At least one issue, and every one of them closed. */
  complete: boolean;
}

export function milestoneProgress(issueCount: number, closedCount: number): MilestoneProgress {
  return {
    total: issueCount,
    closed: closedCount,
    percent: issueCount === 0 ? 0 : Math.round((closedCount / issueCount) * 100),
    complete: issueCount > 0 && closedCount === issueCount,
  };
}

/**
 * Past its due date with work still to do. A milestone whose issues are all closed is finished, not late,
 * and a due date is overdue only after that day has ended.
 */
export function isOverdue(dueDate: string | null, progress: MilestoneProgress, today: string = todayDate()): boolean {
  return dueDate !== null && !progress.complete && dueDate < today;
}
