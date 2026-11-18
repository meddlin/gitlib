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
import { NativeSelect } from "#/components/ui/native-select";
import type { PlanningRepoOption } from "#/server/planning";
import { relinkPlanningRepo, renamePlanningRepo, type PlanningRepoView } from "#/server/planning-repos";

/** Open state, a pending flag and an error for a dialog whose form saves once and refreshes the page. */
function useSave(fallback: string) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function save(action: () => Promise<unknown>) {
    setSaving(true);
    setError(null);
    try {
      await action();
      await router.invalidate();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : fallback);
    } finally {
      setSaving(false);
    }
  }

  return { open, setOpen, saving, error, setError, save };
}

function ErrorLine({ error }: { error: string | null }) {
  return error ? (
    <p role="alert" className="text-sm text-destructive">
      {error}
    </p>
  ) : null;
}

/** Changes the short name a repo's issues are shown under (`slug#3`). */
export function RenamePlanningRepoDialog({
  repo,
  slugLimit,
  children,
}: {
  repo: PlanningRepoView;
  slugLimit: number;
  children: ReactNode;
}) {
  const { open, setOpen, saving, error, setError, save } = useSave("Could not rename the repo.");
  const [slug, setSlug] = useState(repo.slug);
  const inputId = `planning-repo-${repo.id}-slug`;

  function handleOpenChange(next: boolean) {
    if (next) {
      setSlug(repo.slug);
      setError(null);
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save(() => renamePlanningRepo({ data: { id: repo.id, slug } }));
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Rename {repo.slug}</DialogTitle>
            <DialogDescription>
              Its issues are shown as <span className="font-mono">{slug.trim() || repo.slug}#1</span>. Short names are
              unique and can't contain spaces or <span className="font-mono">#</span>. The folder is not renamed.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={inputId}>Short name</Label>
            <Input
              id={inputId}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
              maxLength={slugLimit}
              className="font-mono"
              required
              autoFocus
            />
          </div>
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || slug.trim() === repo.slug}>
              {saving ? "Saving…" : "Rename"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** Points a repo gitlib lost track of at the scanned repo it is now, taking its issues and projects along. */
export function RelinkPlanningRepoDialog({
  repo,
  targets,
  children,
}: {
  repo: PlanningRepoView;
  targets: readonly PlanningRepoOption[];
  children: ReactNode;
}) {
  const { open, setOpen, saving, error, setError, save } = useSave("Could not relink the repo.");
  const [path, setPath] = useState("");
  const selectId = `planning-repo-${repo.id}-target`;

  function handleOpenChange(next: boolean) {
    if (next) {
      // A repo that moved usually keeps its folder name, so a single match is chosen for you.
      const folder = repo.path.split("/").pop();
      const sameName = targets.filter((target) => target.name === folder);
      setPath(sameName.length === 1 ? sameName[0]!.relativePath : "");
      setError(null);
    }
    setOpen(next);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (path) void save(() => relinkPlanningRepo({ data: { id: repo.id, path } }));
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>Relink {repo.slug}</DialogTitle>
            <DialogDescription>
              Gitlib last found it at <span className="font-mono">{repo.path}</span>. Choose where it is now; its issues
              and project memberships go with it.
            </DialogDescription>
          </DialogHeader>
          {targets.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Every scanned repository is already in planning. Move or clone the repo under a scan root, then rescan on
              the Repositories page.
            </p>
          ) : (
            <div className="grid gap-2">
              <Label htmlFor={selectId}>Repository</Label>
              <NativeSelect id={selectId} value={path} onChange={(event) => setPath(event.target.value)} required>
                <option value="" disabled>
                  Choose a scanned repository…
                </option>
                {targets.map((target) => (
                  <option key={target.relativePath} value={target.relativePath}>
                    {target.relativePath}
                  </option>
                ))}
              </NativeSelect>
            </div>
          )}
          <ErrorLine error={error} />
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving || !path}>
              {saving ? "Relinking…" : "Relink"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
