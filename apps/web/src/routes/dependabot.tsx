import { createFileRoute } from "@tanstack/react-router";
import { RefreshCw, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { DismissedRow, FindingCard, Prose } from "#/components/dependabot-finding";
import { RelativeTime } from "#/components/relative-time";
import { Button } from "#/components/ui/button";
import { BUCKET_HELP, BUCKET_LABELS, BUCKET_ORDER, BUCKET_TONES, TRIGGER_NAMES, holderName, prKey, snoozeUntil } from "#/lib/dependabot";
import { notifyDependabotChanged } from "#/lib/use-dependabot-badge";
import { cn } from "#/lib/utils";
import {
  checkDependabotNow,
  dismissDependabotPr,
  getDependabot,
  restoreDependabotPr,
  type DependabotActionResult,
  type DependabotView,
} from "#/server/dependabot";

export const Route = createFileRoute("/dependabot")({
  loader: () => getDependabot(),
  head: () => ({ meta: [{ title: "Dependabot · Gitlib" }] }),
  component: Dependabot,
});

/** How often to look again while another process (the CLI, the schedule) is checking. */
const WATCH_MS = 3_000;

function Dependabot() {
  const loaded = Route.useLoaderData();
  const [view, setView] = useState<DependabotView>(loaded);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => setView(loaded), [loaded]);

  // Someone else is asking GitHub: show it, and pick up the result when they finish.
  const watching = view.running !== null && !checking;
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => {
      getDependabot()
        .then((next) => {
          setView(next);
          if (next.running === null) notifyDependabotChanged();
        })
        .catch(() => undefined);
    }, WATCH_MS);
    return () => clearInterval(timer);
  }, [watching]);

  /** Runs one action, shows the page's data as the server now has it, and the reason if it was refused. */
  async function act(run: () => Promise<DependabotActionResult>, setWorking: (working: boolean) => void) {
    setWorking(true);
    setError(null);
    try {
      const result = await run();
      setView(result.view);
      setError(result.error);
      notifyDependabotChanged();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.");
    } finally {
      setWorking(false);
    }
  }

  const checkNow = () => act(() => checkDependabotNow(), setChecking);
  const snooze = (pr: { repo: string; number: number }) => act(() => dismissDependabotPr({ data: { ...pr, until: snoozeUntil(7) } }), setBusy);
  const dismiss = (pr: { repo: string; number: number }) => act(() => dismissDependabotPr({ data: pr }), setBusy);
  const restore = (pr: { repo: string; number: number }) => act(() => restoreDependabotPr({ data: pr }), setBusy);

  const { run, report } = view;
  const total = BUCKET_ORDER.reduce((sum, bucket) => sum + view.counts[bucket], 0);
  const checkDisabled = !view.canCheck || checking || view.running !== null;

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-6 px-4 py-8 sm:px-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Dependabot</h1>
          <p className="text-sm text-muted-foreground">
            Open Dependabot pull requests on your starred repositories, sorted by what you can do about them. The verdict
            comes from fields GitHub returns, never from the pull request text.
          </p>
        </div>
        <Button type="button" onClick={checkNow} disabled={checkDisabled}>
          <RefreshCw className={cn(checking && "animate-spin")} aria-hidden />
          {checking ? "Checking…" : "Check now"}
        </Button>
      </header>

      <p className="text-sm text-muted-foreground" aria-live="polite">
        {view.running ? (
          <>A check is running ({holderName(view.running.by)}, started <RelativeTime iso={view.running.since} />).</>
        ) : run ? (
          <>
            Checked <RelativeTime iso={run.checkedAt} /> by {TRIGGER_NAMES[run.trigger]}.
          </>
        ) : (
          "No check has run yet."
        )}
      </p>

      {view.unavailableReason ? <Banner tone="warning">{view.unavailableReason}</Banner> : null}
      {error ? <Banner tone="error">{error}</Banner> : null}
      {report && report.errors.length > 0 ? (
        <Banner tone="error">
          The last check could not ask GitHub about {report.errors.map((entry) => entry.owner).join(", ")}; what was seen before is shown, marked
          &ldquo;last seen&rdquo;. {report.errors[0]!.message}
        </Banner>
      ) : null}

      {run && total === 0 && view.dismissed.length === 0 ? (
        <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No open Dependabot pull requests on the repositories that were checked.</p>
      ) : null}

      {BUCKET_ORDER.map((bucket) => {
        const items = view.items.filter((item) => item.bucket === bucket);
        if (items.length === 0) return null;
        const tone = BUCKET_TONES[bucket];
        return (
          <section key={bucket} aria-labelledby={`bucket-${bucket}`} className="flex flex-col gap-3">
            <div>
              <h2 id={`bucket-${bucket}`} className="flex items-center gap-2 text-lg font-medium">
                <span className={cn("size-2.5 rounded-full", tone.dot)} aria-hidden />
                <span className={tone.text}>{BUCKET_LABELS[bucket]}</span>
                <span className="text-sm font-normal text-muted-foreground">{items.length}</span>
              </h2>
              <p className="text-sm text-muted-foreground">{BUCKET_HELP[bucket]}</p>
            </div>
            <ul className="flex flex-col gap-2">
              {items.map((finding) => (
                <FindingCard
                  key={prKey(finding.pr)}
                  finding={finding}
                  checkedAt={report?.checkedAt ?? ""}
                  busy={busy}
                  onSnooze={() => snooze(finding.pr)}
                  onDismiss={() => dismiss(finding.pr)}
                />
              ))}
            </ul>
          </section>
        );
      })}

      {view.dismissed.length > 0 ? (
        <details className="rounded-lg border p-3">
          <summary className="cursor-pointer text-sm font-medium">Put aside ({view.dismissed.length})</summary>
          <ul className="mt-3 flex flex-col gap-2">
            {view.dismissed.map((finding) => (
              <DismissedRow key={prKey(finding.pr)} finding={finding} busy={busy} onRestore={() => restore(finding.pr)} />
            ))}
          </ul>
        </details>
      ) : null}

      {report ? <CoverageNotes report={report} /> : null}
    </div>
  );
}

