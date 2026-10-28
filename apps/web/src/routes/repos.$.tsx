import { Link, createFileRoute, notFound } from "@tanstack/react-router";
import { ArrowLeft, CircleDot, GitPullRequest, HeartPulse } from "lucide-react";
import { RepoCommunity } from "#/components/repo-community";
import { RepoIssues } from "#/components/repo-issues";
import { RepoPulls } from "#/components/repo-pulls";
import { RepoOverview } from "#/components/repo-overview";
import { useLibraryState } from "#/lib/library-state";
import { useRepoTabs } from "#/lib/repo-tabs";
import { TechBadge } from "#/components/tech-badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs";
import { getRepo } from "#/server/repos";

const TABS = ["overview", "issues", "pulls", "community"] as const;
type RepoTab = (typeof TABS)[number];

export const Route = createFileRoute("/repos/$")({
  // The splat holds the repo's relativePath, which may contain slashes.
  loader: async ({ params }) => {
    const repo = await getRepo({ data: { relativePath: params._splat ?? "" } });
    if (!repo) throw notFound();
    return repo;
  },
  validateSearch: (search: Record<string, unknown>): { tab?: RepoTab } => ({
    tab: TABS.find((tab) => tab === search.tab && tab !== "overview"),
  }),
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.name ?? "Repository"} · Gitlib` }] }),
  notFoundComponent: RepoNotFound,
  component: RepoDetail,
});

function BackLink() {
  const library = useLibraryState();
  return (
    <Link
      to="/"
      search={library}
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> Repositories
    </Link>
  );
}

function RepoNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <BackLink />
      <p className="border-y py-10 text-center text-sm text-muted-foreground">
        Gitlib doesn't know that repository. It may have moved or been removed; try a rescan.
      </p>
    </div>
  );
}

function RepoDetail() {
  const repo = Route.useLoaderData();
  const { tab: requestedTab = "overview" } = Route.useSearch();
  const navigate = Route.useNavigate();
  const [visibleTabs] = useRepoTabs();
  // A link to a tab that has since been switched off in Settings lands on Overview.
  const tab = requestedTab !== "overview" && !visibleTabs[requestedTab] ? "overview" : requestedTab;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <BackLink />
      <header className="min-w-0">
        <h1 className="truncate text-2xl font-semibold tracking-tight">{repo.name}</h1>
        <p className="truncate font-mono text-xs text-muted-foreground" title={repo.absolutePath}>
          {repo.relativePath}
        </p>
        {repo.technologies.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1">
            {repo.technologies.map((t) => (
              <TechBadge key={t.name} name={t.name} category={t.category} />
            ))}
          </div>
        ) : null}
      </header>

      <Tabs
        value={tab}
        onValueChange={(next) =>
          navigate({ search: { tab: TABS.find((t) => t === next && t !== "overview") }, replace: true })
        }
      >
        <TabsList aria-label="Repository sections">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          {visibleTabs.issues ? (
            <TabsTrigger value="issues">
              <CircleDot className="size-3.5" aria-hidden />
              Issues
            </TabsTrigger>
          ) : null}
          {visibleTabs.pulls ? (
            <TabsTrigger value="pulls">
              <GitPullRequest className="size-3.5" aria-hidden />
              Pull requests
            </TabsTrigger>
          ) : null}
          {visibleTabs.community ? (
            <TabsTrigger value="community">
              <HeartPulse className="size-3.5" aria-hidden />
              Community
            </TabsTrigger>
          ) : null}
        </TabsList>
        <TabsContent value="overview">
          <RepoOverview repo={repo} />
        </TabsContent>
        {visibleTabs.issues ? (
          <TabsContent value="issues">
            <RepoIssues relativePath={repo.relativePath} />
          </TabsContent>
        ) : null}
        {visibleTabs.pulls ? (
          <TabsContent value="pulls">
            <RepoPulls relativePath={repo.relativePath} />
          </TabsContent>
        ) : null}
        {visibleTabs.community ? (
          <TabsContent value="community">
            <RepoCommunity relativePath={repo.relativePath} canPlan={!repo.isWorktree} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}
