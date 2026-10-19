import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_IGNORE_DIRS,
  runCommand,
  type CommandResult,
  type SystemDeps,
} from "../src/index.js";

export class Fixture {
  readonly base: string;
  readonly gitRoot: string;
  readonly appHome: string;

  constructor() {
    this.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-test-")));
    this.gitRoot = path.join(this.base, "git");
    this.appHome = path.join(this.base, "gitlib-home");
    fs.mkdirSync(this.gitRoot);
  }

  cleanup(): void {
    fs.rmSync(this.base, { recursive: true, force: true });
  }

  writeConfig(options: { roots?: string[]; vscodeCommand?: string[]; search?: string[] } = {}): void {
    const roots = options.roots ?? [this.gitRoot];
    fs.mkdirSync(this.appHome, { recursive: true });
    const list = (items: readonly string[]) => items.map((item) => `  "${item}",`).join("\n");
    const lines = ["roots = [", list(roots), "]", ""];
    if (options.vscodeCommand?.length) {
      lines.push("vscode_command = [", list(options.vscodeCommand), "]", "");
    }
    lines.push("ignore_dirs = [", list(DEFAULT_IGNORE_DIRS), "]", "");
    // Keep tests away from any Meilisearch running on the developer's machine unless they opt in.
    lines.push("[search]", ...(options.search ?? ["enabled = false"]), "");
    fs.writeFileSync(path.join(this.appHome, "config.toml"), lines.join("\n"), "utf-8");
  }

  writeFiles(directory: string, files: Record<string, string> = {}): string {
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(directory, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, "utf-8");
    }
    return directory;
  }

  makeRepo(relativePath: string, files: Record<string, string> = {}): string {
    const repoPath = path.join(this.gitRoot, relativePath);
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    return this.writeFiles(repoPath, files);
  }

  makeDir(relativePath: string, files: Record<string, string> = {}): string {
    const directory = path.join(this.gitRoot, relativePath);
    fs.mkdirSync(directory, { recursive: true });
    return this.writeFiles(directory, files);
  }

  initRealGitRepo(relativePath: string, files: Record<string, string> = {}): string {
    const repoPath = path.join(this.gitRoot, relativePath);
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", repoPath], { stdio: "pipe" });
    return this.writeFiles(repoPath, files);
  }

  /** Adds a real linked worktree of `repoRelativePath` at `worktreeRelativePath` (under the git root). */
  addWorktree(repoRelativePath: string, worktreeRelativePath: string): string {
    const repoPath = path.join(this.gitRoot, repoRelativePath);
    const target = path.join(this.gitRoot, worktreeRelativePath);
    const identity = ["-c", "user.name=Test", "-c", "user.email=test@example.com"];
    execFileSync("git", ["-C", repoPath, ...identity, "commit", "--allow-empty", "-m", "init"], {
      stdio: "pipe",
    });
    fs.mkdirSync(path.dirname(target), { recursive: true });
    execFileSync(
      "git",
      ["-C", repoPath, "worktree", "add", "-b", `wt-${path.basename(target)}`, target],
      { stdio: "pipe" },
    );
    return target;
  }

  git(repoPath: string, ...args: string[]): void {
    execFileSync("git", ["-C", repoPath, ...args], { stdio: "pipe" });
  }

  env(overrides: Record<string, string> = {}): Record<string, string> {
    return { GITLIB_HOME: this.appHome, ...overrides };
  }
}

export type CommandHandler = (command: readonly string[]) => CommandResult;

/**
 * SystemDeps that run real commands for `git` but let tests intercept everything else
 * (the VS Code launcher) and replace the browser opener.
 */
export function fakeSystem(overrides: {
  runCommand?: CommandHandler;
  openUrl?: (url: string) => boolean;
}): SystemDeps & { commands: string[][]; urls: string[] } {
  const commands: string[][] = [];
  const urls: string[] = [];
  return {
    commands,
    urls,
    runCommand(command) {
      if (command[0] === "git" || !overrides.runCommand) return runCommand(command);
      commands.push([...command]);
      return overrides.runCommand(command);
    },
    openUrl(url) {
      urls.push(url);
      return overrides.openUrl ? overrides.openUrl(url) : true;
    },
  };
}
