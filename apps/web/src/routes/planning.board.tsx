import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { List } from "lucide-react";
import { useEffect, useMemo, useState, type DragEvent } from "react";
import { Button } from "#/components/ui/button";
import { NativeSelect } from "#/components/ui/native-select";
import { STATUS_COLUMNS, isStatus, statusLabel } from "#/lib/issue-status";
import { cn } from "#/lib/utils";
import { getPlanning, setLocalIssueStatus, type LocalIssueView } from "#/server/planning";

interface BoardSearch {
  /** relativePath of the repo the board is narrowed to. */
  repo?: string;
}

export const Route = createFileRoute("/planning/board")({
  validateSearch: (search: Record<string, unknown>): BoardSearch => ({
    repo: typeof search.repo === "string" && search.repo ? search.repo : undefined,
  }),
  loader: () => getPlanning(),
  head: () => ({ meta: [{ title: "Board · Planning · Gitlib" }] }),
  component: Board,
});

const DRAG_TYPE = "application/x-gitlib-issue";

function Board() {
  const { issues } = Route.useLoaderData();
  const { repo } = Route.useSearch();
  const navigate = Route.useNavigate();
  const router = useRouter();

  // Moves apply to the board at once and are reconciled with the server's answer afterwards.
  const [overrides, setOverrides] = useState<Record<number, LocalIssueView["status"]>>({});
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);

  // Fresh loader data is authoritative.
  useEffect(() => setOverrides({}), [issues]);

  const filterRepos = useMemo(
    () => [...new Set([...issues.map((issue) => issue.repoPath), ...(repo ? [repo] : [])])].sort(),
    [issues, repo],
  );

  const columns = useMemo(() => {
    const scoped = (repo ? issues.filter((issue) => issue.repoPath === repo) : issues).map((issue) => ({
      ...issue,
      status: overrides[issue.id] ?? issue.status,
    }));
    return STATUS_COLUMNS.map((column) => ({
      ...column,
      issues: scoped.filter((issue) => issue.status === column.status),
    }));
  }, [issues, repo, overrides]);

  async function move(id: number, status: LocalIssueView["status"]) {
    const current = issues.find((issue) => issue.id === id);
    if (!current || (overrides[id] ?? current.status) === status) return;
    setError(null);
    setOverrides((prev) => ({ ...prev, [id]: status }));
    try {
      await setLocalIssueStatus({ data: { id, status } });
      await router.invalidate();
    } catch (caught) {
      setOverrides((prev) => {
        const { [id]: _discarded, ...rest } = prev;
        return rest;
      });
      setError(caught instanceof Error ? caught.message : "Could not move the issue.");
    }
  }

  function drop(event: DragEvent, status: LocalIssueView["status"]) {
    event.preventDefault();
    setDragOver(null);
    const id = Number(event.dataTransfer.getData(DRAG_TYPE));
    if (Number.isInteger(id) && id > 0) void move(id, status);
  }

  return (
    <div className="flex w-full flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Board</h1>
          <p className="text-sm text-muted-foreground">
            Drag an issue between columns to change its status. Moving to Done closes it.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {filterRepos.length > 0 ? (
            <NativeSelect
              aria-label="Filter by repository"
              value={repo ?? ""}
              onChange={(event) => navigate({ search: { repo: event.target.value || undefined }, replace: true })}
              className="w-auto max-w-full sm:max-w-xs"
            >
              <option value="">All repositories</option>
              {filterRepos.map((path) => (
                <option key={path} value={path}>
                  {path}
                </option>
              ))}
            </NativeSelect>
          ) : null}
          <Button variant="outline" asChild>
            <Link to="/planning" search={repo ? { repo } : {}}>
              <List aria-hidden /> List
            </Link>
          </Button>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <div className="grid flex-1 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4" data-testid="issue-board">
        {columns.map((column) => (
          <section
            key={column.status}
            aria-label={column.label}
            data-testid={`column-${column.status}`}
            onDragOver={(event) => {
              event.preventDefault();
              setDragOver(column.status);
            }}
            onDragLeave={(event) => {
              if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(null);
            }}
            onDrop={(event) => drop(event, column.status)}
            className={cn(
              "flex min-h-40 flex-col gap-2 border bg-muted/30 p-2 transition-colors",
              dragOver === column.status && "border-ring bg-muted/70",
            )}
          >
            <h2 className="flex items-center justify-between px-1 py-1 text-sm font-semibold">
              {column.label}
              <span className="text-xs font-normal tabular-nums text-muted-foreground">{column.issues.length}</span>
            </h2>
            {column.issues.length === 0 ? (
              <p className="px-1 py-4 text-center text-xs text-muted-foreground">No issues</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {column.issues.map((issue) => (
                  <BoardCard key={issue.id} issue={issue} onMove={(status) => move(issue.id, status)} />
                ))}
              </ul>
            )}
          </section>
        ))}
      </div>
    </div>
  );
}

function BoardCard({
  issue,
  onMove,
}: {
  issue: LocalIssueView;
  onMove: (status: LocalIssueView["status"]) => void;
}) {
  return (
    <li
      draggable
      onDragStart={(event) => {
        event.dataTransfer.setData(DRAG_TYPE, String(issue.id));
        event.dataTransfer.effectAllowed = "move";
      }}
      className="cursor-grab border bg-card p-3 text-card-foreground shadow-xs active:cursor-grabbing"
    >
      <Link
        to="/planning/issues/$id"
        params={{ id: String(issue.id) }}
        draggable={false}
        className="text-sm font-medium break-words outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
      >
        {issue.title}
      </Link>
      <p className="mt-1 font-mono text-xs text-muted-foreground" title={issue.repoPath}>
        {issue.repoName}#{issue.number}
      </p>
      {/* The keyboard and touch route to the same move that dragging makes. */}
      <NativeSelect
        aria-label={`Status of ${issue.title}`}
        value={issue.status}
        onChange={(event) => {
          if (isStatus(event.target.value)) onMove(event.target.value);
        }}
        className="mt-2 h-8 text-xs md:text-xs"
      >
        {STATUS_COLUMNS.map((column) => (
          <option key={column.status} value={column.status}>
            {statusLabel(column.status)}
          </option>
        ))}
      </NativeSelect>
    </li>
  );
}
