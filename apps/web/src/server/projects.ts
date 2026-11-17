import { createServerFn } from "@tanstack/react-start";
import { MAX_PROJECT_NAME_LENGTH, type ProjectRemote, type ProjectRepo, type RepoRecord } from "@gitlib/core";
import type { CatalogEntry, RemoteProvider } from "#/lib/catalog";
import { buildCatalog } from "./catalog.server";
import { getApp, loadRepositories } from "./gitlib.server";
import type { EpicLimits, EpicView } from "./epics";
import { epicLimits, epicViews } from "./epics.server";
import type { MilestoneLimits, MilestoneView } from "./milestones";
import { milestoneLimits, milestoneViews } from "./milestones.server";
import { toView, type LocalIssueView, type PlanningRepoOption } from "./planning";

export interface ProjectRepoView {
  /** The planning repo's id, which stays the same when the repo moves. */
  id: number;
  /** Short name its issues are shown under (`slug#3`). */
  slug: string;
  relativePath: string;
  name: string;
  /** False when the repo has moved or been removed since it was added. */
  known: boolean;
  /** The repo itself is archived in planning, so its issues are hidden from the planning lists. */
  archived: boolean;
}

/** A hosted repo a project holds, whether or not it is cloned. */
export interface ProjectRemoteView {
  provider: RemoteProvider;
  fullName: string;
  /** Its page on the host, when gitlib can tell where that is. */
  url: string | null;
  /** `relativePath` of a local clone, once the repo has been cloned. */
  clonedAs: string | null;
}

/** A hosted repo that no local clone covers and the project does not hold yet. */
export interface AvailableRemote {
  provider: RemoteProvider;
  fullName: string;
  description: string;
}

export interface ProjectSummary {
  id: number;
  name: string;
  archived: boolean;
  repoCount: number;
  openIssueCount: number;
  issueCount: number;
}

export interface ProjectsView {
  projects: ProjectSummary[];
  nameLimit: number;
}

export interface ProjectDetail {
  id: number;
  name: string;
  /** An archived project takes no new repos, issues or milestones until it is restored. */
  archived: boolean;
  repos: ProjectRepoView[];
  /** Repos taken out of the project. Their issues stay filed under it; adding a repo again brings it back. */
  removedRepos: ProjectRepoView[];
  /** Hosted repos added without a local clone. */
  remotes: ProjectRemoteView[];
  /** Known repos not yet in the project. */
  availableRepos: PlanningRepoOption[];
  /** Repos GitHub or GitLab list that are not cloned and not yet in the project. */
  availableRemotes: AvailableRemote[];
  issues: LocalIssueView[];
  /** Issues in no project, which can be added. */
  unassignedIssues: LocalIssueView[];
  /** Soonest due date first, then milestones with no due date; archived ones included (see `MilestoneView.archived`). */
  milestones: MilestoneView[];
  milestoneLimits: MilestoneLimits;
  /** By title; archived ones included (see `EpicView.archived`). */
  epics: EpicView[];
  epicLimits: EpicLimits;
  nameLimit: number;
}

/** For pickers: every project, by name. */
export interface ProjectOption {
  id: number;
  name: string;
}

// A function, not a constant: client bundles must not keep a runtime import of @gitlib/core.
const nameLimit = (): number => MAX_PROJECT_NAME_LENGTH;

const isId = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value > 0;

function repoView({ id, slug, path, archived }: ProjectRepo, repos: readonly RepoRecord[]): ProjectRepoView {
  const repo = repos.find((candidate) => candidate.relativePath === path);
  return { id, slug, relativePath: path, name: repo?.name ?? path.split("/").pop() ?? path, known: repo !== undefined, archived };
}

export const getProjects = createServerFn({ method: "GET" }).handler(async (): Promise<ProjectsView> => {
  const app = getApp();
  const issues = app.listLocalIssues({ includeArchived: true });
  return {
    projects: app.listProjects({ includeArchived: true }).map((project) => {
      const inProject = issues.filter((issue) => issue.projectId === project.id);
      return {
        id: project.id,
        name: project.name,
        archived: project.archivedAt !== null,
        repoCount: project.repoPaths.length + project.remotes.length,
        issueCount: inProject.length,
        openIssueCount: inProject.filter((issue) => issue.state === "open").length,
      };
    }),
    nameLimit: nameLimit(),
  };
});

export const getProjectOptions = createServerFn({ method: "GET" }).handler(
  async (): Promise<ProjectOption[]> => getApp().listProjects().map(({ id, name }) => ({ id, name })),
);

const PROVIDERS: readonly RemoteProvider[] = ["github", "gitlab"];

const sameRemote = (a: ProjectRemote, b: ProjectRemote): boolean =>
  a.provider === b.provider && a.fullName.toLowerCase() === b.fullName.toLowerCase();

/** The catalog is a convenience here: when it cannot be built the project page still works, without hosted repos. */
async function catalogEntries(): Promise<CatalogEntry[]> {
  try {
    return (await buildCatalog()).entries;
  } catch {
    return [];
  }
}

const hostedBy = (entry: CatalogEntry, remote: ProjectRemote) =>
  entry[remote.provider]?.fullName.toLowerCase() === remote.fullName.toLowerCase();

