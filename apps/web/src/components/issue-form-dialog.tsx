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
import { Textarea } from "#/components/ui/textarea";
import {
  createLocalIssue,
  updateLocalIssue,
  type LocalIssueView,
  type PlanningRepoOption,
  type PlanningView,
} from "#/server/planning";

type Props = {
  limits: PlanningView["limits"];
  /** Called with the saved issue once it is stored. */
  onSaved?: (issue: LocalIssueView) => void;
  children: ReactNode;
} & (
  | {
      mode: "create";
      /** Every repo an issue can be filed against. */
      repos: PlanningRepoOption[];
      /** Pre-selected repo (its relativePath), e.g. the one the list is filtered to. */
      defaultRepo?: string;
    }
  | { mode: "edit"; issue: LocalIssueView }
);

/** Files a new local issue against any repo, or edits the title and description of an existing one. */
export function IssueFormDialog(props: Props) {
  const { limits, onSaved, children } = props;
  const router = useRouter();
  const editing = props.mode === "edit" ? props.issue : null;
  const initial = {
    repo: props.mode === "create" ? (props.defaultRepo ?? "") : "",
    title: editing?.title ?? "",
    body: editing?.body ?? "",
  };

  const [open, setOpen] = useState(false);
  const [repo, setRepo] = useState(initial.repo);
  const [title, setTitle] = useState(initial.title);
  const [body, setBody] = useState(initial.body);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleOpenChange(next: boolean) {
    if (next) {
      setRepo(initial.repo);
      setTitle(initial.title);
      setBody(initial.body);
      setError(null);
    }
    setOpen(next);
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSaving(true);
    setError(null);
    try {
      const saved = editing
        ? await updateLocalIssue({ data: { id: editing.id, title, body } })
        : await createLocalIssue({ data: { repo, title, body } });
      await router.invalidate();
      setOpen(false);
      onSaved?.(saved);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not save the issue.");
    } finally {
      setSaving(false);
    }
  }

  const idPrefix = editing ? `issue-${editing.id}` : "new-issue";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-xl">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{editing ? `Edit ${editing.repoName}#${editing.number}` : "New issue"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Changes are saved in gitlib only."
                : "Stored in gitlib only. Nothing is created on GitHub or GitLab."}
            </DialogDescription>
          </DialogHeader>

          {props.mode === "create" ? (
            <div className="grid gap-2">
              <Label htmlFor={`${idPrefix}-repo`}>Repository</Label>
              <NativeSelect
                id={`${idPrefix}-repo`}
                value={repo}
                onChange={(event) => setRepo(event.target.value)}
                required
              >
                <option value="" disabled>
                  Choose a repository…
                </option>
                {props.repos.map((option) => (
                  <option key={option.relativePath} value={option.relativePath}>
                    {option.relativePath}
                  </option>
                ))}
              </NativeSelect>
            </div>
          ) : null}

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-title`}>Title</Label>
            <Input
              id={`${idPrefix}-title`}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              maxLength={limits.title}
              placeholder="Short summary of the work"
              required
              autoFocus={props.mode === "edit" || initial.repo !== ""}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor={`${idPrefix}-body`}>Description</Label>
            <Textarea
              id={`${idPrefix}-body`}
              value={body}
              onChange={(event) => setBody(event.target.value)}
              maxLength={limits.body}
              rows={8}
              className="max-h-80 font-mono text-sm"
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
              {saving ? "Saving…" : editing ? "Save" : "Create issue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
