import {
  MAX_MILESTONE_DESCRIPTION_LENGTH,
  MAX_MILESTONE_TITLE_LENGTH,
  type LocalIssue,
  type Milestone,
} from "@gitlib/core";
import type { MilestoneLimits, MilestoneView } from "./milestones";

// Server-only (`.server.ts`) so the runtime import of @gitlib/core never reaches a client bundle.
export const milestoneLimits = (): MilestoneLimits => ({
  title: MAX_MILESTONE_TITLE_LENGTH,
  description: MAX_MILESTONE_DESCRIPTION_LENGTH,
});

export function milestoneViews(milestones: readonly Milestone[], issues: readonly LocalIssue[]): MilestoneView[] {
  return milestones.map((milestone) => {
    const inMilestone = issues.filter((issue) => issue.milestoneId === milestone.id);
    return {
      id: milestone.id,
      projectId: milestone.projectId,
      title: milestone.title,
      description: milestone.description,
      dueDate: milestone.dueDate,
      issueCount: inMilestone.length,
      closedCount: inMilestone.filter((issue) => issue.state === "closed").length,
    };
  });
}
