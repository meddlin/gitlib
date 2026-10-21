import { X } from "lucide-react";
import { useState } from "react";
import { RepoOverview } from "#/components/repo-overview";
import { cn } from "#/lib/utils";
import type { RepoView } from "#/server/repos";

/**
 * Side pane that slides out beside the repo table (and over it on narrow screens).
 * The last repo stays rendered while the pane slides shut so it doesn't blank mid-animation.
 */
export function RepoPreview({ repo, onClose }: { repo: RepoView | undefined; onClose: () => void }) {
  const [last, setLast] = useState(repo);
  if (repo && repo !== last) setLast(repo);
  const shown = repo ?? last;
  const open = !!repo;

  return (
    <aside
      aria-label="Repository preview"
      inert={!open}
      className={cn(
        "fixed inset-y-0 right-0 z-30 w-full max-w-md overflow-hidden border-l bg-background transition-transform duration-200 ease-out",
        "lg:sticky lg:top-30 lg:z-auto lg:h-[calc(100vh-8.5rem)] lg:max-w-none lg:shrink-0 lg:self-start lg:transition-[width,transform]",
        open ? "translate-x-0 lg:w-120" : "translate-x-full lg:w-0 lg:translate-x-0 lg:border-l-0",
      )}
    >
      {shown ? (
        <div className="flex h-full w-full max-w-md flex-col lg:w-120 lg:max-w-none" data-testid="repo-preview">
          <header className="flex items-start justify-between gap-3 border-b px-5 py-4">
            <div className="min-w-0">
              <h2 className="truncate text-base font-semibold">{shown.name}</h2>
              <p className="truncate font-mono text-xs text-muted-foreground" title={shown.absolutePath}>
                {shown.relativePath}
              </p>
            </div>
            <button
              type="button"
              onClick={onClose}
              aria-label="Close preview"
              className="-mt-1 -mr-1 inline-flex size-7 shrink-0 items-center justify-center text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="size-4" aria-hidden />
            </button>
          </header>
          {/* Keyed so switching repos starts a fresh README fetch and scroll position. */}
          <div className="flex-1 overflow-y-auto px-5 py-4">
            <RepoOverview key={shown.relativePath} repo={shown} />
          </div>
        </div>
      ) : null}
    </aside>
  );
}
