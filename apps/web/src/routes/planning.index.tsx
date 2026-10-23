import { Link, createFileRoute } from "@tanstack/react-router";
import { CircleCheck, CircleDot, HardDrive, KanbanSquare, Plus } from "lucide-react";
import { useMemo } from "react";
import { IssueFormDialog } from "#/components/issue-form-dialog";
import { Button } from "#/components/ui/button";
import { NativeSelect } from "#/components/ui/native-select";
import { Tabs, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { Badge } from "#/components/ui/badge";
import { formatDate } from "#/lib/format";
import { statusLabel } from "#/lib/issue-status";
import { getPlanning, type LocalIssueView } from "#/server/planning";

type IssueFilter = "open" | "closed" | "all";

interface PlanningSearch {
  /** Defaults to open issues. */
  state?: Exclude<IssueFilter, "open">;
  /** relativePath of the repo the list is narrowed to. */
  repo?: string;
}

export const Route = createFileRoute("/planning/")({
  validateSearch: (search: Record<string, unknown>): PlanningSearch => ({
    state: search.state === "closed" || search.state === "all" ? search.state : undefined,
    repo: typeof search.repo === "string" && search.repo ? search.repo : undefined,
  }),
  loader: () => getPlanning(),
  head: () => ({ meta: [{ title: "Planning · Gitlib" }] }),
  component: Planning,
});

function Planning() {
  const { repos, issues, limits, projects } = Route.useLoaderData();
  const { state = "open", repo } = Route.useSearch();
  const navigate = Route.useNavigate();

  // Counts follow the repo filter, so the tabs always describe the list beneath them.
  const inRepo = useMemo(() => (repo ? issues.filter((issue) => issue.repoPath === repo) : issues), [issues, repo]);
  const counts = useMemo(
    () => ({
      open: inRepo.filter((issue) => issue.state === "open").length,
      closed: inRepo.filter((issue) => issue.state === "closed").length,
      all: inRepo.length,
    }),
    [inRepo],
  );
  const visible = state === "all" ? inRepo : inRepo.filter((issue) => issue.state === state);

  // Only repos that have issues are worth filtering by, plus the one already chosen in the URL.
  const filterRepos = useMemo(
    () => [...new Set([...issues.map((issue) => issue.repoPath), ...(repo ? [repo] : [])])].sort(),
    [issues, repo],
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Planning</h1>
          <p className="text-sm text-muted-foreground">File and track work against any of your repositories.</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" asChild>
            <Link to="/planning/board" search={repo ? { repo } : {}}>
              <KanbanSquare aria-hidden /> Board
            </Link>
          </Button>
          <IssueFormDialog
            mode="create"
            repos={repos}
            defaultRepo={repo && repos.some((option) => option.relativePath === repo) ? repo : undefined}
            limits={limits}
            onSaved={(issue) => navigate({ to: "/planning/issues/$id", params: { id: String(issue.id) } })}
          >
            <Button disabled={repos.length === 0}>
              <Plus aria-hidden /> New issue
            </Button>
          </IssueFormDialog>
        </div>
      </header>

      <p className="inline-flex items-center gap-2 border bg-muted/40 px-3 py-2 text-sm">
        <HardDrive className="size-4 shrink-0" aria-hidden />
        <span>
          Issues here are stored in <span className="font-semibold">gitlib</span> only. They are not read from or sent to
          GitHub or GitLab.
        </span>
      </p>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <Tabs
          value={state}
          onValueChange={(next) =>
            navigate({ search: (prev) => ({ ...prev, state: next === "closed" || next === "all" ? next : undefined }), replace: true })
          }
        >
          <TabsList aria-label="Issue state" className="border-b-0">
            <TabsTrigger value="open">
              <CircleDot className="size-3.5" aria-hidden /> Open
              <span className="text-xs tabular-nums">{counts.open}</span>
            </TabsTrigger>
            <TabsTrigger value="closed">
              <CircleCheck className="size-3.5" aria-hidden /> Closed
              <span className="text-xs tabular-nums">{counts.closed}</span>
            </TabsTrigger>
            <TabsTrigger value="all">
              All <span className="text-xs tabular-nums">{counts.all}</span>
            </TabsTrigger>
          </TabsList>
        </Tabs>

        {filterRepos.length > 0 ? (
          <NativeSelect
            aria-label="Filter by repository"
            value={repo ?? ""}
            onChange={(event) =>
              navigate({ search: (prev) => ({ ...prev, repo: event.target.value || undefined }), replace: true })
            }
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
      </div>

      {repos.length === 0 ? (
        <p className="border-y py-10 text-center text-sm text-muted-foreground">
          Gitlib hasn't found any repositories yet, and issues are filed against a repository. Add a scan root and rescan
          on the Repositories page.
        </p>
      ) : visible.length === 0 ? (
        <p className="border-y py-10 text-center text-sm text-muted-foreground">
          {issues.length === 0
            ? "No issues yet. Choose New issue to file the first one."
            : `No ${state === "all" ? "" : `${state} `}issues${repo ? " in this repository" : ""}.`}
        </p>
      ) : (
        <ul className="divide-y border-y" data-testid="local-issue-list">
          {visible.map((issue) => (
            <IssueRow key={issue.id} issue={issue} projectName={projects.find((p) => p.id === issue.projectId)?.name} />
          ))}
        </ul>
      )}
    </div>
  );
}

function IssueRow({ issue, projectName }: { issue: LocalIssueView; projectName?: string }) {
  const open = issue.state === "open";
  const StateIcon = open ? CircleDot : CircleCheck;
  return (
    <li className="flex items-start gap-3 py-3">
      <StateIcon
        className={open ? "mt-0.5 size-4 shrink-0 text-primary" : "mt-0.5 size-4 shrink-0 text-muted-foreground"}
        aria-label={open ? "Open" : "Closed"}
      />
      <div className="min-w-0 flex-1">
        <Link
          to="/planning/issues/$id"
          params={{ id: String(issue.id) }}
          className="font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
        >
          {issue.title}
        </Link>
        <p className="mt-0.5 text-xs text-muted-foreground">
          <span className="font-mono" title={issue.repoPath}>
            {issue.repoName}#{issue.number}
          </span>
          {issue.repoKnown ? null : " (repository not found)"}
          {projectName ? ` · ${projectName}` : ""} · opened {formatDate(issue.createdAt)}
          {open ? ` · updated ${formatDate(issue.updatedAt)}` : issue.closedAt ? ` · closed ${formatDate(issue.closedAt)}` : ""}
        </p>
      </div>
      {open ? <Badge variant="outline">{statusLabel(issue.status)}</Badge> : null}
    </li>
  );
}
