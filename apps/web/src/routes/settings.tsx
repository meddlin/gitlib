import { createFileRoute } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { cn } from "#/lib/utils";
import { THEMES, useTheme, type ThemeId } from "#/lib/themes";

export const Route = createFileRoute("/settings")({
  head: () => ({ meta: [{ title: "Settings · Gitlib" }] }),
  component: Settings,
});

function Settings() {
  const [theme, setTheme] = useTheme();

  return (
    <div className="mx-auto flex w-full flex-1 max-w-3xl flex-col gap-8 px-4 py-8 sm:px-6">
      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
      </header>

      <section aria-labelledby="color-scheme-heading" className="flex flex-col gap-4">
        <div>
          <h2 id="color-scheme-heading" className="text-lg font-medium">
            Color scheme
          </h2>
          <p className="text-sm text-muted-foreground">
            Saved in this browser. System follows your operating system and updates when it changes.
          </p>
        </div>
        <div role="radiogroup" aria-labelledby="color-scheme-heading" className="grid gap-3 sm:grid-cols-2">
          {THEMES.map((option) => (
            <SchemeOption key={option.id} option={option} selected={theme === option.id} onSelect={setTheme} />
          ))}
        </div>
      </section>
    </div>
  );
}

function SchemeOption({
  option,
  selected,
  onSelect,
}: {
  option: (typeof THEMES)[number];
  selected: boolean;
  onSelect: (id: ThemeId) => void;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={selected}
      onClick={() => onSelect(option.id)}
      className={cn(
        "flex flex-col gap-3 rounded-xl border bg-card p-3 text-left text-card-foreground transition-colors outline-none hover:bg-accent/50 focus-visible:ring-[3px] focus-visible:ring-ring/50",
        selected && "border-primary ring-2 ring-primary/40",
      )}
    >
      {option.id === "system" ? (
        <div className="grid grid-cols-2 overflow-hidden rounded-md border">
          <Preview scheme="light" dark={false} className="rounded-none border-0" />
          <Preview scheme="dark" dark className="rounded-none border-0" />
        </div>
      ) : (
        <Preview scheme={option.id} dark={option.mode === "dark"} />
      )}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-sm font-medium">{option.label}</div>
          <div className="text-xs text-muted-foreground">{option.description}</div>
        </div>
        {selected ? <Check className="size-4 shrink-0 text-primary" aria-label="Selected" /> : null}
      </div>
    </button>
  );
}

/** A miniature card rendered with the scheme's real palette (palettes are scoped by [data-scheme]). */
function Preview({ scheme, dark, className }: { scheme: string; dark: boolean; className?: string }) {
  return (
    <div
      data-scheme={scheme}
      className={cn(
        "flex flex-col gap-1.5 rounded-md border bg-background p-2.5 text-foreground",
        dark && "dark",
        className,
      )}
      aria-hidden
    >
      <div className="h-2 w-2/3 rounded-full bg-foreground/80" />
      <div className="h-1.5 w-full rounded-full bg-muted-foreground/40" />
      <div className="flex items-center gap-1.5 pt-1">
        <div className="h-4 w-10 rounded-sm bg-primary" />
        <div className="h-4 w-8 rounded-sm border bg-secondary" />
        <div className="size-2.5 rounded-full bg-accent" />
      </div>
    </div>
  );
}
