import fs from "node:fs";
import path from "node:path";
import {
  buildChatSystemPrompt,
  ModelLane,
  OllamaBackend,
  type ChatBackend,
  type RemoteLibraryEntry,
  type RemoteRepoContext,
} from "./ai/index.js";
import { DEFAULT_OLLAMA_HOST, loadConfig, type AppConfig, type Env, type OllamaConnectionMode } from "./config.js";
import { normalizeCloneDirectory, writeCloneDirectory } from "./clone-directory.js";
import {
  hostFor,
  normalizeOllamaHost,
  OllamaConnectionError,
  writeOllamaConnection,
  type OllamaConnection,
} from "./ollama-connection.js";
import {
  checkDependabot,
  DependabotBusyError,
  DependabotExplainer,
  DependabotScheduler,
  DependabotStore,
  DependabotUnavailableError,
  GitHubDependabotBackend,
  isValidOwner,
  isValidRepoName,
  normalizeSchedule,
  resolveGitHubToken,
  type DependabotBackend,
  type DependabotReport,
  type RunTrigger,
  type StoredRun,
} from "./dependabot/index.js";
import { discoverRepos } from "./discovery.js";
import { GitLibError } from "./errors.js";
import type { DiscoveredRepo, RemoteTarget, RepoDetails, RepoRecord } from "./models.js";
import {
  LocalIssueNotFoundError,
  PlanningStore,
  type DependabotDismissal,
  type StoredDependabotSchedule,
  normalizeIssueBody,
  normalizeIssueTitle,
  normalizeMilestoneDescription,
  normalizeMilestoneDueDate,
  normalizeMilestoneTitle,
  normalizeProjectName,
  normalizeRepoSlug,
  normalizeProjectRemote,
  MilestoneNotFoundError,
  EpicNotFoundError,
  normalizeEpicDescription,
  normalizeEpicTitle,
  type Epic,
  type EpicChanges,
  type NewEpic,
  AmbiguousPlanningRepoError,
  PlanningRepoNotFoundError,
  ProjectNotFoundError,
  type Milestone,
  type MilestoneChanges,
  type ArchiveFilter,
  type NewMilestone,
  type PlanningRepo,
  type PlanningRepoStatus,
  type Project,
  type ProjectRemote,
  type IssueStatus,
  type LocalIssue,
  type LocalIssueChanges,
  type LocalIssueQuery,
  type LocalIssueState,
} from "./planning/index.js";
import { loadGitRemotes, selectPreferredRemote } from "./remotes.js";
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
  /** Linked git worktrees are hidden unless this is set. */
  includeWorktrees?: boolean;
}

export interface SearchOptions extends Omit<FilterOptions, "search"> {
  /** Most hits to return from the search backend. */
  limit?: number;
}

export const DEFAULT_SEARCH_LIMIT = 200;

/** A Dependabot check is a few requests per owner; this is far longer than one takes, and bounds a crashed holder. */
const DEPENDABOT_LEASE_MS = 15 * 60_000;

export class GitLibApp {
  readonly search: RepoSearch;
  /** The language-model server behind the chat panel; null when `ollama.enabled = false`. */
  get chat(): ChatBackend | null {
    return this.chatBackend;
  }
  private chatBackend: ChatBackend | null;
  /** True when a backend was handed in (tests), so changing the connection never replaces it. */
  private readonly chatInjected: boolean;
  /** Where Dependabot pull requests come from; null when no GitHub token is set. */
  readonly dependabot: DependabotBackend | null;
  /** What the Dependabot checks found, kept in `gitlib.db`. */
  readonly dependabotStore: DependabotStore;
  /** One model request at a time, chat ahead of background work; every caller of `chat` that is not a person goes through it. */
  readonly modelLane = new ModelLane();

  constructor(
    readonly config: AppConfig,
    readonly store: Store,
    readonly system: SystemDeps = defaultSystemDeps,
    searchBackend?: SearchBackend | null,
    readonly planning: PlanningStore = new PlanningStore(config.planningDbPath),
    chatBackend?: ChatBackend | null,
    dependabotBackend: DependabotBackend | null = null,
  ) {
    this.search = new RepoSearch(config.search, searchBackend);
    this.chatInjected = chatBackend !== undefined;
    this.chatBackend = chatBackend !== undefined ? chatBackend : config.ollama.enabled ? new OllamaBackend(config.ollama) : null;
    this.dependabot = dependabotBackend;
    this.dependabotStore = new DependabotStore(config.dbPath);
  }

