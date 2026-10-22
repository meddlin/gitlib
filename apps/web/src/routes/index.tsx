import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ContributionGraph, type ContributionSource } from "#/components/contribution-graph";
import { RepoPreview } from "#/components/repo-preview";
import { RepoTable, sortRepos, type IssueCounts, type RepoHighlights, type Sort, type SortDir, type SortKey } from "#/components/repo-table";
import { SearchBar } from "#/components/search-bar";
import { TechBadge } from "#/components/tech-badge";
import { saveLibraryState, type LibraryTableState } from "#/lib/library-state";
import { cn } from "#/lib/utils";
import { getContributions, type ContributionsView } from "#/server/contributions";
import { getIssueCounts, type IssueCountsView } from "#/server/issues";
import { getRepos, rescanRepos, type RepoView } from "#/server/repos";
import { searchRepos } from "#/server/search";

interface IndexSearch extends LibraryTableState {
  /** relativePath of the repo shown in the preview pane. */
  repo?: string;
}

const SORT_KEYS: readonly SortKey[] = ["name", "description", "stack", "issues", "scanned"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    tech: typeof search.tech === "string" && search.tech ? search.tech : undefined,
    repo: typeof search.repo === "string" && search.repo ? search.repo : undefined,
    worktrees: isTruthyParam(search.worktrees) ? true : undefined,
    sort: SORT_KEYS.find((key) => key === search.sort),
    dir: SORT_DIRS.find((dir) => dir === search.dir),
  }),
  // The query (and whether worktrees count) re-runs the search; the technology filter is applied client-side.
  loaderDeps: ({ search }) => ({ q: search.q, worktrees: search.worktrees }),
  loader: async ({ deps }) => {
    const [listing, found] = await Promise.all([
      getRepos(),
      deps.q ? searchRepos({ data: { q: deps.q, worktrees: deps.worktrees === true } }) : Promise.resolve(null),
    ]);
    return { ...listing, found };
  },
  component: RepoLibrary,
});

const isTruthyParam = (value: unknown): boolean =>
  value === true || value === 1 || value === "true" || value === "1";

function hasTech(repo: RepoView, tech: string | undefined): boolean {
  return !tech || repo.technologies.some((t) => t.name.toLowerCase() === tech.toLowerCase());
}

const DEFAULT_SORT: Sort = { key: "name", dir: "asc" };

/**
 * GitHub issue counts for every repo, fetched after the list renders (it's a network call the table
 * shouldn't wait on). Undefined until they arrive; the server caches them, so refetching is cheap.
 */
function useIssueCounts(refreshKey: unknown): IssueCountsView | undefined {
  const [result, setResult] = useState<IssueCountsView>();
  useEffect(() => {
    let cancelled = false;
    getIssueCounts()
      .then((next) => !cancelled && setResult(next))
      .catch((caught: unknown) => {
        const error = caught instanceof Error ? caught.message : "Could not load issue counts.";
        if (!cancelled) setResult({ status: "error", counts: {}, error });
      });
    return () => {
      cancelled = true;
    };
  }, [refreshKey]);
  return result;
}

const CONTRIBUTION_SOURCE_KEY = "gitlib-contribution-source";

function readSource(): ContributionSource {
  try {
    return localStorage.getItem(CONTRIBUTION_SOURCE_KEY) === "all" ? "all" : "local";
  } catch {
    return "local";
  }
}

/**
 * Commit activity across all repos, fetched after the page renders since it shells out to git. The chosen
 * source is remembered in this browser; the previous graph stays up while a different source loads.
 */
function useContributions(refreshKey: unknown) {
  const [source, setSourceState] = useState<ContributionSource>("local");
  const [result, setResult] = useState<{ source: ContributionSource; view: ContributionsView }>();
  // Read after mount so server and client markup agree.
  useEffect(() => setSourceState(readSource()), []);
  useEffect(() => {
    let cancelled = false;
    getContributions({ data: { source } })
      .then((view) => !cancelled && setResult({ source, view }))
      .catch(() => !cancelled && setResult({ source, view: { days: {}, total: 0, repoCount: 0, notices: [] } }));
    return () => {
      cancelled = true;
    };
  }, [refreshKey, source]);
  const setSource = useCallback((next: ContributionSource) => {
    setSourceState(next);
    try {
      localStorage.setItem(CONTRIBUTION_SOURCE_KEY, next);
    } catch {
      // Not persisted; the choice still applies for this page view.
    }
  }, []);
  return { source, setSource, data: result?.view, loading: result?.source !== source };
}

