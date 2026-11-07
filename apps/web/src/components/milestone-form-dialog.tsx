import { useRouter } from "@tanstack/react-router";
import { useState, type ReactNode } from "react";
import { Button } from "#/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog";
import { Input } from "#/components/ui/input";
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import {
  createMilestone,
  updateMilestone,
  type MilestoneLimits,
  type MilestoneView,
} from "#/server/milestones";

type Props = {
  limits: MilestoneLimits;
  children: ReactNode;
} & ({ mode: "create"; projectId: number } | { mode: "edit"; milestone: MilestoneView });

/** Creates a milestone in a project, or edits the title, description and due date of an existing one. */
export function MilestoneFormDialog(props: Props) {
  const { limits, children } = props;
  const router = useRouter();
  const editing = props.mode === "edit" ? props.milestone : null;
  const initial = {
    title: editing?.title ?? "",
    description: editing?.description ?? "",
    dueDate: editing?.dueDate ?? "",
  };

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [dueDate, setDueDate] = useState(initial.dueDate);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle(initial.title);
      setDescription(initial.description);
      setDueDate(initial.dueDate);
      setError(null);
    }
    setOpen(next);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    // An empty date input means "no due date".
    const due = dueDate || null;
    try {
      if (props.mode === "edit") {
        await updateMilestone({ data: { id: props.milestone.id, title, description, dueDate: due } });
      } else {
        await createMilestone({ data: { projectId: props.projectId, title, description, dueDate: due } });
      }
      await router.invalidate();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the milestone.");
    } finally {
      setSaving(false);
    }
  }

  const idPrefix = editing ? `milestone-${editing.id}` : "new-milestone";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit milestone" : "New milestone"}</DialogTitle>
            <DialogDescription>
              Milestones group a project's issues toward a goal. They are stored in gitlib only.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-title`}>Title</Label>
            <Input
              id={`${idPrefix}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={limits.title}
              placeholder="v1.0 release"
              required
              autoFocus
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-due`}>Due date</Label>
            <Input
              id={`${idPrefix}-due`}
              type="date"
              value={dueDate}
              onChange={(event) => setDueDate(event.target.value)}
              className="w-auto sm:w-48"
            />
            <p className="text-xs text-muted-foreground">Optional. Leave it empty for no deadline.</p>
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-description`}>Description</Label>
            <Textarea
              id={`${idPrefix}-description`}
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              maxLength={limits.description}
              rows={5}
              className="max-h-64 font-mono text-sm"
              placeholder="Optional. Markdown is supported."
            />
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save" : "Create milestone"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
