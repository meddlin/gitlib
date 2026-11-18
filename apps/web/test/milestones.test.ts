import { describe, expect, it } from "vitest";
import type { IssueStatus, LocalIssue } from "@gitlib/core";
import { formatDueDate, isOverdue, milestoneProgress, todayDate } from "../src/lib/milestones";
import { ROLL_UP_LABELS } from "../src/lib/roll-up";
import { epicViews } from "../src/server/epics.server";
import { milestoneViews } from "../src/server/milestones.server";

describe("milestone progress", () => {
  it("counts closed issues and rounds the percentage", () => {
    expect(milestoneProgress(3, 1)).toEqual({ total: 3, closed: 1, percent: 33, complete: false });
    expect(milestoneProgress(4, 4)).toEqual({ total: 4, closed: 4, percent: 100, complete: true });
  });

  it("is not complete, and not divided by zero, with no issues", () => {
    expect(milestoneProgress(0, 0)).toEqual({ total: 0, closed: 0, percent: 0, complete: false });
  });
});

describe("overdue", () => {
  const open = milestoneProgress(2, 1);
  const done = milestoneProgress(2, 2);

  it("is true only after the due day has ended and work remains", () => {
    expect(isOverdue("2026-06-01", open, "2026-06-02")).toBe(true);
    expect(isOverdue("2026-06-01", open, "2026-06-01")).toBe(false);
    expect(isOverdue("2026-06-01", open, "2026-05-31")).toBe(false);
  });

  it("is never true without a due date or once everything is closed", () => {
    expect(isOverdue(null, open, "2030-01-01")).toBe(false);
    expect(isOverdue("2026-06-01", done, "2030-01-01")).toBe(false);
  });

  it("treats an empty milestone past its due date as late", () => {
    expect(isOverdue("2026-06-01", milestoneProgress(0, 0), "2026-06-02")).toBe(true);
  });
});

describe("due dates", () => {
  it("formats the calendar day itself, whatever the time zone", () => {
    // Built from its parts in local time, so the day never slips to the 31st the way a UTC parse can.
    expect(formatDueDate("2026-06-01")).toMatch(/\b1\b/);
    expect(formatDueDate("2026-06-01")).not.toMatch(/\b31\b/);
  });

  it("writes today's local date as YYYY-MM-DD", () => {
    expect(todayDate(new Date(2026, 0, 5, 23, 59))).toBe("2026-01-05");
    expect(todayDate(new Date(2026, 11, 31, 0, 0))).toBe("2026-12-31");
  });
});

describe("rolled-up status", () => {
  const issue = (id: number, status: IssueStatus, groups: { milestoneId?: number; epicId?: number }): LocalIssue => ({
    id,
    repoId: 1,
    repoSlug: "api",
    repoPath: "api",
    number: id,
    title: `Issue ${id}`,
    body: "",
    state: status === "done" ? "closed" : "open",
    status,
    projectId: 1,
    milestoneId: groups.milestoneId ?? null,
    epicId: groups.epicId ?? null,
    archived: false,
    createdAt: "",
    updatedAt: "",
    closedAt: null,
  });
  const group = (id: number) => ({ id, projectId: 1, title: `Group ${id}`, description: "", archivedAt: null, createdAt: "", updatedAt: "" });

  it("gives milestones and epics the same status from their issues", () => {
    const issues = [
      issue(1, "done", { milestoneId: 1, epicId: 1 }),
      issue(2, "in_review", { milestoneId: 1, epicId: 2 }),
      issue(3, "todo", { milestoneId: 2, epicId: 2 }),
      issue(4, "done", { milestoneId: 3 }),
    ];
    const milestones = milestoneViews(
      [1, 2, 3, 4].map((id) => ({ ...group(id), dueDate: null })),
      issues,
    );
    expect(milestones.map((milestone) => milestone.status)).toEqual(["in_progress", "todo", "done", "empty"]);
    expect(epicViews([group(1), group(2)], issues).map((epic) => epic.status)).toEqual(["done", "in_progress"]);
    expect(ROLL_UP_LABELS[milestones[0]!.status]).toBe("In progress");
  });
});
