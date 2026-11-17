/**
 * The repository catalog: every repo gitlib can see, whether it is cloned locally, hosted on GitHub, hosted on
 * GitLab, or any mix. Pure data shaping with no I/O, so the server and the tests share it.
 */

export type RemoteProvider = "github" | "gitlab";

/** A repository as the hosting service lists it for the configured account. */
export interface RemoteRepo {
  provider: RemoteProvider;
  /** `host/path`, lowercased; what a local clone's remote URL is matched against. */
  key: string;
  /** `owner/repo` (GitHub) or `group/subgroup/project` (GitLab). */
  fullName: string;
  name: string;
  description: string;
  url: string;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
  /** Last push (GitHub) or activity (GitLab), ISO 8601. */
  updatedAt: string | null;
  language: string | null;
}

/** One page of a host's repository listing with the ETag it came with, so the next check can revalidate it. */
export interface ListingPage {
  etag: string | null;
  repos: RemoteRepo[];
}

/** What is stored for one host: its pages, and the account they were listed for. */
export interface StoredListing {
  /** Which account and host the pages belong to; a listing for a different one is never reused. */
  scope: string;
  pages: ListingPage[];
}

/** Reads a stored listing back; null when it is unreadable or was listed for a different `scope`. */
export function parseStoredListing(payload: string, scope: string): StoredListing | null {
  try {
    const value = JSON.parse(payload) as Partial<StoredListing> | null;
    if (!value || value.scope !== scope || !Array.isArray(value.pages)) return null;
    for (const page of value.pages) if (!page || !Array.isArray(page.repos)) return null;
    return value as StoredListing;
  } catch {
    return null;
  }
}

/** A remote of a local clone that points at a known hosting service. */
export interface LocalRemote {
  provider: RemoteProvider;
  key: string;
  /** Path on the host, as written in the remote URL. */
  fullName: string;
  url: string;
}

/** What the catalog needs to know about a local clone. */
export interface LocalClone {
  relativePath: string;
  name: string;
  description: string;
  /** Starred in gitlib's local table. */
  isFavorite?: boolean;
  /** Preferred remote first; only the first remote per provider is used to link the clone. */
  remotes: LocalRemote[];
}

/** One repo's presence on one hosting service. */
export interface RemoteLink {
  /** `remoteKey` of the repo on this host; what a remote favorite is stored under. */
  key: string;
  fullName: string;
  url: string;
  /** True when the provider's listing for the configured account contains it; false when only a clone's remote names it. */
  listed: boolean;
  isPrivate: boolean;
  isFork: boolean;
  isArchived: boolean;
}

export interface CatalogEntry {
  /** Stable within one catalog; safe as a React key. */
  id: string;
  name: string;
  /** `owner/repo` when a host knows the repo, otherwise the clone's relative path. */
  fullName: string;
  description: string;
  /** Relative paths of the local clones (usually one); the first is the one links open. */
  locals: string[];
  github: RemoteLink | null;
  gitlab: RemoteLink | null;
  /**
   * Starred. A cloned repo is starred through its clones (the same flag as the local table); a repo that only a
   * host has is starred through its remote favorite.
   */
  isFavorite: boolean;
  updatedAt: string | null;
  language: string | null;
}

/** How a remote favorite is identified in the set `mergeCatalog` takes. */
export const remoteFavoriteId = (provider: RemoteProvider, key: string): string => `${provider}:${key}`;

/** `host/path`, lowercased and without a trailing `.git`: the identity two sources must share to be one repo. */
export function remoteKey(host: string, path: string): string {
  const trimmed = path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  return `${host.toLowerCase()}/${trimmed.toLowerCase()}`;
}

/** Splits a remote landing page (`https://host/a/b`) into its `remoteKey` and path; null if it isn't one. */
export function parseLandingPage(landingPageUrl: string | null): { key: string; path: string } | null {
  if (!landingPageUrl) return null;
  try {
    const url = new URL(landingPageUrl);
    const path = url.pathname.replace(/^\/+|\/+$/g, "");
    if (!url.hostname || !path) return null;
    return { key: remoteKey(url.host, path), path };
  } catch {
    return null;
  }
}

/** Disjoint sets over string ids; joins clones and remote repos that describe the same project. */
class Groups {
  private parent = new Map<string, string>();

  find(id: string): string {
    let root = this.parent.get(id) ?? id;
    if (root !== id) {
      root = this.find(root);
      this.parent.set(id, root);
    }
    return root;
  }

  union(a: string, b: string): void {
    this.parent.set(this.find(a), this.find(b));
  }
}

const collator = new Intl.Collator(undefined, { sensitivity: "base", numeric: true });

function linkFromRemote(remote: RemoteRepo): RemoteLink {
  return {
    key: remote.key,
    fullName: remote.fullName,
    url: remote.url,
    listed: true,
    isPrivate: remote.isPrivate,
    isFork: remote.isFork,
    isArchived: remote.isArchived,
  };
}

/**
 * Joins local clones with the repos each hosting service lists. A clone belongs with the remote repos its
 * preferred GitHub and GitLab remotes name, and clones that share a remote repo collapse into one entry. Remote
 * repos nobody has cloned stand alone. Linked worktrees must be left out of `locals` by the caller.
 * `remoteFavorites` holds `remoteFavoriteId`s; they star only entries with no clone, since a clone's own star wins.
 * Starred entries come first.
 */
