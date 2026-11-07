import { createServerFn } from "@tanstack/react-start";
import { getApp } from "./gitlib.server";

/** A milestone with how many of the issues in it are closed. */
export interface MilestoneView {
  id: number;
  projectId: number;
  title: string;
  description: string;
  /** `YYYY-MM-DD`, or null. */
  dueDate: string | null;
  issueCount: number;
  closedCount: number;
}

/** For pickers: a milestone to choose, by title. */
export interface MilestoneOption {
  id: number;
  title: string;
}

/** Sent down with the data so the form's limits can't drift from the ones the server enforces. */
export interface MilestoneLimits {
  title: number;
  description: number;
}

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

const isTextOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

export const createMilestone = createServerFn({ method: "POST" })
  .validator((input: { projectId: number; title: string; description: string; dueDate: string | null }) => {
    if (
      !isId(input?.projectId) ||
      typeof input?.title !== "string" ||
      typeof input?.description !== "string" ||
      !isTextOrNull(input?.dueDate)
    ) {
      throw new Error("Invalid milestone payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<MilestoneOption> => {
    const { id, title } = getApp().createMilestone(data.projectId, {
      title: data.title,
      description: data.description,
      dueDate: data.dueDate,
    });
    return { id, title };
  });

export const updateMilestone = createServerFn({ method: "POST" })
  .validator((input: { id: number; title: string; description: string; dueDate: string | null }) => {
    if (
      !isId(input?.id) ||
      typeof input?.title !== "string" ||
      typeof input?.description !== "string" ||
      !isTextOrNull(input?.dueDate)
    ) {
      throw new Error("Invalid milestone payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<MilestoneOption> => {
    const { id, title } = getApp().updateMilestone(data.id, {
      title: data.title,
      description: data.description,
      dueDate: data.dueDate,
    });
    return { id, title };
  });

export const deleteMilestone = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid milestone request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().deleteMilestone(data.id);
  });

/** Pass `milestoneId: null` to take the issue out of its milestone. */
export const setIssueMilestone = createServerFn({ method: "POST" })
  .validator((input: { issueId: number; milestoneId: number | null }) => {
    if (!isId(input?.issueId) || (input?.milestoneId !== null && !isId(input?.milestoneId))) {
      throw new Error("Invalid issue milestone payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().setLocalIssueMilestone(data.issueId, data.milestoneId);
  });