  /**
   * Points the chat panel (and the Dependabot notes) at Ollama on this machine or on another one, and remembers the
   * choice in the app home. Takes effect at once; throws if GITLIB_OLLAMA_HOST pins the host.
   */
  setOllamaConnection(input: { mode: OllamaConnectionMode; host?: string | null }): void {
    const ollama = this.config.ollama;
    if (ollama.hostFromEnv) {
      throw new OllamaConnectionError("GITLIB_OLLAMA_HOST is set, so the server can only be changed there.");
    }
    const connection: OllamaConnection =
      input.mode === "local" ? { mode: "local", host: null } : { mode: "server", host: normalizeOllamaHost(input.host ?? "") };
    writeOllamaConnection(this.config.appHome, connection);
    ollama.host = hostFor(connection);
    ollama.mode = ollama.host === DEFAULT_OLLAMA_HOST ? "local" : "server";
    if (!this.chatInjected && ollama.enabled) this.chatBackend = new OllamaBackend(ollama);
  }

  /** Remembers where "Clone locally" puts repositories; takes effect at once. Throws if it is outside every root. */
  setCloneDirectory(input: string): string {
    const directory = normalizeCloneDirectory(input, this.config.roots);
    writeCloneDirectory(this.config.appHome, directory);
    this.config.cloneDir = directory;
    return directory;
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

    const repositories = this.store.listRepositories(false);
    this.reconcilePlanningRepos(repositories);
    return repositories;
  }

  /**
   * Keeps planning repos pointed at their repos after a scan. A planning repo whose path is gone is relinked
   * to the scanned repo with the same first commit, but only when that match is unambiguous: exactly one
   * lost planning repo and exactly one unclaimed, non-worktree repo share it (forks and second clones share a
   * first commit too). Anything else is left for `relinkPlanningRepo`. Archived repos are left where they are.
   */
  private reconcilePlanningRepos(repositories: readonly RepoRecord[]): void {
    const planned = this.planning.listRepos().filter((repo) => repo.archivedAt === null);
    if (planned.length === 0) return;
    const byPath = new Map(repositories.map((repo) => [repo.relativePath, repo]));

    for (const repo of planned) {
      const record = byPath.get(repo.path);
      if (record && repo.rootCommit === null) this.fingerprint(repo, record);
    }

    const lost = planned.filter((repo) => !byPath.has(repo.path) && repo.rootCommit !== null);
    if (lost.length === 0) return;

    // Archived repos still own their paths, so a repo that moved is never handed one of them.
    const claimed = new Set(this.planning.listRepos().map((repo) => repo.path));
    const found = new Map<string, RepoRecord[]>();
    for (const record of repositories) {
      if (record.isWorktree || claimed.has(record.relativePath)) continue;
      const root = this.rootCommitOf(record);
      if (root) found.set(root, [...(found.get(root) ?? []), record]);
    }

    const now = utcNow();
    for (const repo of lost) {
      const matches = found.get(repo.rootCommit!) ?? [];
      const rivals = lost.filter((other) => other.rootCommit === repo.rootCommit);
      if (matches.length === 1 && rivals.length === 1) this.planning.moveRepo(repo.id, matches[0]!.relativePath, null, now);
    }
  }

  /**
   * The repo's first commit (the lowest, if unrelated histories were merged), cached in gitlib.db because
   * walking a long history is slow. Null when git cannot tell, e.g. a repo with no commits yet.
   */
  private rootCommitOf(record: RepoRecord): string | null {
    const cached = this.store.rootCommit(record.id);
    if (cached) return cached;
    let result;
    try {
      result = this.system.runCommand(["git", "-C", record.absolutePath, "rev-list", "--max-parents=0", "HEAD"]);
    } catch {
      return null;
    }
    if (result.status !== 0) return null;
    const root = result.stdout.split("\n").map((line) => line.trim()).filter((line) => /^[0-9a-f]{40,64}$/.test(line)).sort()[0];
    if (!root) return null;
    this.store.saveRootCommit(record.id, root);
    return root;
  }

