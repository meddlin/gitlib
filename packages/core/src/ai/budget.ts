import type { ChatMessage } from "./types.js";

/**
 * Ollama has no tokenizer endpoint, and when a prompt exceeds the context window it drops text without telling
 * the client, so the caller has to stay under the limit by estimating. Code and Markdown tokenise denser than
 * prose, so this is deliberately pessimistic.
 */
export const CHARS_PER_TOKEN = 3.5;
/** Role markers and separators the model's template adds around each message. */
const MESSAGE_OVERHEAD_TOKENS = 4;
/** Longest reply a chat turn may generate. */
export const MAX_REPLY_TOKENS = 1024;
/** Headroom for the estimate being wrong. */
const SAFETY_TOKENS = 256;
const MIN_PROMPT_TOKENS = 256;

export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN) + MESSAGE_OVERHEAD_TOKENS;

/** Tokens available to the prompt once room is kept for the reply. */
export const promptBudget = (numCtx: number): number => Math.max(MIN_PROMPT_TOKENS, numCtx - MAX_REPLY_TOKENS - SAFETY_TOKENS);

export interface FittedMessages {
  messages: ChatMessage[];
  /** Older turns left out to make room. */
  dropped: number;
  /** The newest message itself had to be cut. */
  truncated: boolean;
}

/**
 * Keeps system messages whole and as many of the newest turns as fit `budgetTokens`. The newest message is always
 * kept, cut if it alone is too long, so a question is never silently replaced by older chatter.
 */
export function fitMessages(messages: readonly ChatMessage[], budgetTokens: number): FittedMessages {
  const system = messages.filter((message) => message.role === "system");
  const turns = messages.filter((message) => message.role !== "system");
  let remaining = budgetTokens - system.reduce((sum, message) => sum + estimateTokens(message.content), 0);

  const kept: ChatMessage[] = [];
  let truncated = false;
  for (let index = turns.length - 1; index >= 0; index--) {
    const message = turns[index]!;
    const cost = estimateTokens(message.content);
    if (cost <= remaining) {
      kept.unshift(message);
      remaining -= cost;
      continue;
    }
    if (kept.length === 0) {
      // The newest message alone is too long: keep its beginning and say so.
      const room = Math.max(0, Math.floor((remaining - MESSAGE_OVERHEAD_TOKENS) * CHARS_PER_TOKEN));
      kept.unshift({ ...message, content: `${message.content.slice(0, room).trimEnd()} […cut to fit]` });
      truncated = true;
    }
    break;
  }

  // A reply with no question in front of it only confuses the model.
  while (kept.length > 1 && kept[0]!.role === "assistant") kept.shift();

  return { messages: [...system, ...kept], dropped: turns.length - kept.length, truncated };
}