export const getProjectDetail = createServerFn({ method: "GET" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<ProjectDetail | null> => {
    const app = getApp();
    const project = app.planning.getProject(data.id);
    if (!project) return null;
    const repos = loadRepositories();
    // The project page shows everything filed under it, including issues of archived repos (labelled as such).
    const issues = app.listLocalIssues({ includeArchived: true });
    const entries = await catalogEntries();
    const availableRemotes: AvailableRemote[] = [];
    for (const entry of entries) {
      if (entry.locals.length > 0) continue;
      for (const provider of PROVIDERS) {
        const link = entry[provider];
        if (!link?.listed || project.remotes.some((held) => sameRemote(held, { provider, fullName: link.fullName }))) continue;
        availableRemotes.push({ provider, fullName: link.fullName, description: entry.description });
      }
    }
    return {
      id: project.id,
      name: project.name,
      archived: project.archivedAt !== null,
      repos: project.repos.map((repo) => repoView(repo, repos)),
      removedRepos: project.removedRepos.map((repo) => repoView(repo, repos)),
      remotes: project.remotes.map((remote) => {
        const entry = entries.find((candidate) => hostedBy(candidate, remote));
        return {
          ...remote,
          url: entry?.[remote.provider]?.url ?? (remote.provider === "github" ? `https://github.com/${remote.fullName}` : null),
          clonedAs: entry?.locals[0] ?? null,
        };
      }),
      availableRemotes,
      availableRepos: repos
        .filter((repo) => !repo.isWorktree && !project.repoPaths.includes(repo.relativePath))
        .map(({ relativePath, name }) => ({ relativePath, name })),
      issues: issues.filter((issue) => issue.projectId === project.id).map((issue) => toView(issue, repos)),
      unassignedIssues: issues
        .filter((issue) => issue.projectId === null && !issue.archived)
        .map((issue) => toView(issue, repos)),
      milestones: milestoneViews(app.listMilestones(project.id, { includeArchived: true }), issues),
      milestoneLimits: milestoneLimits(),
      epics: epicViews(app.listEpics(project.id, { includeArchived: true }), issues),
      epicLimits: epicLimits(),
      nameLimit: nameLimit(),
    };
  });

const validName = (input: { name?: unknown }) => {
  if (typeof input?.name !== "string") throw new Error("Invalid project payload.");
};

export const createProject = createServerFn({ method: "POST" })
  .validator((input: { name: string }) => {
    validName(input);
    return input;
  })
  .handler(async ({ data }): Promise<ProjectOption> => {
    const { id, name } = getApp().createProject(data.name);
    return { id, name };
  });

export const renameProject = createServerFn({ method: "POST" })
  .validator((input: { id: number; name: string }) => {
    validName(input);
    if (!isId(input?.id)) throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<ProjectOption> => {
    const { id, name } = getApp().renameProject(data.id, data.name);
    return { id, name };
  });

export const deleteProject = createServerFn({ method: "POST" })
  .validator((input: { id: number }) => {
    if (!isId(input?.id)) throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().deleteProject(data.id);
  });

interface AddReposInput {
  id: number;
  /** `relativePath` of local clones. */
  repos: string[];
  remotes: ProjectRemote[];
}

/** Puts several repos in a project at once: local clones and hosted ones that are not cloned. */
export const addProjectRepos = createServerFn({ method: "POST" })
  .validator((input: AddReposInput) => {
    const valid =
      isId(input?.id) &&
      Array.isArray(input.repos) &&
      input.repos.every((repo) => typeof repo === "string") &&
      Array.isArray(input.remotes) &&
      input.remotes.every((remote) => PROVIDERS.includes(remote?.provider) && typeof remote?.fullName === "string");
    if (!valid || input.repos.length + input.remotes.length === 0) throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    if (data.remotes.length > 0) {
      // Only repos a host lists (or a clone's remote names) may be added, never an arbitrary name.
      const entries = await catalogEntries();
      for (const remote of data.remotes) {
        if (!entries.some((entry) => hostedBy(entry, remote))) {
          throw new Error(`Gitlib does not list ${remote.fullName} on ${remote.provider === "github" ? "GitHub" : "GitLab"}.`);
        }
      }
    }
    getApp().addReposToProject(data.id, data.repos, data.remotes);
  });

export const removeProjectRemote = createServerFn({ method: "POST" })
  .validator((input: { id: number; provider: RemoteProvider; fullName: string }) => {
    if (!isId(input?.id) || !PROVIDERS.includes(input?.provider) || typeof input?.fullName !== "string") {
      throw new Error("Invalid project payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().removeRemoteFromProject(data.id, { provider: data.provider, fullName: data.fullName });
  });

/** Archives (`archived: true`) or restores a project. */
export const setProjectArchived = createServerFn({ method: "POST" })
  .validator((input: { id: number; archived: boolean }) => {
    if (!isId(input?.id) || typeof input?.archived !== "boolean") throw new Error("Invalid project request.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    if (data.archived) getApp().archiveProject(data.id);
    else getApp().restoreProject(data.id);
  });

/** `repoId` is the planning repo's id (`ProjectRepoView.id`), so a repo that has moved can still be removed. */
export const removeProjectRepo = createServerFn({ method: "POST" })
  .validator((input: { id: number; repoId: number }) => {
    if (!isId(input?.id) || !isId(input?.repoId)) throw new Error("Invalid project payload.");
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().removeRepoFromProject(data.id, data.repoId);
  });

/** Pass `projectId: null` to take the issue out of its project. */
export const setIssueProject = createServerFn({ method: "POST" })
  .validator((input: { issueId: number; projectId: number | null }) => {
    if (!isId(input?.issueId) || (input?.projectId !== null && !isId(input?.projectId))) {
      throw new Error("Invalid issue project payload.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<void> => {
    getApp().setLocalIssueProject(data.issueId, data.projectId);
  });
