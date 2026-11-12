import { useRouter } from "@tanstack/react-router";
import { Plus } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";
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
import type { RemoteProvider } from "#/lib/catalog";
import { addProjectRepos, type AvailableRemote } from "#/server/projects";
import type { PlanningRepoOption } from "#/server/planning";

interface Choice {
  /** `local:<relativePath>` or `<provider>:<fullName>`; unique across the lists. */
  key: string;
  label: string;
  description: string;
}

interface Group {
  id: string;
  heading: string;
  choices: Choice[];
}

const PROVIDER_LABELS: Record<RemoteProvider, string> = { github: "GitHub", gitlab: "GitLab" };

function matches(choice: Choice, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = `${choice.label} ${choice.description}`.toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

/**
 * Adds several repositories to a project in one step: clones gitlib has scanned, and repos that GitHub or GitLab list
 * for the account but that are not cloned. Tick any number, then add them together.
 */
export function AddReposDialog({
  projectId,
  localRepos,
  remoteRepos,
  children,
}: {
  projectId: number;
  localRepos: readonly PlanningRepoOption[];
  remoteRepos: readonly AvailableRemote[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<ReadonlySet<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const groups = useMemo<Group[]>(() => {
    const all: Group[] = [
      {
        id: "local",
        heading: "Local clones",
        choices: localRepos.map((repo) => ({ key: `local:${repo.relativePath}`, label: repo.relativePath, description: "" })),
      },
      ...(["github", "gitlab"] as const).map((provider) => ({
        id: provider,
        heading: `${PROVIDER_LABELS[provider]}, not cloned`,
        choices: remoteRepos
          .filter((repo) => repo.provider === provider)
          .map((repo) => ({ key: `${provider}:${repo.fullName}`, label: repo.fullName, description: repo.description })),
      })),
    ];
    return all
      .map((group) => ({ ...group, choices: group.choices.filter((choice) => matches(choice, query)) }))
      .filter((group) => group.choices.length > 0);
  }, [localRepos, remoteRepos, query]);

  const shown = groups.flatMap((group) => group.choices.map((choice) => choice.key));
  const allShownPicked = shown.length > 0 && shown.every((key) => picked.has(key));

  function handleOpenChange(next: boolean) {
    if (next) {
      setQuery("");
      setPicked(new Set());
      setError(null);
    }
    setOpen(next);
  }

  function toggle(keys: readonly string[], on: boolean) {
    setPicked((previous) => {
      const next = new Set(previous);
      for (const key of keys) {
        if (on) next.add(key);
        else next.delete(key);
      }
      return next;
    });
  }

  async function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const repos: string[] = [];
    const remotes: { provider: RemoteProvider; fullName: string }[] = [];
    for (const key of picked) {
      const [kind, ...rest] = key.split(":");
      const value = rest.join(":");
      if (kind === "local") repos.push(value);
      else if (kind === "github" || kind === "gitlab") remotes.push({ provider: kind, fullName: value });
    }
    setSaving(true);
    setError(null);
    try {
      await addProjectRepos({ data: { id: projectId, repos, remotes } });
      await router.invalidate();
      setOpen(false);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not add the repositories.");
    } finally {
      setSaving(false);
    }
  }

  const count = picked.size;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>Add repositories</DialogTitle>
            <DialogDescription>
              Tick as many as you like. Repositories on GitHub or GitLab can be added without cloning them.
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center gap-2">
            <Input
              type="search"
              aria-label="Search repositories"
              placeholder="Search repositories…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoFocus
            />
            <Button type="button" variant="outline" disabled={shown.length === 0} onClick={() => toggle(shown, !allShownPicked)}>
              {allShownPicked ? "Clear shown" : "Select shown"}
            </Button>
          </div>

          <div className="max-h-80 overflow-y-auto border-y" data-testid="add-repos-list">
            {localRepos.length + remoteRepos.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">
                There are no repositories left to add. Gitlib lists the repos it finds under your scan roots and, for
                ones you have not cloned, those GitHub or GitLab list for your account (set GITLIB_GITHUB_TOKEN or
                GITLIB_GITLAB_TOKEN).
              </p>
            ) : groups.length === 0 ? (
              <p className="py-6 text-center text-sm text-muted-foreground">No matching repositories.</p>
            ) : (
              groups.map((group) => (
                <fieldset key={group.id} className="min-w-0">
                  <legend className="sticky top-0 z-10 w-full bg-background py-1.5 text-xs font-medium text-muted-foreground">
                    {group.heading} <span className="font-normal">{group.choices.length}</span>
                  </legend>
                  <ul>
                    {group.choices.map((choice) => (
                      <li key={choice.key}>
                        <label className="flex cursor-pointer items-start gap-3 rounded-sm px-1 py-1.5 hover:bg-accent">
                          <input
                            type="checkbox"
                            className="mt-1 size-4 shrink-0 accent-primary"
                            checked={picked.has(choice.key)}
                            onChange={(event) => toggle([choice.key], event.target.checked)}
                          />
                          <span className="min-w-0">
                            <span className="block truncate font-mono text-sm">{choice.label}</span>
                            {choice.description ? (
                              <span className="block truncate text-xs text-muted-foreground">{choice.description}</span>
                            ) : null}
                          </span>
                        </label>
                      </li>
                    ))}
                  </ul>
                </fieldset>
              ))
            )}
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
            <Button type="submit" disabled={saving || count === 0}>
              <Plus aria-hidden />
              {saving ? "Adding…" : count === 0 ? "Add" : `Add ${count} ${count === 1 ? "repository" : "repositories"}`}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
