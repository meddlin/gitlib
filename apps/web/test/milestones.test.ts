import { describe, expect, it } from "vitest";
import { formatDueDate, isOverdue, milestoneProgress, todayDate } from "../src/lib/milestones";

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
