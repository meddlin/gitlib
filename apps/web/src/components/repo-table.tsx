import { useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Star } from "lucide-react";
import { DescriptionDialog } from "#/components/description-dialog";
import { TechBadge } from "#/components/tech-badge";
import { cn } from "#/lib/utils";
import { setFavorite, type RepoView } from "#/server/repos";

export type SortKey = "name" | "description" | "stack" | "scanned";
export type SortDir = "asc" | "desc";

export interface Sort {
  key: SortKey;
  dir: SortDir;
}

const isKey = (category: string) => category === "language" || category === "framework";

/** Languages and frameworks first, so the key stack leads each row. */
function orderedTech(repo: RepoView) {
  return [...repo.technologies.filter((t) => isKey(t.category)), ...repo.technologies.filter((t) => !isKey(t.category))];
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

/** Sorts by the chosen column, but always lists favorites ahead of everything else. */
export function sortRepos(repos: RepoView[], { key, dir }: Sort): RepoView[] {
  const value = (repo: RepoView): string => {
    switch (key) {
      case "name":
        return repo.name;
      case "description":
        return repo.description;
      case "stack":
        return orderedTech(repo)[0]?.name ?? "";
      case "scanned":
        return repo.lastScannedAt ?? "";
    }
  };
  const sign = dir === "asc" ? 1 : -1;
  return [...repos].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    const [va, vb] = [value(a), value(b)];
    // Empty values always sink to the bottom, whichever way we sort.
    if (!va !== !vb) return va ? -1 : 1;
    return sign * collator.compare(va, vb) || collator.compare(a.relativePath, b.relativePath);
  });
}

function formatScanned(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "—";
  return date.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function SortHeader({
  label,
  column,
  sort,
  onSort,
  className,
}: {
  label: string;
  column: SortKey;
  sort: Sort;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort.key === column;
  const Icon = !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        className={cn(
          "-mx-1 inline-flex items-center gap-1 px-1 py-0.5 uppercase tracking-wide outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
          active && "text-foreground",
        )}
      >
        {label}
        <Icon className={cn("size-3", !active && "opacity-40")} aria-hidden />
      </button>
    </th>
  );
}

function FavoriteButton({ repo }: { repo: RepoView }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      await setFavorite({ data: { relativePath: repo.relativePath, favorite: !repo.isFavorite } });
      await router.invalidate();
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={repo.isFavorite}
      aria-label={`${repo.isFavorite ? "Remove" : "Add"} ${repo.name} ${repo.isFavorite ? "from" : "to"} favorites`}
      title={repo.isFavorite ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "inline-flex size-7 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        repo.isFavorite ? "text-amber-500" : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      <Star className={cn("size-3.5", repo.isFavorite && "fill-current")} aria-hidden />
    </button>
  );
}

export function RepoTable({
  repos,
  sort,
  onSort,
  activeTech,
  onToggleTech,
  selectedPath,
  onSelect,
}: {
  repos: RepoView[];
  sort: Sort;
  onSort: (key: SortKey) => void;
  activeTech: string | undefined;
  onToggleTech: (name: string) => void;
  selectedPath: string | undefined;
  onSelect: (repo: RepoView) => void;
}) {
  return (
    <div className="overflow-x-auto border-y">
      <table className="w-full min-w-176 table-fixed border-collapse text-sm">
        <thead className="border-b">
          <tr>
            <th scope="col" className="w-10 px-3">
              <span className="sr-only">Favorite</span>
            </th>
            <SortHeader label="Repository" column="name" sort={sort} onSort={onSort} className="w-[26%]" />
            <SortHeader label="Description" column="description" sort={sort} onSort={onSort} className="w-[34%]" />
            <SortHeader label="Stack" column="stack" sort={sort} onSort={onSort} className="w-[28%]" />
            <SortHeader label="Scanned" column="scanned" sort={sort} onSort={onSort} className="w-[10%]" />
            <th scope="col" className="w-10 px-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {repos.map((repo) => (
            <tr
              key={repo.id}
              data-testid="repo-row"
              onClick={(event) => {
                // Ignore clicks that came from portalled dialogs or from the row's other controls.
                const target = event.target as HTMLElement;
                if (!event.currentTarget.contains(target) || target.closest("button:not([data-row-trigger])")) return;
                onSelect(repo);
              }}
              className={cn(
                "cursor-pointer align-top transition-colors hover:bg-accent/50",
                selectedPath === repo.relativePath && "bg-accent",
              )}
            >
              <td className="px-3 py-2">
                <FavoriteButton repo={repo} />
              </td>
              <td className="px-3 py-3">
                {/* The real button gives keyboard users a way in; mouse clicks anywhere on the row land on the row. */}
                <button
                  type="button"
                  data-row-trigger
                  aria-expanded={selectedPath === repo.relativePath}
                  aria-label={`Preview ${repo.name}`}
                  className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <span className="block truncate font-medium">
                    {repo.name}
                    {repo.isWorktree ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">worktree</span>
                    ) : null}
                  </span>
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={repo.absolutePath}>
                    {repo.relativePath}
                  </span>
                </button>
              </td>
              <td className="px-3 py-3">
                {repo.description ? (
                  <span className="leading-snug">{repo.description}</span>
                ) : (
                  <span className="text-muted-foreground">—</span>
                )}
              </td>
              <td className="px-3 py-3">
                {repo.technologies.length === 0 ? (
                  <span className="text-muted-foreground">—</span>
                ) : (
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {orderedTech(repo).map((tech) => (
                      <button
                        key={tech.name}
                        type="button"
                        onClick={() => onToggleTech(tech.name)}
                        aria-label={`Filter by ${tech.name}`}
                        aria-pressed={activeTech?.toLowerCase() === tech.name.toLowerCase()}
                        className="outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring"
                      >
                        <TechBadge
                          name={tech.name}
                          category={tech.category}
                          active={activeTech?.toLowerCase() === tech.name.toLowerCase()}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </td>
              <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                {formatScanned(repo.lastScannedAt)}
              </td>
              <td className="px-3 py-2 text-right">
                <DescriptionDialog repo={repo}>
                  <button
                    type="button"
                    aria-label={`${repo.description ? "Edit" : "Add"} description for ${repo.name}`}
                    title={repo.description ? "Edit description" : "Add description"}
                    className="inline-flex size-7 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Pencil className="size-3.5" aria-hidden />
                  </button>
                </DescriptionDialog>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
