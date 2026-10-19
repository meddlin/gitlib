# Search options

Status: **decided — Meilisearch** (2026-10-19). This records why, and what we compared.

## Context

Before this change, search was a case-insensitive substring match run in memory:

- `GitLibApp.filterRepositories` in `packages/core/src/app.ts` — used by the CLI `list` command and the TUI.
  Matches name, relative path, absolute path, technologies, notes and description.
- A separate copy of the matcher in `apps/web/src/routes/index.tsx` — name, relative path, description and
  technologies only (no notes, no absolute path), so the web app and CLI/TUI had already diverged.

There was no typo tolerance, no ranking, and nothing searched README content. The app is growing
(web app, more content to index), and we want search across READMEs and other repo text, so we
compared four options.

## Options considered

### MiniSearch (in-process library)

```ts
const index = new MiniSearch<RepoRecord>({
  idField: "id",
  fields: ["name", "relativePath", "technologies", "description", "notes", "readme"],
  searchOptions: { boost: { name: 3, technologies: 2 }, prefix: true, fuzzy: 0.2, combineWith: "AND" },
});
index.addAll(repos);
index.search(query).map((hit) => hit.id);
```

Typo tolerance, prefix matching and field boosts in ~20 KB with no infrastructure. The index lives in
memory (it can be serialised to JSON), so every process — CLI invocation, TUI, web server — rebuilds or
loads its own copy.

### Fuse.js (in-process library)

```ts
const fuse = new Fuse(repos, {
  keys: [{ name: "name", weight: 3 }, { name: "technologies", weight: 2 }, { name: "description", weight: 1.5 }],
  threshold: 0.35,
  ignoreLocation: true,
});
fuse.search(query).map((hit) => hit.item.id);
```

Smallest option (~10 lines, ~6 KB), but it scans every document on every query, so it degrades past
roughly 10k documents and is poor for long text such as READMEs. Ranking is a similarity score with no
term-frequency awareness.

### SQLite FTS5 (already in the stack)

`packages/core` stores data with `node:sqlite`, and FTS5 is available in it (verified on Node 24).

```sql
CREATE VIRTUAL TABLE repo_fts USING fts5(name, relative_path, technologies, description, notes, readme,
  tokenize='porter unicode61 remove_diacritics 2', prefix='2 3');
SELECT rowid FROM repo_fts WHERE repo_fts MATCH ? ORDER BY bm25(repo_fts, 10, 2, 5, 3, 1, 1);
```

No new dependency, BM25 ranking, handles large text. No typo tolerance, and the index has to be kept in
sync with the repo table by hand.

### Meilisearch (separate search server)

A search server with typo tolerance, ranking rules, prefix search, highlighting/cropping, facets,
synonyms, and (later) hybrid/semantic search. Accessed over HTTP with an official JS client.

## Comparison

| | MiniSearch | Fuse.js | SQLite FTS5 | Meilisearch |
|---|---|---|---|---|
| Typo tolerance | Yes | Yes (fuzzier) | No | Yes, best of the four |
| Ranking quality | Good (BM25-like, boosts) | Mediocre | Good (BM25) | Very good, configurable rules |
| Prefix / search-as-you-type | Yes | Partial | Yes | Yes, built for it |
| Snippets / highlighting | Manual | Manual (match indices) | `snippet()` / `highlight()` | Built in (crop + highlight) |
| Facets / filters | Callback filter | Manual | SQL `WHERE` | First-class |
| Scale ceiling | ~100k docs, in memory | ~10k docs | Millions | Millions |
| Long text (READMEs, docs) | Fine | Poor | Good | Excellent |
| Infrastructure | None | None | None (already present) | **A separate server process** |
| Fits a local-first CLI | Excellent | Excellent | Excellent | Awkward — needs a running server |
| One index shared by CLI + web | Needs sharing/serialising | Same | Yes (same DB file) | Yes (one server) |
| Growth path | Outgrown by large content | Outgrown quickly | Limited by feature set | Synonyms, multi-index, hybrid/vector search |

## Trade-offs of choosing Meilisearch

Pros:

- Best relevance for free-text queries across heterogeneous fields (name vs. README body).
- Highlighting and cropping are built in, which is what makes README hits readable.
- Scales to indexing much more than READMEs (docs, code comments, issues) without changing the architecture.
- One index serves the CLI, TUI and web app.

Cons:

- Operational cost. `gitlib` is local-first; search needs a server on `127.0.0.1:7700` (a port, an optional
  master key, a data directory, upgrades). A plain `gitlib list` must not depend on it.
- Another process to document and keep healthy.
- Index can go stale if indexing fails; it is a derived copy of the SQLite data.
- Tests that exercise real search need a Meilisearch binary.

## Decision

Use Meilisearch, because the app is growing past a simple CLI and we want README-level search with good
relevance. To contain the operational cost:

1. **Search is optional.** If Meilisearch is unreachable (or `search.enabled = false`), search falls back to
   the previous substring matcher and the UI says so. `list`, `show`, `notes` and the TUI never need it.
2. **Meilisearch is a derived index.** SQLite and the repos on disk stay the source of truth; the index is
   rebuilt with `gitlib reindex` (and automatically on web rescan and after `gitlib scan`).
3. **One seam.** `packages/core` owns a `SearchBackend` interface; only `MeilisearchBackend` knows about
   Meilisearch. Swapping in MiniSearch or FTS5 later means writing another backend, not touching callers.
4. **One matcher.** The web app's duplicated matcher is replaced by calls into core.

## What is indexed

Per repository: name, relative path, absolute path, technologies, description, notes, and the README
(`README.md`, `README.markdown`, `README`, `README.txt`, any casing), capped at 100,000 characters
because Meilisearch only indexes the first 65,535 word positions of an attribute.

Not indexed yet (candidates for later): other Markdown such as `docs/`, `CONTRIBUTING.md`, `CHANGELOG.md`;
`package.json` / manifest descriptions; source files.

## Running Meilisearch

See the "Search" section of the repository `README.md`.