function RepoLibrary() {
  const { repos: allRepos, roots, found } = Route.useLoaderData();
  const { q, tech, repo: selectedPath, worktrees: showWorktrees, sort: sortKey, dir: sortDir } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  const contributions = useContributions(allRepos);
  const issueCountsResult = useIssueCounts(allRepos);
  const issueCounts: IssueCounts = issueCountsResult?.counts;

  const searching = useRouterState({ select: (state) => state.isLoading });

  const worktreeCount = useMemo(() => allRepos.filter((repo) => repo.isWorktree).length, [allRepos]);
  const repos = useMemo(
    () => (showWorktrees ? allRepos : allRepos.filter((repo) => !repo.isWorktree)),
    [allRepos, showWorktrees],
  );

  // With a query the search ranks the results; without one every repository is listed.
  const results = useMemo(() => {
    if (!q || !found) return repos.map((repo) => ({ repo, highlights: undefined }));
    const byId = new Map(repos.map((repo) => [repo.id, repo]));
    return found.hits.flatMap((hit) => {
      const repo = byId.get(hit.id);
      return repo ? [{ repo, highlights: hit.highlights }] : [];
    });
  }, [repos, found, q]);
  const highlights: RepoHighlights = useMemo(
    () => new Map(results.flatMap(({ repo, highlights }) => (highlights ? [[repo.id, highlights] as const] : []))),
    [results],
  );

  // Filters and sort live in the URL (and are remembered for links back here), so they survive navigating away.
  useEffect(
    () => saveLibraryState({ q, tech, worktrees: showWorktrees, sort: sortKey, dir: sortDir }),
    [q, tech, showWorktrees, sortKey, sortDir],
  );

  // Without a chosen column the rows keep search-relevance order (or name order when not searching).
  const sort = useMemo<Sort | null>(() => (sortKey ? { key: sortKey, dir: sortDir ?? "asc" } : null), [sortKey, sortDir]);
  const ranked = Boolean(q && found);
  const activeSort = sort ?? (ranked ? null : DEFAULT_SORT);

  const visible = useMemo(() => {
    const filtered = results.map(({ repo }) => repo).filter((repo) => hasTech(repo, tech));
    return activeSort ? sortRepos(filtered, activeSort, issueCounts) : filtered;
  }, [results, tech, activeSort, issueCounts]);

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
  // A new query goes back to relevance order until the user picks a column to sort by.
  const setQuery = useCallback(
    (next: string) => setSearch({ q: next.trim() || undefined, sort: undefined, dir: undefined }),
    [setSearch],
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

  // Issue counts read most useful biggest-first, so that column starts descending.
  const toggleSort = (key: SortKey) =>
    setSearch(
      activeSort?.key === key
        ? { sort: key, dir: activeSort.dir === "asc" ? "desc" : "asc" }
        : { sort: key, dir: key === "issues" ? "desc" : "asc" },
    );

  return (
    <>
      <SearchBar value={q ?? ""} onChange={setQuery} busy={searching && Boolean(q)} />
      <div
        className={cn(
          "mx-auto flex w-full flex-1 flex-col gap-5 px-4 py-8 transition-[max-width] duration-200 sm:px-6",
          selected ? "max-w-[96rem]" : "max-w-6xl",
        )}
      >
        <ContributionGraph
          data={contributions.data}
          loading={contributions.loading}
          source={contributions.source}
          onSourceChange={contributions.setSource}
        />

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
          {q && found ? (
            <p className="text-sm text-muted-foreground" role="status">
              {found.mode === "meilisearch" ? (
                <>
                  {visible.length} {visible.length === 1 ? "result" : "results"} for{" "}
                  <span className="font-medium text-foreground">“{q}”</span>
                </>
              ) : found.notice ? (
                <span className="text-amber-700 dark:text-amber-400">Showing basic matches only — {found.notice}</span>
              ) : (
                <>Showing basic matches (full-text search is turned off).</>
              )}
            </p>
          ) : null}

          {issueCountsResult && issueCountsResult.status !== "ok" ? (
            <p className="text-xs text-muted-foreground" role="status">
              {issueCountsResult.status === "no-token"
                ? "GitHub issue counts are off: set GITLIB_GITHUB_TOKEN (or GITHUB_TOKEN) to show and sort by them."
                : `Some GitHub issue counts couldn't be loaded: ${issueCountsResult.error}`}
            </p>
          ) : null}

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
                  onClick={() => setSearch({ q: undefined, tech: undefined, sort: undefined, dir: undefined })}
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
                highlights={ranked ? highlights : undefined}
                sort={activeSort}
                onSort={toggleSort}
                activeTech={tech}
                onToggleTech={toggleTech}
                issueCounts={issueCounts}
                selectedPath={selected?.relativePath}
                onSelect={(repo) => setSearch({ repo: repo.relativePath })}
              />
            </div>
            <RepoPreview repo={selected} onClose={closePreview} />
          </div>
        )}
      </div>
    </>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="border-y py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
