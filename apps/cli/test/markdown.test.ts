import { describe, expect, it } from "vitest";
import { renderMarkdownLines } from "../src/tui/markdown.js";

// Terminal styling is an implementation detail (and depends on whether colour is enabled), so compare plain text.
// eslint-disable-next-line no-control-regex
const plain = (lines: string[]) => lines.map((line) => line.replace(/\u001B\[[0-9;]*m/g, ""));

describe("renderMarkdownLines", () => {
  it("returns no lines for empty or whitespace-only input", () => {
    expect(renderMarkdownLines("", 40)).toEqual([]);
    expect(renderMarkdownLines("\n\n  \n", 40)).toEqual([]);
  });

  it("renders headings and paragraphs, turning inline emphasis into styling rather than markers", () => {
    const text = plain(renderMarkdownLines("# Title\n\nSome **bold** words.", 60)).join("\n");
    expect(text).toContain("Title");
    expect(text).toContain("Some bold words.");
    expect(text).not.toContain("**");
  });

  it("renders list items on their own lines", () => {
    const lines = plain(renderMarkdownLines("- alpha\n- beta\n- gamma", 60));
    for (const item of ["alpha", "beta", "gamma"]) {
      expect(lines.filter((line) => line.includes(item))).toHaveLength(1);
    }
  });

  it("drops trailing blank lines but keeps blank lines between blocks", () => {
    const lines = renderMarkdownLines("first\n\nsecond\n\n\n", 40);
    expect(lines.at(-1)?.trim()).not.toBe("");
    expect(plain(lines).findIndex((line) => line.includes("second"))).toBeGreaterThan(1);
  });

  it("reflows long paragraphs to the requested width", () => {
    const paragraph = Array.from({ length: 30 }, (_, index) => `word${index}`).join(" ");
    const lines = plain(renderMarkdownLines(paragraph, 30));
    expect(lines.length).toBeGreaterThan(1);
    expect(lines.join(" ").replace(/\s+/g, " ")).toContain("word0 word1");
    for (const line of lines) expect(line.length).toBeLessThanOrEqual(30);
  });

  it("keeps code block contents", () => {
    const text = plain(renderMarkdownLines("```\nnpm run build\n```", 60)).join("\n");
    expect(text).toContain("npm run build");
  });
});
