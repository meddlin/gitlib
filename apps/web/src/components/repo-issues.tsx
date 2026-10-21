import { MessageSquare } from "lucide-react";
import { PROVIDERS, ProviderBanner } from "#/components/provider-banner";
import { formatDate, labelColor } from "#/lib/format";
import { useServerData } from "#/lib/use-server-data";
import { getIssues, type IssuesView } from "#/server/issues";

const loadIssues = (relativePath: string) => getIssues({ data: { relativePath } });
const issuesFailed = (error: string): IssuesView => ({
  provider: null,
  slug: null,
  issuesUrl: null,
  issues: [],
  hasMore: false,
  error,
});

export function RepoIssues({ relativePath }: { relativePath: string }) {
  const loaded = useServerData(relativePath, loadIssues, issuesFailed);

  if (loaded.status === "loading") return <p className="text-sm text-muted-foreground">Loading issues…</p>;

  const issues = loaded.value;
  const provider = issues.provider ? PROVIDERS[issues.provider] : null;
  if (!issues.provider || !provider || !issues.slug || !issues.issuesUrl) {
    return issues.error ? (
      <p role="alert" className="text-sm text-destructive">
        {issues.error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        This repository has no GitHub remote, so there are no issues to show.
      </p>
    );
  }

  return (
    <section aria-label={`Open issues from ${provider.label}`}>
      <ProviderBanner provider={issues.provider} noun="Issues" slug={issues.slug} url={issues.issuesUrl} />

      {issues.error ? (
        <p role="alert" className="text-sm text-destructive">
          {issues.error}
        </p>
      ) : (
        <>
          <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {issues.hasMore
              ? `Latest ${issues.issues.length} open issues`
              : `${issues.issues.length} open ${issues.issues.length === 1 ? "issue" : "issues"}`}
          </h3>
          {issues.issues.length === 0 ? (
            <p className="border-y py-8 text-center text-sm text-muted-foreground">No open issues.</p>
          ) : (
            <ul className="divide-y border-y" data-testid="issue-list">
              {issues.issues.map((issue) => (
                <li key={issue.number} className="flex items-start justify-between gap-4 py-3">
                  <div className="min-w-0">
                    <a
                      href={issue.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {issue.title}
                    </a>
                    {issue.labels.map((label) => (
                      <span
                        key={label.name}
                        className="ml-2 inline-flex items-center gap-1 align-middle text-xs text-muted-foreground"
                      >
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: labelColor(label.color) }}
                          aria-hidden
                        />
                        {label.name}
                      </span>
                    ))}
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      #{issue.number} opened {formatDate(issue.createdAt)}
                      {issue.author ? ` by ${issue.author}` : ""} · updated {formatDate(issue.updatedAt)}
                    </p>
                  </div>
                  {issue.comments > 0 ? (
                    <span className="inline-flex shrink-0 items-center gap-1 text-xs text-muted-foreground tabular-nums">
                      <MessageSquare className="size-3" aria-hidden />
                      <span className="sr-only">Comments:</span>
                      {issue.comments}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
          {issues.hasMore ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the most recently updated.{" "}
              <a href={issues.issuesUrl} target="_blank" rel="noopener noreferrer" className="underline">
                See all on {provider.label}
              </a>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
