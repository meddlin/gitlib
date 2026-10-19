import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig, type Env } from "./config.js";
import { discoverRepos } from "./discovery.js";
import { GitLibError } from "./errors.js";
import type { DiscoveredRepo, RemoteTarget, RepoDetails, RepoRecord } from "./models.js";
import { parseGitRemotes, selectPreferredRemote } from "./remotes.js";
import { scanRepo } from "./scanner.js";
import { RepoSearch, SearchUnavailableError, type SearchBackend, type SearchHit, type SearchResult } from "./search/index.js";
import { Store } from "./store.js";
import { defaultSystemDeps, type SystemDeps } from "./system.js";

/** ISO-8601 UTC timestamp with second precision, e.g. `2026-01-02T03:04:05+00:00`. */
export function utcNow(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

export const repoKey = (repo: DiscoveredRepo): string =>
  JSON.stringify([repo.rootPath, repo.relativePath]);

export function buildNestedRepoMap(repositories: readonly DiscoveredRepo[]): Map<string, Set<string>> {
  const nested = new Map<string, Set<string>>(repositories.map((repo) => [repoKey(repo), new Set()]));

  for (const repo of repositories) {
    for (const other of repositories) {
      if (repo === other) continue;
      const relative = path.relative(repo.absolutePath, other.absolutePath);
      if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) continue;
      nested.get(repoKey(repo))!.add(other.absolutePath);
    }
  }

  return nested;
}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export function loadGitRemotes(
  repoPath: string,
  system: SystemDeps = defaultSystemDeps,
): { remotes: RemoteTarget[]; error: string | null } {
  let result;
  try {
    result = system.runCommand(["git", "-C", repoPath, "remote", "-v"]);
  } catch (error) {
    return { remotes: [], error: errorMessage(error) };
  }

  if (result.status !== 0) {
    const message =
      result.stderr.trim() || result.stdout.trim() || `git exited with status ${result.status}`;
    return { remotes: [], error: message };
  }

  return { remotes: parseGitRemotes(result.stdout), error: null };
}

export function loadRepoReadme(repoPath: string): { markdown: string | null; error: string | null } {
  const readmePath = path.join(repoPath, "README.md");
  if (!fs.existsSync(readmePath)) return { markdown: null, error: null };

  try {
    return { markdown: fs.readFileSync(readmePath, "utf-8"), error: null };
  } catch (error) {
    return { markdown: null, error: `${errorMessage(error)} (${readmePath})` };
  }
}

export interface FilterOptions {
  search?: string | null;
  technology?: string | null;
  notesOnly?: boolean;
}

export interface SearchOptions extends Omit<FilterOptions, "search"> {
  /** Most hits to return from the search backend. */
  limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 200;

export class GitLibApp {
  readonly search: RepoSearch;

  constructor(
    readonly config: AppConfig,
    readonly store: Store,
    readonly system: SystemDeps = defaultSystemDeps,
    searchBackend?: SearchBackend | null,
  ) {
    this.search = new RepoSearch(config.search, searchBackend);
  }

  refresh(): RepoRecord[] {
    const discovered = discoverRepos(this.config.roots, this.config.ignoreDirs);
    const seenAt = utcNow();
    const repoIds = this.store.syncRepositories(discovered, this.config.roots, seenAt);
    const nestedRepoMap = buildNestedRepoMap(discovered);

    for (const repo of discovered) {
      const key = repoKey(repo);
      const technologies = scanRepo(repo.absolutePath, this.config.ignoreDirs, nestedRepoMap.get(key)!);
      this.store.replaceTechnologies(repoIds.get(key)!, technologies, seenAt);
    }

    return this.store.listRepositories(false);
  }

  loadRepositories(): RepoRecord[] {
    return this.store.listRepositories(false);
  }

  filterRepositories(repositories: readonly RepoRecord[], options: FilterOptions = {}): RepoRecord[] {
    let filtered = [...repositories];

    if (options.search) {
      const needle = options.search.toLowerCase();
      filtered = filtered.filter(
        (repo) =>
          repo.name.toLowerCase().includes(needle) ||
          repo.relativePath.toLowerCase().includes(needle) ||
          repo.absolutePath.toLowerCase().includes(needle) ||
          repo.technologies.some((tag) => tag.toLowerCase().includes(needle)) ||
          repo.notes.toLowerCase().includes(needle) ||
          repo.description.toLowerCase().includes(needle),
      );
    }

    return this.applyFilters(filtered, options);
  }

  private applyFilters(repositories: RepoRecord[], options: FilterOptions): RepoRecord[] {
    let filtered = repositories;

    if (options.technology) {
      const needle = options.technology.toLowerCase();
      filtered = filtered.filter((repo) => repo.technologies.some((tag) => tag.toLowerCase() === needle));
    }

    if (options.notesOnly) filtered = filtered.filter((repo) => repo.hasNotes);

    return filtered;
  }

