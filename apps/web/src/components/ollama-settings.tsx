import { useEffect, useId, useState } from "react";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { cn } from "#/lib/utils";
import { getChatStatus, saveOllamaConnection, type ChatStatus } from "#/server/chat";

const MODES = [
  { id: "local", label: "Local models", description: "Ollama running on this machine (http://127.0.0.1:11434)." },
  { id: "server", label: "Ollama server", description: "Ollama running on another machine, such as a homelab box." },
] as const;

type Mode = (typeof MODES)[number]["id"];

/** Settings for where the Ask panel finds Ollama: this machine, or a server at an address you type. */
export function OllamaSettings() {
  const hostId = useId();
  const [status, setStatus] = useState<ChatStatus | null>(null);
  const [mode, setMode] = useState<Mode>("local");
  const [host, setHost] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = (initial: boolean) =>
    getChatStatus().then((next) => {
      setStatus(next);
      if (initial) {
        setMode(next.mode);
        setHost(next.mode === "server" ? next.host : "");
      }
    });

  useEffect(() => {
    load(true).catch(() => setError("Could not read the current Ollama settings."));
  }, []);

  const save = async () => {
    setSaving(true);
    setError(null);
    setSaved(false);
    try {
      const result = await saveOllamaConnection({ data: { mode, host } });
      if (!result.ok) setError(result.error);
      else {
        setSaved(true);
        await load(false);
      }
    } catch {
      setError("Could not save. See the server log.");
    } finally {
      setSaving(false);
    }
  };

  const locked = status?.hostFromEnv ?? false;

  return (
    <section aria-labelledby="ollama-heading" className="flex flex-col gap-4">
      <div>
        <h2 id="ollama-heading" className="text-lg font-medium">
          Ollama
        </h2>
        <p className="text-sm text-muted-foreground">
          Where the Ask panel and Dependabot notes find their language model. Saved on the server, so it applies in every browser.
        </p>
      </div>

      <div role="radiogroup" aria-labelledby="ollama-heading" className="grid gap-3 sm:grid-cols-2">
        {MODES.map((option) => (
          <button
            key={option.id}
            type="button"
            role="radio"
            aria-checked={mode === option.id}
            disabled={locked}
            onClick={() => {
              setMode(option.id);
              setSaved(false);
            }}
            className={cn(
              "flex flex-col gap-1 rounded-xl border bg-card p-3 text-left text-card-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-60",
              mode === option.id && "border-primary ring-2 ring-primary/40",
            )}
          >
            <span className="text-sm font-medium">{option.label}</span>
            <span className="text-xs text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </div>

      {mode === "server" ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={hostId}>Server address</Label>
          <Input
            id={hostId}
            value={host}
            disabled={locked}
            placeholder="http://192.168.1.50:11434"
            onChange={(event) => {
              setHost(event.target.value);
              setSaved(false);
            }}
            autoComplete="off"
            spellCheck={false}
          />
          <p className="text-xs text-muted-foreground">
            On that machine Ollama must listen beyond loopback (OLLAMA_HOST=0.0.0.0:11434). Ollama has no login: keep it off the internet.
          </p>
        </div>
      ) : null}

      {locked ? (
        <p className="text-sm text-muted-foreground">GITLIB_OLLAMA_HOST is set to {status?.host}, so it can only be changed there.</p>
      ) : (
        <div className="flex items-center gap-3">
          <Button type="button" onClick={save} disabled={saving || (mode === "server" && !host.trim())}>
            {saving ? "Saving…" : "Save"}
          </Button>
          {saved ? <span className="text-sm text-muted-foreground">Saved.</span> : null}
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {status ? (
        <p className="text-sm text-muted-foreground" aria-live="polite">
          {!status.enabled
            ? "Chat is turned off (ollama.enabled = false in config.toml)."
            : status.reachable
              ? `Connected to ${status.host}: ${status.models.length} model${status.models.length === 1 ? "" : "s"} installed.`
              : `Cannot reach ${status.host}${status.error ? `: ${status.error}` : "."}`}
        </p>
      ) : null}
    </section>
  );
}
