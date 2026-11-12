import { GitLibError } from "../errors.js";
import type { ProjectRemote } from "./types.js";

export const MAX_ISSUE_TITLE_LENGTH = 200;
export const MAX_ISSUE_BODY_LENGTH = 50_000;

export class LocalIssueValidationError extends GitLibError {}

export function normalizeIssueTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new LocalIssueValidationError("An issue needs a title.");
  if (trimmed.length > MAX_ISSUE_TITLE_LENGTH) {
    throw new LocalIssueValidationError(`Issue titles are limited to ${MAX_ISSUE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

export function normalizeIssueBody(body: string): string {
  const trimmed = body.trim();
  if (trimmed.length > MAX_ISSUE_BODY_LENGTH) {
    throw new LocalIssueValidationError(`Issue descriptions are limited to ${MAX_ISSUE_BODY_LENGTH} characters.`);
  }
  return trimmed;
}

export const MAX_MILESTONE_TITLE_LENGTH = 100;
export const MAX_MILESTONE_DESCRIPTION_LENGTH = 10_000;

export class MilestoneValidationError extends GitLibError {}

export function normalizeMilestoneTitle(title: string): string {
  const trimmed = title.trim();
  if (!trimmed) throw new MilestoneValidationError("A milestone needs a title.");
  if (trimmed.length > MAX_MILESTONE_TITLE_LENGTH) {
    throw new MilestoneValidationError(`Milestone titles are limited to ${MAX_MILESTONE_TITLE_LENGTH} characters.`);
  }
  return trimmed;
}

export function normalizeMilestoneDescription(description: string): string {
  const trimmed = description.trim();
  if (trimmed.length > MAX_MILESTONE_DESCRIPTION_LENGTH) {
    throw new MilestoneValidationError(
      `Milestone descriptions are limited to ${MAX_MILESTONE_DESCRIPTION_LENGTH} characters.`,
    );
  }
  return trimmed;
}

/** A real calendar date as `YYYY-MM-DD`, or null for "no due date" (null, undefined or blank). */
export function normalizeMilestoneDueDate(dueDate: string | null | undefined): string | null {
  const trimmed = dueDate?.trim();
  if (!trimmed) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
  const date = match ? new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]))) : null;
  // Round-tripping rejects dates that only look valid, such as 2026-02-31.
  if (!date || date.toISOString().slice(0, 10) !== trimmed) {
    throw new MilestoneValidationError("A due date must be a real date, written YYYY-MM-DD.");
  }
  return trimmed;
}

export const MAX_PROJECT_NAME_LENGTH = 100;

/** Checks a hosted repo before it is stored: a known provider and a full name of plain path segments. */
export function normalizeProjectRemote(remote: ProjectRemote): ProjectRemote {
  const fullName = typeof remote?.fullName === "string" ? remote.fullName.trim().replace(/^\/+|\/+$/g, "") : "";
  if ((remote?.provider !== "github" && remote?.provider !== "gitlab") || !fullName.includes("/")) {
    throw new ProjectValidationError("A hosted repository needs a provider and a name like owner/repo.");
  }
  if (fullName.split("/").some((segment) => !segment || segment === "." || segment === ".." || /[\s\\:\0]/.test(segment))) {
    throw new ProjectValidationError(`"${fullName}" is not a valid repository name.`);
  }
  return { provider: remote.provider, fullName };
}

export class ProjectValidationError extends GitLibError {}

export function normalizeProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectValidationError("A project needs a name.");
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectValidationError(`Project names are limited to ${MAX_PROJECT_NAME_LENGTH} characters.`);
  }
  return trimmed;
}
