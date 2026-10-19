import { createServerFn } from "@tanstack/react-start";
import type { SearchField, TextSegment } from "@gitlib/core";
import { getApp, loadAndIndexRepositories, settleIndexing } from "./gitlib.server";

export interface SearchHitView {
  id: number;
  /** Only fields that matched; README and notes are short snippets. */
  highlights: Partial<Record<SearchField, TextSegment[]>>;
}

export interface SearchResponse {
  /** `meilisearch` = ranked full-text results; `basic` = plain substring matching. */
  mode: "meilisearch" | "basic";
  /** Set when the fallback was used because Meilisearch could not be reached. */
  notice: string | null;
  hits: SearchHitView[];
}

export const MAX_QUERY_LENGTH = 200;

export const searchRepos = createServerFn({ method: "GET" })
  .validator((input: { q: string }) => {
    if (typeof input?.q !== "string") throw new Error("Invalid search payload.");
    return { q: input.q.slice(0, MAX_QUERY_LENGTH) };
  })
  .handler(async ({ data }): Promise<SearchResponse> => {
    await loadAndIndexRepositories(false);
    await settleIndexing();
    const result = await getApp().searchRepositories(data.q);
    return {
      mode: result.mode,
      notice: result.notice,
      hits: result.hits.map((hit) => ({ id: hit.repo.id, highlights: hit.highlights })),
    };
  });
