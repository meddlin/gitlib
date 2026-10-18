import { spawnSync } from "node:child_process";

export interface CommandResult {
  /** Exit status, or `null` if the process was terminated by a signal. */
  status: number | null;
  stdout: string;
  stderr: string;
}

/**
 * Side-effecting integrations, injectable so tests (and other front-ends) can swap them.
 * Both throw when the underlying process cannot be spawned.
 */
export interface SystemDeps {
  runCommand(command: readonly string[]): CommandResult;
  /** Returns whether the platform opener reported success. */
  openUrl(url: string): boolean;
}

export function runCommand(command: readonly string[]): CommandResult {
  const [file, ...args] = command;
  if (!file) throw new Error("empty command");
  const result = spawnSync(file, args, { encoding: "utf-8" });
  if (result.error) throw result.error;
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function browserOpenerCommand(url: string): string[] {
  switch (process.platform) {
    case "darwin":
      return ["open", url];
    case "win32":
      return ["cmd", "/c", "start", "", url];
    default:
      return ["xdg-open", url];
  }
}

export function openUrl(url: string): boolean {
  return runCommand(browserOpenerCommand(url)).status === 0;
}

export const defaultSystemDeps: SystemDeps = { runCommand, openUrl };
