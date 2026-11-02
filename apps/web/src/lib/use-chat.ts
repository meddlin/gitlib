import { useCallback, useEffect, useRef, useState } from "react";
import { MAX_TURN_CHARS, MAX_TURNS, readStreamEvents, type ChatRequestBody } from "./chat-protocol";

export interface ChatMessageView {
  id: number;
  role: "user" | "assistant";
  content: string;
  /** Replies only: `stopped` is a reply the user cut short; its text so far is kept. */
  status: "streaming" | "done" | "stopped" | "error";
  error?: string;
  model?: string;
  /** Set when the server left something out to fit the model's context. */
  notice?: string;
}

export interface SendOptions {
  model: string | null;
  /** `relativePath` of the repository on screen, if any. */
  repo: string | null;
}

/** A failure whose message is already fit to show. */
class ChatFailure extends Error {}

function noticeFor(droppedMessages: number, truncated: boolean): string | undefined {
  if (truncated) return "Your message was too long for the model's context, so the end was cut off.";
  if (droppedMessages > 0) return "Older messages were left out to fit the model's context.";
  return undefined;
}

/**
 * One conversation with the model. The server holds no history: each request carries the finished turns, and the
 * server cuts them to fit. The list lives in a ref as well as in state so `send` never reads a stale copy.
 */
export function useChat() {
  const [messages, setMessages] = useState<ChatMessageView[]>([]);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<ChatMessageView[]>([]);
  const controllerRef = useRef<AbortController | null>(null);
  const nextId = useRef(1);

  const update = useCallback((change: (list: ChatMessageView[]) => ChatMessageView[]) => {
    listRef.current = change(listRef.current);
    setMessages(listRef.current);
  }, []);

  const patch = useCallback(
    (id: number, change: (message: ChatMessageView) => ChatMessageView) =>
      update((list) => list.map((message) => (message.id === id ? change(message) : message))),
    [update],
  );

  const send = useCallback(
    async (text: string, { model, repo }: SendOptions) => {
      const question = text.trim();
      if (!question || controllerRef.current) return;

      const finished = listRef.current
        .filter((message) => message.content && (message.status === "done" || message.status === "stopped"))
        .map((message) => ({ role: message.role, content: message.content.slice(0, MAX_TURN_CHARS) }));
      const turns = [...finished, { role: "user" as const, content: question }].slice(-MAX_TURNS);

      const replyId = nextId.current + 1;
      update((list) => [
        ...list,
        { id: nextId.current, role: "user", content: question, status: "done" },
        { id: replyId, role: "assistant", content: "", status: "streaming" },
      ]);
      nextId.current += 2;

      const controller = new AbortController();
      controllerRef.current = controller;
      setBusy(true);
      const body: ChatRequestBody = { messages: turns, ...(model ? { model } : {}), ...(repo ? { repo } : {}) };

      try {
        const response = await fetch("/api/chat", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
        if (!response.ok || !response.body) {
          const detail = (await response.json().catch(() => null)) as { error?: unknown } | null;
          throw new ChatFailure(typeof detail?.error === "string" ? detail.error : `The server answered ${response.status}.`);
        }

        let ended = false;
        for await (const event of readStreamEvents(response.body)) {
          if (event.type === "start") {
            patch(replyId, (message) => ({ ...message, model: event.model, notice: noticeFor(event.droppedMessages, event.truncated) }));
          } else if (event.type === "delta") {
            patch(replyId, (message) => ({ ...message, content: message.content + event.text }));
          } else if (event.type === "done") {
            ended = true;
            patch(replyId, (message) => ({ ...message, status: "done" }));
          } else {
            ended = true;
            patch(replyId, (message) => ({ ...message, status: "error", error: event.message }));
          }
        }
        if (!ended) throw new ChatFailure("The reply stopped before it was finished.");
      } catch (error) {
        if (controller.signal.aborted) {
          patch(replyId, (message) => ({ ...message, status: "stopped" }));
        } else {
          const reason = error instanceof ChatFailure ? error.message : "Lost the connection to gitlib.";
          patch(replyId, (message) => ({ ...message, status: "error", error: reason }));
        }
      } finally {
        controllerRef.current = null;
        setBusy(false);
      }
    },
    [patch, update],
  );

  /** Stops the reply in progress; the text so far stays. */
  const stop = useCallback(() => controllerRef.current?.abort(), []);

  /** Forgets the conversation, stopping any reply in progress. */
  const clear = useCallback(() => {
    controllerRef.current?.abort();
    update(() => []);
  }, [update]);

  useEffect(() => () => controllerRef.current?.abort(), []);

  return { messages, busy, send, stop, clear };
}
