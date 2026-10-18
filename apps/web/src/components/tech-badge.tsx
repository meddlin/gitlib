import type { TechnologyCategory } from "@gitlib/core";
import { Badge } from "#/components/ui/badge";
import { cn } from "#/lib/utils";

const CATEGORY_STYLES: Record<TechnologyCategory, string> = {
  language: "border-tech-language/40 bg-tech-language/12 text-tech-language",
  framework: "border-tech-framework/40 bg-tech-framework/12 text-tech-framework",
  runtime: "border-tech-runtime/40 bg-tech-runtime/12 text-tech-runtime",
  tooling: "border-border bg-transparent text-muted-foreground",
};

export const CATEGORY_LABELS: Record<TechnologyCategory, string> = {
  language: "Language",
  framework: "Framework",
  runtime: "Runtime",
  tooling: "Tooling",
};

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
    <Badge
      variant="outline"
      title={CATEGORY_LABELS[category]}
      className={cn(
        CATEGORY_STYLES[category],
        // Languages and frameworks are the "key" stack, so they get more weight.
        (category === "language" || category === "framework") && "font-semibold",
        active && "ring-2 ring-current/40",
        className,
      )}
    >
      {name}
    </Badge>
  );
}
