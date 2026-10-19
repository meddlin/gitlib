import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { RefreshCw, Search, Settings, X } from "lucide-react";
import { useMemo, useState } from "react";
import { RepoCard } from "#/components/repo-card";
import { TechBadge } from "#/components/tech-badge";
import { Button } from "#/components/ui/button";
import { Input } from "#/components/ui/input";
import { getRepos, rescanRepos, type RepoView } from "#/server/repos";

interface IndexSearch {
  q?: string;
  tech?: string;
}

export const Route = createFileRoute("/")({
  validateSearch: (search: Record<string, unknown>): IndexSearch => ({
    q: typeof search.q === "string" && search.q ? search.q : undefined,
    tech: typeof search.tech === "string" && search.tech ? search.tech : undefined,
  }),
  loader: () => getRepos(),
  component: RepoLibrary,
});

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
  const { repos, roots } = Route.useLoaderData();
  const { q, tech } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [scanning, setScanning] = useState(false);

  const visible = useMemo(() => repos.filter((repo) => matches(repo, q, tech)), [repos, q, tech]);

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
        <div className="flex items-center gap-2">
          <Button variant="outline" onClick={rescan} disabled={scanning}>
            <RefreshCw className={scanning ? "animate-spin" : undefined} aria-hidden />
            {scanning ? "Scanning…" : "Rescan"}
          </Button>
          <Button asChild variant="outline" size="icon" aria-label="Settings">
            <Link to="/settings">
              <Settings aria-hidden />
            </Link>
          </Button>
        </div>
      </header>

      <div className="flex flex-col gap-3">
        <div className="relative">
          <Search
            className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
            aria-hidden
          />
          <Input
            type="search"
            placeholder="Search by name, path, description or technology"
            aria-label="Search repositories"
            className="pl-9"
            value={q ?? ""}
            onChange={(event) => setSearch({ q: event.target.value || undefined })}
          />
        </div>

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
          {visible.map((repo) => (
            <li key={repo.id} className="flex">
              <RepoCard repo={repo} activeTech={tech} onToggleTech={toggleTech} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyState({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded-lg border border-dashed p-10 text-center text-sm text-muted-foreground">
      {children}
    </div>
  );
}
