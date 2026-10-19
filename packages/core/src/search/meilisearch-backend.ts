import { Meilisearch, MeilisearchApiError, type Index, type Task } from "meilisearch";
import type { SearchConfig } from "../config.js";
import { HIGHLIGHT_END, HIGHLIGHT_START } from "./highlight.js";
import {
  SearchUnavailableError,
  type BackendHit,
  type SearchBackend,
  type SearchDocument,
  type SearchField,
} from "./types.js";

/** Most relevant first: a match in the name beats one deep inside a README. */
export const SEARCHABLE_ATTRIBUTES = [
  "name",
  "description",
  "technologies",
  "relativePath",
  "notes",
  "readme",
  "absolutePath",
] as const;

const HIGHLIGHT_FIELDS: readonly SearchField[] = ["name", "relativePath", "description", "notes", "readme"];
const CROPPED_FIELDS = ["description", "notes", "readme"] as const;
const SNIPPET_WORDS = 24;
const REQUEST_TIMEOUT_MS = 5_000;
const TASK_TIMEOUT_MS = 120_000;

export class MeilisearchBackend implements SearchBackend {
  readonly label: string;
  private readonly client: Meilisearch;
  private readonly indexName: string;
  private ready = false;

  constructor(config: Pick<SearchConfig, "host" | "apiKey" | "indexName">, client?: Meilisearch) {
    this.label = config.host;
    this.indexName = config.indexName;
    this.client =
      client ?? new Meilisearch({ host: config.host, apiKey: config.apiKey ?? undefined, timeout: REQUEST_TIMEOUT_MS });
  }

  async replaceAll(documents: readonly SearchDocument[]): Promise<void> {
    await this.guard(async () => {
      const index = await this.ensureIndex();
      const existing = await index.getDocuments<{ id: number }>({ fields: ["id"], limit: 1_000_000 });
      const keep = new Set(documents.map((document) => document.id));
      const stale = existing.results.map((document) => document.id).filter((id) => !keep.has(id));

      if (documents.length > 0) await this.finish(index.addDocuments([...documents], { primaryKey: "id" }));
      if (stale.length > 0) await this.finish(index.deleteDocuments(stale));
    });
  }

  async upsert(documents: readonly SearchDocument[]): Promise<void> {
    if (documents.length === 0) return;
    await this.guard(async () => {
      const index = await this.ensureIndex();
      await this.finish(index.addDocuments([...documents], { primaryKey: "id" }));
    });
  }

  async search(query: string, limit: number): Promise<BackendHit[]> {
    return this.guard(async () => {
      const index = this.client.index(this.indexName);
      const response = await index.search<SearchDocument>(query, {
        limit,
        attributesToRetrieve: ["id"],
        attributesToHighlight: [...HIGHLIGHT_FIELDS],
        attributesToCrop: [...CROPPED_FIELDS],
        cropLength: SNIPPET_WORDS,
        cropMarker: "…",
        highlightPreTag: HIGHLIGHT_START,
        highlightPostTag: HIGHLIGHT_END,
      });

      return response.hits.map((hit): BackendHit => {
        const formatted = (hit as { _formatted?: Record<string, unknown> })._formatted ?? {};
        const highlights: Partial<Record<SearchField, string>> = {};
        for (const field of HIGHLIGHT_FIELDS) {
          const value = formatted[field];
          if (typeof value === "string" && value.includes(HIGHLIGHT_START)) highlights[field] = value;
        }
        return { id: hit.id, highlights };
      });
    });
  }

  private async ensureIndex(): Promise<Index<SearchDocument>> {
    if (!this.ready) {
      try {
        await this.client.getIndex(this.indexName);
      } catch (error) {
        if (!(error instanceof MeilisearchApiError) || error.cause?.code !== "index_not_found") throw error;
        await this.finish(this.client.createIndex(this.indexName, { primaryKey: "id" }));
      }
      const index = this.client.index<SearchDocument>(this.indexName);
      await this.finish(index.updateSettings({ searchableAttributes: [...SEARCHABLE_ATTRIBUTES] }));
      this.ready = true;
    }
    return this.client.index<SearchDocument>(this.indexName);
  }

  private async finish(enqueued: { waitTask: (options?: { timeout?: number }) => Promise<Task> }): Promise<void> {
    const task = await enqueued.waitTask({ timeout: TASK_TIMEOUT_MS });
    if (task.status === "failed" || task.status === "canceled") {
      throw new Error(task.error?.message ?? `Meilisearch task ${task.uid} ${task.status}`);
    }
  }

  /** Every failure becomes a SearchUnavailableError so callers have a single thing to catch. */
  private async guard<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof SearchUnavailableError) throw error;
      if (error instanceof MeilisearchApiError && error.cause?.code === "index_not_found") {
        throw new SearchUnavailableError("The search index has not been built yet. Run `gitlib reindex`.", { cause: error });
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new SearchUnavailableError(`Meilisearch at ${this.label} is unavailable: ${reason}`, { cause: error });
    }
  }
}
