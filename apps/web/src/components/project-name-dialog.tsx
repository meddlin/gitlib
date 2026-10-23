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
import { createProject, renameProject, type ProjectOption } from "#/server/projects";

type Props = {
  nameLimit: number;
  /** Called with the saved project once it is stored. */
  onSaved?: (project: ProjectOption) => void;
  children: ReactNode;
} & ({ mode: "create" } | { mode: "rename"; project: ProjectOption });

/** Names a new project or renames an existing one. */
export function ProjectNameDialog(props: Props) {
  const { nameLimit, onSaved, children } = props;
  const router = useRouter();
  const existing = props.mode === "rename" ? props.project : null;

  const [open, setOpen] = useState(false);
  const [name, setName] = useState(existing?.name ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setName(existing?.name ?? "");
      setError(null);
    }
    setOpen(next);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = existing
        ? await renameProject({ data: { id: existing.id, name } })
        : await createProject({ data: { name } });
      await router.invalidate();
      setOpen(false);
      onSaved?.(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the project.");
    } finally {
      setSaving(false);
    }
  }

  const inputId = existing ? `project-${existing.id}-name` : "new-project-name";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{existing ? "Rename project" : "New project"}</DialogTitle>
            <DialogDescription>
              Projects group repositories and issues. They are stored in gitlib only.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={inputId}>Name</Label>
            <Input
              id={inputId}
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={nameLimit}
              required
              autoFocus
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
              {saving ? "Saving…" : existing ? "Rename" : "Create project"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