export function mergeCatalog(
  locals: readonly LocalClone[],
  github: readonly RemoteRepo[],
  gitlab: readonly RemoteRepo[],
  remoteFavorites: ReadonlySet<string> = new Set(),
): CatalogEntry[] {
  const remotes = new Map<string, RemoteRepo>();
  for (const remote of [...github, ...gitlab]) remotes.set(`${remote.provider}:${remote.key}`, remote);

  const groups = new Groups();
  const nodeIds = new Set<string>();
  const cloneByNode = new Map<string, LocalClone>();
  /** The remote each clone uses per provider, in the clone's own preference order. */
  const cloneRemotes = new Map<string, Partial<Record<RemoteProvider, LocalRemote>>>();

  for (const clone of locals) {
    const node = `local:${clone.relativePath}`;
    cloneByNode.set(node, clone);
    nodeIds.add(node);
    const chosen: Partial<Record<RemoteProvider, LocalRemote>> = {};
    for (const remote of clone.remotes) chosen[remote.provider] ??= remote;
    cloneRemotes.set(node, chosen);
    for (const remote of Object.values(chosen)) groups.union(node, `${remote.provider}:${remote.key}`);
  }
  for (const id of remotes.keys()) nodeIds.add(id);

  const members = new Map<string, string[]>();
  for (const node of nodeIds) {
    const root = groups.find(node);
    members.set(root, [...(members.get(root) ?? []), node]);
  }

  const entries: CatalogEntry[] = [];
  for (const [root, nodes] of members) {
    const clones = nodes.flatMap((node) => cloneByNode.get(node) ?? []);
    const listed: Partial<Record<RemoteProvider, RemoteRepo>> = {};
    for (const node of nodes) {
      const remote = remotes.get(node);
      if (remote) listed[remote.provider] ??= remote;
    }

    const links: Record<RemoteProvider, RemoteLink | null> = { github: null, gitlab: null };
    for (const provider of ["github", "gitlab"] as const) {
      const hit = listed[provider];
      if (hit) {
        links[provider] = linkFromRemote(hit);
        continue;
      }
      // Not in the account's listing (other owner, no access, or the host isn't configured): the clone's own
      // remote still says where it lives.
      const named = clones.map((clone) => cloneRemotes.get(`local:${clone.relativePath}`)?.[provider]).find(Boolean);
      if (named) {
        links[provider] = {
          key: named.key,
          fullName: named.fullName,
          url: named.url,
          listed: false,
          isPrivate: false,
          isFork: false,
          isArchived: false,
        };
      }
    }

    const primary = clones[0];
    const remote = listed.github ?? listed.gitlab;
    const hosted = links.github ?? links.gitlab;
    const isFavorite =
      clones.length > 0
        ? clones.some((clone) => clone.isFavorite)
        : (["github", "gitlab"] as const).some((provider) => {
            const link = links[provider];
            return link !== null && remoteFavorites.has(remoteFavoriteId(provider, link.key));
          });
    entries.push({
      id: root,
      name: primary?.name ?? remote?.name ?? root,
      fullName: hosted?.fullName ?? primary?.relativePath ?? root,
      description: primary?.description || remote?.description || "",
      locals: clones.map((clone) => clone.relativePath).sort(collator.compare),
      github: links.github,
      gitlab: links.gitlab,
      isFavorite,
      updatedAt: [listed.github?.updatedAt, listed.gitlab?.updatedAt].filter(Boolean).sort().at(-1) ?? null,
      language: remote?.language ?? null,
    });
  }

  return entries.sort(
    (a, b) =>
      Number(b.isFavorite) - Number(a.isFavorite) ||
      collator.compare(a.fullName, b.fullName) ||
      collator.compare(a.id, b.id),
  );
}

export type CatalogSource = "combined" | "local" | "github" | "gitlab";

export const CATALOG_SOURCES: readonly CatalogSource[] = ["combined", "local", "github", "gitlab"];

/** The entries a catalog tab shows. "github"/"gitlab" mean repos that host lists for the account. */
export function entriesForSource(entries: readonly CatalogEntry[], source: CatalogSource): CatalogEntry[] {
  switch (source) {
    case "combined":
      return [...entries];
    case "local":
      return entries.filter((entry) => entry.locals.length > 0);
    case "github":
      return entries.filter((entry) => entry.github?.listed);
    case "gitlab":
      return entries.filter((entry) => entry.gitlab?.listed);
  }
}

/** Case-insensitive match of every word in `query` against the name, full name and description. */
export function matchesQuery(entry: CatalogEntry, query: string | undefined): boolean {
  const words = query?.toLowerCase().split(/\s+/).filter(Boolean) ?? [];
  if (words.length === 0) return true;
  const haystack = `${entry.name} ${entry.fullName} ${entry.description}`.toLowerCase();
  return words.every((word) => haystack.includes(word));
}

/** The entry for a repo that only a hosting service has: listed (or named) by `provider`, with no local clone. */
export function findRemoteOnly(
  entries: readonly CatalogEntry[],
  provider: RemoteProvider,
  fullName: string,
): CatalogEntry | null {
  const target = fullName.toLowerCase();
  return (
    entries.find((entry) => entry.locals.length === 0 && entry[provider]?.fullName.toLowerCase() === target) ?? null
  );
}

/** The HTTPS URL `git clone` takes for a repo's landing page. */
export function cloneUrlOf(landingPageUrl: string): string {
  return landingPageUrl.replace(/\/+$/, "").replace(/\.git$/i, "") + ".git";
}

/** The folder a clone gets: the repo's own name, which is the last segment of its full name. */
export function cloneFolderName(fullName: string): string | null {
  const name = fullName.split("/").filter(Boolean).at(-1)?.replace(/\.git$/i, "");
  return name && name !== "." && name !== ".." && !/[\\:\0]/.test(name) ? name : null;
}
