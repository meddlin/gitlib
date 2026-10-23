import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, CircleDot, Pencil, Trash2, X } from "lucide-react";
import { useState } from "react";
import { DeleteProjectDialog } from "#/components/delete-project-dialog";
import { ProjectNameDialog } from "#/components/project-name-dialog";
import { Button } from "#/components/ui/button";
import { SearchSelect } from "#/components/ui/search-select";
import { statusLabel } from "#/lib/issue-status";
import { addProjectRepo, getProjectDetail, removeProjectRepo, setIssueProject } from "#/server/projects";

export const Route = createFileRoute("/projects/$id")({
  loader: async ({ params }) => {
    const id = Number(params.id);
    const detail = Number.isInteger(id) && id > 0 ? await getProjectDetail({ data: { id } }) : null;
    if (!detail) throw notFound();
    return detail;
  },
  head: ({ loaderData }) => ({
    meta: [{ title: `${loaderData ? `${loaderData.name} · ` : ""}Projects · Gitlib` }],
  }),
  notFoundComponent: ProjectNotFound,
  component: ProjectDetailPage,
});

function BackLink() {
  return (
    <Link
      to="/projects"
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> Projects
    </Link>
  );
}

function ProjectNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <BackLink />
      <p className="border-y py-10 text-center text-sm text-muted-foreground">Gitlib doesn't have that project.</p>
    </div>
  );
}

function ProjectDetailPage() {
  const project = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function run(action: () => Promise<unknown>, fallback: string) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setBusy(false);
    }
  }

  const self = { id: project.id, name: project.name };

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <BackLink />

      <header className="flex flex-wrap items-start justify-between gap-3">
        <h1 className="min-w-0 text-2xl font-semibold tracking-tight break-words">{project.name}</h1>
        <div className="flex items-center gap-2">
          <ProjectNameDialog mode="rename" project={self} nameLimit={project.nameLimit}>
            <Button variant="outline">
              <Pencil aria-hidden /> Rename
            </Button>
          </ProjectNameDialog>
          <DeleteProjectDialog project={self} onDeleted={() => navigate({ to: "/projects" })}>
            <Button variant="outline">
              <Trash2 aria-hidden /> Delete
            </Button>
          </DeleteProjectDialog>
        </div>
      </header>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <section aria-labelledby="project-repos" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="project-repos" className="text-lg font-semibold">
            Repositories <span className="text-sm font-normal text-muted-foreground">{project.repos.length}</span>
          </h2>
          {project.availableRepos.length > 0 ? (
            <SearchSelect
              aria-label="Add a repository"
              placeholder="Add a repository…"
              searchPlaceholder="Search repositories…"
              emptyText="No matching repositories."
              disabled={busy}
              options={project.availableRepos.map((repo) => ({ value: repo.relativePath, label: repo.relativePath }))}
              onSelect={(repo) =>
                void run(() => addProjectRepo({ data: { id: project.id, repo } }), "Could not add the repository.")
              }
              className="sm:w-72"
            />
          ) : null}
        </div>
        {project.repos.length === 0 ? (
          <p className="border-y py-6 text-center text-sm text-muted-foreground">No repositories in this project yet.</p>
        ) : (
          <ul className="divide-y border-y" data-testid="project-repo-list">
            {project.repos.map((repo) => (
              <li key={repo.relativePath} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  {repo.known ? (
                    <Link
                      to="/repos/$"
                      params={{ _splat: repo.relativePath }}
                      className="font-mono text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {repo.relativePath}
                    </Link>
                  ) : (
                    <span className="font-mono text-sm" title="Gitlib no longer finds this repository.">
                      {repo.relativePath} (not found)
                    </span>
                  )}
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${repo.relativePath} from this project`}
                  disabled={busy}
                  onClick={() =>
                    void run(
                      () => removeProjectRepo({ data: { id: project.id, repo: repo.relativePath } }),
                      "Could not remove the repository.",
                    )
                  }
                >
                  <X aria-hidden />
                </Button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="project-issues" className="grid gap-3">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="project-issues" className="text-lg font-semibold">
            Issues <span className="text-sm font-normal text-muted-foreground">{project.issues.length}</span>
          </h2>
          {project.unassignedIssues.length > 0 ? (
            <SearchSelect
              aria-label="Add an issue"
              placeholder="Add an issue…"
              searchPlaceholder="Search issues…"
              emptyText="No matching issues."
              disabled={busy}
              options={project.unassignedIssues.map((issue) => ({
                value: String(issue.id),
                label: `${issue.repoName}#${issue.number} ${issue.title}`,
              }))}
              onSelect={(value) =>
                void run(
                  () => setIssueProject({ data: { issueId: Number(value), projectId: project.id } }),
                  "Could not add the issue.",
                )
              }
              className="sm:w-72"
            />
          ) : null}
        </div>
        {project.issues.length === 0 ? (
          <p className="border-y py-6 text-center text-sm text-muted-foreground">No issues in this project yet.</p>
        ) : (
          <ul className="divide-y border-y" data-testid="project-issue-list">
            {project.issues.map((issue) => {
              const open = issue.state === "open";
              const StateIcon = open ? CircleDot : CircleCheck;
              return (
                <li key={issue.id} className="flex items-start gap-3 py-2.5">
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
                      {open ? ` · ${statusLabel(issue.status)}` : " · Closed"}
                    </p>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Remove ${issue.title} from this project`}
                    disabled={busy}
                    onClick={() =>
                      void run(
                        () => setIssueProject({ data: { issueId: issue.id, projectId: null } }),
                        "Could not remove the issue.",
                      )
                    }
                  >
                    <X aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </div>
  );
}
