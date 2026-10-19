import { createServerFn } from "@tanstack/react-start";
import { technologyCategory, type TechnologyCategory } from "@gitlib/core";
import { getApp, loadAndIndexRepositories } from "./gitlib.server";

export interface TechnologyView {
  name: string;
  category: TechnologyCategory;
}

export interface RepoView {
  id: number;
  name: string;
  relativePath: string;
  absolutePath: string;
  description: string;
  hasNotes: boolean;
  lastScannedAt: string | null;
  technologies: TechnologyView[];
}

export interface RepoListing {
  roots: string[];
  repos: RepoView[];
}

export const MAX_DESCRIPTION_LENGTH = 500;

async function listing(force: boolean): Promise<RepoListing> {
  const app = getApp();
  const repos = (await loadAndIndexRepositories(force)).map(
    (repo): RepoView => ({
      id: repo.id,
      name: repo.name,
      relativePath: repo.relativePath,
      absolutePath: repo.absolutePath,
      description: repo.description,
      hasNotes: repo.hasNotes,
      lastScannedAt: repo.lastScannedAt,
      technologies: repo.technologies.map((name) => ({ name, category: technologyCategory(name) })),
    }),
  );
  return { roots: app.config.roots, repos };
}

export const getRepos = createServerFn({ method: "GET" }).handler(async () => listing(false));

export const rescanRepos = createServerFn({ method: "POST" }).handler(async () => listing(true));

export const saveDescription = createServerFn({ method: "POST" })
  .validator((input: { relativePath: string; description: string }) => {
    if (typeof input?.relativePath !== "string" || typeof input?.description !== "string") {
      throw new Error("Invalid description payload.");
    }
    if (input.description.length > MAX_DESCRIPTION_LENGTH) {
      throw new Error(`Descriptions are limited to ${MAX_DESCRIPTION_LENGTH} characters.`);
    }
    return input;
  })
  .handler(async ({ data }) => {
    const app = getApp();
    const repo = app.saveRepositoryDescription(data.relativePath, data.description);
    if (app.search.enabled) {
      // Best effort: the description is saved either way, and a rescan or `gitlib reindex` catches up.
      await app.syncRepositorySearch(repo.relativePath).catch((error: unknown) => {
        console.warn("Search index not updated:", error instanceof Error ? error.message : error);
      });
    }
    return { relativePath: repo.relativePath, description: repo.description };
  });
