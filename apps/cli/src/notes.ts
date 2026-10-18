import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitLibError, type Env } from "@gitlib/core";

export class NotesError extends GitLibError {}

/** Minimal POSIX-style word splitting (quotes and backslash escapes), like Python's `shlex.split`. */
export function shellSplit(input: string): string[] {
  const words: string[] = [];
  let current = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;

  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quote === "'") {
      if (char === "'") quote = null;
      else current += char;
    } else if (quote === '"') {
      if (char === '"') quote = null;
      else if (char === "\\" && '"\\$`'.includes(input[index + 1] ?? "")) current += input[++index];
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
      inWord = true;
    } else if (char === "\\") {
      current += input[++index] ?? "";
      inWord = true;
    } else if (/\s/.test(char)) {
      if (inWord) words.push(current);
      current = "";
      inWord = false;
    } else {
      current += char;
      inWord = true;
    }
  }

  if (quote) throw new Error("No closing quotation");
  if (inWord) words.push(current);
  return words;
}

export function editNotes(initialNotes: string, env: Env = process.env): string {
  const editor = env["EDITOR"] || "vi";
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-notes-"));
  const tempPath = path.join(tempDir, "notes.md");
  fs.writeFileSync(tempPath, initialNotes, "utf-8");

  try {
    let command: string[];
    try {
      command = [...shellSplit(editor), tempPath];
    } catch (error) {
      throw new NotesError(`Unable to launch editor '${editor}': ${(error as Error).message}`);
    }

    const [file, ...args] = command;
    const result = spawnSync(file!, args, {
      stdio: "inherit",
      env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
    });
    if (result.error) {
      throw new NotesError(`Unable to launch editor '${editor}': ${result.error.message}`, {
        cause: result.error,
      });
    }
    if (result.status !== 0) {
      throw new NotesError(`Editor exited with status ${result.status ?? result.signal}`);
    }
    return fs.readFileSync(tempPath, "utf-8").trimEnd();
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}
