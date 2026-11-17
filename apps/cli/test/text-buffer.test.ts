import { describe, expect, it } from "vitest";
import { TextBuffer } from "../src/tui/text-buffer.js";

/** A buffer holding `value` with the cursor at `offset`. */
function bufferAt(value: string, offset: number): TextBuffer {
  const buffer = new TextBuffer(value);
  buffer.cursor = offset;
  return buffer;
}

describe("TextBuffer editing", () => {
  it("starts empty with the cursor at the end of any initial value", () => {
    expect(new TextBuffer()).toMatchObject({ value: "", cursor: 0 });
    expect(new TextBuffer("abc")).toMatchObject({ value: "abc", cursor: 3 });
  });

  it("inserts at the cursor and advances past the inserted text", () => {
    const buffer = bufferAt("held", 3);
    buffer.insert("lo wor");
    expect(buffer).toMatchObject({ value: "hello word", cursor: 9 });
  });

  it("inserts multi-line text in one go", () => {
    const buffer = new TextBuffer("ab");
    buffer.insert("\ncd");
    expect(buffer.value).toBe("ab\ncd");
    expect(buffer.position()).toEqual({ row: 1, column: 2 });
  });

  it("backspace removes the character before the cursor, and does nothing at the start", () => {
    const buffer = bufferAt("abc", 2);
    buffer.backspace();
    expect(buffer).toMatchObject({ value: "ac", cursor: 1 });

    const atStart = bufferAt("abc", 0);
    atStart.backspace();
    expect(atStart).toMatchObject({ value: "abc", cursor: 0 });
  });

  it("deleteForward removes the character under the cursor, and does nothing at the end", () => {
    const buffer = bufferAt("abc", 1);
    buffer.deleteForward();
    expect(buffer).toMatchObject({ value: "ac", cursor: 1 });

    const atEnd = new TextBuffer("abc");
    atEnd.deleteForward();
    expect(atEnd).toMatchObject({ value: "abc", cursor: 3 });
  });

  it("backspace can join two lines", () => {
    const buffer = bufferAt("ab\ncd", 3);
    buffer.backspace();
    expect(buffer).toMatchObject({ value: "abcd", cursor: 2 });
  });
});

describe("TextBuffer horizontal movement", () => {
  it("moves left and right, clamped to the text", () => {
    const buffer = bufferAt("ab", 1);
    buffer.left();
    expect(buffer.cursor).toBe(0);
    buffer.left();
    expect(buffer.cursor).toBe(0);
    buffer.right();
    buffer.right();
    buffer.right();
    expect(buffer.cursor).toBe(2);
  });

  it("home and end work on the current line only", () => {
    const buffer = bufferAt("one\ntwo\nthree", 5); // inside "two"
    buffer.home();
    expect(buffer.cursor).toBe(4);
    buffer.end();
    expect(buffer.cursor).toBe(7);

    buffer.cursor = 9; // inside "three", the last line has no trailing newline
    buffer.end();
    expect(buffer.cursor).toBe("one\ntwo\nthree".length);
    buffer.home();
    expect(buffer.cursor).toBe(8);
  });
});

describe("TextBuffer position", () => {
  it("reports a zero-based row and column", () => {
    expect(new TextBuffer("").position()).toEqual({ row: 0, column: 0 });
    expect(bufferAt("a\nbc", 3).position()).toEqual({ row: 1, column: 1 });
    expect(bufferAt("a\n", 2).position()).toEqual({ row: 1, column: 0 });
  });

  it("setPosition moves to a row and column", () => {
    const buffer = new TextBuffer("first\nsecond\nthird");
    buffer.setPosition(1, 3);
    expect(buffer.cursor).toBe(9);
    expect(buffer.position()).toEqual({ row: 1, column: 3 });
  });

  it("setPosition clamps to the text that exists", () => {
    const buffer = new TextBuffer("ab\ncdef");
    buffer.setPosition(99, 99);
    expect(buffer.position()).toEqual({ row: 1, column: 4 });
    buffer.setPosition(-5, -5);
    expect(buffer.position()).toEqual({ row: 0, column: 0 });
    buffer.setPosition(0, 99); // past the end of a shorter line stays on that line
    expect(buffer.position()).toEqual({ row: 0, column: 2 });
  });
});

describe("TextBuffer vertical movement", () => {
  it("keeps the column when the target line is long enough", () => {
    const buffer = bufferAt("abcde\nfghij", 3);
    buffer.down();
    expect(buffer.position()).toEqual({ row: 1, column: 3 });
    buffer.up();
    expect(buffer.position()).toEqual({ row: 0, column: 3 });
  });

  it("clamps the column to a shorter line", () => {
    const buffer = new TextBuffer("hello\nhi\nworld"); // cursor at the end of "world"
    buffer.up();
    expect(buffer.position()).toEqual({ row: 1, column: 2 });
    buffer.up();
    expect(buffer.position()).toEqual({ row: 0, column: 2 });
  });

  it("stays on the first and last lines when there is nowhere further to go", () => {
    const buffer = bufferAt("ab\ncd", 1);
    buffer.up();
    expect(buffer.cursor).toBe(1);

    buffer.down();
    buffer.down();
    expect(buffer.position()).toEqual({ row: 1, column: 1 });
  });

  it("moves through blank lines", () => {
    const buffer = bufferAt("a\n\nb", 1);
    buffer.down();
    expect(buffer.position()).toEqual({ row: 1, column: 0 });
    buffer.down();
    expect(buffer.position()).toEqual({ row: 2, column: 0 });
  });
});
