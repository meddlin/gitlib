import { ChevronDown, Search } from "lucide-react";
import { Popover } from "radix-ui";
import { useId, useMemo, useRef, useState } from "react";
import { cn } from "#/lib/utils";

export interface SearchSelectOption {
  value: string;
  label: string;
}

/**
 * A button that opens a filterable list. Choosing an option calls `onSelect` and closes the list;
 * the control holds no selection of its own, so it suits "add one of these" pickers.
 */
export function SearchSelect({
  options,
  onSelect,
  placeholder,
  searchPlaceholder = "Search…",
  emptyText = "No matches.",
  disabled,
  className,
  ...aria
}: {
  options: SearchSelectOption[];
  onSelect: (value: string) => void;
  placeholder: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  const matches = useMemo(() => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    return options.filter((option) => {
      const label = option.label.toLowerCase();
      return terms.every((term) => label.includes(term));
    });
  }, [options, query]);

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setQuery("");
      setActive(0);
    }
  }

  function choose(option: SearchSelectOption | undefined) {
    if (!option) return;
    setOpen(false);
    onSelect(option.value);
  }

  function move(index: number) {
    const next = Math.max(0, Math.min(matches.length - 1, index));
    setActive(next);
    listRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      move(active + 1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      move(active - 1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      choose(matches[active]);
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger
        disabled={disabled}
        aria-label={aria["aria-label"]}
        className={cn(
          "flex h-9 w-full min-w-0 items-center justify-between gap-2 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none md:text-sm dark:bg-input/30",
          "focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50",
          className,
        )}
      >
        <span className="truncate text-muted-foreground">{placeholder}</span>
        <ChevronDown className="size-4 shrink-0 opacity-50" aria-hidden />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="end"
          sideOffset={4}
          className="z-50 w-(--radix-popover-trigger-width) min-w-64 overflow-hidden rounded-md border bg-popover text-popover-foreground shadow-md"
        >
          <div className="flex items-center gap-2 border-b px-3">
            <Search className="size-4 shrink-0 opacity-50" aria-hidden />
            <input
              autoFocus
              role="combobox"
              aria-expanded
              aria-controls={listId}
              aria-activedescendant={matches[active] ? `${listId}-${active}` : undefined}
              aria-label={searchPlaceholder}
              value={query}
              onChange={(event) => {
                setQuery(event.target.value);
                setActive(0);
              }}
              onKeyDown={handleKeyDown}
              placeholder={searchPlaceholder}
              className="h-9 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <ul ref={listRef} id={listId} role="listbox" className="max-h-64 overflow-y-auto p-1">
            {matches.map((option, index) => (
              <li
                key={option.value}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === active}
                onMouseMove={() => setActive(index)}
                onClick={() => choose(option)}
                className={cn(
                  "cursor-default truncate rounded-sm px-2 py-1.5 text-sm",
                  index === active && "bg-accent text-accent-foreground",
                )}
              >
                {option.label}
              </li>
            ))}
            {matches.length === 0 ? <li className="px-2 py-3 text-center text-sm text-muted-foreground">{emptyText}</li> : null}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
