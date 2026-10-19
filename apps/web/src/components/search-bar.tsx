import { Loader2, Search, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { Input } from "#/components/ui/input";

const DEBOUNCE_MS = 200;

/**
 * Search box pinned to the top of the page. `value` is the committed query (from the URL);
 * edits are debounced into `onChange`, and "/" focuses the box from anywhere on the page.
 */
export function SearchBar({
  value,
  onChange,
  busy,
}: {
  value: string;
  onChange: (next: string) => void;
  busy: boolean;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // The last query we sent up. `value` lags behind it while a search is in flight, and must not
  // overwrite what the user has typed since.
  const emitted = useRef(value);

  const emit = (next: string) => {
    emitted.current = next;
    onChange(next);
  };

  // Follow changes that did not come from this box (e.g. "Clear filters").
  useEffect(() => {
    if (value !== emitted.current) {
      emitted.current = value;
      setDraft(value);
    }
  }, [value]);

  useEffect(() => {
    if (draft === emitted.current) return;
    const timer = setTimeout(() => emit(draft), DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [draft]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      const typing = target && (target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName));
      if (event.key === "/" && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) {
        event.preventDefault();
        inputRef.current?.focus();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <div className="sticky top-0 z-20 border-b bg-background/85 backdrop-blur supports-[backdrop-filter]:bg-background/70">
      <div className="mx-auto max-w-6xl px-4 py-3 sm:px-6">
        <form role="search" className="relative" onSubmit={(event) => {
            event.preventDefault();
            emit(draft);
          }}>
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            ref={inputRef}
            type="search"
            name="q"
            autoComplete="off"
            placeholder="Search repositories, READMEs and notes  ( / )"
            aria-label="Search repositories"
            className="h-10 pr-10 pl-9 [&::-webkit-search-cancel-button]:hidden"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                setDraft("");
                emit("");
              }
            }}
          />
          <div className="absolute top-1/2 right-3 -translate-y-1/2 text-muted-foreground">
            {busy ? (
              <Loader2 className="size-4 animate-spin" aria-label="Searching" />
            ) : draft ? (
              <button
                type="button"
                aria-label="Clear search"
                className="rounded-sm hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                onClick={() => {
                  setDraft("");
                  emit("");
                  inputRef.current?.focus();
                }}
              >
                <X className="size-4" />
              </button>
            ) : null}
          </div>
        </form>
      </div>
    </div>
  );
}
