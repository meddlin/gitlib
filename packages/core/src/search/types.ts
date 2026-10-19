import { GitLibError } from "../errors.js";
import type { RepoRecord } from "../models.js";

/** Repository text that can produce a highlighted match. */
export type SearchField = "name" | "relativePath" | "description" | "notes" | "readme";

/** One repository as stored in the search index. */
export interface SearchDocument {
  id: number;
  name: string;
  relativePath: string;
  absolutePath: string;
  technologies: string[];
  description: string;
  notes: string;
  readme: string;
}

/** A hit from a backend: the repo id plus raw text where matches are wrapped in highlight markers. */
export interface BackendHit {
  id: number;
  highlights: Partial<Record<SearchField, string>>;
}

/** The only thing the rest of gitlib knows about a search engine. */
export interface SearchBackend {
  /** Human-readable location, used in error messages. */
  readonly label: string;
  /** Make the index contain exactly `documents`. */
  replaceAll(documents: readonly SearchDocument[]): Promise<void>;
  /** Insert or update documents, leaving the rest of the index alone. */
  upsert(documents: readonly SearchDocument[]): Promise<void>;
  /** Ranked best-first. */
  search(query: string, limit: number): Promise<BackendHit[]>;
}

/** The search backend is disabled, unreachable, or has no index yet. Callers can fall back. */
export class SearchUnavailableError extends GitLibError {}

export interface TextSegment {
  text: string;
  match: boolean;
}

export interface SearchHit {
  repo: RepoRecord;
  /** Only fields that actually matched; README and notes are cropped to a snippet. */
  highlights: Partial<Record<SearchField, TextSegment[]>>;
}

export interface SearchResult {
  /** `meilisearch` = ranked full-text results, `basic` = substring fallback. */
  mode: "meilisearch" | "basic";
  hits: SearchHit[];
  /** Why the fallback was used, when it was a surprise. */
  notice: string | null;
}
