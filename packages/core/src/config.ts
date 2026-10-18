import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { GitLibError } from "./errors.js";
import { expandUser, resolvePath } from "./fsutil.js";

export const DEFAULT_ROOTS = ["~/git"] as const;
export const DEFAULT_VSCODE_COMMAND = ["code", "--new-window"] as const;
export const DEFAULT_IGNORE_DIRS = [
  ".git",
  "node_modules",
  ".next",
  "dist",
  "build",
  "venv",
  "env",
  "obj",
  "bin",
  "lib",
  "include",
  ".pytest_cache",
] as const;

export class ConfigError extends GitLibError {}

export type Env = Readonly<Record<string, string | undefined>>;

export interface AppConfig {
  appHome: string;
  configPath: string;
  dbPath: string;
  roots: string[];
  vscodeCommand: string[];
  ignoreDirs: ReadonlySet<string>;
}

export function getAppHome(env: Env = process.env): string {
  const configured = env["GITLIB_HOME"];
  if (configured) return path.resolve(expandUser(configured));
  return path.join(os.homedir(), ".git-library");
}

function tomlList(values: readonly string[]): string {
  return values.map((value) => `  "${value}",`).join("\n");
}

function defaultConfigText(): string {
  return [
    "roots = [",
    tomlList(DEFAULT_ROOTS),
    "]",
    "",
    "vscode_command = [",
    tomlList(DEFAULT_VSCODE_COMMAND),
    "]",
    "",
    "ignore_dirs = [",
    tomlList(DEFAULT_IGNORE_DIRS),
    "]",
    "",
  ].join("\n");
}

function writeDefaultConfig(configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, defaultConfigText(), "utf-8");
}

function normalizeRoot(value: string, configPath: string): string {
  let target = expandUser(value);
  if (!path.isAbsolute(target)) target = path.resolve(path.dirname(configPath), target);
  return resolvePath(target);
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function loadConfig(env: Env = process.env): AppConfig {
  const appHome = getAppHome(env);
  const configPath = path.join(appHome, "config.toml");
  const dbPath = path.join(appHome, "gitlib.db");

  if (!fs.existsSync(configPath)) writeDefaultConfig(configPath);

  let data: Record<string, unknown>;
  try {
    data = parseToml(fs.readFileSync(configPath, "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`Unable to load config at ${configPath}: ${reason}`, { cause: error });
  }

  const rootsRaw = data["roots"] ?? [...DEFAULT_ROOTS];
  const vscodeCommandRaw = data["vscode_command"] ?? [...DEFAULT_VSCODE_COMMAND];
  const ignoreDirsRaw = data["ignore_dirs"] ?? [...DEFAULT_IGNORE_DIRS];

  if (!isStringList(rootsRaw)) {
    throw new ConfigError(`Config key 'roots' must be a list of strings in ${configPath}`);
  }
  if (!isStringList(vscodeCommandRaw) || vscodeCommandRaw.length === 0) {
    throw new ConfigError(
      `Config key 'vscode_command' must be a non-empty list of strings in ${configPath}`,
    );
  }
  if (!isStringList(ignoreDirsRaw)) {
    throw new ConfigError(`Config key 'ignore_dirs' must be a list of strings in ${configPath}`);
  }

  fs.mkdirSync(appHome, { recursive: true });

  return {
    appHome,
    configPath,
    dbPath,
    roots: rootsRaw.map((item) => normalizeRoot(item, configPath)),
    vscodeCommand: vscodeCommandRaw,
    ignoreDirs: new Set(ignoreDirsRaw),
  };
}
