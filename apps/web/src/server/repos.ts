import { createServerFn } from "@tanstack/react-start";
import { technologyCategory, type TechnologyCategory } from "@gitlib/core";
import { getApp, loadRepositories } from "./gitlib.server";

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
  isWorktree: boolean;
  lastScannedAt: string | null;
  technologies: TechnologyView[];
}

export interface RepoListing {
  roots: string[];
  repos: RepoView[];
}

export const MAX_DESCRIPTION_LENGTH = 500;

function listing(force: boolean): RepoListing {
  const app = getApp();
  const repos = loadRepositories(force).map(
    (repo): RepoView => ({
      id: repo.id,
      name: repo.name,
      relativePath: repo.relativePath,
      absolutePath: repo.absolutePath,
      description: repo.description,
      hasNotes: repo.hasNotes,
      isWorktree: repo.isWorktree,
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
    const repo = getApp().saveRepositoryDescription(data.relativePath, data.description);
    return { relativePath: repo.relativePath, description: repo.description };
  });
