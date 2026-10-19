import type { TechnologyCategory } from "@gitlib/core";
import { cn } from "#/lib/utils";

const CATEGORY_DOT: Record<TechnologyCategory, string> = {
  language: "bg-tech-language",
  framework: "bg-tech-framework",
  runtime: "bg-tech-runtime",
  tooling: "bg-tech-tooling",
};

const CATEGORY_TEXT: Record<TechnologyCategory, string> = {
  language: "text-tech-language",
  framework: "text-tech-framework",
  runtime: "text-tech-runtime",
  tooling: "text-muted-foreground",
};

export const CATEGORY_LABELS: Record<TechnologyCategory, string> = {
  language: "Language",
  framework: "Framework",
  runtime: "Runtime",
  tooling: "Tooling",
};

/** Flat technology label: a coloured dot for its category followed by the name. */
export function TechBadge({
  name,
  category,
  active = false,
  className,
}: {
  name: string;
  category: TechnologyCategory;
  active?: boolean;
  className?: string;
}) {
  return (
    <span
      title={CATEGORY_LABELS[category]}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs whitespace-nowrap",
        CATEGORY_TEXT[category],
        // Languages and frameworks are the "key" stack, so they get more weight.
        (category === "language" || category === "framework") && "font-semibold",
        active && "underline decoration-current underline-offset-4",
        className,
      )}
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", CATEGORY_DOT[category])} />
      {name}
    </span>
  );
}
