import { createServerFn } from "@tanstack/react-start";
import { isGitLibError } from "@gitlib/core";
import { isRemoteSlug } from "../lib/chat-protocol";
import { getApp } from "./gitlib.server";
import { syncRemote, type RemoteSync } from "./repo-snapshot.server";

export type { RemoteSync } from "./repo-snapshot.server";

export interface ChatStatus {
  /** False when the config turns chat off; nothing else is filled in then. */
  enabled: boolean;
  host: string;
  /** "local" is Ollama on this machine, "server" one at another address. */
  mode: "local" | "server";
  /** True when GITLIB_OLLAMA_HOST pins the host, so the Settings page cannot change it. */
  hostFromEnv: boolean;
  numCtx: number;
  reachable: boolean;
  /** Installed models, sorted. */
  models: string[];
  /** The configured model if it is installed, else the first one. */
  defaultModel: string | null;
  /** Why chat cannot be used, in words fit for the panel. */
  error: string | null;
}

/** Whether the model server answers and what it has installed; asked each time the chat panel opens. */
export const getChatStatus = createServerFn({ method: "GET" }).handler(async (): Promise<ChatStatus> => {
  const app = getApp();
  const { host, model, numCtx, mode, hostFromEnv } = app.config.ollama;
  const base = { host, mode, hostFromEnv, numCtx, models: [], defaultModel: null };
  if (!app.chat) return { ...base, enabled: false, reachable: false, error: null };

  try {
    const models = await app.chat.listModels();
    const defaultModel = model && models.includes(model) ? model : (models[0] ?? null);
    const error =
      models.length === 0
        ? `No models are installed on Ollama at ${host}. Run \`ollama pull <model>\` on that machine.`
        : model && !models.includes(model)
          ? `The configured model "${model}" is not installed on Ollama at ${host}.`
          : null;
    return { ...base, enabled: true, reachable: true, models, defaultModel, error };
  } catch (error) {
    if (isGitLibError(error)) return { ...base, enabled: true, reachable: false, error: error.message };
    throw error;
  }
});

export interface OllamaConnectionInput {
  mode: "local" | "server";
  host?: string;
}

/** Saves where the chat panel finds Ollama; the result is the fresh status so Settings can show whether it answers. */
export const saveOllamaConnection = createServerFn({ method: "POST" })
  .validator((input: OllamaConnectionInput): OllamaConnectionInput => {
    if (!input || (input.mode !== "local" && input.mode !== "server")) throw new Error("Choose local or server.");
    return { mode: input.mode, host: typeof input.host === "string" ? input.host : undefined };
  })
  .handler(async ({ data }): Promise<{ ok: true } | { ok: false; error: string }> => {
    try {
      getApp().setOllamaConnection(data);
      return { ok: true };
    } catch (error) {
      if (isGitLibError(error)) return { ok: false, error: error.message };
      throw error;
    }
  });

/**
 * Fetches (if missing or old, or when `force`) what GitHub says about a repository that is not cloned, so the next
 * question about it answers at once. Only repositories the GitHub account lists are accepted.
 */
export const syncRemoteRepo = createServerFn({ method: "POST" })
  .validator((input: { slug: string; force?: boolean }): { slug: string; force: boolean } => {
    if (!input || !isRemoteSlug(input.slug)) throw new Error("Choose a GitHub repository as owner/repo.");
    return { slug: input.slug, force: input.force === true };
  })
  .handler(({ data }): Promise<RemoteSync> => syncRemote(data.slug, data.force));
