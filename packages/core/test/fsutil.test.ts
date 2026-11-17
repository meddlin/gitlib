import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { expandUser, isDirectory, isRelativeTo, resolvePath, walk, type WalkEntry } from "../src/fsutil.js";

let base: string;

beforeEach(() => {
  // realpath: os.tmpdir() is itself a symlink on macOS, which would skew path comparisons.
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-fsutil-")));
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const touch = (...segments: string[]) => {
  const file = path.join(base, ...segments);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "");
  return file;
};

describe("expandUser", () => {
  it("expands a bare ~ and a leading ~/ to the home directory", () => {
    expect(expandUser("~")).toBe(os.homedir());
    expect(expandUser("~/git/project")).toBe(path.join(os.homedir(), "git", "project"));
  });

  it("leaves everything else alone", () => {
    expect(expandUser("/abs/path")).toBe("/abs/path");
    expect(expandUser("relative/path")).toBe("relative/path");
    // Only the current user's home is expanded; `~other` is not something we can resolve.
    expect(expandUser("~someone/git")).toBe("~someone/git");
    expect(expandUser("not/~/home")).toBe("not/~/home");
  });
});

describe("resolvePath", () => {
  it("returns an existing path unchanged", () => {
    expect(resolvePath(base)).toBe(base);
  });

  it("resolves symlinks in the part of the path that exists", () => {
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link"));
    expect(resolvePath(path.join(base, "link"))).toBe(real);
  });

  it("appends a missing remainder lexically, after resolving what does exist", () => {
    const real = path.join(base, "real");
    fs.mkdirSync(real);
    fs.symlinkSync(real, path.join(base, "link"));
    expect(resolvePath(path.join(base, "link", "not", "yet"))).toBe(path.join(real, "not", "yet"));
    expect(resolvePath(path.join(base, "missing", "deeper"))).toBe(path.join(base, "missing", "deeper"));
  });

  it("normalizes `..` and relative input to an absolute path", () => {
    expect(resolvePath(path.join(base, "a", "..", "b"))).toBe(path.join(base, "b"));
    expect(path.isAbsolute(resolvePath("some/relative/dir"))).toBe(true);
  });
});

describe("isDirectory", () => {
  it("is true only for directories", () => {
    const file = touch("file.txt");
    expect(isDirectory(base)).toBe(true);
    expect(isDirectory(file)).toBe(false);
    expect(isDirectory(path.join(base, "missing"))).toBe(false);
  });

  it("follows a symlink to a directory", () => {
    fs.mkdirSync(path.join(base, "real"));
    fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));
    expect(isDirectory(path.join(base, "link"))).toBe(true);
  });

  it("is false for a dangling symlink", () => {
    fs.symlinkSync(path.join(base, "nowhere"), path.join(base, "dangling"));
    expect(isDirectory(path.join(base, "dangling"))).toBe(false);
  });
});

describe("isRelativeTo", () => {
  it("is true for the parent itself and anything beneath it", () => {
    expect(isRelativeTo("/a/b", "/a/b")).toBe(true);
    expect(isRelativeTo("/a/b/c", "/a/b")).toBe(true);
    expect(isRelativeTo("/a/b/c/d/e", "/a/b")).toBe(true);
  });

  it("is false for siblings, ancestors and look-alike prefixes", () => {
    expect(isRelativeTo("/a/c", "/a/b")).toBe(false);
    expect(isRelativeTo("/a", "/a/b")).toBe(false);
    expect(isRelativeTo("/a/bc", "/a/b")).toBe(false);
  });
});

describe("walk", () => {
  const collect = (root: string): WalkEntry[] => [...walk(root)];

  it("visits directories top-down with sorted names", () => {
    touch("b.txt");
    touch("a.txt");
    touch("z", "inner.txt");
    touch("m", "deep", "leaf.txt");

    const visited = collect(base).map((entry) => path.relative(base, entry.dirpath) || ".");
    expect(visited).toEqual([".", "m", path.join("m", "deep"), "z"]);

    const [top] = collect(base);
    expect(top?.filenames).toEqual(["a.txt", "b.txt"]);
    expect(top?.dirnames).toEqual(["m", "z"]);
  });

  it("does not descend into a directory removed from dirnames", () => {
    touch("keep", "a.txt");
    touch("skip", "b.txt");

    const visited: string[] = [];
    for (const entry of walk(base)) {
      visited.push(path.relative(base, entry.dirpath) || ".");
      entry.dirnames.splice(0, entry.dirnames.length, ...entry.dirnames.filter((name) => name !== "skip"));
    }
    expect(visited).toEqual([".", "keep"]);
  });

  it("lists a symlink to a directory in dirnames but never descends into it", () => {
    touch("real", "inside.txt");
    fs.symlinkSync(path.join(base, "real"), path.join(base, "link"));

    const entries = collect(base);
    expect(entries[0]?.dirnames).toEqual(["link", "real"]);
    expect(entries.map((entry) => path.relative(base, entry.dirpath) || ".")).toEqual([".", "real"]);
  });

  it("treats a symlink to a file, and a dangling symlink, as files", () => {
    const file = touch("target.txt");
    fs.symlinkSync(file, path.join(base, "file-link"));
    fs.symlinkSync(path.join(base, "nowhere"), path.join(base, "dangling"));

    expect(collect(base)[0]?.filenames).toEqual(["dangling", "file-link", "target.txt"]);
  });

  it("yields nothing for a missing directory or a file", () => {
    expect(collect(path.join(base, "missing"))).toEqual([]);
    expect(collect(touch("file.txt"))).toEqual([]);
  });

  it("yields an empty directory once, with no children", () => {
    expect(collect(base)).toEqual([{ dirpath: base, dirnames: [], filenames: [] }]);
  });
});
