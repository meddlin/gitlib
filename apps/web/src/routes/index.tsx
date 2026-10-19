import { createFileRoute, useRouter, useRouterState } from "@tanstack/react-router";
import { RefreshCw, X } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import { RepoCard } from "#/components/repo-card";
import { TechBadge } from "#/components/tech-badge";
import { Button } from "#/components/ui/button";
import { SearchBar } from "#/components/search-bar";
import { getRepos, rescanRepos, type RepoView } from "#/server/repos";
import { searchRepos } from "#/server/search";

interface IndexSearch {
  q?: string;
  tech?: string;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    tech: typeof search.tech === "string" && search.tech ? search.tech : undefined,
  }),
  // Only the query re-runs the search; the technology filter is applied client-side.
  loaderDeps: ({ search }) => ({ q: search.q }),
  loader: async ({ deps }) => {
    const [listing, found] = await Promise.all([
      getRepos(),
      deps.q ? searchRepos({ data: { q: deps.q } }) : Promise.resolve(null),
    ]);
    return { ...listing, found };
  },
  component: RepoLibrary,
});

function hasTech(repo: RepoView, tech: string | undefined): boolean {
  return !tech || repo.technologies.some((t) => t.name.toLowerCase() === tech.toLowerCase());
}

function RepoLibrary() {
  const { repos, roots, found } = Route.useLoaderData();
  const { q, tech } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  const searching = useRouterState({ select: (state) => state.isLoading });

  // With a query the search ranks the results; without one every repository is listed.
  const results = useMemo(() => {
    if (!q || !found) return repos.map((repo) => ({ repo, highlights: undefined }));
    const byId = new Map(repos.map((repo) => [repo.id, repo]));
    return found.hits.flatMap((hit) => {
      const repo = byId.get(hit.id);
      return repo ? [{ repo, highlights: hit.highlights }] : [];
    });
  }, [repos, found, q]);
  const visible = useMemo(() => results.filter(({ repo }) => hasTech(repo, tech)), [results, tech]);

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

  const setSearch = (next: IndexSearch) =>
    navigate({ search: (prev) => ({ ...prev, ...next }), replace: true });
  const setQuery = useCallback(
    (next: string) => navigate({ search: (prev) => ({ ...prev, q: next.trim() || undefined }), replace: true }),
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

  return (
    <>
      <SearchBar value={q ?? ""} onChange={setQuery} busy={searching && Boolean(q)} />
      <div className="mx-auto flex min-h-screen max-w-6xl flex-col gap-6 px-4 py-8 sm:px-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <h1 className="text-2xl font-semibold tracking-tight">Gitlib</h1>
            <p className="text-sm text-muted-foreground">
              {repos.length} {repos.length === 1 ? "repository" : "repositories"} · {described} described
            </p>
            {roots.length > 0 ? (
              <p className="mt-1 text-xs break-all text-muted-foreground">
                Scanning <span className="font-mono">{roots.join(", ")}</span>
              </p>
            ) : null}
          </div>
          <Button variant="outline" onClick={rescan} disabled={scanning}>
            <RefreshCw className={scanning ? "animate-spin" : undefined} aria-hidden />
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
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
                <span className="text-amber-700 dark:text-amber-400">
                  Showing basic matches only — {found.notice}
                </span>
              ) : (
                <>Showing basic matches (full-text search is turned off).</>
              )}
            </p>
          ) : null}

          {techCounts.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5" aria-label="Filter by technology">
              {techCounts.map(([name, { category, count }]) => (
                <button
                  key={name}
                  type="button"
                  onClick={() => toggleTech(name)}
                  aria-pressed={tech?.toLowerCase() === name.toLowerCase()}
                  className="rounded-full focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <TechBadge
                    name={`${name} · ${count}`}
                    category={category}
                    active={tech?.toLowerCase() === name.toLowerCase()}
                  />
                </button>
              ))}
              {tech || q ? (
                <Button variant="ghost" size="xs" onClick={() => setSearch({ q: undefined, tech: undefined })}>
                  <X aria-hidden /> Clear filters
                </Button>
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
          <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {visible.map(({ repo, highlights }) => (
              <li key={repo.id} className="flex">
                <RepoCard repo={repo} activeTech={tech} highlights={highlights} onToggleTech={toggleTech} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
