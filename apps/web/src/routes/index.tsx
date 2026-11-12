import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { CatalogTable } from "#/components/catalog-table";
import { ContributionGraph, type ContributionSource } from "#/components/contribution-graph";
import { RepoPreview } from "#/components/repo-preview";
import {
  RepoTable,
  sortRepos,
  type CommunityScores,
  type IssueCounts,
  type RepoHighlights,
  type Sort,
  type SortDir,
  type SortKey,
} from "#/components/repo-table";
import { SearchBar } from "#/components/search-bar";
import { TechBadge } from "#/components/tech-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { CATALOG_SOURCES, entriesForSource, matchesQuery, type CatalogSource } from "#/lib/catalog";
import { DEFAULT_COMMUNITY_SCOPE, oldestFetchedAt } from "#/lib/community";
import { formatAgo } from "#/lib/format";
import { saveLibraryState, type LibraryTableState } from "#/lib/library-state";
import { cn } from "#/lib/utils";
import { getCatalog, refreshCatalog, type CatalogView, type ProviderStatus } from "#/server/catalog";
import { getCommunityScores, refreshCommunityScores, type CommunityScoresView } from "#/server/community";
import { getContributions, type ContributionsView } from "#/server/contributions";
import { getIssueCounts, type IssueCountsView } from "#/server/issues";
import { getRepos, rescanRepos, type RepoView } from "#/server/repos";
import { searchRepos } from "#/server/search";

interface IndexSearch extends LibraryTableState {
  /** relativePath of the repo shown in the preview pane. */
  repo?: string;
}

const SORT_KEYS: readonly SortKey[] = ["name", "description", "stack", "issues", "community", "scanned"];
const SORT_DIRS: readonly SortDir[] = ["asc", "desc"];

/** The tab shown when the URL names none. */
const DEFAULT_SOURCE: CatalogSource = "combined";

const SOURCE_LABELS: Record<CatalogSource, string> = {
  combined: "Combined",
  local: "Local",
  github: "GitHub",
  gitlab: "GitLab",
};

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    tech: typeof search.tech === "string" && search.tech ? search.tech : undefined,
    repo: typeof search.repo === "string" && search.repo ? search.repo : undefined,
    worktrees: isTruthyParam(search.worktrees) ? true : undefined,
    source: CATALOG_SOURCES.find((source) => source === search.source && source !== DEFAULT_SOURCE),
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
 * Data about every repo that comes from GitHub, fetched after the list renders (it's a network call the table
 * shouldn't wait on). Undefined until it arrives; the server caches it, so refetching is cheap.
 */
function useBackgroundView<T>(load: () => Promise<T>, onError: (message: string) => T, refreshKey: unknown): T | undefined {
  const [result, setResult] = useState<T>();
  useEffect(() => {
    let cancelled = false;
    load()
      .then((next) => !cancelled && setResult(next))
      .catch((caught: unknown) => {
        if (!cancelled) setResult(onError(caught instanceof Error ? caught.message : "Something went wrong."));
      });
    return () => {
      cancelled = true;
    };
    // `load` and `onError` are stable in every caller, so `refreshKey` is the only real input.
  }, [refreshKey]);
  return result;
}

const issueCountsFailed = (error: string): IssueCountsView => ({ status: "error", counts: {}, error });
const communityScoresFailed = (error: string): CommunityScoresView => ({
  status: "error",
  scope: DEFAULT_COMMUNITY_SCOPE,
  scores: {},
  bySlug: {},
  error,
  updatedAt: null,
  refreshing: false,
});

/** How often to look again while the server refreshes scores in the background. */
const COMMUNITY_POLL_MS = 3_000;

/**
 * Community scores as stored in gitlib's database, plus a way to ask GitHub for fresh ones. The server also
 * refreshes on its own when they are a day old; while it does, this keeps polling so the table fills in.
 */
function useCommunityScores(refreshKey: unknown) {
  const [view, setView] = useState<CommunityScoresView>();
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCommunityScores()
      .then((next) => !cancelled && setView(next))
      .catch((caught: unknown) => {
        if (!cancelled) setView(communityScoresFailed(caught instanceof Error ? caught.message : "Something went wrong."));
      });
    return () => {
      cancelled = true;
    };
    // `refreshKey` is the only real input; the server functions are stable.
  }, [refreshKey]);

  const refreshing = view?.refreshing === true;
  useEffect(() => {
    if (!refreshing) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getCommunityScores()
        .then((next) => !cancelled && setView(next))
        .catch(() => !cancelled && setView((prev) => prev && { ...prev, refreshing: false }));
    }, COMMUNITY_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, refreshing]);

  // Starts the refresh and returns at once; the polling above keeps `busy` on until the server has finished.
  // `uncloned` adds GitHub repos with no clone, which the repository tabs that list them ask for.
  const refresh = useCallback(async (uncloned: boolean) => {
    setRequesting(true);
    try {
      setView(await refreshCommunityScores({ data: { uncloned } }));
    } catch (caught) {
      setView(communityScoresFailed(caught instanceof Error ? caught.message : "Something went wrong."));
    } finally {
      setRequesting(false);
    }
  }, []);

  return { view, refresh, busy: requesting || refreshing };
}

