import { createServerFn } from "@tanstack/react-start";
import { isGitLibError } from "@gitlib/core";
import { getApp } from "./gitlib.server";

export interface ChatStatus {
  /** False when the config turns chat off; nothing else is filled in then. */
  enabled: boolean;
  host: string;
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
  const { host, model, numCtx } = app.config.ollama;
  const base = { host, numCtx, models: [], defaultModel: null };
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
