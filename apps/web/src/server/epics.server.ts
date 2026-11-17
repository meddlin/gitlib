import {
  MAX_EPIC_DESCRIPTION_LENGTH,
  MAX_EPIC_TITLE_LENGTH,
  rollUpStatus,
  type Epic,
  type LocalIssue,
} from "@gitlib/core";
import type { EpicLimits, EpicView } from "./epics";

// Server-only (`.server.ts`) so the runtime import of @gitlib/core never reaches a client bundle.
export const epicLimits = (): EpicLimits => ({ title: MAX_EPIC_TITLE_LENGTH, description: MAX_EPIC_DESCRIPTION_LENGTH });

export function epicViews(epics: readonly Epic[], issues: readonly LocalIssue[]): EpicView[] {
  return epics.map((epic) => {
    const inEpic = issues.filter((issue) => issue.epicId === epic.id);
    return {
      id: epic.id,
      projectId: epic.projectId,
      title: epic.title,
      description: epic.description,
      archived: epic.archivedAt !== null,
      issueCount: inEpic.length,
      closedCount: inEpic.filter((issue) => issue.state === "closed").length,
      status: rollUpStatus(inEpic.map((issue) => issue.status)),
    };
  });
}
