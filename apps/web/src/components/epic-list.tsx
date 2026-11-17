import { useRouter } from "@tanstack/react-router";
import { Archive, ArchiveRestore, Layers, Pencil, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import { DeleteEpicDialog } from "#/components/delete-epic-dialog";
import { EpicFormDialog } from "#/components/epic-form-dialog";
import { Badge } from "#/components/ui/badge";
import { Button } from "#/components/ui/button";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "#/components/ui/card";
import { milestoneProgress } from "#/lib/milestones";
import { setEpicArchived, type EpicLimits, type EpicView } from "#/server/epics";

/** How an epic's rolled-up status reads. */
const STATUS_LABELS: Record<EpicView["status"], string> = {
  empty: "No issues",
  todo: "Not started",
  in_progress: "In progress",
  done: "Done",
};

/**
 * A project's epics as cards, with the controls to add, edit, archive and delete them. Archived epics are listed
 * apart, under the cards, where they can be restored. `readOnly` (an archived project) hides the controls.
 */
export function EpicList({
  projectId,
  epics: all,
  limits,
  readOnly = false,
}: {
  projectId: number;
  epics: EpicView[];
  limits: EpicLimits;
  readOnly?: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const epics = all.filter((epic) => !epic.archived);
  const archived = all.filter((epic) => epic.archived);

  async function toggleArchived(epic: EpicView) {
    setBusy(true);
    setError(null);
    try {
      await setEpicArchived({ data: { id: epic.id, archived: !epic.archived } });
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not change the epic.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="project-epics" className="grid gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 id="project-epics" className="text-lg font-semibold">
            Epics <span className="text-sm font-normal text-muted-foreground">{epics.length}</span>
          </h2>
          <p className="text-sm text-muted-foreground">
            Bodies of work, such as features. An epic's issues can come from any of the project's repositories.
          </p>
        </div>
        {readOnly ? null : (
          <EpicFormDialog mode="create" projectId={projectId} limits={limits}>
            <Button variant="outline">
              <Plus aria-hidden /> New epic
            </Button>
          </EpicFormDialog>
        )}
      </div>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {epics.length === 0 ? (
        <p className="border-y py-6 text-center text-sm text-muted-foreground">No epics in this project yet.</p>
      ) : (
        <ul className="grid gap-3 sm:grid-cols-2" data-testid="project-epic-list">
          {epics.map((epic) => (
            <li key={epic.id} className="flex">
              <EpicCard epic={epic} limits={limits} readOnly={readOnly} busy={busy} onArchive={() => void toggleArchived(epic)} />
            </li>
          ))}
        </ul>
      )}

      {archived.length > 0 ? (
        <div className="grid gap-1">
          <h3 className="flex items-center gap-1.5 text-sm font-medium text-muted-foreground">
            <Archive className="size-3.5" aria-hidden /> Archived <span className="font-normal">{archived.length}</span>
          </h3>
          <ul className="divide-y border-y" data-testid="archived-epic-list">
            {archived.map((epic) => (
              <li key={epic.id} className="flex items-center gap-3 py-2">
                <span className="min-w-0 flex-1 text-sm break-words text-muted-foreground">
                  {epic.title}
                  <span className="text-xs"> · {STATUS_LABELS[epic.status]}</span>
                </span>
                {readOnly ? null : (
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Restore ${epic.title}`}
                    disabled={busy}
                    onClick={() => void toggleArchived(epic)}
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

function EpicCard({
  epic,
  limits,
  readOnly,
  busy,
  onArchive,
}: {
  epic: EpicView;
  limits: EpicLimits;
  readOnly: boolean;
  busy: boolean;
  onArchive: () => void;
}) {
  const progress = milestoneProgress(epic.issueCount, epic.closedCount);

  return (
    <Card className="w-full gap-3 py-4">
      <CardHeader className="px-4">
        <CardTitle className="flex items-start gap-2 leading-snug break-words">
          <Layers
            className={epic.status === "done" ? "mt-0.5 size-4 shrink-0 text-primary" : "mt-0.5 size-4 shrink-0 text-muted-foreground"}
            aria-hidden
          />
          <span className="min-w-0">{epic.title}</span>
        </CardTitle>
        <CardDescription className="text-xs">
          <Badge variant={epic.status === "done" ? "default" : "secondary"}>{STATUS_LABELS[epic.status]}</Badge>
        </CardDescription>
        {readOnly ? null : (
          <CardAction className="-mt-1 -mr-2 flex items-center">
            <EpicFormDialog mode="edit" epic={epic} limits={limits}>
              <Button variant="ghost" size="icon-sm" aria-label={`Edit ${epic.title}`}>
                <Pencil aria-hidden />
              </Button>
            </EpicFormDialog>
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Archive ${epic.title}`}
              title="Archive: its issues keep it, but no new ones can join"
              disabled={busy}
              onClick={onArchive}
            >
              <Archive aria-hidden />
            </Button>
            <DeleteEpicDialog epic={epic} issueCount={epic.issueCount}>
              <Button variant="ghost" size="icon-sm" aria-label={`Delete ${epic.title}`}>
                <Trash2 aria-hidden />
              </Button>
            </DeleteEpicDialog>
          </CardAction>
        )}
      </CardHeader>

      <CardContent className="grid gap-2 px-4">
        {epic.description ? (
          <p className="line-clamp-3 text-sm break-words text-muted-foreground">{epic.description}</p>
        ) : null}
        {progress.total > 0 ? (
          <div
            role="progressbar"
            aria-label={`${epic.title} progress`}
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
