import { MAX_REPLY_TOKENS, fitMessages, isGitLibError, promptBudget, type GitLibApp } from "@gitlib/core";
import { MAX_BODY_BYTES, parseChatRequest, type ChatStreamEvent } from "../lib/chat-protocol";
import { getApp } from "./gitlib.server";
import type { RemoteChatSource } from "./repo-snapshot.server";

const jsonError = (status: number, error: string): Response => Response.json({ error }, { status });

/** The request body as text, or null if it is longer than `limit` bytes (a lying Content-Length does not help). */
async function readLimited(request: Request, limit: number): Promise<string | null> {
  if (Number(request.headers.get("content-length") ?? 0) > limit) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * `POST /api/chat`: answers the conversation with the configured model and streams the reply as NDJSON events
 * (see `lib/chat-protocol.ts`). Everything the model sees besides the user's turns is built here, from data
 * gitlib already holds, and is cut to fit the context window before it is sent. `remote` supplies the GitHub-only
 * repositories (their list, and the details of one the user picked); without it the chat knows only cloned repos.
 */
export async function handleChat(request: Request, app: GitLibApp = getApp(), remote?: RemoteChatSource): Promise<Response> {
  const backend = app.chat;
  if (!backend) return jsonError(503, "Chat is turned off (ollama.enabled = false in config.toml).");

  // A cross-site form cannot send this content type without a preflight, which this server never approves.
  if (!/^application\/json\b/i.test(request.headers.get("content-type") ?? "")) return jsonError(415, "Send JSON.");

  const text = await readLimited(request, MAX_BODY_BYTES);
  if (text === null) return jsonError(413, "That conversation is too long to send.");
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return jsonError(400, "The request is not valid JSON.");
  }
  const parsed = parseChatRequest(input);
  if (!parsed.ok) return jsonError(400, parsed.error);
  const { messages, model: requestedModel, repo, remote: remoteSlug } = parsed.value;
  if (remoteSlug && !remote) return jsonError(400, "GitHub repositories are not available to the chat here.");

  let systemPrompt: string;
  try {
    const remoteRepositories = remote ? await remote.list().catch(() => []) : [];
    const remoteContext = remote && remoteSlug ? await remote.resolve(remoteSlug) : null;
    systemPrompt = app.chatSystemPrompt(repo ?? null, { remote: remoteContext, remoteRepositories });
  } catch (error) {
    // `isGitLibError`, not `instanceof`: the dev server can hold two copies of core, and a class check then fails.
    if (isGitLibError(error)) return jsonError(400, error.message);
    throw error;
  }

  let model = requestedModel ?? app.config.ollama.model;
  if (!model) {
    try {
      model = (await backend.listModels(request.signal))[0] ?? null;
    } catch (error) {
      if (isGitLibError(error)) return jsonError(503, error.message);
      throw error;
    }
    if (!model) return jsonError(503, `No models are installed on Ollama at ${backend.label}. Run \`ollama pull <model>\` on that machine.`);
  }

  const fitted = fitMessages([{ role: "system", content: systemPrompt }, ...messages], promptBudget(backend.numCtx));

  // Either end can stop the reply: the browser disconnecting (request.signal) or the stream being cancelled.
  const stop = new AbortController();
  request.signal.addEventListener("abort", () => stop.abort(), { once: true });
  const encoder = new TextEncoder();
  let open = true;

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: ChatStreamEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`${JSON.stringify(event)}\n`));
        } catch {
          open = false;
        }
      };
      // One model request at a time: this waits for the lane, and tells background work (the Dependabot notes) to step aside.
      const ticket = await app.modelLane.acquire("chat", stop.signal);
      if (!ticket) {
        open = false;
        try {
          controller.close();
        } catch {
          // Already closed because the browser went away.
        }
        return;
      }
      send({ type: "start", model: model!, droppedMessages: fitted.dropped, truncated: fitted.truncated });
      try {
        for await (const event of backend.chat({ model: model!, messages: fitted.messages, maxReplyTokens: MAX_REPLY_TOKENS, signal: stop.signal })) {
          send(event);
        }
      } catch (error) {
        // A GitLibError's message is written to be shown; anything else may leak internals, so it stays in the log.
        if (!isGitLibError(error)) console.error("Chat failed:", error);
        send({ type: "error", message: isGitLibError(error) ? error.message : "The chat failed unexpectedly. See the server log." });
      } finally {
        ticket.release();
        if (open) {
          open = false;
          try {
            controller.close();
          } catch {
            // Already closed because the browser went away.
          }
        }
      }
    },
    cancel() {
      open = false;
      stop.abort();
    },
  });

  return new Response(body, {
    headers: {
      "content-type": "application/x-ndjson; charset=utf-8",
      "cache-control": "no-store",
      // Tells nginx not to hold the reply back until it is complete (docs/ollama-integration.md).
      "x-accel-buffering": "no",
    },
  });
}
