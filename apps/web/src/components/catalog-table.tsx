import { Link } from "@tanstack/react-router";
import { ExternalLink, Star } from "lucide-react";
import { useState } from "react";
import { TechBadge } from "#/components/tech-badge";
import { formatAgo } from "#/lib/format";
import type { CatalogEntry, RemoteLink } from "#/lib/catalog";
import { cn } from "#/lib/utils";
import type { ProviderStatus } from "#/server/catalog";
import type { RepoView } from "#/server/repos";

const chip = "inline-flex h-5 items-center gap-1 border px-1.5 text-xs whitespace-nowrap";

/** Whether gitlib holds a list from this host, so a repo absent from it really is missing there. */
const wasListed = (status: ProviderStatus | undefined): boolean =>
  status !== undefined && status.status !== "not-configured" && status.fetchedAt !== null;

function RemoteChip({ label, link, listed }: { label: string; link: RemoteLink | null; listed: boolean }) {
  if (!link) {
    // Only call a repo "missing" from a host gitlib has actually listed.
    return listed ? (
      <span className={cn(chip, "border-dashed text-muted-foreground/60")} aria-label={`Not on ${label}`}>
        {label}
        <span aria-hidden>—</span>
      </span>
    ) : null;
  }
  const flags = [link.isPrivate && "private", link.isFork && "fork", link.isArchived && "archived"].filter(Boolean);
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={`${link.fullName}${flags.length > 0 ? ` (${flags.join(", ")})` : ""}${link.listed ? "" : " — not in your account's list"}`}
      className={cn(chip, "font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring", !link.listed && "text-muted-foreground")}
    >
      {label}
      <ExternalLink className="size-3 opacity-60" aria-hidden />
    </a>
  );
}

/** The star in front of a row. `onToggle` rejects when the server refuses, which the button just reports. */
export function CatalogFavoriteButton({
  name,
  isFavorite,
  onToggle,
}: {
  name: string;
  isFavorite: boolean;
  onToggle: (favorite: boolean) => Promise<unknown>;
}) {
  const [pending, setPending] = useState(false);

  async function toggle() {
    setPending(true);
    try {
      await onToggle(!isFavorite);
    } catch {
      // The star stays as it was; the next refresh shows what the server holds.
    } finally {
      setPending(false);
    }
  }

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={pending}
      aria-pressed={isFavorite}
      aria-label={`${isFavorite ? "Remove" : "Add"} ${name} ${isFavorite ? "from" : "to"} favorites`}
      title={isFavorite ? "Remove from favorites" : "Add to favorites"}
      className={cn(
        "inline-flex size-7 items-center justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50",
        isFavorite ? "text-amber-500" : "text-muted-foreground/50 hover:text-foreground",
      )}
    >
      <Star className={cn("size-3.5", isFavorite && "fill-current")} aria-hidden />
    </button>
  );
}

/** What `setCatalogEntryFavorite` needs to name the entry: a clone if there is one, else its host. */
export function favoriteTarget(entry: CatalogEntry) {
  const local = entry.locals[0];
  if (local) return { relativePath: local };
  if (entry.github) return { provider: "github" as const, fullName: entry.github.fullName };
  if (entry.gitlab) return { provider: "gitlab" as const, fullName: entry.gitlab.fullName };
  return null;
}

function flagsOf(entry: CatalogEntry): string[] {
  const links = [entry.github, entry.gitlab].filter((link): link is RemoteLink => link !== null);
  return [
    links.some((link) => link.isPrivate) && "private",
    links.some((link) => link.isFork) && "fork",
    links.some((link) => link.isArchived) && "archived",
  ].filter((flag): flag is string => Boolean(flag));
}

/**
 * Repositories from every source in one list: where each lives (clone, GitHub, GitLab) is a column, so the
 * combined view and the single-source views are the same table over different slices of the catalog.
 */