  /**
   * Full-text search (including README content) through the search backend. If the backend is
   * disabled or unreachable this falls back to the substring matcher, so it never throws for that.
   */
  async searchRepositories(query: string, options: SearchOptions = {}): Promise<SearchResult> {
    const text = query.trim();
    const { limit = DEFAULT_SEARCH_LIMIT, ...filters } = options;
    const repositories = this.loadRepositories();

    if (!text) {
      const hits = this.applyFilters(repositories, filters).map((repo): SearchHit => ({ repo, highlights: {} }));
      return { mode: "basic", hits, notice: null };
    }

    try {
      const byId = new Map(repositories.map((repo) => [repo.id, repo]));
      const matches = await this.search.query(text, limit);
      const hits: SearchHit[] = [];
      for (const match of matches) {
        const repo = byId.get(match.id);
        if (repo && this.applyFilters([repo], filters).length > 0) hits.push({ repo, highlights: match.highlights });
      }
      return { mode: "meilisearch", hits, notice: null };
    } catch (error) {
      if (!(error instanceof SearchUnavailableError)) throw error;
      const hits = this.filterRepositories(repositories, { ...filters, search: text }).map(
        (repo): SearchHit => ({ repo, highlights: {} }),
      );
      return { mode: "basic", hits, notice: this.search.enabled ? error.message : null };
    }
  }

  /** Rebuilds the search index from the stored repositories and their READMEs. */
  async reindexSearch(): Promise<number> {
    return this.search.reindex(this.loadRepositories());
  }

  /** Re-indexes one repository, e.g. after its notes or description changed. */
  async syncRepositorySearch(selector: string): Promise<void> {
    await this.search.syncRepository(this.store.resolveRepository(selector));
  }

  listRepositories(options: FilterOptions & { refresh?: boolean } = {}): RepoRecord[] {
    const { refresh = true, ...filters } = options;
    const repositories = refresh ? this.refresh() : this.loadRepositories();
    return this.filterRepositories(repositories, filters);
  }

  getRepository(selector: string, refresh = false): RepoRecord {
    if (refresh) this.refresh();
    return this.store.resolveRepository(selector);
  }

  showRepository(selector: string): RepoRecord {
    return this.getRepository(selector, true);
  }

  getRepositoryDetails(selector: string, refresh = false): RepoDetails {
    const repo = this.getRepository(selector, refresh);
    const { remotes, error: remoteError } = loadGitRemotes(repo.absolutePath, this.system);
    const { markdown, error: readmeError } = loadRepoReadme(repo.absolutePath);
    return { repo, remotes, remoteError, readmeMarkdown: markdown, readmeError };
  }

  openRepositoryInVscode(selector: string, refresh = false): RepoRecord {
    const repo = this.getRepository(selector, refresh);
    const command = [...this.config.vscodeCommand, repo.absolutePath];

    let result;
    try {
      result = this.system.runCommand(command);
    } catch (error) {
      throw new GitLibError(`Unable to launch VS Code: ${errorMessage(error)}`, { cause: error });
    }

    if (result.status !== 0) {
      const message =
        result.stderr.trim() || result.stdout.trim() || `command exited with status ${result.status}`;
      throw new GitLibError(`Unable to launch VS Code: ${message}`);
    }

    return repo;
  }

  openRepositoryRemote(selector: string, refresh = false): { repo: RepoRecord; remote: RemoteTarget } {
    const details = this.getRepositoryDetails(selector, refresh);
    const { repo } = details;

    if (details.remoteError) {
      throw new GitLibError(`Remote links unavailable for ${repo.relativePath}: ${details.remoteError}`);
    }

    const remote = selectPreferredRemote(details.remotes);
    if (remote === null || remote.landingPageUrl === null) {
      throw new GitLibError(`No remote landing page available for ${repo.relativePath}.`);
    }

    let opened: boolean;
    try {
      opened = this.system.openUrl(remote.landingPageUrl);
    } catch (error) {
      throw new GitLibError(
        `Unable to open ${remote.name} for ${repo.relativePath}: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    if (!opened) throw new GitLibError(`Unable to open ${remote.name} for ${repo.relativePath}.`);

    return { repo, remote };
  }

  saveRepositoryNotes(selector: string, notes: string, refresh = false): RepoRecord {
    if (refresh) this.refresh();
    const repo = this.store.resolveRepository(selector);
    this.store.updateNotes(repo.id, notes);
    return this.store.resolveRepository(selector);
  }

  saveRepositoryDescription(selector: string, description: string, refresh = false): RepoRecord {
    if (refresh) this.refresh();
    const repo = this.store.resolveRepository(selector);
    this.store.updateDescription(repo.id, description.trim());
    return this.store.resolveRepository(selector);
  }

  editRepositoryNotes(selector: string, notes: string): RepoRecord {
    return this.saveRepositoryNotes(selector, notes, true);
  }
}

export function createApplication(
  env: Env = process.env,
  system: SystemDeps = defaultSystemDeps,
  searchBackend?: SearchBackend | null,
): GitLibApp {
  const config = loadConfig(env);
  const store = new Store(config.dbPath);
  return new GitLibApp(config, store, system, searchBackend);
}
