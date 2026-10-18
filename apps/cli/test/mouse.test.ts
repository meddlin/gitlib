import { describe, expect, it } from "vitest";
import { computeLayout, contains } from "../src/tui/layout.js";
import { parseMouseEvents } from "../src/tui/mouse.js";

describe("parseMouseEvents", () => {
  it("parses presses and releases with zero-based coordinates", () => {
    expect(parseMouseEvents("\u001B[<0;12;5M\u001B[<0;12;5m")).toEqual([
      { kind: "press", button: "left", x: 11, y: 4 },
      { kind: "release", button: "left", x: 11, y: 4 },
    ]);
    expect(parseMouseEvents("\u001B[<2;1;1M")[0]).toMatchObject({ button: "right", x: 0, y: 0 });
  });

  it("parses vertical wheel events and ignores horizontal ones", () => {
    expect(parseMouseEvents("\u001B[<64;3;4M\u001B[<65;3;4M\u001B[<66;3;4M")).toEqual([
      { kind: "wheel", button: "none", direction: "up", x: 2, y: 3 },
      { kind: "wheel", button: "none", direction: "down", x: 2, y: 3 },
    ]);
  });

  it("ignores motion, modifier-free text and unrelated escapes", () => {
    expect(parseMouseEvents("\u001B[<35;3;4M")).toEqual([]);
    expect(parseMouseEvents("hello\u001B[A")).toEqual([]);
  });

  it("finds reports embedded in other input", () => {
    expect(parseMouseEvents("a\u001B[<0;2;2Mb")).toHaveLength(1);
  });
});

describe("computeLayout", () => {
  it("keeps regions inside the screen and non-overlapping", () => {
    const layout = computeLayout(160, 44);
    expect(contains(layout.tablePane, 0, 2)).toBe(true);
    expect(contains(layout.detailPane, layout.leftWidth, 2)).toBe(true);
    expect(contains(layout.tablePane, layout.leftWidth, 2)).toBe(false);
    expect(layout.tableRows.y + layout.tableRows.height).toBeLessThanOrEqual(layout.tablePane.y + layout.tablePane.height);
    expect(layout.readme.y + layout.readme.height).toBeLessThanOrEqual(layout.detailPane.y + layout.detailPane.height);
    expect(layout.footer.every((button) => button.rect.y === layout.statusY + 1)).toBe(true);
    const search = layout.search;
    expect(contains(search, layout.technology.x, search.y)).toBe(false);
  });
});