  /** Records the first commit of a planning repo that does not have one yet, so a later move can be followed. */
  private fingerprint(repo: PlanningRepo, record: RepoRecord): void {
    if (repo.rootCommit !== null) return;
    const root = this.rootCommitOf(record);
    if (root) this.planning.setRepoRootCommit(repo.id, root);
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
    let filtered = options.includeWorktrees ? repositories : repositories.filter((repo) => !repo.isWorktree);

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

  /**
   * The chat's system prompt: a capped list of every repository plus, when `repoSelector` names one, that
   * repository's details and README. Throws `RepoNotFoundError` for a repository gitlib does not know.
   * GitHub-only repositories are not in gitlib's scan, so the caller that knows them passes them in `remote`
   * (the one being looked at) and `remoteRepositories` (all of them).
   */
  chatSystemPrompt(
    repoSelector?: string | null,
    { remote, remoteRepositories }: { remote?: RemoteRepoContext | null; remoteRepositories?: readonly RemoteLibraryEntry[] } = {},
  ): string {
    const repo = repoSelector ? this.store.resolveRepository(repoSelector) : null;
    return buildChatSystemPrompt({ repositories: this.loadRepositories(), repo, remote, remoteRepositories });
  }

  /**
   * Asks GitHub for the open Dependabot pull requests of every favorite repository and sorts them into buckets.
   * Report only: nothing is written to GitHub or to gitlib's data. Throws `DependabotUnavailableError` without a token.
   */
  async checkDependabot(options: { signal?: AbortSignal; now?: Date } = {}): Promise<DependabotReport> {
    if (!this.dependabot) {
      throw new DependabotUnavailableError(
        "Checking Dependabot pull requests needs a GitHub token: set GITLIB_GITHUB_TOKEN or GITHUB_TOKEN.",
      );
    }
    return checkDependabot({
      repositories: this.loadRepositories(),
      remoteFavorites: this.store.listRemoteFavorites(),
      backend: this.dependabot,
      system: this.system,
      ...options,
    });
  }

  /**
   * Like `checkDependabot`, but takes the lock that keeps two checks (CLI, web button, schedule) from running at
   * once and saves the result as the newest run. Throws `DependabotBusyError` when another check holds the lock.
   */
  async runDependabotCheck(options: { trigger: RunTrigger; signal?: AbortSignal; now?: Date }): Promise<StoredRun> {
    const startedAt = options.now ?? new Date();
    const holder = `${options.trigger}:${process.pid}`;
    const lease = this.dependabotStore.acquireLease(holder, startedAt, DEPENDABOT_LEASE_MS);
    if (!lease.acquired) {
      throw new DependabotBusyError(
        `A Dependabot check is already running (started ${lease.heldBy.takenAt} by ${lease.heldBy.holder.split(":")[0]}).`,
      );
    }
    try {
      const report = await this.checkDependabot({ signal: options.signal, now: startedAt });
      return this.dependabotStore.saveRun(report, {
        trigger: options.trigger,
        startedAt: startedAt.toISOString(),
        finishedAt: new Date().toISOString(),
      });
    } finally {
      this.dependabotStore.releaseLease(holder);
    }
  }

  /** The newest saved Dependabot check, or null if none has run. */
  latestDependabotRun(): StoredRun | null {
    return this.dependabotStore.latestRun();
  }

  /** Puts a Dependabot PR aside until `until` (an ISO time), or until it closes when `until` is null. */
  dismissDependabotPr(repo: string, number: number, until: string | null = null): DependabotDismissal {
    const [owner, name, ...rest] = repo.split("/");
    if (!owner || !name || rest.length > 0 || !isValidOwner(owner) || !isValidRepoName(name)) {
      throw new GitLibError(`"${repo}" is not a GitHub repository (expected owner/repo).`);
    }
    if (!Number.isInteger(number) || number < 1) throw new GitLibError(`"${number}" is not a pull request number.`);
    if (until !== null && Number.isNaN(Date.parse(until))) throw new GitLibError(`"${until}" is not a date.`);
    return this.planning.dismissDependabotPr(repo, number, until === null ? null : new Date(until).toISOString(), utcNow());
  }

  restoreDependabotPr(repo: string, number: number): void {
    this.planning.restoreDependabotPr(repo, number);
  }

  listDependabotDismissals(): DependabotDismissal[] {
    return this.planning.listDependabotDismissals();
  }

  /** When the web server checks on its own; off until the user turns it on. */
  getDependabotSchedule(): StoredDependabotSchedule {
    return this.planning.getDependabotSchedule();
  }

  /** Validates and saves the schedule. Throws `DependabotScheduleError` for one that cannot be followed. */
  saveDependabotSchedule(input: { enabled?: unknown; days?: unknown; time?: unknown }): StoredDependabotSchedule {
    return this.planning.saveDependabotSchedule(normalizeSchedule(input), utcNow());
  }

  /** Writes the plain-language notes under Dependabot PRs that need a person; the caller starts it. */
  createDependabotExplainer(): DependabotExplainer {
    return new DependabotExplainer(this);
  }

  /** A scheduler over this application; the caller starts it (the web server does, at boot). */
  createDependabotScheduler(): DependabotScheduler {
    return new DependabotScheduler(this);
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

  saveRepositoryFavorite(selector: string, favorite: boolean, refresh = false): RepoRecord {
    if (refresh) this.refresh();
    const repo = this.store.resolveRepository(selector);
    this.store.updateFavorite(repo.id, favorite);
    return this.store.resolveRepository(selector);
  }

  editRepositoryNotes(selector: string, notes: string): RepoRecord {
    return this.saveRepositoryNotes(selector, notes, true);
  }

  /**
   * Files an issue against a repository gitlib has scanned. It is stored in gitlib's planning
   * database only; nothing is sent to GitHub or GitLab.
   */
  createLocalIssue(selector: string, input: { title: string; body?: string }): LocalIssue {
    const title = normalizeIssueTitle(input.title);
    const body = normalizeIssueBody(input.body ?? "");
    const repo = this.store.resolveRepository(selector);
    const issue = this.planning.createIssue({ repoPath: repo.relativePath, title, body }, utcNow());
    this.fingerprint(this.planning.getRepo(issue.repoId)!, repo);
    return issue;
  }

  getLocalIssue(id: number): LocalIssue {
    const issue = this.planning.getIssue(id);
    if (!issue) throw new LocalIssueNotFoundError(`Issue ${id} was not found.`);
    return issue;
  }

  /**
   * Issues across every repo, including ones whose repo gitlib no longer finds. Issues whose repo or project is
   * archived are left out unless `includeArchived` is set.
   */
  listLocalIssues(query: LocalIssueQuery = {}): LocalIssue[] {
    return this.planning.listIssues(query);
  }

  updateLocalIssue(id: number, changes: LocalIssueChanges): LocalIssue {
    const normalized: LocalIssueChanges = {};
    if (changes.title !== undefined) normalized.title = normalizeIssueTitle(changes.title);
    if (changes.body !== undefined) normalized.body = normalizeIssueBody(changes.body);
    return this.planning.updateIssue(id, normalized, utcNow());
  }

  setLocalIssueState(id: number, state: LocalIssueState): LocalIssue {
    return this.planning.setIssueState(id, state, utcNow());
  }

  setLocalIssueStatus(id: number, status: IssueStatus): LocalIssue {
    return this.planning.setIssueStatus(id, status, utcNow());
  }

  /** Projects by name; archived ones only with `includeArchived`. */
  listProjects(filter: ArchiveFilter = {}): Project[] {
    return this.planning.listProjects(filter);
  }

  /** Puts a finished project away: it and its issues leave the default lists, and nothing new can be added to it. */
  archiveProject(id: number): Project {
    this.planning.setArchived("project", id, true, utcNow());
    return this.getProject(id);
  }

  restoreProject(id: number): Project {
    this.planning.setArchived("project", id, false, utcNow());
    return this.getProject(id);
  }

  getProject(id: number): Project {
    const project = this.planning.getProject(id);
    if (!project) throw new ProjectNotFoundError(`Project ${id} was not found.`);
    return project;
  }

  createProject(name: string): Project {
    return this.planning.createProject(normalizeProjectName(name), utcNow());
  }

  renameProject(id: number, name: string): Project {
    return this.planning.renameProject(id, normalizeProjectName(name), utcNow());
  }

  deleteProject(id: number): void {
    this.planning.deleteProject(id);
  }

  /** Puts a repository gitlib has scanned into a project. A repo can belong to several projects. */
  addRepoToProject(id: number, selector: string): Project {
    const repo = this.store.resolveRepository(selector);
    const project = this.planning.addRepoToProject(id, repo.relativePath, utcNow());
    this.fingerprint(this.planning.ensureRepoAt(repo.relativePath, utcNow()), repo);
    return project;
  }

  /**
   * Puts several repos into a project at once: clones gitlib has scanned (by selector) and hosted repos that are not
   * cloned. Nothing is added unless every clone resolves. Repos already in the project are skipped.
   */
  addReposToProject(id: number, selectors: readonly string[], remotes: readonly ProjectRemote[] = []): Project {
    const records = selectors.map((selector) => this.store.resolveRepository(selector));
    const project = this.planning.addReposToProject(
      id,
      records.map((record) => record.relativePath),
      remotes.map(normalizeProjectRemote),
      utcNow(),
    );
    for (const record of records) this.fingerprint(this.planning.ensureRepoAt(record.relativePath, utcNow()), record);
    return project;
  }

  /** Takes a hosted repo that was added without a clone out of a project. */
  removeRemoteFromProject(id: number, remote: ProjectRemote): Project {
    return this.planning.removeRemoteFromProject(id, normalizeProjectRemote(remote), utcNow());
  }

  /**
   * Takes a repo out by its planning repo id, short name or path, which works even for a repo gitlib no
   * longer finds.
   */
  removeRepoFromProject(id: number, repo: string | number): Project {
    this.getProject(id);
    const repoId = typeof repo === "number" ? repo : this.resolvePlanningRepo(repo).id;
    return this.planning.removeRepoFromProject(id, repoId, utcNow());
  }

  /** Every repo the planning data refers to, and whether the last scan found it where planning expects it. */
  listPlanningRepos(): PlanningRepoStatus[] {
    const present = new Set(this.loadRepositories().map((repo) => repo.relativePath));
    return this.planning.listRepos().map((repo) => ({ ...repo, found: present.has(repo.path) }));
  }

  /**
   * A planning repo by slug (ignoring case) or by the path it was last found at. Throws
   * `AmbiguousPlanningRepoError` when the slug of one repo is the path of another.
   */
  resolvePlanningRepo(selector: string): PlanningRepo {
    const normalized = selector.trim().replace(/^\.\/|\/+$/g, "");
    const bySlug = this.planning.findRepoBySlug(normalized);
    const byPath = this.planning.findRepoByPath(normalized);
    if (bySlug && byPath && bySlug.id !== byPath.id) {
      throw new AmbiguousPlanningRepoError(
        `'${selector}' is the name of the repo at ${bySlug.path} and the path of the repo named ${byPath.slug}; use the other one's name or path.`,
      );
    }
    const repo = bySlug ?? byPath;
    if (!repo) throw new PlanningRepoNotFoundError(`No planning repo is called or found at '${selector}'.`);
    return repo;
  }

  /**
   * Puts a repo away (by slug or path). Its issues and project memberships stay but leave the default lists, it
   * takes no new issues or projects, and gitlib stops following it when it moves. Nothing is deleted.
   */
  archivePlanningRepo(selector: string): PlanningRepo {
    const repo = this.resolvePlanningRepo(selector);
    this.planning.setArchived("repo", repo.id, true, utcNow());
    return this.planning.getRepo(repo.id)!;
  }

  restorePlanningRepo(selector: string): PlanningRepo {
    const repo = this.resolvePlanningRepo(selector);
    this.planning.setArchived("repo", repo.id, false, utcNow());
    return this.planning.getRepo(repo.id)!;
  }

  /** Changes the short name a repo's issues are shown under (`slug#3`). */
  renamePlanningRepo(selector: string, slug: string): PlanningRepo {
    return this.planning.renameRepo(this.resolvePlanningRepo(selector).id, normalizeRepoSlug(slug), utcNow());
  }

  /**
   * Points a planning repo (by slug or old path) at a repo gitlib has scanned, for a move gitlib could not
   * follow on its own. Its issues and project memberships go with it.
   */
  relinkPlanningRepo(selector: string, repoSelector: string): PlanningRepo {
    const planned = this.resolvePlanningRepo(selector);
    const record = this.store.resolveRepository(repoSelector);
    return this.planning.moveRepo(planned.id, record.relativePath, this.rootCommitOf(record), utcNow());
  }

  /** Files an issue under a project, or pass `null` to take it out of its project. */
  setLocalIssueProject(id: number, projectId: number | null): LocalIssue {
    return this.planning.setIssueProject(id, projectId, utcNow());
  }

  /** Puts an issue in a milestone of its project, or pass `null` to take it out. */
  setLocalIssueMilestone(id: number, milestoneId: number | null): LocalIssue {
    return this.planning.setIssueMilestone(id, milestoneId, utcNow());
  }

  /** Puts an issue in an epic of its project, or pass `null` to take it out. */
  setLocalIssueEpic(id: number, epicId: number | null): LocalIssue {
    return this.planning.setIssueEpic(id, epicId, utcNow());
  }

  /** Epics of one project, or of every project when `projectId` is omitted; archived ones only with `includeArchived`. */
  listEpics(projectId?: number, filter: ArchiveFilter = {}): Epic[] {
    return this.planning.listEpics(projectId, filter);
  }

  getEpic(id: number): Epic {
    const epic = this.planning.getEpic(id);
    if (!epic) throw new EpicNotFoundError(`Epic ${id} was not found.`);
    return epic;
  }

  createEpic(projectId: number, input: NewEpic): Epic {
    return this.planning.createEpic(
      projectId,
      { title: normalizeEpicTitle(input.title), description: normalizeEpicDescription(input.description ?? "") },
      utcNow(),
    );
  }

  updateEpic(id: number, changes: EpicChanges): Epic {
    const normalized: EpicChanges = {};
    if (changes.title !== undefined) normalized.title = normalizeEpicTitle(changes.title);
    if (changes.description !== undefined) normalized.description = normalizeEpicDescription(changes.description);
    return this.planning.updateEpic(id, normalized, utcNow());
  }

  /** Removes the epic; its issues stay in the project. Archiving is the gentler way to put one away. */
  deleteEpic(id: number): void {
    this.planning.deleteEpic(id);
  }

  /** Puts an epic away. Its issues keep it; no other issue can join it until it is restored. */
  archiveEpic(id: number): Epic {
    this.planning.setArchived("epic", id, true, utcNow());
    return this.getEpic(id);
  }

  restoreEpic(id: number): Epic {
    this.planning.setArchived("epic", id, false, utcNow());
    return this.getEpic(id);
  }

  /** Milestones of one project, or of every project when `projectId` is omitted; archived ones only with `includeArchived`. */
  listMilestones(projectId?: number, filter: ArchiveFilter = {}): Milestone[] {
    return this.planning.listMilestones(projectId, filter);
  }

  /** Puts a milestone away. Its issues keep it; no other issue can be put in it until it is restored. */
  archiveMilestone(id: number): Milestone {
    this.planning.setArchived("milestone", id, true, utcNow());
    return this.getMilestone(id);
  }

  restoreMilestone(id: number): Milestone {
    this.planning.setArchived("milestone", id, false, utcNow());
    return this.getMilestone(id);
  }

  getMilestone(id: number): Milestone {
    const milestone = this.planning.getMilestone(id);
    if (!milestone) throw new MilestoneNotFoundError(`Milestone ${id} was not found.`);
    return milestone;
  }

  createMilestone(projectId: number, input: NewMilestone): Milestone {
    return this.planning.createMilestone(
      projectId,
      {
        title: normalizeMilestoneTitle(input.title),
        description: normalizeMilestoneDescription(input.description ?? ""),
        dueDate: normalizeMilestoneDueDate(input.dueDate),
      },
      utcNow(),
    );
  }

  updateMilestone(id: number, changes: MilestoneChanges): Milestone {
    const normalized: MilestoneChanges = {};
    if (changes.title !== undefined) normalized.title = normalizeMilestoneTitle(changes.title);
    if (changes.description !== undefined) normalized.description = normalizeMilestoneDescription(changes.description);
    if (changes.dueDate !== undefined) normalized.dueDate = normalizeMilestoneDueDate(changes.dueDate);
    return this.planning.updateMilestone(id, normalized, utcNow());
  }

  deleteMilestone(id: number): void {
    this.planning.deleteMilestone(id);
  }

  /** Snapshots the planning database, by default into `<app home>/backups/`. Returns the file written. */
  backupPlanning(destination?: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    return this.planning.backup(destination ?? path.join(this.config.appHome, "backups", `planning-${stamp}.db`));
  }
}

export function createApplication(
  env: Env = process.env,
  system: SystemDeps = defaultSystemDeps,
  searchBackend?: SearchBackend | null,
  chatBackend?: ChatBackend | null,
  dependabotBackend?: DependabotBackend | null,
): GitLibApp {
  const config = loadConfig(env);
  const store = new Store(config.dbPath);
  const token = resolveGitHubToken(env);
  const dependabot = dependabotBackend !== undefined ? dependabotBackend : token ? new GitHubDependabotBackend(token) : null;
  return new GitLibApp(config, store, system, searchBackend, undefined, chatBackend, dependabot);
}
