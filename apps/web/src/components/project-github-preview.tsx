import { ExternalLink, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";
import { PROVIDERS } from "#/components/provider-banner";
import { Button } from "#/components/ui/button";
import { formatAgo } from "#/lib/format";
import { getProjectGitHub, type GitHubList, type ProjectGitHubRepo, type ProjectGitHubView } from "#/server/project-github";

/** Items listed per kind before the rest are left to GitHub. */
const SHOWN = 5;

const GitHubMark = PROVIDERS.github.icon;

/** "7", "50+" when GitHub has more than gitlib fetched, "–" when the lookup failed. */
function countOf(list: GitHubList<unknown>): string {
  if (list.error !== null) return "–";
  return `${list.items.length}${list.hasMore ? "+" : ""}`;
}

function sumOf(repos: readonly ProjectGitHubRepo[], pick: (repo: ProjectGitHubRepo) => GitHubList<unknown>): string {
  const lists = repos.map(pick).filter((list) => list.error === null);
  if (lists.length === 0) return "–";
  const total = lists.reduce((sum, list) => sum + list.items.length, 0);
  return `${total}${lists.some((list) => list.hasMore) ? "+" : ""}`;
}

/**
 * What GitHub currently holds for the project's repos. It is a separate block with its own heading and
 * wording, every row links out to GitHub, and nothing here can be edited, assigned or filed: gitlib's own
 * issues (above) are the only ones this app owns.
 */
export function ProjectGitHubPreview({ projectId, repoPaths }: { projectId: number; repoPaths: readonly string[] }) {
  const [state, setState] = useState<
    { status: "loading" } | { status: "error"; message: string } | { status: "done"; view: ProjectGitHubView }
  >({ status: "loading" });
  // Bumped by Refresh. Starts at 0 so that opening the page may use GitHub data cached a few minutes ago.
  const [refreshes, setRefreshes] = useState(0);
  const repoKey = repoPaths.join("\n");

  useEffect(() => {
    if (repoPaths.length === 0) return;
    let cancelled = false;
    setState((previous) => (previous.status === "done" ? previous : { status: "loading" }));
    getProjectGitHub({ data: { id: projectId, refresh: refreshes > 0 } })
      .then((view) => !cancelled && setState({ status: "done", view }))
      .catch((caught: unknown) => {
        if (!cancelled) {
          setState({ status: "error", message: caught instanceof Error ? caught.message : "Could not load GitHub." });
        }
      });
    return () => {
      cancelled = true;
    };
    // `repoKey` stands in for `repoPaths`, which is a new array on every render.
  }, [projectId, repoKey, refreshes]);

  const loading = state.status === "loading";

  return (
    <section aria-labelledby="project-github" className="grid gap-3 border bg-muted/30 p-4" data-testid="project-github">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 id="project-github" className="inline-flex items-center gap-2 text-lg font-semibold">
            <GitHubMark className="size-5" aria-hidden /> On GitHub
            <span className="border px-1.5 py-px text-xs font-normal text-muted-foreground">Read-only preview</span>
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Pulled live from GitHub for the repositories above and kept in memory for a few minutes. Gitlib does not save, edit
            or sync any of it, and the issues you file in gitlib are never sent here.
          </p>
        </div>
        {repoPaths.length > 0 ? (
          <Button variant="outline" disabled={loading} onClick={() => setRefreshes((n) => n + 1)}>
            <RefreshCw className={loading ? "animate-spin" : undefined} aria-hidden /> Refresh
          </Button>
        ) : null}
      </div>

      {repoPaths.length === 0 ? (
        <p className="text-sm text-muted-foreground">Add a repository to this project to see what is open on GitHub.</p>
      ) : state.status === "loading" ? (
        <p className="text-sm text-muted-foreground">Loading from GitHub…</p>
      ) : state.status === "error" ? (
        <p role="alert" className="text-sm text-destructive">
          {state.message}
        </p>
      ) : (
        <Loaded view={state.view} />
      )}
    </section>
  );
}

function Loaded({ view }: { view: ProjectGitHubView }) {
  const linked = view.repos.filter((repo) => repo.slug !== null);
  const unlinked = view.repos.filter((repo) => repo.slug === null);

  return (
    <>
      {linked.length > 0 ? (
        <p className="text-sm" data-testid="github-totals">
          <strong className="font-semibold">{sumOf(linked, (repo) => repo.pulls)}</strong> open PRs ·{" "}
          <strong className="font-semibold">{sumOf(linked, (repo) => repo.issues)}</strong> open issues on GitHub, across{" "}
          {linked.length} {linked.length === 1 ? "repository" : "repositories"}
        </p>
      ) : null}

      {!view.hasToken ? (
        <p className="text-sm text-muted-foreground">
          No GitHub token is set, so private repositories are hidden and GitHub allows only a few lookups an hour. Set{" "}
          <code className="font-mono">GITHUB_TOKEN</code> to lift that.
        </p>
      ) : null}

      {linked.length > 0 ? (
        <ul className="divide-y border-y bg-background" data-testid="github-repo-list">
          {linked.map((repo) => (
            <RepoActivity key={repo.relativePath} repo={repo} />
          ))}
        </ul>
      ) : null}

      {unlinked.length > 0 ? (
        <ul className="grid gap-1 text-sm text-muted-foreground" data-testid="github-unlinked">
          {unlinked.map((repo) => (
            <li key={repo.relativePath}>
              <span className="font-mono">{repo.relativePath}</span>{" "}
              {repo.error ? `· ${repo.error}` : "· no GitHub remote, so nothing to show."}
            </li>
          ))}
        </ul>
      ) : null}

      <p className="text-xs text-muted-foreground">Checked {formatAgo(view.fetchedAt) || "just now"}.</p>
    </>
  );
}

function RepoActivity({ repo }: { repo: ProjectGitHubRepo }) {
  const slug = repo.slug ?? repo.relativePath;
  const latest = repo.commits.items[0];
  // GitHub refusing a whole repo (not found, rate limited) fails all three lists the same way; say it once.
  const sharedError =
    repo.pulls.error !== null && repo.pulls.error === repo.issues.error && repo.issues.error === repo.commits.error
      ? repo.pulls.error
      : null;
  return (
    <li>
      <details className="group">
        <summary className="flex cursor-pointer flex-wrap items-center gap-x-4 gap-y-1 px-3 py-2.5 outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span className="min-w-0 flex-1 font-mono text-sm">{slug}</span>
          <span className="text-xs text-muted-foreground">
            {countOf(repo.pulls)} PRs · {countOf(repo.issues)} issues
            {latest?.committedAt ? ` · last commit ${formatAgo(latest.committedAt)}` : ""}
          </span>
        </summary>
        {sharedError !== null ? (
          <p role="alert" className="border-t px-3 py-3 text-sm text-destructive">
            {sharedError}
          </p>
        ) : (
          <div className="grid gap-4 border-t px-3 py-3">
            <Section
              title="Open pull requests"
              list={repo.pulls}
              slug={slug}
              moreUrl={`${repo.url}/pulls`}
              empty="No open pull requests."
              render={(pull) => ({
                key: pull.number,
                url: pull.url,
                title: pull.title,
                ref: `${slug}#${pull.number}`,
                meta: `${pull.author ? `${pull.author} · ` : ""}updated ${formatAgo(pull.updatedAt)}`,
                badge: pull.draft ? "Draft" : null,
              })}
            />
            <Section
              title="Open issues"
              list={repo.issues}
              slug={slug}
              moreUrl={`${repo.url}/issues`}
              empty="No open issues."
              render={(issue) => ({
                key: issue.number,
                url: issue.url,
                title: issue.title,
                ref: `${slug}#${issue.number}`,
                meta: `${issue.author ? `${issue.author} · ` : ""}updated ${formatAgo(issue.updatedAt)}`,
                badge: null,
              })}
            />
            <Section
              title="Recent commits"
              list={repo.commits}
              slug={slug}
              moreUrl={`${repo.url}/commits`}
              empty="No commits yet."
              render={(commit) => ({
                key: commit.sha,
                url: commit.url,
                title: commit.message,
                ref: `${slug}@${commit.sha}`,
                meta: `${commit.author ? `${commit.author} · ` : ""}${commit.committedAt ? formatAgo(commit.committedAt) : ""}`,
                badge: null,
              })}
            />
          </div>
        )}
      </details>
    </li>
  );
}

interface Row {
  key: string | number;
  url: string;
  title: string;
  /** The GitHub name for the item, always including `owner/repo`, so it cannot pass for a gitlib `repo#3`. */
  ref: string;
  meta: string;
  badge: string | null;
}

function Section<T>({
  title,
  list,
  slug,
  moreUrl,
  empty,
  render,
}: {
  title: string;
  list: GitHubList<T>;
  slug: string;
  moreUrl: string;
  empty: string;
  render: (item: T) => Row;
}) {
  const rows = list.items.slice(0, SHOWN).map(render);
  const hidden = list.items.length - rows.length;
  return (
    <div>
      <h3 className="mb-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">{title}</h3>
      {list.error !== null ? (
        <p role="alert" className="text-sm text-destructive">
          {list.error}
        </p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : (
        <ul className="grid gap-2">
          {rows.map((row) => (
            <li key={row.key} className="text-sm">
              <a
                href={row.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex max-w-full items-baseline gap-1 font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
              >
                <span className="truncate">{row.title}</span>
                <ExternalLink className="size-3 shrink-0 self-center" aria-label="opens on GitHub" />
              </a>
              {row.badge ? <span className="ml-2 border px-1.5 py-px align-middle text-xs text-muted-foreground">{row.badge}</span> : null}
              <p className="text-xs text-muted-foreground">
                <span className="font-mono">{row.ref}</span> · {row.meta}
              </p>
            </li>
          ))}
        </ul>
      )}
      {list.error === null && (hidden > 0 || list.hasMore) ? (
        <p className="mt-1.5 text-xs text-muted-foreground">
          <a href={moreUrl} target="_blank" rel="noopener noreferrer" aria-label={`See all of ${slug} on GitHub`} className="underline">
            {hidden > 0 ? `${hidden}${list.hasMore ? "+" : ""} more on GitHub` : "See all on GitHub"}
          </a>
        </p>
      ) : null}
    </div>
  );
}
