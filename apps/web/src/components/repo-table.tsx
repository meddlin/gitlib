import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";
import { ArrowDown, ArrowUp, ArrowUpDown, Pencil, Star } from "lucide-react";
import { DescriptionDialog } from "#/components/description-dialog";
import { Highlighted } from "#/components/highlighted";
import { TechBadge } from "#/components/tech-badge";
import { COMMUNITY_ITEMS, TONE_CLASSES, scoreTone } from "#/lib/community";
import { cn } from "#/lib/utils";
import type { CommunityScoresView } from "#/server/community";
import { setFavorite, type RepoView } from "#/server/repos";
import type { IssueCountsView } from "#/server/issues";
import type { SearchHitView } from "#/server/search";

export type RepoHighlights = ReadonlyMap<number, SearchHitView["highlights"]>;

const SNIPPETS = [
  ["notes", "Notes"],
  ["readme", "README"],
] as const;

/** Open GitHub issue counts by repo relativePath; undefined while they are still loading. */
export type IssueCounts = IssueCountsView["counts"] | undefined;

/** GitHub community scores by repo relativePath; undefined while they are still loading. */
export type CommunityScores = CommunityScoresView["scores"] | undefined;

export type SortKey = "name" | "description" | "stack" | "issues" | "community" | "scanned";
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
export function sortRepos(
  repos: RepoView[],
  { key, dir }: Sort,
  issueCounts?: IssueCounts,
  communityScores?: CommunityScores,
): RepoView[] {
  const text = (repo: RepoView): string => {
    switch (key) {
      case "name":
        return repo.name;
      case "description":
        return repo.description;
      case "stack":
        return orderedTech(repo)[0]?.name ?? "";
      case "scanned":
        return repo.lastScannedAt ?? "";
      case "issues":
      case "community":
        return "";
    }
  };
  const number = (repo: RepoView): number | undefined =>
    key === "issues" ? issueCounts?.[repo.relativePath] : communityScores?.[repo.relativePath]?.score;
  const sign = dir === "asc" ? 1 : -1;
  return [...repos].sort((a, b) => {
    if (a.isFavorite !== b.isFavorite) return a.isFavorite ? -1 : 1;
    if (key === "issues" || key === "community") {
      const [ca, cb] = [number(a), number(b)];
      // Repos with no number (no GitHub remote, or not loaded yet) sink to the bottom; zero is a real value.
      if ((ca === undefined) !== (cb === undefined)) return ca === undefined ? 1 : -1;
      if (ca !== undefined && cb !== undefined && ca !== cb) return sign * (ca - cb);
      return collator.compare(a.relativePath, b.relativePath);
    }
    const [va, vb] = [text(a), text(b)];
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
  title,
}: {
  label: string;
  title?: string;
  column: SortKey;
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  className?: string;
}) {
  const active = sort?.key === column;
  const Icon = !sort || !active ? ArrowUpDown : sort.dir === "asc" ? ArrowUp : ArrowDown;
  return (
    <th
      scope="col"
      aria-sort={sort && active ? (sort.dir === "asc" ? "ascending" : "descending") : "none"}
      className={cn("h-9 px-3 text-left align-middle text-xs font-medium text-muted-foreground", className)}
    >
      <button
        type="button"
        onClick={() => onSort(column)}
        title={title}
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

function IssueCount({ repo, counts }: { repo: RepoView; counts: IssueCounts }) {
  if (!counts) return <span aria-label="Loading issue count">…</span>;
  const count = counts[repo.relativePath];
  if (count === undefined) return <span>—</span>;
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repo.relativePath }}
      search={{ tab: "issues" }}
      aria-label={`${count} open GitHub ${count === 1 ? "issue" : "issues"} for ${repo.name}`}
      className={cn(
        "outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring",
        count > 0 && "font-medium text-foreground",
      )}
    >
      {count}
    </Link>
  );
}

