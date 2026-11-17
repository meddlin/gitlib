import fs from "node:fs";
import path from "node:path";
import { COMMUNITY_SCOPES, DEFAULT_COMMUNITY_SCOPE, parseCommunityScope, type CommunityScope } from "../lib/community";
import { getApp } from "./gitlib.server";

/**
 * Where the choice is kept: a small file in gitlib's home beside `ollama-connection.json`, so it is saved on the
 * server, applies in every browser, and is read by the background refresh even when no page is open.
 */
const scopeFile = (): string => path.join(getApp().config.appHome, "community-scope.json");

/** The saved choice; the default when nothing was saved or the file is unreadable (a bad file must not break scoring). */
export function readCommunityScope(): CommunityScope {
  try {
    const raw: unknown = JSON.parse(fs.readFileSync(scopeFile(), "utf-8"));
    return parseCommunityScope(raw && typeof raw === "object" ? (raw as Record<string, unknown>)["scope"] : undefined);
  } catch {
    return DEFAULT_COMMUNITY_SCOPE;
  }
}

export function writeCommunityScope(scope: CommunityScope): void {
  if (!COMMUNITY_SCOPES.includes(scope)) throw new Error("Invalid community score setting.");
  const file = scopeFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({ scope }, null, 2)}\n`, "utf-8");
}
