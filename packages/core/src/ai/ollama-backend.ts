import type { OllamaConfig } from "../config.js";
import { LlmUnavailableError, type ChatBackend, type ChatEvent, type ChatRequest } from "./types.js";

const LIST_TIMEOUT_MS = 5_000;
/**
 * Longest silence tolerated while waiting for the server. A model can take a while to load before its first
 * token, so this is generous; the clock restarts with every chunk, so a long reply is never cut off.
 */
export const DEFAULT_STALL_TIMEOUT_MS = 120_000;

export interface OllamaBackendOptions {
  fetch?: typeof fetch;
  stallTimeoutMs?: number;
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** Why a `fetch` failed, in words: undici hides the useful part (ECONNREFUSED, ENOTFOUND, ...) in `cause`. */
function describeFetchError(error: unknown): string {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined;
  if (typeof cause?.code === "string") return cause.code;
  if (typeof cause?.message === "string") return cause.message;
  return error instanceof Error ? error.message : String(error);
}

/** Talks to Ollama's native `/api/chat` and `/api/tags` over plain `fetch`; see docs/ollama-integration.md. */
export class OllamaBackend implements ChatBackend {
  readonly label: string;
  readonly numCtx: number;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly stallTimeoutMs: number;

  constructor(config: Pick<OllamaConfig, "host" | "numCtx">, options: OllamaBackendOptions = {}) {
    this.label = config.host;
    this.baseUrl = config.host;
    this.numCtx = config.numCtx;
    this.fetchImpl = options.fetch ?? fetch;
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
  }

  async listModels(signal?: AbortSignal): Promise<string[]> {
    const timeout = AbortSignal.timeout(LIST_TIMEOUT_MS);
    try {
      const response = await this.send("/api/tags", { method: "GET", signal: signal ? AbortSignal.any([signal, timeout]) : timeout });
      const body = (await response.json().catch(() => null)) as { models?: { name?: unknown }[] } | null;
      return (body?.models ?? [])
        .flatMap((model) => (typeof model.name === "string" ? [model.name] : []))
        .sort((a, b) => a.localeCompare(b));
    } catch (error) {
      if (timeout.aborted && !signal?.aborted) {
        throw new LlmUnavailableError(`Ollama at ${this.label} did not answer within ${LIST_TIMEOUT_MS / 1000} seconds.`, { cause: error });
      }
      throw error;
    }
  }

  async *chat(request: ChatRequest): AsyncGenerator<ChatEvent> {
    const stalled = new AbortController();
    const signal = request.signal ? AbortSignal.any([request.signal, stalled.signal]) : stalled.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const armStallTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => stalled.abort(), this.stallTimeoutMs);
    };

    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      armStallTimer();
      const response = await this.send("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          options: { num_ctx: this.numCtx, num_predict: request.maxReplyTokens },
        }),
        signal,
      });
      if (!response.body) throw new LlmUnavailableError(`Ollama at ${this.label} sent an empty response.`);
      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armStallTimer();
        buffer += decoder.decode(value, { stream: true });
        for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          for (const event of this.parseLine(line)) {
            if (event.type === "done") finished = true;
            yield event;
          }
        }
      }
      buffer += decoder.decode();
      if (buffer.trim()) {
        for (const event of this.parseLine(buffer.trim())) {
          if (event.type === "done") finished = true;
          yield event;
        }
      }
      if (!finished) throw new LlmUnavailableError(`Ollama at ${this.label} closed the connection before the reply was finished.`);
    } catch (error) {
      if (request.signal?.aborted) return;
      if (stalled.signal.aborted) {
        const seconds = Math.max(1, Math.round(this.stallTimeoutMs / 1000));
        throw new LlmUnavailableError(
          `Ollama at ${this.label} sent nothing for ${seconds} second${seconds === 1 ? "" : "s"}.`,
          { cause: error },
        );
      }
      throw error;
    } finally {
      clearTimeout(timer);
      await reader?.cancel().catch(() => undefined);
    }
  }

  /** One NDJSON line from `/api/chat`: some text, the final summary, or an error the server reports mid-stream. */
  private parseLine(line: string): ChatEvent[] {
    let data: { message?: { content?: unknown }; error?: unknown; done?: unknown; done_reason?: unknown; prompt_eval_count?: unknown; eval_count?: unknown };
    try {
      data = JSON.parse(line);
    } catch {
      throw new LlmUnavailableError(`Ollama at ${this.label} sent a reply gitlib could not read.`);
    }
    if (typeof data.error === "string") throw new LlmUnavailableError(data.error);

    const events: ChatEvent[] = [];
    const text = data.message?.content;
    if (typeof text === "string" && text) events.push({ type: "delta", text });
    if (data.done === true) {
      events.push({
        type: "done",
        promptTokens: numberOrNull(data.prompt_eval_count),
        replyTokens: numberOrNull(data.eval_count),
        doneReason: typeof data.done_reason === "string" ? data.done_reason : null,
      });
    }
    return events;
  }

  /** `fetch` that turns "nobody answered" and HTTP errors into messages worth showing. */
  private async send(path: string, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, init);
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new LlmUnavailableError(`Cannot reach Ollama at ${this.label}: ${describeFetchError(error)}`, { cause: error });
    }
    if (response.ok) return response;

    const text = await response.text().catch(() => "");
    let detail = text.trim();
    try {
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
    } catch {
      // Not JSON (a proxy's error page, say): the raw text is the best explanation there is.
    }
    if (response.status === 503) throw new LlmUnavailableError(`Ollama at ${this.label} is busy. Try again in a moment.`);
    throw new LlmUnavailableError(`Ollama at ${this.label} answered ${response.status}${detail ? `: ${detail.slice(0, 300)}` : "."}`);
  }
}
