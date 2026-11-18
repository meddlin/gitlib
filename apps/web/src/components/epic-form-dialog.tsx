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
import { createEpic, updateEpic, type EpicLimits, type EpicView } from "#/server/epics";

type Props = {
  limits: EpicLimits;
  children: ReactNode;
} & ({ mode: "create"; projectId: number } | { mode: "edit"; epic: EpicView });

/** Creates an epic in a project, or edits the title and description of an existing one. */
export function EpicFormDialog(props: Props) {
  const { limits, children } = props;
  const router = useRouter();
  const editing = props.mode === "edit" ? props.epic : null;
  const initial = { title: editing?.title ?? "", description: editing?.description ?? "" };

  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(initial.title);
  const [description, setDescription] = useState(initial.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setTitle(initial.title);
      setDescription(initial.description);
      setError(null);
    }
    setOpen(next);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      if (props.mode === "edit") {
        await updateEpic({ data: { id: props.epic.id, title, description } });
      } else {
        await createEpic({ data: { projectId: props.projectId, title, description } });
      }
      await router.invalidate();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the epic.");
    } finally {
      setSaving(false);
    }
  }

  const idPrefix = editing ? `epic-${editing.id}` : "new-epic";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit epic" : "New epic"}</DialogTitle>
            <DialogDescription>
              An epic is a body of work, such as a feature, that can span the project's repositories. It is stored in
              gitlib only.
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-title`}>Title</Label>
            <Input
              id={`${idPrefix}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={limits.title}
              placeholder="Auth rewrite"
              required
              autoFocus
            />
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
              {saving ? "Saving…" : editing ? "Save" : "Create epic"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
