import { Link, createFileRoute } from "@tanstack/react-router";
import { Archive, FolderKanban, Plus } from "lucide-react";
import { ProjectNameDialog } from "#/components/project-name-dialog";
import { Button } from "#/components/ui/button";
import { getProjects, type ProjectSummary } from "#/server/projects";

export const Route = createFileRoute("/projects/")({
  loader: () => getProjects(),
  head: () => ({ meta: [{ title: "Projects · Gitlib" }] }),
  component: Projects,
});

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Projects() {
  const { projects, nameLimit } = Route.useLoaderData();
  const navigate = Route.useNavigate();
  const active = projects.filter((project) => !project.archived);
  const archived = projects.filter((project) => project.archived);

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Projects</h1>
          <p className="text-sm text-muted-foreground">Organize repositories and issues into projects.</p>
        </div>
        <ProjectNameDialog
          mode="create"
          nameLimit={nameLimit}
          onSaved={(project) => navigate({ to: "/projects/$id", params: { id: String(project.id) } })}
        >
          <Button>
            <Plus aria-hidden /> New project
          </Button>
        </ProjectNameDialog>
      </header>

      {active.length === 0 ? (
        <p className="border-y py-10 text-center text-sm text-muted-foreground">
          {archived.length === 0
            ? "No projects yet. Choose New project to create the first one."
            : "No active projects. Choose New project to start one."}
        </p>
      ) : (
        <ProjectList projects={active} testId="project-list" />
      )}

      {archived.length > 0 ? (
        <section aria-labelledby="archived-projects" className="grid gap-2">
          <h2 id="archived-projects" className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Archive className="size-3.5" aria-hidden /> Archived <span className="font-normal">{archived.length}</span>
          </h2>
          <ProjectList projects={archived} testId="archived-project-list" />
        </section>
      ) : null}
    </div>
  );
}

function ProjectList({ projects, testId }: { projects: ProjectSummary[]; testId: string }) {
  return (
    <ul className="divide-y border-y" data-testid={testId}>
      {projects.map((project) => (
        <li key={project.id} className="flex items-center gap-3 py-3">
          {project.archived ? (
            <Archive className="size-4 shrink-0 text-muted-foreground" aria-label="Archived" />
          ) : (
            <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <div className="min-w-0 flex-1">
            <Link
              to="/projects/$id"
              params={{ id: String(project.id) }}
              className={
                project.archived
                  ? "font-medium text-muted-foreground outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  : "font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              }
            >
              {project.name}
            </Link>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {count(project.repoCount, "repository", "repositories")} · {count(project.issueCount, "gitlib issue", "gitlib issues")}
              {project.issueCount > 0 ? ` (${project.openIssueCount} open)` : ""}
            </p>
          </div>
        </li>
      ))}
    </ul>
  );
}
