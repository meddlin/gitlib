import { RepoNotFoundError, utcNow, type RemoteLibraryEntry, type RemoteRepoContext } from "@gitlib/core";
import type { CatalogEntry } from "#/lib/catalog";
import { isStale, refreshIntervalMs } from "#/lib/community";
import { parseSnapshot, parseStoredSnapshot, serializeSnapshot, toSnapshotContext, type RepoSnapshot } from "#/lib/repo-snapshot";
import { buildCatalog } from "./catalog.server";
import { githubGet, sourceOf, type GitHubSource } from "./github.server";
import { getApp } from "./gitlib.server";

/** Where the chat gets GitHub-only repositories from; `handleChat` takes one so tests can supply their own. */
export interface RemoteChatSource {
  /** Every repository the GitHub account lists that is not cloned here, newest push first. */
  list(): Promise<RemoteLibraryEntry[]>;
  /** The chat context for one of them, fetching a fresh snapshot when the stored one is old. Throws `RepoNotFoundError` for any other repo. */
  resolve(slug: string): Promise<RemoteRepoContext>;
}

/** Hours before a stored snapshot is fetched again; 0 means only when asked. A README rarely changes faster than this. */
const refreshInterval = (): number | null => refreshIntervalMs(process.env["GITLIB_SNAPSHOT_REFRESH_HOURS"]);

/** Reads GitHub's four answers for a repository. Only the repository itself must exist; the rest are empty for a repo without them. */
async function fetchSnapshot(source: GitHubSource): Promise<RepoSnapshot> {
  const [repo, languages, contents, readme] = await Promise.all([
    githubGet<unknown>(source, "", {}),
    githubGet<unknown>(source, "/languages", {}),
    githubGet<unknown>(source, "/contents", {}),
    githubGet<{ content?: unknown; encoding?: unknown }>(source, "/readme", {}),
  ]);
  if (repo.error !== null) throw new Error(repo.error);
  // A 404 is how GitHub says "no README" or "empty repository"; anything else (rate limit, outage) is a real failure.
  for (const result of [languages, contents, readme]) if (result.error !== null && result.status !== 404) throw new Error(result.error);

  const encoded = readme.data && typeof readme.data.content === "string" && readme.data.encoding === "base64" ? readme.data.content : "";
  return parseSnapshot({
    repo: repo.data,
    languages: languages.data,
    contents: contents.data,
    readme: Buffer.from(encoded.replace(/\s/g, ""), "base64").toString("utf-8"),
  });
}

/** Fetches in flight by slug, so a click on the picker and the question that follows it share one request. Each resolves to its error, if any. */
const inFlight = new Map<string, Promise<string | null>>();

export interface SnapshotState {
  snapshot: RepoSnapshot | null;
  fetchedAt: string | null;
  /** Why GitHub could not be asked; a stored snapshot may still be present. */
  error: string | null;
}

/**
 * The snapshot for a repository: the stored one while it is fresh, otherwise one fetched now. A failed fetch
 * falls back to whatever is stored, so a rate limit costs freshness, not the answer.
 */
export async function ensureSnapshot(source: GitHubSource, { force = false }: { force?: boolean } = {}): Promise<SnapshotState> {
  const store = getApp().store;
  const read = (): SnapshotState => {
    const row = store.getRepoSnapshot(source.slug);
    const snapshot = row ? parseStoredSnapshot(row.payload) : null;
    return { snapshot, fetchedAt: snapshot && row ? row.fetchedAt : null, error: null };
  };

  const stored = read();
  const interval = refreshInterval();
  const fresh = stored.snapshot && stored.fetchedAt && !force && (interval === null || !isStale(stored.fetchedAt, Date.now(), interval));
  if (fresh) return stored;

  const key = source.slug.toLowerCase();
  const running =
    inFlight.get(key) ??
    (async (): Promise<string | null> => {
      try {
        store.saveRepoSnapshot(source.slug, serializeSnapshot(await fetchSnapshot(source)), utcNow());
        return null;
      } catch (caught) {
        return caught instanceof Error ? caught.message : "Could not fetch the repository from GitHub.";
      }
    })();
  inFlight.set(key, running);
  void running.finally(() => inFlight.get(key) === running && inFlight.delete(key));
  const error = await running;
  return { ...read(), error };
}

/** The GitHub repository behind a catalog entry the account lists; never an arbitrary one. */
async function listedEntry(slug: string): Promise<(CatalogEntry & { github: NonNullable<CatalogEntry["github"]> }) | null> {
  const wanted = slug.toLowerCase();
  const { entries } = await buildCatalog();
  for (const entry of entries) if (entry.github?.listed && entry.github.fullName.toLowerCase() === wanted) return entry as CatalogEntry & { github: NonNullable<CatalogEntry["github"]> };
  return null;
}

/** What the model is told about a repository when the snapshot is missing or may be out of date. */
function syncNote(state: SnapshotState): string | null {
  if (!state.error) return null;
  return state.snapshot
    ? `GitHub could not be asked just now (${state.error}), so this snapshot may be out of date.`
    : `GitHub could not be asked for this repository's details (${state.error}).`;
}

export interface RemoteSync {
  /** When the stored snapshot was fetched; null when there is none. */
  fetchedAt: string | null;
  /** Why GitHub could not be asked just now. A stored snapshot may still exist. */
  error: string | null;
}

/** Makes sure a snapshot is stored for a listed repository (fetching it if missing or old, or when `force`), for the picker. */
export async function syncRemote(slug: string, force: boolean): Promise<RemoteSync> {
  const entry = await listedEntry(slug);
  const source = entry && sourceOf(entry.github.fullName);
  if (!source) return { fetchedAt: null, error: `${slug} is not a repository your GitHub account lists.` };
  const state = await ensureSnapshot(source, { force });
  return { fetchedAt: state.fetchedAt, error: state.error };
}

export const githubChatSource: RemoteChatSource = {
  async list() {
    const { entries } = await buildCatalog();
    return entries
      .filter((entry) => entry.github?.listed && entry.locals.length === 0)
      .sort((a, b) => (b.updatedAt ?? "").localeCompare(a.updatedAt ?? ""))
      .map((entry) => ({ fullName: entry.github!.fullName, description: entry.description, language: entry.language }));
  },

  async resolve(slug) {
    const entry = await listedEntry(slug);
    const source = entry && sourceOf(entry.github.fullName);
    if (!entry || !source) throw new RepoNotFoundError(`${slug} is not a repository your GitHub account lists.`);

    const state = await ensureSnapshot(source);
    return {
      fullName: entry.github.fullName,
      url: entry.github.url,
      description: entry.description,
      isPrivate: entry.github.isPrivate,
      isFork: entry.github.isFork,
      isArchived: entry.github.isArchived,
      primaryLanguage: entry.language,
      pushedAt: entry.updatedAt,
      snapshot: state.snapshot && state.fetchedAt ? toSnapshotContext(state.snapshot, state.fetchedAt) : null,
      syncNote: syncNote(state),
    };
  },
};
