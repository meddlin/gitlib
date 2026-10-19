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
import { Label } from "#/components/ui/label";
import { Textarea } from "#/components/ui/textarea";
import { MAX_DESCRIPTION_LENGTH, saveDescription, type RepoView } from "#/server/repos";

export function DescriptionDialog({ repo, children }: { repo: RepoView; children: ReactNode }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState(repo.description);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setValue(repo.description);
      setError(null);
    }
    setOpen(next);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await saveDescription({ data: { relativePath: repo.relativePath, description: value } });
      await router.invalidate();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the description.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent>
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{repo.name}</DialogTitle>
            <DialogDescription>
              A short summary of what this repository is for. Shown in the table and searchable.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={`description-${repo.id}`}>Description</Label>
            <Textarea
              id={`description-${repo.id}`}
              value={value}
              onChange={(event) => setValue(event.target.value)}
              maxLength={MAX_DESCRIPTION_LENGTH}
              rows={4}
              placeholder="e.g. Billing service for the customer portal"
              autoFocus
            />
            <p className="text-right text-xs text-muted-foreground">
              {value.length}/{MAX_DESCRIPTION_LENGTH}
            </p>
            {error ? (
              <p role="alert" className="text-sm text-destructive">
                {error}
              </p>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
