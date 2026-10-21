import { ArrowRight } from "lucide-react";
import { PROVIDERS, ProviderBanner } from "#/components/provider-banner";
import { formatDate, labelColor } from "#/lib/format";
import { useServerData } from "#/lib/use-server-data";
import { getPullRequests, type PullRequestsView } from "#/server/pulls";

const loadPulls = (relativePath: string) => getPullRequests({ data: { relativePath } });
const pullsFailed = (error: string): PullRequestsView => ({
  provider: null,
  slug: null,
  pullsUrl: null,
  pulls: [],
  hasMore: false,
  error,
});

export function RepoPulls({ relativePath }: { relativePath: string }) {
  const loaded = useServerData(relativePath, loadPulls, pullsFailed);

  if (loaded.status === "loading") return <p className="text-sm text-muted-foreground">Loading pull requests…</p>;

  const view = loaded.value;
  const provider = view.provider ? PROVIDERS[view.provider] : null;
  if (!view.provider || !provider || !view.slug || !view.pullsUrl) {
    return view.error ? (
      <p role="alert" className="text-sm text-destructive">
        {view.error}
      </p>
    ) : (
      <p className="text-sm text-muted-foreground">
        This repository has no GitHub remote, so there are no pull requests to show.
      </p>
    );
  }

  return (
    <section aria-label={`Open pull requests from ${provider.label}`}>
      <ProviderBanner provider={view.provider} noun="Pull requests" slug={view.slug} url={view.pullsUrl} />

      {view.error ? (
        <p role="alert" className="text-sm text-destructive">
          {view.error}
        </p>
      ) : (
        <>
          <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {view.hasMore
              ? `Latest ${view.pulls.length} open pull requests`
              : `${view.pulls.length} open pull ${view.pulls.length === 1 ? "request" : "requests"}`}
          </h3>
          {view.pulls.length === 0 ? (
            <p className="border-y py-8 text-center text-sm text-muted-foreground">No open pull requests.</p>
          ) : (
            <ul className="divide-y border-y" data-testid="pull-list">
              {view.pulls.map((pull) => (
                <li key={pull.number} className="py-3">
                  <a
                    href={pull.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {pull.title}
                  </a>
                  {pull.draft ? (
                    <span className="ml-2 border px-1.5 py-px align-middle text-xs text-muted-foreground">Draft</span>
                  ) : null}
                  {pull.labels.map((label) => (
                    <span key={label.name} className="ml-2 inline-flex items-center gap-1 align-middle text-xs text-muted-foreground">
                      <span className="size-2 rounded-full" style={{ backgroundColor: labelColor(label.color) }} aria-hidden />
                      {label.name}
                    </span>
                  ))}
                  <p className="mt-0.5 text-xs text-muted-foreground">
                    #{pull.number} opened {formatDate(pull.createdAt)}
                    {pull.author ? ` by ${pull.author}` : ""} · updated {formatDate(pull.updatedAt)}
                  </p>
                  <p className="mt-0.5 flex items-center gap-1 font-mono text-xs text-muted-foreground">
                    <span className="truncate">{pull.head}</span>
                    <ArrowRight className="size-3 shrink-0" aria-label="into" />
                    <span className="truncate">{pull.base}</span>
                  </p>
                </li>
              ))}
            </ul>
          )}
          {view.hasMore ? (
            <p className="mt-3 text-xs text-muted-foreground">
              Showing the most recently updated.{" "}
              <a href={view.pullsUrl} target="_blank" rel="noopener noreferrer" className="underline">
                See all on {provider.label}
              </a>
            </p>
          ) : null}
        </>
      )}
    </section>
  );
}
