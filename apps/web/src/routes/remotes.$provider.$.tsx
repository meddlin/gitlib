import { Link, createFileRoute, notFound, useNavigate, useRouter } from "@tanstack/react-router";
import { ArrowLeft, Download, ExternalLink, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { CatalogFavoriteButton } from "#/components/catalog-table";
import { TechBadge } from "#/components/tech-badge";
import { Button } from "#/components/ui/button";
import type { RemoteProvider } from "#/lib/catalog";
import { useLibraryState } from "#/lib/library-state";
import { cloneRepo, getRemoteRepo, setCatalogEntryFavorite } from "#/server/catalog";

const LABELS: Record<RemoteProvider, string> = { github: "GitHub", gitlab: "GitLab" };

export const Route = createFileRoute("/remotes/$provider/$")({
  // The splat holds the repo's full name on the host, which contains slashes.
  loader: async ({ params }) => {
    const provider = params.provider === "github" || params.provider === "gitlab" ? params.provider : null;
    if (!provider) throw notFound();
    const entry = await getRemoteRepo({ data: { provider, fullName: params._splat ?? "" } });
    // Cloned in the meantime: the local detail page is the one to show.
    if (!entry) throw notFound();
    return { provider: provider as RemoteProvider, entry };
  },
  head: ({ loaderData }) => ({ meta: [{ title: `${loaderData?.entry.name ?? "Repository"} · Gitlib` }] }),
  notFoundComponent: RemoteNotFound,
  component: RemoteRepoDetail,
});

function BackLink() {
  const library = useLibraryState();
  return (
    <Link
      to="/"
      search={library}
      className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
    >
      <ArrowLeft className="size-3.5" aria-hidden /> Repositories
    </Link>
  );
}

function RemoteNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-4 px-4 py-8 sm:px-6">
      <BackLink />
      <p className="border-y py-10 text-center text-sm text-muted-foreground">
        That repository isn't listed as hosted-only. It may already be cloned, or the listing may have changed; try a refresh.
      </p>
    </div>
  );
}

function RemoteRepoDetail() {
  const { provider, entry } = Route.useLoaderData();
  const link = entry[provider]!;
  const navigate = useNavigate();
  const router = useRouter();
  const [cloning, setCloning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flags = [link.isPrivate && "private", link.isFork && "fork", link.isArchived && "archived"].filter(Boolean);

  async function clone() {
    setCloning(true);
    setError(null);
    try {
      const { relativePath } = await cloneRepo({ data: { provider, fullName: link.fullName } });
      await navigate({ to: "/repos/$", params: { _splat: relativePath } });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not clone the repository.");
      setCloning(false);
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-1 flex-col gap-5 px-4 py-8 sm:px-6">
      <BackLink />
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{entry.name}</h1>
            <CatalogFavoriteButton
              name={entry.name}
              isFavorite={entry.isFavorite}
              onToggle={async (favorite) => {
                await setCatalogEntryFavorite({ data: { provider, fullName: link.fullName, favorite } });
                await router.invalidate();
              }}
            />
          </div>
          <p className="truncate font-mono text-xs text-muted-foreground" title={link.fullName}>
            {link.fullName}
          </p>
          {entry.language ? (
            <div className="mt-2">
              <TechBadge name={entry.language} category="language" />
            </div>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" asChild>
            <a href={link.url} target="_blank" rel="noreferrer">
              <ExternalLink aria-hidden /> Open on {LABELS[provider]}
            </a>
          </Button>
          <Button size="sm" onClick={clone} disabled={cloning}>
            {cloning ? <LoaderCircle className="animate-spin" aria-hidden /> : <Download aria-hidden />}
            {cloning ? "Cloning…" : "Clone locally"}
          </Button>
        </div>
      </header>
      {error ? (
        <p role="alert" className="text-sm whitespace-pre-wrap text-destructive">
          {error}
        </p>
      ) : null}
      <p className="text-sm text-muted-foreground">
        This repository is only on {LABELS[provider]}
        {flags.length > 0 ? ` (${flags.join(", ")})` : ""}. Cloning puts a copy in the clone directory set on the Settings page.
      </p>
      {entry.description ? <p className="text-sm leading-relaxed">{entry.description}</p> : null}
    </div>
  );
}
