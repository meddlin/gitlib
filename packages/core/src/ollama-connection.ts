import fs from "node:fs";
import path from "node:path";
import { DEFAULT_OLLAMA_HOST, type OllamaConnectionMode } from "./config.js";
import { GitLibError } from "./errors.js";

/** What the Settings page saves: use Ollama on this machine, or on another one at `host`. */
export interface OllamaConnection {
  mode: OllamaConnectionMode;
  /** The server's address; only used (and only kept) when `mode` is "server". */
  host: string | null;
}

export class OllamaConnectionError extends GitLibError {}

export function ollamaConnectionPath(appHome: string): string {
  return path.join(appHome, "ollama-connection.json");
}

/** Tidies a typed address into `http(s)://host[:port]`; throws an error fit to show beside the field. */
export function normalizeOllamaHost(input: string): string {
  const text = input.trim();
  if (!text) throw new OllamaConnectionError("Enter the address of your Ollama server, e.g. http://192.168.1.50:11434.");
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `http://${text}`);
  } catch {
    throw new OllamaConnectionError(`"${text}" is not a valid address. Try something like http://192.168.1.50:11434.`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new OllamaConnectionError("The address must start with http:// or https://.");
  }
  if (url.username || url.password) throw new OllamaConnectionError("Leave the username and password out of the address.");
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

/** The saved choice, or null if none was saved or the file is unreadable (a bad file must not break startup). */
export function readOllamaConnection(appHome: string): OllamaConnection | null {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(ollamaConnectionPath(appHome), "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    const { mode, host } = raw as Record<string, unknown>;
    if (mode === "local") return { mode, host: null };
    if (mode === "server" && typeof host === "string" && host) return { mode, host };
  } catch {
    // Missing or corrupt: fall back to the config file's host.
  }
  return null;
}

export function writeOllamaConnection(appHome: string, connection: OllamaConnection): void {
  fs.mkdirSync(appHome, { recursive: true });
  fs.writeFileSync(ollamaConnectionPath(appHome), `${JSON.stringify(connection, null, 2)}\n`, "utf-8");
}

/** The host a saved choice points at. */
export const hostFor = (connection: OllamaConnection): string =>
  connection.mode === "local" ? DEFAULT_OLLAMA_HOST : (connection.host ?? DEFAULT_OLLAMA_HOST);
