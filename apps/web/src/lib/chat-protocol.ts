/**
 * What the browser and the server say to each other over `POST /api/chat`. The request is JSON; the reply is
 * newline-delimited JSON, one event per line, so text can appear as it is generated.
 */

export const MAX_TURNS = 40;
export const MAX_TURN_CHARS = 8_000;
export const MAX_MODEL_NAME_CHARS = 120;
export const MAX_REPO_PATH_CHARS = 1_000;
/** Room for MAX_TURNS full turns, with multi-byte characters, and no more. */
export const MAX_BODY_BYTES = 400_000;

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export interface ChatRequestBody {
  /** The conversation so far, ending with the user's new question. The server adds its own system prompt. */
  messages: ChatTurn[];
  /** An installed model; the server's default when left out. */
  model?: string;
  /** `relativePath` of the repository the user is looking at. */
  repo?: string;
}

export type ChatStreamEvent =
  | { type: "start"; model: string; droppedMessages: number; truncated: boolean }
  | { type: "delta"; text: string }
  | { type: "done"; promptTokens: number | null; replyTokens: number | null; doneReason: string | null }
  | { type: "error"; message: string };

export type Parsed<T> = { ok: true; value: T } | { ok: false; error: string };

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]*$/;

/** Checks an untrusted request body. Only `user` and `assistant` turns are accepted: the system prompt is the server's. */
export function parseChatRequest(input: unknown): Parsed<ChatRequestBody> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return { ok: false, error: "Send a JSON object." };
  const { messages, model, repo } = input as Record<string, unknown>;

  if (!Array.isArray(messages) || messages.length === 0) return { ok: false, error: "messages must be a non-empty list." };
  if (messages.length > MAX_TURNS) return { ok: false, error: `messages can hold at most ${MAX_TURNS} turns.` };

  const turns: ChatTurn[] = [];
  for (const [index, message] of messages.entries()) {
    const { role, content } = (message ?? {}) as Record<string, unknown>;
    if (role !== "user" && role !== "assistant") return { ok: false, error: `messages[${index}].role must be "user" or "assistant".` };
    if (typeof content !== "string" || !content.trim()) return { ok: false, error: `messages[${index}].content must be non-empty text.` };
    if (content.length > MAX_TURN_CHARS) return { ok: false, error: `messages[${index}].content is longer than ${MAX_TURN_CHARS} characters.` };
    turns.push({ role, content });
  }
  if (turns[turns.length - 1]!.role !== "user") return { ok: false, error: "The last message must be from the user." };

  const value: ChatRequestBody = { messages: turns };
  if (model !== undefined) {
    if (typeof model !== "string" || model.length > MAX_MODEL_NAME_CHARS || !MODEL_NAME.test(model)) {
      return { ok: false, error: "model is not a valid model name." };
    }
    value.model = model;
  }
  if (repo !== undefined) {
    if (typeof repo !== "string" || !repo || repo.length > MAX_REPO_PATH_CHARS) return { ok: false, error: "repo must be a repository path." };
    value.repo = repo;
  }
  return { ok: true, value };
}

const numberOrNull = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

/** One line of the reply, or null if it is not an event this version knows. */
export function parseStreamEvent(line: string): ChatStreamEvent | null {
  let data: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return null;
    data = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (data["type"]) {
    case "start":
      return typeof data["model"] === "string"
        ? { type: "start", model: data["model"], droppedMessages: numberOrNull(data["droppedMessages"]) ?? 0, truncated: data["truncated"] === true }
        : null;
    case "delta":
      return typeof data["text"] === "string" ? { type: "delta", text: data["text"] } : null;
    case "done":
      return {
        type: "done",
        promptTokens: numberOrNull(data["promptTokens"]),
        replyTokens: numberOrNull(data["replyTokens"]),
        doneReason: typeof data["doneReason"] === "string" ? data["doneReason"] : null,
      };
    case "error":
      return typeof data["message"] === "string" ? { type: "error", message: data["message"] } : null;
    default:
      return null;
  }
}

/** Reads a streamed reply event by event, however the network cut it into chunks. */
export async function* readStreamEvents(body: ReadableStream<Uint8Array>): AsyncGenerator<ChatStreamEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      for (let newline = buffer.indexOf("\n"); newline >= 0; newline = buffer.indexOf("\n")) {
        const event = parseStreamEvent(buffer.slice(0, newline).trim());
        buffer = buffer.slice(newline + 1);
        if (event) yield event;
      }
    }
    buffer += decoder.decode();
    const last = buffer.trim() ? parseStreamEvent(buffer.trim()) : null;
    if (last) yield last;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}