const catalogFailed = (error: string) => error;

/** How often to look again while the server lists a host in the background. */
const CATALOG_POLL_MS = 3_000;

/**
 * Every repo across clones, GitHub and GitLab, fetched after the page renders. The hosts' listings come from
 * gitlib's database and are re-checked in the background, so loading is cheap; `refresh` asks the hosts again.
 */
function useCatalog(refreshKey: unknown) {
  const [view, setView] = useState<CatalogView>();
  const [error, setError] = useState<string>();
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    let cancelled = false;
    getCatalog()
      .then((next) => {
        if (cancelled) return;
        setView(next);
        setError(undefined);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(catalogFailed(caught instanceof Error ? caught.message : "Something went wrong."));
      });
    return () => {
      cancelled = true;
    };
    // `refreshKey` is the only real input; the server function is stable.
  }, [refreshKey]);

  // While a host is being listed (the first time, or a scheduled check) keep looking so the table fills in.
  const refreshing = view?.github.refreshing === true || view?.gitlab.refreshing === true;
  useEffect(() => {
    if (!refreshing) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getCatalog()
        .then((next) => !cancelled && setView(next))
        .catch(() => undefined);
    }, CATALOG_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [view, refreshing]);

  const refresh = useCallback(async () => {
    setRequesting(true);
    try {
      setView(await refreshCatalog());
      setError(undefined);
    } catch (caught) {
      setError(catalogFailed(caught instanceof Error ? caught.message : "Something went wrong."));
    } finally {
      setRequesting(false);
    }
  }, []);

  return { view, error, refresh, busy: requesting || refreshing };
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
  const { q, tech, repo: selectedPath, worktrees: showWorktrees, sort: sortKey, dir: sortDir, source: sourceParam } = Route.useSearch();
  const source = sourceParam ?? DEFAULT_SOURCE;
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  const contributions = useContributions(allRepos);
  const issueCountsResult = useBackgroundView(getIssueCounts, issueCountsFailed, allRepos);
  const issueCounts: IssueCounts = issueCountsResult?.counts;
  const community = useCommunityScores(allRepos);
  const catalog = useCatalog(allRepos);
  const communityResult = community.view;
  const communityScores: CommunityScores = communityResult?.scores;

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
    () => saveLibraryState({ q, tech, worktrees: showWorktrees, source: sourceParam, sort: sortKey, dir: sortDir }),
    [q, tech, showWorktrees, sourceParam, sortKey, sortDir],
  );

  // Without a chosen column the rows keep search-relevance order (or name order when not searching).
  const sort = useMemo<Sort | null>(() => (sortKey ? { key: sortKey, dir: sortDir ?? "asc" } : null), [sortKey, sortDir]);
  const ranked = Boolean(q && found);
  const activeSort = sort ?? (ranked ? null : DEFAULT_SORT);

  const visible = useMemo(() => {
    const filtered = results.map(({ repo }) => repo).filter((repo) => hasTech(repo, tech));
    return activeSort ? sortRepos(filtered, activeSort, issueCounts, communityScores) : filtered;
  }, [results, tech, activeSort, issueCounts, communityScores]);

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

  const reposByPath = useMemo(() => new Map(allRepos.map((repo) => [repo.relativePath, repo])), [allRepos]);
  const catalogEntries = catalog.view?.entries;
  const sourceCounts = useMemo(
    () =>
      Object.fromEntries(
        CATALOG_SOURCES.map((key) => [key, catalogEntries ? entriesForSource(catalogEntries, key).length : undefined]),
      ) as Record<CatalogSource, number | undefined>,
    [catalogEntries],
  );
  const catalogRows = useMemo(
    () => (catalogEntries ? entriesForSource(catalogEntries, source).filter((entry) => matchesQuery(entry, q)) : undefined),
    [catalogEntries, source, q],
  );
  const setSource = (next: string) => {
    const picked = CATALOG_SOURCES.find((candidate) => candidate === next);
    if (picked) setSearch({ source: picked === DEFAULT_SOURCE ? undefined : picked, repo: undefined });
  };

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

  // Issue counts read most useful biggest-first, so that column starts descending. Community starts ascending:
  // the repos missing the most are the ones to look at first.
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
            {source === "local" ? (
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
            ) : (
              <p className="text-sm text-muted-foreground">
                {SOURCE_DESCRIPTIONS[source]}
                {catalogRows ? ` · ${catalogRows.length} ${catalogRows.length === 1 ? "repository" : "repositories"}` : ""}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {source === "local" ? (
              <>
              <button
                type="button"
                onClick={rescan}
                disabled={scanning}
                className="inline-flex h-8 items-center gap-1.5 border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3.5", scanning && "animate-spin")} aria-hidden />
                {scanning ? "Scanning…" : "Rescan"}
              </button>
              <button
                type="button"
                onClick={() => community.refresh(false)}
                disabled={community.busy}
                title={refreshScoresTitle(communityResult?.scope, false)}
                className="inline-flex h-8 items-center gap-1.5 border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3.5", community.busy && "animate-spin")} aria-hidden />
                {community.busy ? "Refreshing scores…" : "Refresh scores"}
              </button>
              </>
            ) : (
              <>
              {source === "gitlab" ? null : (
                <button
                  type="button"
                  onClick={() => community.refresh(true)}
                  disabled={community.busy}
                  title={refreshScoresTitle(communityResult?.scope, true)}
                  className="inline-flex h-8 items-center gap-1.5 border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
                >
                  <RefreshCw className={cn("size-3.5", community.busy && "animate-spin")} aria-hidden />
                  {community.busy ? "Refreshing scores…" : "Refresh scores"}
                </button>
              )}
              <button
                type="button"
                onClick={catalog.refresh}
                disabled={catalog.busy}
                title="Ask GitHub and GitLab for their complete repository lists now. They are otherwise re-checked in the background."
                className="inline-flex h-8 items-center gap-1.5 border px-3 text-sm outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50"
              >
                <RefreshCw className={cn("size-3.5", catalog.busy && "animate-spin")} aria-hidden />
                {catalog.busy ? "Refreshing…" : "Refresh"}
              </button>
              </>
            )}
          </div>
        </header>

        <Tabs value={source} onValueChange={setSource} className="gap-5">
          <TabsList aria-label="Repository sources">
            {CATALOG_SOURCES.map((key) => {
              const count = key === "local" ? repos.length : sourceCounts[key];
              return (
                <TabsTrigger key={key} value={key}>
                  {SOURCE_LABELS[key]}
                  <span className="text-xs font-normal text-muted-foreground tabular-nums" aria-label={count === undefined ? "loading" : `${count} repositories`}>
                    {count ?? "…"}
                  </span>
                </TabsTrigger>
              );
            })}
          </TabsList>
          <TabsContent value={source} className="flex flex-col gap-5">
            {source === "local" ? (
              <>
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

                {communityResult && communityResult.status !== "ok" ? (
                  <p className="text-xs text-muted-foreground" role="status">
                    Some GitHub community scores couldn't be refreshed: {communityResult.error}
                  </p>
                ) : null}
                {communityResult?.updatedAt ? (
                  <p className="text-xs text-muted-foreground">
                    Community scores last fetched from GitHub {formatAgo(communityResult.updatedAt)}.
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
                  Add scan roots to <span className="font-mono">~/.git-library/config.toml</span> and rescan. Running in
                  Docker? Set <span className="font-mono">GITLIB_REPOS</span> in <span className="font-mono">.env</span> to
                  the folder on your machine that holds your repos, then run{" "}
                  <span className="font-mono">docker compose up -d</span>.
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
                      communityScores={communityScores}
                      communityScope={communityResult?.scope}
                      selectedPath={selected?.relativePath}
                      onSelect={(repo) => setSearch({ repo: repo.relativePath })}
                    />
                  </div>
                  <RepoPreview repo={selected} onClose={closePreview} />
                </div>
              )}
              </>
            ) : (
              <SourceBody
                source={source}
                rows={catalogRows}
                error={catalog.error}
                github={catalog.view?.github}
                gitlab={catalog.view?.gitlab}
                reposByPath={reposByPath}
                community={communityResult}
                query={q}
              />
            )}
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}

