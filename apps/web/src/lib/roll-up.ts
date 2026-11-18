import type { RollUpStatus } from "@gitlib/core";

/** How the status of an epic or milestone, worked out from its issues, reads on the page. */
export const ROLL_UP_LABELS: Record<RollUpStatus, string> = {
  empty: "No issues",
  todo: "Not started",
  in_progress: "In progress",
  done: "Done",
};
