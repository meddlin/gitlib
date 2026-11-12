import { Flag, Pencil, Plus, Trash2 } from "lucide-react";
import { DeleteMilestoneDialog } from "#/components/delete-milestone-dialog";
import { MilestoneFormDialog } from "#/components/milestone-form-dialog";
import { Button } from "#/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { formatDueDate, isOverdue, milestoneProgress } from "#/lib/milestones";
import type { MilestoneLimits, MilestoneView } from "#/server/milestones";

/** A project's milestones as cards, with the controls to add, edit and delete them. */
export function MilestoneCards({
  projectId,
  milestones,
  limits,
}: {
  projectId: number;
  milestones: MilestoneView[];
  limits: MilestoneLimits;
}) {
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
        <MilestoneFormDialog mode="create" projectId={projectId} limits={limits}>
          <Button variant="outline">
            <Plus aria-hidden /> New milestone
          </Button>
        </MilestoneFormDialog>
      </div>

      {milestones.length === 0 ? (
        <p className="border-y py-6 text-center text-sm text-muted-foreground">No milestones in this project yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="project-milestone-list">
          {milestones.map((milestone) => (
            <li key={milestone.id} className="flex">
              <MilestoneCard milestone={milestone} limits={limits} />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function MilestoneCard({ milestone, limits }: { milestone: MilestoneView; limits: MilestoneLimits }) {
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
        <CardDescription className="text-xs">
          {milestone.dueDate ? (
            <span className={overdue ? "font-medium text-destructive" : undefined}>
              {overdue ? "Overdue · " : "Due "}
              {formatDueDate(milestone.dueDate)}
            </span>
          ) : (
            "No due date"
          )}
        </CardDescription>
        <CardAction className="-mt-1 -mr-2 flex items-center">
          <MilestoneFormDialog mode="edit" milestone={milestone} limits={limits}>
            <Button variant="ghost" size="icon-sm" aria-label={`Edit ${milestone.title}`}>
              <Pencil aria-hidden />
            </Button>
          </MilestoneFormDialog>
          <DeleteMilestoneDialog milestone={milestone} issueCount={milestone.issueCount}>
            <Button variant="ghost" size="icon-sm" aria-label={`Delete ${milestone.title}`}>
              <Trash2 aria-hidden />
            </Button>
          </DeleteMilestoneDialog>
        </CardAction>
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
        <p className="text-xs text-muted-foreground">
          {progress.total === 0
            ? "No issues"
            : `${progress.closed} of ${progress.total} ${progress.total === 1 ? "issue" : "issues"} closed`}
        </p>
      </CardContent>
    </Card>
  );
}
