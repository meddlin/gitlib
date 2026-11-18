import { Link, createFileRoute, useRouter } from "@tanstack/react-router";
import { Archive, ArchiveRestore, ArrowLeft, Link2, Pencil, TriangleAlert } from "lucide-react";
import { useState } from "react";
import { RelinkPlanningRepoDialog, RenamePlanningRepoDialog } from "#/components/planning-repo-dialogs";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import type { PlanningRepoOption } from "#/server/planning";
import { getPlanningRepos, setPlanningRepoArchived, type PlanningRepoView } from "#/server/planning-repos";

export const Route = createFileRoute("/planning/repos")({
  loader: () => getPlanningRepos(),
  head: () => ({ meta: [{ title: "Repos · Planning · Gitlib" }] }),
  component: PlanningRepos,
});

function PlanningRepos() {
  const { repos, relinkTargets, slugLimit } = Route.useLoaderData();
  const router = useRouter();
  const [busyId, setBusyId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function setArchived(repo: PlanningRepoView, archived: boolean) {
    setBusyId(repo.id);
    setError(null);
    try {
      await setPlanningRepoArchived({ data: { id: repo.id, archived } });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `Could not ${archived ? "archive" : "restore"} ${repo.slug}.`);
    } finally {
      setBusyId(null);
    }
  }

  const active = repos.filter((repo) => !repo.archived);
  const archived = repos.filter((repo) => repo.archived);
  const lost = active.filter((repo) => !repo.found).length;

  const row = (repo: PlanningRepoView) => (
    <RepoRow
      key={repo.id}
      repo={repo}
      targets={relinkTargets}
      slugLimit={slugLimit}
      busy={busyId === repo.id}
      onArchive={(next) => void setArchived(repo, next)}
    />
  );

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <Link
        to="/planning"
        className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
      >
        <ArrowLeft className="size-3.5" aria-hidden /> Planning
      </Link>

      <header>
        <h1 className="text-2xl font-semibold tracking-tight">Repos in planning</h1>
        <p className="text-sm text-muted-foreground">
          Every repo an issue or project uses. Issues follow a repo by its id, so renaming it, moving it or relinking it
          keeps them; only the short name they are shown under changes when you rename.
        </p>
      </header>

      {lost > 0 ? (
        <p role="status" className="inline-flex items-start gap-2 border bg-muted/40 px-3 py-2 text-sm">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            {lost === 1 ? "One repo wasn't" : `${lost} repos weren't`} found where planning expects{" "}
            {lost === 1 ? "it" : "them"} in the last scan. Use <span className="font-semibold">Relink</span> to point a
            repo that moved at where it is now.
          </span>
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {repos.length === 0 ? (
        <p className="border-y py-10 text-center text-sm text-muted-foreground">
          No repos in planning yet. One is added the first time an issue or project uses it.
        </p>
      ) : (
        <>
          {active.length > 0 ? (
            <ul className="divide-y border-y" aria-label="Repos in planning" data-testid="planning-repo-list">
              {active.map(row)}
            </ul>
          ) : (
            <p className="border-y py-6 text-center text-sm text-muted-foreground">Every repo in planning is archived.</p>
          )}

          {archived.length > 0 ? (
            <section className="grid gap-2" aria-labelledby="archived-repos">
              <div>
                <h2 id="archived-repos" className="text-lg font-semibold tracking-tight">
                  Archived
                </h2>
                <p className="text-sm text-muted-foreground">
                  Their issues are kept but hidden from the planning list and board, they take no new issues or projects,
                  and gitlib stops following them when they move.
                </p>
              </div>
              <ul className="divide-y border-y" aria-label="Archived repos" data-testid="archived-planning-repo-list">
                {archived.map(row)}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}

function RepoRow({
  repo,
  targets,
  slugLimit,
  busy,
  onArchive,
}: {
  repo: PlanningRepoView;
  targets: readonly PlanningRepoOption[];
  slugLimit: number;
  busy: boolean;
  onArchive: (archived: boolean) => void;
}) {
  const issues =
    repo.issueCount === 0
      ? "no issues"
      : `${repo.openIssueCount} open of ${repo.issueCount} issue${repo.issueCount === 1 ? "" : "s"}`;

  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 py-3" data-repo-id={repo.id}>
      <div className="min-w-0 flex-1">
        <p className="flex flex-wrap items-center gap-2">
          <span className="font-mono font-medium">{repo.slug}</span>
          {repo.found ? null : (
            <Badge variant="destructive" title="The last scan found nothing at this path.">
              Not found
            </Badge>
          )}
          {repo.archived ? <Badge variant="secondary">Archived</Badge> : null}
        </p>
        <p className="mt-0.5 flex flex-wrap gap-x-1 text-xs text-muted-foreground">
          {repo.found ? (
            <Link
              to="/repos/$"
              params={{ _splat: repo.path }}
              className="font-mono break-all outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {repo.path}
            </Link>
          ) : (
            <span className="font-mono break-all" title="Where gitlib last found it">
              {repo.path}
            </span>
          )}
          <span aria-hidden>·</span>
          {repo.issueCount > 0 && !repo.archived ? (
            <Link
              to="/planning"
              search={{ repo: repo.path, state: "all" }}
              className="outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {issues}
            </Link>
          ) : (
            <span>{issues}</span>
          )}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {repo.found ? null : (
          <RelinkPlanningRepoDialog repo={repo} targets={targets}>
            <Button variant="outline" size="sm" aria-label={`Relink ${repo.slug}`}>
              <Link2 aria-hidden /> Relink
            </Button>
          </RelinkPlanningRepoDialog>
        )}
        <RenamePlanningRepoDialog repo={repo} slugLimit={slugLimit}>
          <Button variant="outline" size="sm" aria-label={`Rename ${repo.slug}`}>
            <Pencil aria-hidden /> Rename
          </Button>
        </RenamePlanningRepoDialog>
        <Button
          variant="outline"
          size="sm"
          disabled={busy}
          aria-label={`${repo.archived ? "Restore" : "Archive"} ${repo.slug}`}
          onClick={() => onArchive(!repo.archived)}
        >
          {repo.archived ? (
            <>
              <ArchiveRestore aria-hidden /> Restore
            </>
          ) : (
            <>
              <Archive aria-hidden /> Archive
            </>
          )}
        </Button>
      </div>
    </li>
  );
}
