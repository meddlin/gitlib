import { createServerFn } from "@tanstack/react-start";
import { loadRepoReadme, technologyCategory, type TechnologyCategory } from "@gitlib/core";
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
  isFavorite: boolean;
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
      isFavorite: repo.isFavorite,
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

export const setFavorite = createServerFn({ method: "POST" })
  .validator((input: { relativePath: string; favorite: boolean }) => {
    if (typeof input?.relativePath !== "string" || typeof input?.favorite !== "boolean") {
      throw new Error("Invalid favorite payload.");
    }
    return input;
  })
  .handler(async ({ data }) => {
    const repo = getApp().saveRepositoryFavorite(data.relativePath, data.favorite);
    return { relativePath: repo.relativePath, isFavorite: repo.isFavorite };
  });

export interface ReadmeView {
  markdown: string | null;
  error: string | null;
}

/** Keeps a pathological README from bloating the response. */
const MAX_README_LENGTH = 500_000;

/** Reads README.md for a repository gitlib already knows about; never an arbitrary path. */
export const getReadme = createServerFn({ method: "GET" })
  .validator((input: { relativePath: string }) => {
    if (typeof input?.relativePath !== "string" || !input.relativePath) {
      throw new Error("Invalid README request.");
    }
    return input;
  })
  .handler(async ({ data }): Promise<ReadmeView> => {
    try {
      const repo = getApp().getRepository(data.relativePath);
      const { markdown, error } = loadRepoReadme(repo.absolutePath);
      return { markdown: markdown?.slice(0, MAX_README_LENGTH) ?? null, error };
    } catch (caught) {
      return { markdown: null, error: caught instanceof Error ? caught.message : "Could not read the README." };
    }
  });