/** A score with one square per checklist item, so what is missing shows without opening the repo. */
function CommunityScore({ repo, scores }: { repo: RepoView; scores: CommunityScores }) {
  if (!scores) return <span aria-label="Loading community score">…</span>;
  const entry = scores[repo.relativePath];
  if (!entry) return <span>—</span>;

  const missing = COMMUNITY_ITEMS.filter((item) => entry.missing.includes(item.id));
  const tone = TONE_CLASSES[scoreTone(entry.score)];
  return (
    <Link
      to="/repos/$"
      params={{ _splat: repo.relativePath }}
      search={{ tab: "community" }}
      aria-label={`Community profile score ${entry.score}% for ${repo.name}${
        missing.length > 0 ? `; missing ${missing.map((item) => item.label).join(", ")}` : ""
      }`}
      title={missing.length > 0 ? `Missing: ${missing.map((item) => item.label).join(", ")}` : "Nothing missing"}
      className="flex w-fit flex-col gap-1 outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className={cn("text-sm font-medium", tone.text)}>{entry.score}%</span>
      <span className="flex gap-[3px]" aria-hidden>
        {COMMUNITY_ITEMS.map((item) => (
          <span
            key={item.id}
            className={cn("size-2", entry.missing.includes(item.id) ? "border border-muted-foreground/70" : tone.bar)}
          />
        ))}
      </span>
    </Link>
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
  highlights,
  sort,
  onSort,
  activeTech,
  onToggleTech,
  issueCounts,
  communityScores,
  selectedPath,
  onSelect,
}: {
  repos: RepoView[];
  /** Search matches by repo id; present while the rows are search results. */
  highlights?: RepoHighlights;
  /** Null while rows are in search-relevance order, so no column header looks active. */
  sort: Sort | null;
  onSort: (key: SortKey) => void;
  activeTech: string | undefined;
  onToggleTech: (name: string) => void;
  issueCounts: IssueCounts;
  communityScores: CommunityScores;
  selectedPath: string | undefined;
  onSelect: (repo: RepoView) => void;
}) {
  return (
    <div className="overflow-x-auto border-y">
      <table className="w-full min-w-192 table-fixed border-collapse text-sm">
        <thead className="border-b">
          <tr>
            <th scope="col" className="w-10 px-3">
              <span className="sr-only">Favorite</span>
            </th>
            <SortHeader label="Repository" column="name" sort={sort} onSort={onSort} className="w-[22%]" />
            <SortHeader label="Description" column="description" sort={sort} onSort={onSort} className="w-[27%]" />
            <SortHeader label="Stack" column="stack" sort={sort} onSort={onSort} className="w-[22%]" />
            <SortHeader
              label="Issues"
              title="Open GitHub issues"
              column="issues"
              sort={sort}
              onSort={onSort}
              className="w-[8%]"
            />
            <SortHeader
              label="Community"
              title="GitHub community profile score"
              column="community"
              sort={sort}
              onSort={onSort}
              className="w-[10%]"
            />
            <SortHeader label="Scanned" column="scanned" sort={sort} onSort={onSort} className="w-[10%]" />
            <th scope="col" className="w-10 px-3">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {repos.map((repo) => {
            const matches = highlights?.get(repo.id);
            return (
              <tr
                key={repo.id}
                data-testid="repo-row"
                onClick={(event) => {
                  // Ignore clicks that came from portalled dialogs or from the row's links and other controls.
                  const target = event.target as HTMLElement;
                  if (!event.currentTarget.contains(target) || target.closest("a, button:not([data-row-trigger])")) return;
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
                  <Link
                    to="/repos/$"
                    params={{ _splat: repo.relativePath }}
                    className="block truncate font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <Highlighted segments={matches?.name} fallback={repo.name} />
                    {repo.isWorktree ? (
                      <span className="ml-2 text-xs font-normal text-muted-foreground">worktree</span>
                    ) : null}
                  </Link>
                  {/* The real button gives keyboard users a way into the preview; mouse clicks anywhere on the row land on the row. */}
                  <button
                    type="button"
                    data-row-trigger
                    aria-expanded={selectedPath === repo.relativePath}
                    aria-label={`Preview ${repo.name}`}
                    className="block w-full text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <span className="block truncate font-mono text-xs text-muted-foreground" title={repo.absolutePath}>
                      <Highlighted segments={matches?.relativePath} fallback={repo.relativePath} />
                    </span>
                  </button>
                </td>
                <td className="px-3 py-3">
                  {repo.description ? (
                    <span className="leading-snug">
                      <Highlighted segments={matches?.description} fallback={repo.description} />
                    </span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                  {SNIPPETS.map(([field, label]) => {
                    const segments = matches?.[field];
                    return segments ? (
                      <span key={field} className="mt-1.5 block text-xs leading-snug text-muted-foreground">
                        <span className="mr-1.5 font-medium text-foreground">{label}</span>
                        <Highlighted segments={segments} fallback="" />
                      </span>
                    ) : null;
                  })}
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
                  <IssueCount repo={repo} counts={issueCounts} />
                </td>
                <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  <CommunityScore repo={repo} scores={communityScores} />
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
