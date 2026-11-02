import { GitLibError } from "../errors.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatRequest {
  messages: readonly ChatMessage[];
  model: string;
  /** Cap on generated tokens, so one reply cannot occupy the GPU for as long as it likes. */
  maxReplyTokens: number;
  /** Stops the request. A stopped chat ends quietly instead of throwing. */
  signal?: AbortSignal;
}

export type ChatEvent =
  | { type: "delta"; text: string }
  | {
      type: "done";
      /** Token counts as the server reports them; null when it does not say. */
      promptTokens: number | null;
      replyTokens: number | null;
      doneReason: string | null;
    };

/** The only thing the rest of gitlib knows about a language-model server. */
export interface ChatBackend {
  /** Human-readable location, used in error messages. */
  readonly label: string;
  /** Context window sent with every request; callers size prompts against it. */
  readonly numCtx: number;
  /** Streams a reply: any number of `delta` events, then one `done`. */
  chat(request: ChatRequest): AsyncGenerator<ChatEvent>;
  /** Installed model names, sorted. */
  listModels(signal?: AbortSignal): Promise<string[]>;
}

/** The model server is disabled, unreachable, or refused the request. The message is safe to show. */
export class LlmUnavailableError extends GitLibError {}
