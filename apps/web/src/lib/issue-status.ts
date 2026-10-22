import type { IssueStatus } from "@gitlib/core";

export interface StatusColumn {
  status: IssueStatus;
  label: string;
}

// Type-only import above: client bundles must not keep a runtime import of @gitlib/core, so the
// board order lives here. Record<IssueStatus, …> makes a status added in core a compile error.
const LABELS: Record<IssueStatus, string> = {
  todo: "To do",
  in_progress: "In progress",
  in_review: "In review",
  done: "Done",
};

export const STATUS_COLUMNS: readonly StatusColumn[] = (Object.keys(LABELS) as IssueStatus[]).map((status) => ({
  status,
  label: LABELS[status],
}));

export const statusLabel = (status: IssueStatus): string => LABELS[status];

export const isStatus = (value: unknown): value is IssueStatus =>
  typeof value === "string" && Object.hasOwn(LABELS, value);
