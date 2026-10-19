import { Pencil, X } from "lucide-react";
import { useEffect, useState } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { DescriptionDialog } from "#/components/description-dialog";
import { cn } from "#/lib/utils";
import { getReadme, type ReadmeView, type RepoView } from "#/server/repos";

const isRemote = (url: string | undefined): url is string => !!url && /^https?:\/\//i.test(url);

// README links and images are relative to the repo on disk, which the browser can't reach,
// so only absolute http(s) ones are live. Raw HTML is dropped, never rendered.
const MARKDOWN_COMPONENTS: Components = {
  a: ({ href, children }) =>
    isRemote(href) ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ src, alt }) =>
    typeof src === "string" && isRemote(src) ? (
      <img src={src} alt={alt ?? ""} loading="lazy" referrerPolicy="no-referrer" />
    ) : alt ? (
      <span className="text-muted-foreground">[{alt}]</span>
    ) : null,
};

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

function PreviewBody({ repo }: { repo: RepoView }) {
  const readme = useReadme(repo.relativePath);

  return (
    <div className="flex-1 overflow-y-auto px-5 py-4">
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
          <div className="markdown">
            <Markdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS} skipHtml>
              {readme.markdown}
            </Markdown>
          </div>
        )}
      </section>
    </div>
  );
}

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
        "lg:sticky lg:top-16 lg:z-auto lg:h-[calc(100vh-5rem)] lg:max-w-none lg:shrink-0 lg:self-start lg:transition-[width,transform]",
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
          <PreviewBody key={shown.relativePath} repo={shown} />
        </div>
      ) : null}
    </aside>
  );
}
