import { Pencil } from "lucide-react";
import { useEffect, useState } from "react";
import { DescriptionDialog } from "#/components/description-dialog";
import { MarkdownBody } from "#/components/markdown-body";
import { getReadme, type ReadmeView, type RepoView } from "#/server/repos";

type ReadmeState = { status: "loading" } | ({ status: "done" } & ReadmeView);

function useReadme(relativePath: string | undefined): ReadmeState {
  const [state, setState] = useState<{ path: string; result: ReadmeView } | null>(null);

  useEffect(() => {
    if (!relativePath) return;
    let cancelled = false;
    getReadme({ data: { relativePath } })
      .then((result) => !cancelled && setState({ path: relativePath, result }))
      .catch((caught: unknown) => {
        const error = caught instanceof Error ? caught.message : "Could not load the README.";
        if (!cancelled) setState({ path: relativePath, result: { markdown: null, error } });
      });
    return () => {
      cancelled = true;
    };
  }, [relativePath]);

  return state && state.path === relativePath ? { status: "done", ...state.result } : { status: "loading" };
}

/** The repo's description and rendered README; shared by the preview pane and the detail page. */
export function RepoOverview({ repo }: { repo: RepoView }) {
  const readme = useReadme(repo.relativePath);

  return (
    <div>
      <section>
        <div className="mb-1.5 flex items-center justify-between">
          <h3 className="text-xs font-medium tracking-wide text-muted-foreground uppercase">Description</h3>
          <DescriptionDialog repo={repo}>
            <button
              type="button"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
            >
              <Pencil className="size-3" aria-hidden />
              {repo.description ? "Edit" : "Add"}
            </button>
          </DescriptionDialog>
        </div>
        {repo.description ? (
          <p className="text-sm leading-relaxed">{repo.description}</p>
        ) : (
          <p className="text-sm text-muted-foreground">No description yet.</p>
        )}
      </section>

      <section className="mt-6 border-t pt-4">
        <h3 className="mb-3 text-xs font-medium tracking-wide text-muted-foreground uppercase">README.md</h3>
        {readme.status === "loading" ? (
          <p className="text-sm text-muted-foreground">Loading…</p>
        ) : readme.error ? (
          <p role="alert" className="text-sm text-destructive">
            {readme.error}
          </p>
        ) : readme.markdown === null ? (
          <p className="text-sm text-muted-foreground">This repository has no README.md.</p>
        ) : (
          <MarkdownBody>{readme.markdown}</MarkdownBody>
        )}
      </section>
    </div>
  );
}
