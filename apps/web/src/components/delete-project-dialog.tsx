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
import { deleteProject, type ProjectOption } from "#/server/projects";

/** Confirms before deleting a project. Its repos and issues are kept; they just leave the project. */
export function DeleteProjectDialog({
  project,
  onDeleted,
  children,
}: {
  project: ProjectOption;
  onDeleted?: () => void;
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm() {
    setDeleting(true);
    setError(null);
    try {
      await deleteProject({ data: { id: project.id } });
      setOpen(false);
      onDeleted?.();
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the project.");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) setError(null);
        setOpen(next);
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Delete “{project.name}”?</DialogTitle>
          <DialogDescription>
            This removes the project only. Its repositories and issues are not deleted; they just stop belonging to it.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setOpen(false)}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={deleting}>
            {deleting ? "Deleting…" : "Delete project"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
