import { Link, createFileRoute } from "@tanstack/react-router";
import { FolderKanban, Plus } from "lucide-react";
import { ProjectNameDialog } from "#/components/project-name-dialog";
import { Button } from "#/components/ui/button";
import { getProjects } from "#/server/projects";

export const Route = createFileRoute("/projects/")({
  loader: () => getProjects(),
  head: () => ({ meta: [{ title: "Projects · Gitlib" }] }),
  component: Projects,
});

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function Projects() {
  const { projects, nameLimit } = Route.useLoaderData();
  const navigate = Route.useNavigate();

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

      {projects.length === 0 ? (
        <p className="border-y py-10 text-center text-sm text-muted-foreground">
          No projects yet. Choose New project to create the first one.
        </p>
      ) : (
        <ul className="divide-y border-y" data-testid="project-list">
          {projects.map((project) => (
            <li key={project.id} className="flex items-center gap-3 py-3">
              <FolderKanban className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <div className="min-w-0 flex-1">
                <Link
                  to="/projects/$id"
                  params={{ id: String(project.id) }}
                  className="font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {project.name}
                </Link>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {count(project.repoCount, "repository", "repositories")} · {count(project.issueCount, "issue", "issues")}
                  {project.issueCount > 0 ? ` (${project.openIssueCount} open)` : ""}
                </p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