const SOURCE_DESCRIPTIONS: Record<Exclude<CatalogSource, "local">, string> = {
  combined: "Clones, GitHub and GitLab in one list",
  github: "Repositories your GitHub account can reach",
  gitlab: "Projects your GitLab account is a member of",
};

function statusNotice(label: string, status: ProviderStatus | undefined): string | null {
  if (!status || status.status === "ok") return null;
  return status.status === "not-configured"
    ? `${label} isn't included. ${status.message ?? ""}`.trim()
    : `${label} couldn't be refreshed${status.fetchedAt ? ` (showing the list from ${formatAgo(status.fetchedAt)})` : ""}: ${
        status.message ?? "unknown error"
      }`;
}

/** When each host's list was last checked, for the hosts this tab shows. */
function checkedNotice(source: Exclude<CatalogSource, "local">, github: ProviderStatus | undefined, gitlab: ProviderStatus | undefined) {
  const describe = (label: string, status: ProviderStatus | undefined): string | null => {
    if (!status || status.status === "not-configured") return null;
    if (status.refreshing) return `${label} is being checked…`;
    return status.fetchedAt ? `${label} checked ${formatAgo(status.fetchedAt)}` : null;
  };
  const parts = [
    source !== "gitlab" ? describe("GitHub", github) : null,
    source !== "github" ? describe("GitLab", gitlab) : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `Lists stored in gitlib · ${parts.join(" · ")}` : null;
}

/** Whether a host this tab depends on has nothing stored yet but is being listed. */
function isChecking(source: Exclude<CatalogSource, "local">, github: ProviderStatus | undefined, gitlab: ProviderStatus | undefined) {
  const waiting = (status: ProviderStatus | undefined) => status?.refreshing === true && status.fetchedAt === null;
  return source === "github" ? waiting(github) : source === "gitlab" ? waiting(gitlab) : waiting(github) || waiting(gitlab);
}

/** The hover text for a Refresh scores button, which covers whatever the Settings page says is scored. */
function refreshScoresTitle(scope: CommunityScoresView["scope"] | undefined, uncloned: boolean): string {
  if (scope !== "all") {
    return "Ask GitHub for every favorited repository's community profile now. Scores are otherwise refreshed daily. Change which repositories are scored in Settings.";
  }
  return uncloned
    ? "Ask GitHub for the community profile of every GitHub repository in the list now, cloned or not: one request each, so a long list takes a while. Scores of cloned repositories are otherwise refreshed daily."
    : "Ask GitHub for every cloned repository's community profile now. Scores are otherwise refreshed daily.";
}

/** What to say about the scores in a catalog table: a failed refresh, and how old the ones shown are. */
function communityNoticesFor(rows: ReturnType<typeof entriesForSource>, community: CommunityScoresView | undefined): string[] {
  if (!community) return [];
  const notices: string[] = [];
  if (community.status !== "ok" && community.error) notices.push(`Some GitHub community scores couldn't be refreshed: ${community.error}`);
  const slugs = rows.flatMap((entry) => (entry.github ? [entry.github.fullName] : []));
  const oldest = oldestFetchedAt(slugs, community.bySlug);
  if (oldest) notices.push(`Community scores last fetched from GitHub ${formatAgo(oldest)}.`);
  return notices;
}

/** The Combined, GitHub and GitLab tabs: one catalog table, plus what is missing when a host can't be listed. */
function SourceBody({
  source,
  rows,
  error,
  github,
  gitlab,
  reposByPath,
  community,
  query,
}: {
  source: Exclude<CatalogSource, "local">;
  rows: ReturnType<typeof entriesForSource> | undefined;
  error: string | undefined;
  github: ProviderStatus | undefined;
  gitlab: ProviderStatus | undefined;
  reposByPath: ReadonlyMap<string, RepoView>;
  community: CommunityScoresView | undefined;
  query: string | undefined;
}) {
  if (error) return <EmptyState>Couldn't load repositories: {error}</EmptyState>;
  if (!rows) return <EmptyState>Loading repositories…</EmptyState>;

  // The combined tab notes which host it left out; a tab for one host explains itself when it is empty.
  const notices =
    source === "combined"
      ? [statusNotice("GitHub", github), statusNotice("GitLab", gitlab)].filter(
          (notice): notice is string => notice !== null,
        )
      : [];
  const checked = checkedNotice(source, github, gitlab);
  const communityNotices = source === "gitlab" ? [] : communityNoticesFor(rows, community);
  const hostNotice =
    source === "github" ? statusNotice("GitHub", github) : source === "gitlab" ? statusNotice("GitLab", gitlab) : null;

  return (
    <>
      {notices.length > 0 || checked || communityNotices.length > 0 ? (
        <div className="flex flex-col gap-1">
          {notices.map((notice) => (
            <p key={notice} className="text-xs text-muted-foreground" role="status">
              {notice}
            </p>
          ))}
          {checked ? <p className="text-xs text-muted-foreground">{checked}</p> : null}
          {communityNotices.map((notice) => (
            <p key={notice} className="text-xs text-muted-foreground">
              {notice}
            </p>
          ))}
        </div>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState>
          {query
            ? "No repositories match your search."
            : isChecking(source, github, gitlab)
              ? "Listing repositories for the first time…"
              : (hostNotice ?? "No repositories found.")}
        </EmptyState>
      ) : (
        <CatalogTable entries={rows} reposByPath={reposByPath} github={github} gitlab={gitlab} community={community} />
      )}
    </>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return <div className="border-y py-10 text-center text-sm text-muted-foreground">{children}</div>;
}
