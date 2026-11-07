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
import { deleteMilestone, type MilestoneOption } from "#/server/milestones";

/** Confirms before deleting a milestone. Its issues are kept; they just leave the milestone. */
export function DeleteMilestoneDialog({
  milestone,
  issueCount,
  children,
}: {
  milestone: MilestoneOption;
  issueCount: number;
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
      await deleteMilestone({ data: { id: milestone.id } });
      setOpen(false);
      await router.invalidate();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not delete the milestone.");
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
          <DialogTitle>Delete “{milestone.title}”?</DialogTitle>
          <DialogDescription>
            {issueCount === 0
              ? "This milestone has no issues."
              : issueCount === 1
                ? "Its 1 issue stays in the project; it just stops belonging to this milestone."
                : `Its ${issueCount} issues stay in the project; they just stop belonging to this milestone.`}
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
            {deleting ? "Deleting…" : "Delete milestone"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