function Banner({ tone, children }: { tone: "warning" | "error"; children: React.ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "flex items-start gap-2 rounded-lg border p-3 text-sm",
        tone === "error" ? "border-destructive/40 text-destructive" : "border-amber-500/40 text-amber-800 dark:text-amber-300",
      )}
    >
      <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div>{children}</div>
    </div>
  );
}

/** What the last check covered and what it could not, so an empty list is never mistaken for "all clear". */
function CoverageNotes({ report }: { report: NonNullable<DependabotView["report"]> }) {
  const unreachable = report.watched.filter((repo) => repo.status === "unreachable");
  const quiet = report.watched.filter((repo) => repo.status === "checked" && repo.openPrs === 0);
  const lines: React.ReactNode[] = [];

  if (unreachable.length > 0) {
    lines.push(
      <>
        <strong>Not checked:</strong> GitHub does not show {unreachable.map((repo) => repo.slug).join(", ")} to your token (private without access, renamed or deleted).
      </>,
    );
  }
  for (const owner of report.truncatedOwners) {
    lines.push(
      <>
        <strong>Incomplete:</strong> {owner} has more matching pull requests than GitHub search returns, so some are missing.
      </>,
    );
  }
  for (const warning of report.warnings) lines.push(<>GitHub warning: {warning}</>);
  if (report.skipped.length > 0) {
    lines.push(
      <>
        Skipped {report.skipped.length} starred {report.skipped.length === 1 ? "repository" : "repositories"} with no GitHub remote to ask about:{" "}
        {report.skipped.map((repo) => `${repo.relativePath} (${repo.reason})`).join("; ")}.
      </>,
    );
  }
  if (report.watched.length === 0) {
    lines.push(<>No starred repository has a GitHub remote, so there is nothing to check. Star repositories on the Repositories page, then rescan.</>);
  }
  if (quiet.length > 0) lines.push(<>No open Dependabot pull requests: {quiet.map((repo) => repo.slug).join(", ")}.</>);
  if (report.rateLimit) {
    lines.push(
      <>
        GitHub quota: the last check cost {report.rateLimit.cost}; {report.rateLimit.remaining} left until <RelativeTime iso={report.rateLimit.resetAt} />.
      </>,
    );
  }
  if (lines.length === 0) return null;
  return (
    <section aria-label="What was checked" className="flex flex-col gap-1.5 border-t pt-4 text-xs text-muted-foreground">
      {lines.map((line, index) => (
        <p key={index}>{typeof line === "string" ? <Prose text={line} /> : line}</p>
      ))}
    </section>
  );
}
