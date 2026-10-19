import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  DEFAULT_IGNORE_DIRS,
  runCommand,
  type CommandResult,
  type SearchBackend,
  type SystemDeps,
} from "@gitlib/core";
import { main } from "../src/cli.js";

export class Fixture {
  readonly base: string;
  readonly gitRoot: string;
  readonly appHome: string;

  constructor() {
    this.base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-cli-test-")));
    this.gitRoot = path.join(this.base, "git");
    this.appHome = path.join(this.base, "gitlib-home");
    fs.mkdirSync(this.gitRoot);
  }

  cleanup(): void {
    fs.rmSync(this.base, { recursive: true, force: true });
  }

  writeConfig(options: { vscodeCommand?: string[]; search?: string[] } = {}): void {
    fs.mkdirSync(this.appHome, { recursive: true });
    const list = (items: readonly string[]) => items.map((item) => `  "${item}",`).join("\n");
    const lines = ["roots = [", list([this.gitRoot]), "]", ""];
    if (options.vscodeCommand?.length) {
      lines.push("vscode_command = [", list(options.vscodeCommand), "]", "");
    }
    lines.push("ignore_dirs = [", list(DEFAULT_IGNORE_DIRS), "]", "");
    // Keep tests away from any Meilisearch running on the developer's machine unless they opt in.
    lines.push("[search]", ...(options.search ?? ["enabled = false"]), "");
    fs.writeFileSync(path.join(this.appHome, "config.toml"), lines.join("\n"), "utf-8");
  }

  makeRepo(relativePath: string, files: Record<string, string> = {}): string {
    const repoPath = path.join(this.gitRoot, relativePath);
    fs.mkdirSync(path.join(repoPath, ".git"), { recursive: true });
    for (const [file, contents] of Object.entries(files)) {
      const target = path.join(repoPath, file);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, contents, "utf-8");
    }
    return repoPath;
  }

  initRealGitRepo(relativePath: string, files: Record<string, string> = {}): string {
    const repoPath = path.join(this.gitRoot, relativePath);
    fs.mkdirSync(repoPath, { recursive: true });
    execFileSync("git", ["init", repoPath], { stdio: "pipe" });
    for (const [file, contents] of Object.entries(files)) {
      fs.writeFileSync(path.join(repoPath, file), contents, "utf-8");
    }
    return repoPath;
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

  async runCli(
    args: string[],
    options: { env?: Record<string, string>; system?: SystemDeps; searchBackend?: SearchBackend | null } = {},
  ): Promise<{ code: number; stdout: string; stderr: string }> {
    let stdout = "";
    let stderr = "";
    const code = await main(args, {
      env: this.env(options.env),
      stdout: { write: (chunk) => void (stdout += chunk) },
      stderr: { write: (chunk) => void (stderr += chunk) },
      ...(options.system ? { system: options.system } : {}),
      ...(options.searchBackend !== undefined ? { searchBackend: options.searchBackend } : {}),
    });
    return { code, stdout, stderr };
  }
}

export function fakeSystem(overrides: {
  runCommand?: (command: readonly string[]) => CommandResult;
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
