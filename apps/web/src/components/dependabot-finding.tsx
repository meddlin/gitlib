import { ExternalLink } from "lucide-react";
import type { ReactNode } from "react";
import { RelativeTime } from "#/components/relative-time";
import { Button } from "#/components/ui/button";
import { ciLabel, codeSegments, prKey, safeHref } from "#/lib/dependabot";
import { cn } from "#/lib/utils";
import type { DismissedFinding } from "#/server/dependabot";
import type { StoredFinding } from "@gitlib/core";

/** Text in which `backticked` pieces are drawn as code. Nothing is parsed as HTML. */
export function Prose({ text }: { text: string }) {
  return (
    <>
      {codeSegments(text).map((segment, index) =>
        segment.code ? (
          <code key={index} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]">
            {segment.text}
          </code>
        ) : (
          <span key={index}>{segment.text}</span>
        ),
      )}
    </>
  );
}

function Facts({ finding, checkedAt }: { finding: StoredFinding; checkedAt: string }) {
  const { pr } = finding;
  const facts: ReactNode[] = [
    prKey(pr),
    pr.ecosystem,
    pr.updateType === "unknown" ? "update type unknown" : `${pr.updateType} update`,
    <span key="ci" className={cn(pr.ci.state === "unknown" && "font-medium text-amber-700 dark:text-amber-400")}>
      {ciLabel(pr.ci)}
    </span>,
  ];
  // A finding carried over from an earlier check says so: GitHub could not be asked about its repository this time.
  if (finding.observedAt !== checkedAt) {
    facts.push(
      <span key="seen" className="text-amber-700 dark:text-amber-400">
        last seen <RelativeTime iso={finding.observedAt} />
      </span>,
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground">
      {facts
        .filter((fact) => fact !== null)
        .map((fact, index) => (
          <span key={index} className="inline-flex items-center gap-2">
            {index > 0 ? <span aria-hidden>·</span> : null}
            {fact}
          </span>
        ))}
    </p>
  );
}

function Title({ finding }: { finding: StoredFinding }) {
  const href = safeHref(finding.pr.url);
  const title = finding.pr.title || prKey(finding.pr);
  return href ? (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-start gap-1 break-words font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
    >
      {title}
      <ExternalLink className="mt-1 size-3 shrink-0 text-muted-foreground" aria-label="opens GitHub" />
    </a>
  ) : (
    <span className="break-words font-medium">{title}</span>
  );
}

/** One pull request: what it is, why it is in its bucket, what to do, and buttons to put it aside. */
export function FindingCard({
  finding,
  checkedAt,
  busy,
  onSnooze,
  onDismiss,
}: {
  finding: StoredFinding;
  checkedAt: string;
  busy: boolean;
  onSnooze: () => void;
  onDismiss: () => void;
}) {
  return (
    <li className="flex flex-col gap-2 rounded-lg border bg-card p-3 text-card-foreground">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <Title finding={finding} />
          <Facts finding={finding} checkedAt={checkedAt} />
        </div>
        <div className="flex shrink-0 gap-1">
          {/* The tooltip would otherwise become the buttons' names, which should say which pull request they act on. */}
          <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onSnooze} aria-label={`Snooze ${prKey(finding.pr)} for a week`} title="Hide it for a week">
            Snooze
          </Button>
          <Button type="button" variant="ghost" size="xs" disabled={busy} onClick={onDismiss} aria-label={`Dismiss ${prKey(finding.pr)} until it is closed`} title="Hide it until it is closed">
            Dismiss
          </Button>
        </div>
      </div>
      <ul className="list-disc space-y-0.5 pl-5 text-sm">
        {finding.reasons.map((reason) => (
          <li key={reason}>
            <Prose text={reason} />
          </li>
        ))}
      </ul>
      {finding.actions.length > 0 ? (
        <ul className="space-y-0.5 text-xs text-muted-foreground">
          {finding.actions.map((action) => (
            <li key={action}>
              <span className="font-medium">Next: </span>
              <Prose text={action} />
            </li>
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A pull request the user put aside, with how long and a way back. */
export function DismissedRow({ finding, busy, onRestore }: { finding: DismissedFinding; busy: boolean; onRestore: () => void }) {
  const { snoozedUntil } = finding.dismissal;
  const href = safeHref(finding.pr.url);
  return (
    <li className="flex items-center justify-between gap-3 text-sm">
      <span className="min-w-0 truncate">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline">
            {prKey(finding.pr)}
          </a>
        ) : (
          prKey(finding.pr)
        )}
        <span className="text-muted-foreground"> · {finding.pr.title}</span>
        <span className="text-muted-foreground"> · {snoozedUntil ? <>until <RelativeTime iso={snoozedUntil} /></> : "until closed"}</span>
      </span>
      <Button type="button" variant="outline" size="xs" disabled={busy} onClick={onRestore} aria-label={`Restore ${prKey(finding.pr)}`}>
        Restore
      </Button>
    </li>
  );
}
