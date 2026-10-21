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

export const DEFAULT_SEARCH_HOST = "http://127.0.0.1:7700";
export const DEFAULT_SEARCH_INDEX = "gitlib_repos";

export class ConfigError extends GitLibError {}

export type Env = Readonly<Record<string, string | undefined>>;

/** Where to find the Meilisearch server that backs full-text search. */
export interface SearchConfig {
  /** When false, Meilisearch is never contacted and search uses plain substring matching. */
  enabled: boolean;
  host: string;
  apiKey: string | null;
  indexName: string;
}

export interface AppConfig {
  appHome: string;
  configPath: string;
  dbPath: string;
  /** gitlib's own planning data; kept apart from `dbPath` because it cannot be rebuilt by rescanning. */
  planningDbPath: string;
  roots: string[];
  vscodeCommand: string[];
  ignoreDirs: ReadonlySet<string>;
  search: SearchConfig;
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

function loadSearchConfig(raw: unknown, env: Env, configPath: string): SearchConfig {
  if (raw !== undefined && (typeof raw !== "object" || raw === null || Array.isArray(raw))) {
    throw new ConfigError(`Config key 'search' must be a table in ${configPath}`);
  }
  const table = (raw ?? {}) as Record<string, unknown>;

  const string = (key: string): string | undefined => {
    const value = table[key];
    if (value === undefined) return undefined;
    if (typeof value !== "string") {
      throw new ConfigError(`Config key 'search.${key}' must be a string in ${configPath}`);
    }
    return value;
  };

  const enabled = table["enabled"] ?? true;
  if (typeof enabled !== "boolean") {
    throw new ConfigError(`Config key 'search.enabled' must be true or false in ${configPath}`);
  }

  const host = (env["GITLIB_MEILI_HOST"] || string("host") || DEFAULT_SEARCH_HOST).trim();
  const apiKey = (env["GITLIB_MEILI_API_KEY"] || string("api_key") || "").trim();
  const indexName = (string("index") || DEFAULT_SEARCH_INDEX).trim();

  return { enabled, host, apiKey: apiKey || null, indexName };
}

export function loadConfig(env: Env = process.env): AppConfig {
  const appHome = getAppHome(env);
  const configPath = path.join(appHome, "config.toml");
  const dbPath = path.join(appHome, "gitlib.db");
  const planningDbPath = path.join(appHome, "planning.db");

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
    planningDbPath,
    roots: rootsRaw.map((item) => normalizeRoot(item, configPath)),
    vscodeCommand: vscodeCommandRaw,
    ignoreDirs: new Set(ignoreDirsRaw),
    search: loadSearchConfig(data["search"], env, configPath),
  };
}
