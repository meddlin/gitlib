import { ISSUE_STATUSES } from "@gitlib/core";
import { describe, expect, it } from "vitest";
import { STATUS_COLUMNS, isStatus, statusLabel } from "../src/lib/issue-status";

describe("board columns", () => {
  it("has one column per core status, in core's board order", () => {
    // The web copy of the order exists so client bundles never import @gitlib/core at runtime;
    // this keeps the two from drifting apart.
    expect(STATUS_COLUMNS.map((column) => column.status)).toEqual([...ISSUE_STATUSES]);
  });

  it("labels each column for people", () => {
    expect(STATUS_COLUMNS.map((column) => column.label)).toEqual(["To do", "In progress", "In review", "Done"]);
    for (const column of STATUS_COLUMNS) expect(statusLabel(column.status)).toBe(column.label);
  });
});

describe("isStatus", () => {
  it("accepts every real status", () => {
    for (const status of ISSUE_STATUSES) expect(isStatus(status)).toBe(true);
  });

  it("rejects unknown strings and anything that is not a string", () => {
    for (const value of ["", "TODO", "in progress", "open", null, undefined, 0, {}, ["todo"]]) {
      expect(isStatus(value)).toBe(false);
    }
  });

  it("does not mistake inherited object keys for statuses", () => {
    for (const value of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(isStatus(value)).toBe(false);
    }
  });
});
