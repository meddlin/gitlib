import { useRouter } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Flag, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteMilestoneDialog } from "#/components/delete-milestone-dialog";
import { MilestoneFormDialog } from "#/components/milestone-form-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { formatDueDate, isOverdue, milestoneProgress } from "#/lib/milestones";
import { ROLL_UP_LABELS } from "#/lib/roll-up";
import { setMilestoneArchived, type MilestoneLimits, type MilestoneView } from "#/server/milestones";

/** Archives or restores a milestone, then reloads the page data; returns the action and any error. */
function useArchiveToggle() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function toggle(milestone: MilestoneView) {
    setBusy(true);
    setError(null);
    try {
      await setMilestoneArchived({ data: { id: milestone.id, archived: !milestone.archived } });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the milestone.");
    } finally {
      setBusy(false);
    }
  }
  return { busy, error, toggle };
}

/**
 * A project's milestones as cards, with the controls to add, edit, archive and delete them. Archived milestones
 * are listed apart, under the cards, where they can be restored. `readOnly` (an archived project) hides the controls.
 */
export function MilestoneCards({
  projectId,
  milestones: all,
  limits,
  readOnly = false,
}: {
  projectId: number;
  milestones: MilestoneView[];
  limits: MilestoneLimits;
  readOnly?: boolean;
}) {
  const milestones = all.filter((milestone) => !milestone.archived);
  const archived = all.filter((milestone) => milestone.archived);
  const { busy, error, toggle } = useArchiveToggle();

  return (
    <section aria-labelledby="project-milestones" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="project-milestones" className="text-lg font-semibold">
            Milestones <span className="text-sm font-normal text-muted-foreground">{milestones.length}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Goals to group this project's issues under, optionally with a due date.
          </p>
        </div>
        {readOnly ? null : (
          <MilestoneFormDialog mode="create" projectId={projectId} limits={limits}>
            <Button variant="outline">
              <Plus aria-hidden /> New milestone
            </Button>
          </MilestoneFormDialog>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {milestones.length === 0 ? (
        <p className="border-y py-6 text-center text-sm text-muted-foreground">No milestones in this project yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="project-milestone-list">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="flex">
              <MilestoneCard
                milestone={milestone}
                limits={limits}
                readOnly={readOnly}
                busy={busy}
                onArchive={() => void toggle(milestone)}
              />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Archive className="size-3.5" aria-hidden /> Archived <span className="font-normal">{archived.length}</span>
          </h3>
          <ul className="divide-y border-y" data-testid="archived-milestone-list">
            {archived.map((milestone) => (
              <li key={milestone.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-sm break-words text-muted-foreground">
                  {milestone.title}
                  <span className="text-xs">
                    {" · "}
                    {milestone.issueCount === 0
                      ? ROLL_UP_LABELS.empty
                      : `${ROLL_UP_LABELS[milestone.status]}, ${milestone.closedCount} of ${milestone.issueCount} closed`}
                  </span>
                </span>
                {readOnly ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Restore ${milestone.title}`}
                    disabled={busy}
                    onClick={() => void toggle(milestone)}
                  >
                    <ArchiveRestore aria-hidden /> Restore
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function MilestoneCard({
  milestone,
  limits,
  readOnly,
  busy,
  onArchive,
}: {
  milestone: MilestoneView;
  limits: MilestoneLimits;
  readOnly: boolean;
  busy: boolean;
  onArchive: () => void;
}) {
  const progress = milestoneProgress(milestone.issueCount, milestone.closedCount);
  const overdue = isOverdue(milestone.dueDate, progress);

  return (
    <Card className="w-full gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-start gap-2 leading-snug break-words">
          <Flag
            className={
              progress.complete
                ? "mt-0.5 size-4 shrink-0 text-primary"
                : "mt-0.5 size-4 shrink-0 text-muted-foreground"
            }
            aria-label={progress.complete ? "Complete" : undefined}
            aria-hidden={progress.complete ? undefined : true}
          />
          <span className="min-w-0">{milestone.title}</span>
        </CardTitle>
        <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
          <Badge variant={milestone.status === "done" ? "default" : "secondary"}>{ROLL_UP_LABELS[milestone.status]}</Badge>
          {milestone.dueDate ? (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              {overdue ? "Overdue · " : "Due "}
              {formatDueDate(milestone.dueDate)}
            </span>
          ) : (
            <span>No due date</span>
          )}
        </CardDescription>
        {readOnly ? null : (
          <CardAction className="-mt-1 -mr-2 flex items-center">
            <MilestoneFormDialog mode="edit" milestone={milestone} limits={limits}>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${milestone.title}`}>
                <Pencil aria-hidden />
              </Button>
            </MilestoneFormDialog>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${milestone.title}`}
              title="Archive: its issues keep it, but no new ones can join"
              disabled={busy}
              onClick={onArchive}
            >
              <Archive aria-hidden />
            </Button>
            <DeleteMilestoneDialog milestone={milestone} issueCount={milestone.issueCount}>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${milestone.title}`}>
                <Trash2 aria-hidden />
              </Button>
            </DeleteMilestoneDialog>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="grid gap-2 px-4">
        {milestone.description ? (
          <p className="line-clamp-3 text-sm break-words text-muted-foreground">{milestone.description}</p>
        ) : null}
        {progress.total > 0 ? (
          <div
            role="progressbar"
            aria-label={`${milestone.title} progress`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress.percent}
            className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
          >
            <div className="h-full rounded-full bg-primary" style={{ width: `${progress.percent}%` }} />
          </div>
        ) : null}
        {progress.total > 0 ? (
          <p className="text-xs text-muted-foreground">
            {`${progress.closed} of ${progress.total} ${progress.total === 1 ? "issue" : "issues"} closed`}
          </p>
        ) : null}
      </CardContent>
    </Card>
  );
}
