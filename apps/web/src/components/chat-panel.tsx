import { useMatch } from "@tanstack/react-router";
import { RefreshCw, Send, Square, Trash2, TriangleAlert } from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { MarkdownBody } from "#/components/markdown-body";
import { Button } from "#/components/ui/button";
import { RelativeTime } from "#/components/relative-time";
import { NativeSelect } from "#/components/ui/native-select";
import { SearchSelect, type SearchSelectOption } from "#/components/ui/search-select";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "#/components/ui/sheet";
import { Textarea } from "#/components/ui/textarea";
import { MAX_TURN_CHARS } from "#/lib/chat-protocol";
import { useChat, type ChatMessageView } from "#/lib/use-chat";
import { getCatalog } from "#/server/catalog";
import { getChatStatus, syncRemoteRepo, type ChatStatus, type RemoteSync } from "#/server/chat";

const MODEL_KEY = "gitlib:chat-model";

function readStoredModel(): string | null {
  try {
    return localStorage.getItem(MODEL_KEY);
  } catch {
    return null; // private windows and blocked storage: the server's default is fine
  }
}

function storeModel(name: string): void {
  try {
    localStorage.setItem(MODEL_KEY, name);
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

type StatusState = { state: "loading" } | { state: "ready"; status: ChatStatus } | { state: "failed"; message: string };

/** Asks the server whether Ollama answers each time the panel opens, keeping the last answer on screen meanwhile. */
function useChatStatus(open: boolean) {
  const [result, setResult] = useState<StatusState>({ state: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    getChatStatus()
      .then((status) => !cancelled && setResult({ state: "ready", status }))
      .catch((error: unknown) => {
        if (!cancelled) setResult({ state: "failed", message: error instanceof Error ? error.message : "Could not check Ollama." });
      });
    return () => {
      cancelled = true;
    };
  }, [open, attempt]);

  return { result, retry: () => setAttempt((count) => count + 1) };
}

/** What the next question is about: everything, a cloned repository, or a GitHub repository that is not cloned. */
type Scope = { kind: "all" } | { kind: "local"; path: string } | { kind: "remote"; slug: string };

const ALL_VALUE = "all";

const scopeValue = (scope: Scope): string =>
  scope.kind === "all" ? ALL_VALUE : scope.kind === "local" ? `local:${scope.path}` : `remote:${scope.slug}`;

function scopeFromValue(value: string): Scope {
  if (value.startsWith("local:")) return { kind: "local", path: value.slice("local:".length) };
  if (value.startsWith("remote:")) return { kind: "remote", slug: value.slice("remote:".length) };
  return { kind: "all" };
}

function scopeLabel(scope: Scope): string {
  if (scope.kind === "all") return "All repositories";
  if (scope.kind === "local") return scope.path.split("/").pop() || scope.path;
  return `${scope.slug} (GitHub)`;
}

/** Every repository the chat can be pointed at: cloned ones, and GitHub ones that are not cloned. Loaded once, when the panel first opens. */
function useScopeOptions(open: boolean): SearchSelectOption[] {
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof getCatalog>>["entries"] | null>(null);
  useEffect(() => {
    if (!open || entries) return;
    let cancelled = false;
    getCatalog()
      .then((catalog) => !cancelled && setEntries(catalog.entries))
      .catch(() => !cancelled && setEntries([])); // the picker still offers "All repositories"
    return () => {
      cancelled = true;
    };
  }, [open, entries]);

  return useMemo(
    () => [
      { value: ALL_VALUE, label: "All repositories" },
      ...(entries ?? []).flatMap((entry): SearchSelectOption[] => {
        const local = entry.locals[0];
        if (local) return [{ value: scopeValue({ kind: "local", path: local }), label: entry.fullName }];
        if (entry.github?.listed) return [{ value: scopeValue({ kind: "remote", slug: entry.github.fullName }), label: `${entry.github.fullName} (GitHub only)` }];
        return [];
      }),
    ],
    [entries],
  );
}

type SyncState = ({ state: "loading" } | ({ state: "done" } & RemoteSync)) & { slug: string };

/** Fetches what GitHub says about the picked repository, so the first question about it is not slowed down. */
function useRemoteSync(slug: string | null) {
  const [sync, setSync] = useState<SyncState | null>(null);

  function run(target: string, force: boolean) {
    setSync({ slug: target, state: "loading" });
    syncRemoteRepo({ data: { slug: target, force } })
      .then((result) => setSync((current) => (current?.slug === target ? { slug: target, state: "done", ...result } : current)))
      .catch((error: unknown) =>
        setSync((current) =>
          current?.slug === target
            ? { slug: target, state: "done", fetchedAt: null, error: error instanceof Error ? error.message : "Could not reach GitHub." }
            : current,
        ),
      );
  }

  useEffect(() => {
    if (slug) run(slug, false);
    else setSync(null);
  }, [slug]);

  return { sync: sync && sync.slug === slug ? sync : null, refresh: () => slug && run(slug, true) };
}

function RemoteStatus({ sync, refresh, disabled }: { sync: SyncState | null; refresh: () => void; disabled: boolean }) {
  if (!sync || sync.state === "loading") return <p className="text-xs text-muted-foreground">Fetching details from GitHub…</p>;
  return (
    <div className="space-y-1 text-xs text-muted-foreground">
      <p className="flex flex-wrap items-center gap-x-2">
        {sync.fetchedAt ? (
          <span>
            Details from GitHub, <RelativeTime iso={sync.fetchedAt} />
          </span>
        ) : (
          <span>No details from GitHub yet.</span>
        )}
        <Button type="button" variant="ghost" size="xs" onClick={refresh} disabled={disabled} className="h-5 px-1.5">
          <RefreshCw /> Refresh
        </Button>
      </p>
      {sync.error && (
        <p role="alert" className="text-destructive">
          {sync.error}
        </p>
      )}
    </div>
  );
}

const Message = memo(function Message({ message }: { message: ChatMessageView }) {
  if (message.role === "user") {
    return (
      <div className="ml-auto max-w-[85%] rounded-lg bg-primary px-3 py-2 text-sm break-words whitespace-pre-wrap text-primary-foreground">
        {message.content}
      </div>
    );
  }
  return (
    <div className="max-w-full">
      <div className="rounded-lg bg-muted px-3 py-2 text-sm break-words [&_pre]:overflow-x-auto">
        {message.content ? (
          <MarkdownBody untrusted>{message.content}</MarkdownBody>
        ) : message.status === "streaming" ? (
          <span className="animate-pulse text-muted-foreground">Thinking…</span>
        ) : null}
        {message.status === "stopped" && <p className="mt-1 text-xs text-muted-foreground">Stopped.</p>}
        {message.status === "error" && (
          <p role="alert" className="mt-2 flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            <span>{message.error}</span>
          </p>
        )}
      </div>
      {message.notice && <p className="mt-1 px-1 text-xs text-muted-foreground">{message.notice}</p>}
      {message.model && message.status !== "streaming" && <p className="mt-1 px-1 text-xs text-muted-foreground">{message.model}</p>}
    </div>
  );
});

const LIBRARY_QUESTIONS = ["Which of my repos use TypeScript?", "Which repos have no description?", "What are my favorites?"];
const REPO_QUESTIONS = ["What is this repo for?", "How do I run it?", "Summarize my notes on it."];
const REMOTE_QUESTIONS = ["What can you tell me about the repo composition?", "What is this repo for?", "What is at the top level of the repo?"];

/** Why the composer is off, or null when chat is ready. */
function Banner({ result, retry }: { result: StatusState; retry: () => void }) {
  let message: string | null = null;
  let hint: string | null = null;
  let canRetry = true;

  if (result.state === "loading") {
    message = "Checking Ollama…";
    canRetry = false;
  } else if (result.state === "failed") {
    message = result.message;
  } else if (!result.status.enabled) {
    message = "Chat is turned off. Set `enabled = true` under [ollama] in config.toml to use it.";
    canRetry = false;
  } else if (!result.status.reachable) {
    message = result.status.error;
    hint = "Set GITLIB_OLLAMA_HOST to your Ollama server's address. Inside Docker, localhost is the container itself.";
  } else {
    message = result.status.error;
  }
  if (!message) return null;

  return (
    <div role="status" className="border-b bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
      <p>{message}</p>
      {hint && <p className="mt-1">{hint}</p>}
      {canRetry && (
        <Button type="button" variant="outline" size="xs" className="mt-2" onClick={retry}>
          <RefreshCw /> Try again
        </Button>
      )}
    </div>
  );
}

/** The slide-out chat: questions about your repositories, answered by the model on your Ollama server. */
export function ChatPanel({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { result, retry } = useChatStatus(open);
  const status = result.state === "ready" ? result.status : null;
  // On a repository's page the answers can use its notes and README, unless another scope is picked.
  const routeRepo = useMatch({ from: "/repos/$", shouldThrow: false })?.params._splat || null;
  const [picked, setPicked] = useState<Scope | null>(null);
  // Going to another page puts the scope back to what that page is about.
  useEffect(() => setPicked(null), [routeRepo]);
  const scope: Scope = picked ?? (routeRepo ? { kind: "local", path: routeRepo } : { kind: "all" });
  const repo = scope.kind === "local" ? scope.path : null;
  const remote = scope.kind === "remote" ? scope.slug : null;
  const scoped = repo !== null || remote !== null;
  const scopeOptions = useScopeOptions(open);
  const remoteSync = useRemoteSync(remote);

  const chat = useChat();
  const [draft, setDraft] = useState("");
  const [chosen, setChosen] = useState<string | null>(null);
  useEffect(() => setChosen(readStoredModel()), []);
  const model = status && chosen && status.models.includes(chosen) ? chosen : (status?.defaultModel ?? null);
  const ready = !!status && status.enabled && status.reachable && status.models.length > 0 && !!model;

  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const stuckToBottom = useRef(true);

  // Follow the reply as it grows, unless the reader has scrolled up to look at something.
  useEffect(() => {
    const list = listRef.current;
    if (list && stuckToBottom.current) list.scrollTop = list.scrollHeight;
  }, [chat.messages, open]);

  function submit(text: string) {
    const question = text.trim();
    if (!ready || chat.busy || !question) return;
    setDraft("");
    stuckToBottom.current = true;
    void chat.send(question, { model, repo, remote });
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      submit(draft);
    }
  }

  const questions = remote ? REMOTE_QUESTIONS : repo ? REPO_QUESTIONS : LIBRARY_QUESTIONS;

  return (
    <Sheet open={open} onOpenChange={onOpenChange} modal={false}>
      <SheetContent
        // A click on the page behind must not close it: the panel is meant to stay beside what you are reading.
        onInteractOutside={(event) => event.preventDefault()}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          inputRef.current?.focus();
        }}
      >
        <SheetHeader className="gap-2 border-b p-3 pr-10">
          <div className="flex items-center gap-2">
            <SheetTitle className="text-sm">Ask Gitlib</SheetTitle>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="ml-auto"
              onClick={chat.clear}
              disabled={chat.messages.length === 0}
              aria-label="Clear conversation"
              title="Clear conversation"
            >
              <Trash2 />
            </Button>
          </div>
          <SheetDescription className="sr-only">Ask a local model questions about your repositories.</SheetDescription>
          <SearchSelect
            aria-label="Repository to ask about"
            className="h-8 text-xs"
            options={scopeOptions}
            placeholder={scopeLabel(scope)}
            searchPlaceholder="Find a repository…"
            onSelect={(value) => setPicked(scopeFromValue(value))}
          />
          {remote && <RemoteStatus sync={remoteSync.sync} refresh={remoteSync.refresh} disabled={chat.busy || remoteSync.sync?.state === "loading"} />}
          {status && status.models.length > 0 && (
            <NativeSelect
              aria-label="Model"
              className="h-8 text-xs"
              value={model ?? ""}
              disabled={chat.busy}
              onChange={(event) => {
                setChosen(event.target.value);
                storeModel(event.target.value);
              }}
            >
              {status.models.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          )}
        </SheetHeader>

        {!ready && <Banner result={result} retry={retry} />}

        <div
          ref={listRef}
          onScroll={(event) => {
            const list = event.currentTarget;
            stuckToBottom.current = list.scrollHeight - list.scrollTop - list.clientHeight < 48;
          }}
          className="flex-1 space-y-3 overflow-y-auto p-3"
        >
          {chat.messages.length === 0 && ready && (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">
                {scoped ? "Ask about this repository, or about your library." : "Ask about your repositories."}{" "}
                {remote
                  ? "This one is not cloned, so answers use what GitHub reports: description, languages, top-level files and README."
                  : "Answers use only what Gitlib knows: names, technologies, descriptions, notes and READMEs."}
              </p>
              <div className="flex flex-wrap gap-2">
                {questions.map((question) => (
                  <Button key={question} type="button" variant="outline" size="xs" onClick={() => submit(question)}>
                    {question}
                  </Button>
                ))}
              </div>
            </div>
          )}
          {chat.messages.map((message) => (
            <Message key={message.id} message={message} />
          ))}
          <p className="sr-only" aria-live="polite">
            {chat.busy ? "Waiting for a reply" : chat.messages.length > 0 ? "Reply finished" : ""}
          </p>
        </div>

        <form
          onSubmit={(event: FormEvent) => {
            event.preventDefault();
            submit(draft);
          }}
          className="border-t p-3"
        >
          <div className="flex items-end gap-2">
            <Textarea
              ref={inputRef}
              rows={1}
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
              disabled={!ready}
              maxLength={MAX_TURN_CHARS}
              aria-label="Your question"
              placeholder={scoped ? "Ask about this repo…" : "Ask about your repositories…"}
              className="max-h-40 min-h-9 resize-none"
            />
            {chat.busy ? (
              <Button type="button" variant="outline" size="icon" onClick={chat.stop} aria-label="Stop" title="Stop">
                <Square />
              </Button>
            ) : (
              <Button type="submit" size="icon" disabled={!ready || !draft.trim()} aria-label="Send" title="Send">
                <Send />
              </Button>
            )}
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Runs on {status?.host ?? "your Ollama server"}. Answers can be wrong.
          </p>
        </form>
      </SheetContent>
    </Sheet>
  );
}