export function CatalogTable({
  entries,
  reposByPath,
  github,
  gitlab,
  onToggleFavorite,
}: {
  entries: CatalogEntry[];
  /** Stars or unstars the entry; the table shows the new state when `entries` changes. */
  onToggleFavorite: (entry: CatalogEntry, favorite: boolean) => Promise<unknown>;
  /** Local repos by relativePath, for the stack detected in a clone. */
  reposByPath: ReadonlyMap<string, RepoView>;
  github: ProviderStatus | undefined;
  gitlab: ProviderStatus | undefined;
}) {
  return (
    <div className="overflow-x-auto border-y">
      <table className="w-full min-w-184 table-fixed border-collapse text-sm" data-testid="catalog-table">
        <thead className="border-b">
          <tr className="h-9 text-left text-xs font-medium tracking-wide text-muted-foreground uppercase">
            <th scope="col" className="w-10 px-3">
              <span className="sr-only">Favorite</span>
            </th>
            <th scope="col" className="w-[27%] px-3">Repository</th>
            <th scope="col" className="w-[27%] px-3">Description</th>
            <th scope="col" className="w-[22%] px-3">Where</th>
            <th scope="col" className="w-[10%] px-3">Stack</th>
            <th scope="col" className="w-[10%] px-3">Updated</th>
          </tr>
        </thead>
        <tbody className="divide-y">
          {entries.map((entry) => {
            const local = entry.locals[0];
            const technologies = local ? (reposByPath.get(local)?.technologies ?? []) : [];
            const remote = entry.github
              ? ({ provider: "github", link: entry.github } as const)
              : entry.gitlab
                ? ({ provider: "gitlab", link: entry.gitlab } as const)
                : null;
            const flags = flagsOf(entry);
            return (
              <tr key={entry.id} data-testid="catalog-row" className="align-top">
                <td className="px-3 py-2">
                  <CatalogFavoriteButton
                    name={entry.name}
                    isFavorite={entry.isFavorite}
                    onToggle={(favorite) => onToggleFavorite(entry, favorite)}
                  />
                </td>
                <td className="px-3 py-3">
                  {local ? (
                    <Link
                      to="/repos/$"
                      params={{ _splat: local }}
                      className="block truncate font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {entry.name}
                    </Link>
                  ) : remote ? (
                    <Link
                      to="/remotes/$provider/$"
                      params={{ provider: remote.provider, _splat: remote.link.fullName }}
                      className="block truncate font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
                    >
                      {entry.name}
                    </Link>
                  ) : (
                    <span className="block truncate font-medium">{entry.name}</span>
                  )}
                  <span className="block truncate font-mono text-xs text-muted-foreground" title={entry.fullName}>
                    {entry.fullName}
                  </span>
                  {flags.length > 0 ? (
                    <span className="block text-xs text-muted-foreground">{flags.join(" · ")}</span>
                  ) : null}
                </td>
                <td className="px-3 py-3">
                  {entry.description ? (
                    <span className="leading-snug">{entry.description}</span>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3">
                  <div className="flex flex-wrap gap-1.5">
                    {local ? (
                      <Link
                        to="/repos/$"
                        params={{ _splat: local }}
                        title={entry.locals.join("\n")}
                        className={cn(chip, "font-medium outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring")}
                      >
                        {entry.locals.length > 1 ? `Local ×${entry.locals.length}` : "Local"}
                      </Link>
                    ) : (
                      <span className={cn(chip, "border-dashed text-muted-foreground/60")} aria-label="Not cloned locally">
                        Local
                        <span aria-hidden>—</span>
                      </span>
                    )}
                    <RemoteChip label="GitHub" link={entry.github} listed={wasListed(github)} />
                    <RemoteChip label="GitLab" link={entry.gitlab} listed={wasListed(gitlab)} />
                  </div>
                </td>
                <td className="px-3 py-3">
                  {technologies.length > 0 ? (
                    <div className="flex flex-wrap gap-x-3 gap-y-1">
                      {technologies
                        .filter((tech) => tech.category === "language" || tech.category === "framework")
                        .slice(0, 3)
                        .map((tech) => (
                          <TechBadge key={tech.name} name={tech.name} category={tech.category} />
                        ))}
                    </div>
                  ) : entry.language ? (
                    <TechBadge name={entry.language} category="language" />
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </td>
                <td className="px-3 py-3 text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                  {entry.updatedAt ? formatAgo(entry.updatedAt) : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
