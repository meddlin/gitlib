import { createServerFn } from "@tanstack/react-start";
import type { RollUpStatus } from "@gitlib/core";
import { getApp } from "./gitlib.server";

/** An epic with where its issues stand. */
export interface EpicView {
  id: number;
  projectId: number;
  title: string;
  description: string;
  /** Archived epics keep their issues but take no new ones; the project page lists them apart. */
  archived: boolean;
  issueCount: number;
  closedCount: number;
  /** Worked out from its issues' statuses (see `rollUpStatus`). */
  status: RollUpStatus;
}

/** For pickers: an epic to choose, by title. */
export interface EpicOption {
  id: number;
  title: string;
}

/** Sent down with the data so the form's limits can't drift from the ones the server enforces. */
export interface EpicLimits {
  title: number;
  description: number;
}

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

export const createEpic = createServerFn({ method: "POST" })
  .validator((input: { projectId: number; title: string; description: string }) => {
    if (!isId(input?.projectId) || typeof input?.title !== "string" || typeof input?.description !== "string") {
      throw new Error("Invalid epic payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<EpicOption> => {
    const { id, title } = getApp().createEpic(data.projectId, { title: data.title, description: data.description });
    return { id, title };
  });

export const updateEpic = createServerFn({ method: "POST" })
  .validator((input: { id: number; title: string; description: string }) => {
    if (!isId(input?.id) || typeof input?.title !== "string" || typeof input?.description !== "string") {
      throw new Error("Invalid epic payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<EpicOption> => {
    const { id, title } = getApp().updateEpic(data.id, { title: data.title, description: data.description });
    return { id, title };
  });

export const deleteEpic = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid epic request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().deleteEpic(data.id);
  });

/** Archives (`archived: true`) or restores an epic. */
export const setEpicArchived = createServerFn({ method: "POST" })
  .validator((input: { id: number; archived: boolean }) => {
    if (!isId(input?.id) || typeof input?.archived !== "boolean") throw new Error("Invalid epic request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    if (data.archived) getApp().archiveEpic(data.id);
    else getApp().restoreEpic(data.id);
  });

/** Pass `epicId: null` to take the issue out of its epic. */
export const setIssueEpic = createServerFn({ method: "POST" })
  .validator((input: { issueId: number; epicId: number | null }) => {
    if (!isId(input?.issueId) || (input?.epicId !== null && !isId(input?.epicId))) {
      throw new Error("Invalid issue epic payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().setLocalIssueEpic(data.issueId, data.epicId);
  });
