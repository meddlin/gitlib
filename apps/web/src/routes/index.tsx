import { createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw, Search, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { RepoPreview } from "#/components/repo-preview";
import { RepoTable, sortRepos, type Sort, type SortKey } from "#/components/repo-table";
import { TechBadge } from "#/components/tech-badge";
import { Input } from "#/components/ui/input";
import { cn } from "#/lib/utils";
import { getRepos, rescanRepos, type RepoView } from "#/server/repos";

interface IndexSearch {
  q?: string;
  tech?: string;
  /** relativePath of the repo shown in the preview pane. */
  repo?: string;
  /** Linked git worktrees are hidden unless this is set. */
  worktrees?: true;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    tech: typeof search.tech === "string" && search.tech ? search.tech : undefined,
    repo: typeof search.repo === "string" && search.repo ? search.repo : undefined,
    worktrees: isTruthyParam(search.worktrees) ? true : undefined,
  }),
  loader: () => getRepos(),
  component: RepoLibrary,
});

const isTruthyParam = (value: unknown): boolean =>
  value === true || value === 1 || value === "true" || value === "1";

function matches(repo: RepoView, q: string | undefined, tech: string | undefined): boolean {
  if (tech && !repo.technologies.some((t) => t.name.toLowerCase() === tech.toLowerCase())) return false;
  if (!q) return true;
  const needle = q.toLowerCase();
  return (
    repo.name.toLowerCase().includes(needle) ||
    repo.relativePath.toLowerCase().includes(needle) ||
    repo.description.toLowerCase().includes(needle) ||
    repo.technologies.some((t) => t.name.toLowerCase().includes(needle))
  );
}

function RepoLibrary() {
  const { repos: allRepos, roots } = Route.useLoaderData();
  const { q, tech, repo: selectedPath, worktrees: showWorktrees } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);
  const [sort, setSort] = useState<Sort>({ key: "name", dir: "asc" });

  const worktreeCount = useMemo(() => allRepos.filter((repo) => repo.isWorktree).length, [allRepos]);
  const repos = useMemo(
    () => (showWorktrees ? allRepos : allRepos.filter((repo) => !repo.isWorktree)),
    [allRepos, showWorktrees],
  );

  const visible = useMemo(
    () => sortRepos(repos.filter((repo) => matches(repo, q, tech)), sort),
    [repos, q, tech, sort],
  );

  // Every detected technology with how many repos use it; languages and frameworks first.
  const techCounts = useMemo(() => {
    const counts = new Map<string, { category: RepoView["technologies"][number]["category"]; count: number }>();
    for (const repo of repos) {
      for (const t of repo.technologies) {
        const entry = counts.get(t.name) ?? { category: t.category, count: 0 };
        entry.count += 1;
        counts.set(t.name, entry);
      }
    }
    const weight = { language: 0, framework: 1, runtime: 2, tooling: 3 } as const;
    return [...counts.entries()].sort(
      ([nameA, a], [nameB, b]) => weight[a.category] - weight[b.category] || b.count - a.count || nameA.localeCompare(nameB),
    );
  }, [repos]);

  const setSearch = useCallback(
    (next: IndexSearch) => navigate({ search: (prev) => ({ ...prev, ...next }), replace: true }),
    [navigate],
  );
  const toggleTech = (name: string) =>
    setSearch({ tech: tech?.toLowerCase() === name.toLowerCase() ? undefined : name });

  async function rescan() {
    setScanning(true);
    try {
      await rescanRepos();
      await router.invalidate();
    } finally {
      setScanning(false);
    }
  }

  const described = repos.filter((repo) => repo.description).length;

  const selected = useMemo(() => repos.find((repo) => repo.relativePath === selectedPath), [repos, selectedPath]);
  const closePreview = useCallback(() => setSearch({ repo: undefined }), [setSearch]);

  useEffect(() => {
    if (!selected) return;
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape inside an open dialog belongs to the dialog.
      if (event.key === "Escape" && !event.defaultPrevented) closePreview();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [selected, closePreview]);

  const toggleSort = (key: SortKey) =>
    setSort((prev) => (prev.key === key ? { key, dir: prev.dir === "asc" ? "desc" : "asc" } : { key, dir: "asc" }));

  return (
    <div
      className={cn(
        "mx-auto flex w-full flex-1 flex-col gap-5 px-4 py-8 transition-[max-width] duration-200 sm:px-6",
        selected ? "max-w-[96rem]" : "max-w-6xl",
      )}
    >
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-lg font-semibold tracking-tight">Repositories</h1>
          <p className="text-sm text-muted-foreground">
            {repos.length} {repos.length === 1 ? "repository" : "repositories"} · {described} described
            {!showWorktrees && worktreeCount > 0 ? ` · ${worktreeCount} worktrees hidden` : ""}
            {roots.length > 0 ? (
              <>
                {" · "}
                <span className="font-mono text-xs break-all">{roots.join(", ")}</span>
              </>
            ) : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={rescan}
            disabled={scanning}
            className="inline-flex h-8 items-center gap-1.5 border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
          >
            <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} aria-hidden />
            {scanning ? "Scanning…" : "Rescan"}
          </button>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-0 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search by name, path, description or technology"
            aria-label="Search repositories"
            className="rounded-none border-0 border-b bg-transparent pl-6 shadow-none focus-visible:ring-0 dark:bg-transparent"
            value={q ?? ""}
            onChange={(event) => setSearch({ q: event.target.value || undefined })}
          />
        </div>

        {worktreeCount > 0 ? (
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs text-muted-foreground">
            <input
              type="checkbox"
              className="size-3.5 accent-primary"
              checked={Boolean(showWorktrees)}
              onChange={(event) => setSearch({ worktrees: event.target.checked ? true : undefined })}
            />
            Show worktrees ({worktreeCount})
          </label>
        ) : null}

        {techCounts.length > 0 ? (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1" aria-label="Filter by technology">
            {techCounts.map(([name, { category, count }]) => {
              const active = tech?.toLowerCase() === name.toLowerCase();
              return (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleTech(name)}
                  aria-pressed={active}
                  className="outline-none hover:opacity-70 focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TechBadge name={`${name} ${count}`} category={category} active={active} />
                </button>
              );
            })}
            {tech || q ? (
              <button
                type="button"
                onClick={() => setSearch({ q: undefined, tech: undefined })}
                className="inline-flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                <X className="size-3" aria-hidden /> Clear filters
              </button>
            ) : null}
          </div>
        ) : null}
      </div>

      {repos.length === 0 ? (
        <EmptyState>
          No git repositories were found under <span className="font-mono">{roots.join(", ") || "any root"}</span>.
          Add scan roots to <span className="font-mono">~/.git-library/config.toml</span> and rescan.
        </EmptyState>
      ) : visible.length === 0 ? (
        <EmptyState>No repositories match your filters.</EmptyState>
      ) : (
        <div className="flex items-start">
          <div className="min-w-0 flex-1">
            <RepoTable
              repos={visible}
              sort={sort}
              onSort={toggleSort}
              activeTech={tech}
              onToggleTech={toggleTech}
              selectedPath={selected?.relativePath}
              onSelect={(repo) => setSearch({ repo: repo.relativePath })}
            />
          </div>
          <RepoPreview repo={selected} onClose={closePreview} />
        </div>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="border-y py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
