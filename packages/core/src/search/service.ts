import type { SearchConfig } from "../config.js";
import type { RepoRecord } from "../models.js";
import { buildSearchDocument } from "./documents.js";
import { parseHighlights } from "./highlight.js";
import { MeilisearchBackend } from "./meilisearch-backend.js";
import {
  SearchUnavailableError,
  type SearchBackend,
  type SearchDocument,
  type SearchField,
  type TextSegment,
} from "./types.js";

export interface RankedMatch {
  id: number;
  highlights: Partial<Record<SearchField, TextSegment[]>>;
}

/** Turns repo records into index documents and ranked matches; the backend does the actual searching. */
export class RepoSearch {
  readonly backend: SearchBackend | null;

  constructor(
    config: SearchConfig,
    backend?: SearchBackend | null,
    private readonly toDocument: (repo: RepoRecord) => SearchDocument = buildSearchDocument,
  ) {
    this.backend = backend !== undefined ? backend : config.enabled ? new MeilisearchBackend(config) : null;
  }

  get enabled(): boolean {
    return this.backend !== null;
  }

  /** Rebuilds the whole index from `repos`; resolves with how many repositories were indexed. */
  async reindex(repos: readonly RepoRecord[]): Promise<number> {
    const documents = repos.filter((repo) => !repo.isMissing).map((repo) => this.toDocument(repo));
    await this.requireBackend().replaceAll(documents);
    return documents.length;
  }

  async syncRepository(repo: RepoRecord): Promise<void> {
    await this.requireBackend().upsert([this.toDocument(repo)]);
  }

  async query(text: string, limit: number): Promise<RankedMatch[]> {
    const hits = await this.requireBackend().search(text, limit);
    return hits.map((hit) => {
      const highlights: RankedMatch["highlights"] = {};
      for (const [field, raw] of Object.entries(hit.highlights) as [SearchField, string][]) {
        const segments = parseHighlights(raw);
        if (segments) highlights[field] = segments;
      }
      return { id: hit.id, highlights };
    });
  }

  private requireBackend(): SearchBackend {
    if (!this.backend) throw new SearchUnavailableError("Search is disabled (search.enabled = false in config.toml).");
    return this.backend;
  }
}
