import { Link, createFileRoute, notFound, useRouter } from "@tanstack/react-router";
import { ArrowLeft, CircleCheck, CircleDot, ExternalLink, Pencil, Plus, Trash2, X } from "lucide-react";
import { useState } from "react";
import { AddReposDialog } from "#/components/add-repos-dialog";
import { DeleteProjectDialog } from "#/components/delete-project-dialog";
import { MilestoneCards } from "#/components/milestone-cards";
import { ProjectGitHubPreview } from "#/components/project-github-preview";
import { ProjectNameDialog } from "#/components/project-name-dialog";
import { Button } from "#/components/ui/button";
import { NativeSelect } from "#/components/ui/native-select";
import { SearchSelect } from "#/components/ui/search-select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { statusLabel } from "#/lib/issue-status";
import { setIssueMilestone } from "#/server/milestones";
import { getProjectDetail, removeProjectRemote, removeProjectRepo, setIssueProject } from "#/server/projects";

const TABS = ["repositories", "issues", "github"] as const;
type ProjectTab = (typeof TABS)[number];

export const Route = createFileRoute("/projects/$id")({
  validateSearch: (search: Record<string, unknown>): { tab?: ProjectTab } => ({
    tab: TABS.find((tab) => tab === search.tab && tab !== "repositories"),
  }),
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
  const { tab = "repositories" } = Route.useSearch();
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
  const repoTotal = project.repos.length + project.remotes.length;

  // Without milestones the issues are one plain list. With them, each milestone gets a heading so it is clear
  // which issues count toward which, and issues in none come last.
  const issueGroups =
    project.milestones.length === 0
      ? [{ key: "all", heading: null, issues: project.issues }]
      : [
          ...project.milestones.map((milestone) => ({
            key: String(milestone.id),
            heading: milestone.title,
            issues: project.issues.filter((issue) => issue.milestoneId === milestone.id),
          })),
          {
            key: "none",
            heading: "No milestone",
            issues: project.issues.filter((issue) => issue.milestoneId === null),
          },
        ].filter((group) => group.issues.length > 0);

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

      <MilestoneCards projectId={project.id} milestones={project.milestones} limits={project.milestoneLimits} />

      <Tabs
        value={tab}
        onValueChange={(next) =>
          void navigate({ search: { tab: TABS.find((t) => t === next && t !== "repositories") }, replace: true })
        }
      >
        <TabsList aria-label="Project sections">
          <TabsTrigger value="repositories">
            Repositories <span className="font-normal text-muted-foreground">{repoTotal}</span>
          </TabsTrigger>
          <TabsTrigger value="issues">
            Gitlib issues <span className="font-normal text-muted-foreground">{project.issues.length}</span>
          </TabsTrigger>
          <TabsTrigger value="github">GitHub</TabsTrigger>
        </TabsList>

        <TabsContent value="repositories">
          <section aria-labelledby="project-repos" className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <h2 id="project-repos" className="text-lg font-semibold">
                Repositories <span className="text-sm font-normal text-muted-foreground">{repoTotal}</span>
              </h2>
              <AddReposDialog
                projectId={project.id}
                localRepos={project.availableRepos}
                remoteRepos={project.availableRemotes}
              >
                <Button variant="outline" disabled={busy}>
                  <Plus aria-hidden /> Add repositories
                </Button>
              </AddReposDialog>
            </div>
            {repoTotal === 0 ? (
              <p className="border-y py-6 text-center text-sm text-muted-foreground">
                No repositories in this project yet.
              </p>
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
                {project.remotes.map((remote) => {
                  const host = remote.provider === "github" ? "GitHub" : "GitLab";
                  return (
                    <li key={`${remote.provider}:${remote.fullName}`} className="flex items-center gap-3 py-2.5">
                      <div className="min-w-0 flex-1">
                        {remote.clonedAs ? (
                          <Link
                            to="/repos/$"
                            params={{ _splat: remote.clonedAs }}
                            className="font-mono text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {remote.fullName}
                          </Link>
                        ) : remote.url ? (
                          <a
                            href={remote.url}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 font-mono text-sm outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                          >
                            {remote.fullName} <ExternalLink className="size-3" aria-label={`Open on ${host}`} />
                          </a>
                        ) : (
                          <span className="font-mono text-sm">{remote.fullName}</span>
                        )}
                        <p className="text-xs text-muted-foreground">
                          {host} · {remote.clonedAs ? `cloned as ${remote.clonedAs}` : "not cloned"}
                        </p>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={`Remove ${remote.fullName} from this project`}
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () =>
                              removeProjectRemote({
                                data: { id: project.id, provider: remote.provider, fullName: remote.fullName },
                              }),
                            "Could not remove the repository.",
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
        </TabsContent>

        <TabsContent value="issues">
          <section aria-labelledby="project-issues" className="grid gap-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 id="project-issues" className="text-lg font-semibold">
                  Gitlib issues{" "}
                  <span className="text-sm font-normal text-muted-foreground">{project.issues.length}</span>
                </h2>
                <p className="text-sm text-muted-foreground">
                  Your own planning issues. They live in gitlib only and are never sent to GitHub.
                </p>
              </div>
              {project.unassignedIssues.length > 0 ? (
                <SearchSelect
                  aria-label="Add a gitlib issue"
                  placeholder="Add a gitlib issue…"
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
              <p className="border-y py-6 text-center text-sm text-muted-foreground">
                No gitlib issues in this project yet.
              </p>
            ) : (
              <div className="grid gap-4" data-testid="project-issue-list">
                {issueGroups.map((group) => (
                  <div key={group.key} className="grid gap-1">
                    {group.heading ? (
                      <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
                        {group.heading}
                        <span className="font-normal">{group.issues.length}</span>
                      </h3>
                    ) : null}
                    <ul className="divide-y border-y">
                      {group.issues.map((issue) => {
                        const open = issue.state === "open";
                        const StateIcon = open ? CircleDot : CircleCheck;
                        return (
                          <li key={issue.id} className="flex items-start gap-3 py-2.5">
                            <StateIcon
                              className={
                                open
                                  ? "mt-0.5 size-4 shrink-0 text-primary"
                                  : "mt-0.5 size-4 shrink-0 text-muted-foreground"
                              }
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
                            {project.milestones.length > 0 ? (
                              <NativeSelect
                                aria-label={`Milestone for ${issue.title}`}
                                value={issue.milestoneId ?? ""}
                                disabled={busy}
                                onChange={(event) =>
                                  void run(
                                    () =>
                                      setIssueMilestone({
                                        data: {
                                          issueId: issue.id,
                                          milestoneId: event.target.value ? Number(event.target.value) : null,
                                        },
                                      }),
                                    "Could not change the issue's milestone.",
                                  )
                                }
                                className="w-auto max-w-40"
                              >
                                <option value="">No milestone</option>
                                {project.milestones.map((milestone) => (
                                  <option key={milestone.id} value={milestone.id}>
                                    {milestone.title}
                                  </option>
                                ))}
                              </NativeSelect>
                            ) : null}
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
                  </div>
                ))}
              </div>
            )}
          </section>
        </TabsContent>

        <TabsContent value="github">
          <ProjectGitHubPreview
            projectId={project.id}
            repoPaths={[
              ...project.repos.map((repo) => repo.relativePath),
              ...project.remotes.filter((remote) => remote.provider === "github").map((remote) => remote.fullName),
            ]}
          />
        </TabsContent>
      </Tabs>
    </div>
  );
}
