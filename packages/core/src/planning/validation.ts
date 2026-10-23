import { GitLibError } from "../errors.js";

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

export const MAX_PROJECT_NAME_LENGTH = 100;

export class ProjectValidationError extends GitLibError {}

export function normalizeProjectName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) throw new ProjectValidationError("A project needs a name.");
  if (trimmed.length > MAX_PROJECT_NAME_LENGTH) {
    throw new ProjectValidationError(`Project names are limited to ${MAX_PROJECT_NAME_LENGTH} characters.`);
  }
  return trimmed;
}
