import fs from "node:fs";
import path from "node:path";
import {
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  SearchUnavailableError,
  type BackendHit,
  type SearchBackend,
  type SearchDocument,
} from "@gitlib/core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Fixture } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
  fx.writeConfig();
  fx.makeRepo("billing", { "README.md": "# Billing\nHandles invoices." });
  fx.makeRepo("garden", { "README.md": "# Garden\nTomatoes." });
});
afterEach(() => fx.cleanup());

class FakeBackend implements SearchBackend {
  readonly label = "fake";
  documents: SearchDocument[] = [];
  upserts: SearchDocument[] = [];
  hits: BackendHit[] = [];
  failWith: Error | null = null;

  async replaceAll(documents: readonly SearchDocument[]) {
    if (this.failWith) throw this.failWith;
    this.documents = [...documents];
  }
  async upsert(documents: readonly SearchDocument[]) {
    if (this.failWith) throw this.failWith;
    this.upserts.push(...documents);
  }
  async search() {
    if (this.failWith) throw this.failWith;
    return this.hits;
  }
}

// Repos are numbered in scan order (sorted by path).
const ID = { billing: 1, garden: 2 } as const;

describe("search", () => {
  it("prints ranked repositories with README snippets", async () => {
    const backend = new FakeBackend();
    await fx.runCli(["scan"], { searchBackend: null });
    backend.hits = [
      { id: ID.billing, highlights: { readme: `Handles ${HIGHLIGHT_START}invoices${HIGHLIGHT_END}.` } },
    ];

    const result = await fx.runCli(["search", "invoices"], { searchBackend: backend });

    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("billing  (billing)\n  readme: Handles «invoices».");
  });

  it("joins multi-word queries and emits JSON with plain snippets", async () => {
    const backend = new FakeBackend();
    await fx.runCli(["scan"], { searchBackend: null });
    backend.hits = [
      { id: ID.garden, highlights: { readme: `${HIGHLIGHT_START}Tomatoes${HIGHLIGHT_END}.` } },
    ];

    const result = await fx.runCli(["search", "red", "tomatoes", "--json"], { searchBackend: backend });
    const parsed = JSON.parse(result.stdout);

    expect(parsed).toMatchObject({ query: "red tomatoes", mode: "meilisearch" });
    expect(parsed.results[0]).toMatchObject({ name: "garden", matches: { readme: "Tomatoes." } });
  });

  it("says when nothing matches", async () => {
    await fx.runCli(["scan"], { searchBackend: null });
    const result = await fx.runCli(["search", "zzz"], { searchBackend: new FakeBackend() });
    expect(result.stdout.trim()).toBe("No repositories match.");
  });

  it("falls back to basic matching and explains why", async () => {
    const backend = new FakeBackend();
    backend.failWith = new SearchUnavailableError("Meilisearch at fake is unavailable: refused");
    await fx.runCli(["scan"], { searchBackend: null });

    const result = await fx.runCli(["search", "garden"], { searchBackend: backend });

    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("garden  (garden)");
    expect(result.stderr).toContain("Using basic matching: Meilisearch at fake is unavailable");
  });

  it("rejects a bad --limit", async () => {
    const result = await fx.runCli(["search", "x", "--limit", "0"], { searchBackend: null });
    expect(result.code).not.toBe(0);
  });
});

describe("reindex", () => {
  it("indexes every repository with its README", async () => {
    const backend = new FakeBackend();
    await fx.runCli(["scan"], { searchBackend: null });

    const result = await fx.runCli(["reindex"], { searchBackend: backend });

    expect(result.stdout.trim()).toBe("Indexed 2 repositories for search.");
    expect(backend.documents.map((d) => [d.relativePath, d.readme])).toEqual([
      ["billing", "Billing Handles invoices."],
      ["garden", "Garden Tomatoes."],
    ]);
  });

  it("fails clearly when search is disabled", async () => {
    await fx.runCli(["scan"], { searchBackend: null });
    const result = await fx.runCli(["reindex"], { searchBackend: null });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("Search is disabled");
  });

  it("scan re-indexes, and warns instead of failing when the server is down", async () => {
    const backend = new FakeBackend();
    const scanned = await fx.runCli(["scan"], { searchBackend: backend });
    expect(scanned.stdout).toContain("Scanned 2 repositories.");
    expect(scanned.stdout).toContain("Indexed 2 repositories for search.");

    backend.failWith = new SearchUnavailableError("Meilisearch at fake is unavailable: refused");
    const down = await fx.runCli(["scan"], { searchBackend: backend });
    expect(down.code).toBe(0);
    expect(down.stderr).toContain("Search index not updated");
  });

  it("notes edit syncs the repository into the index", async () => {
    const backend = new FakeBackend();
    const editor = path.join(fx.base, "write-notes.mjs");
    fs.writeFileSync(editor, 'import fs from "node:fs"; fs.writeFileSync(process.argv[2], "needle in notes\\n");');

    const result = await fx.runCli(["notes", "edit", "garden"], {
      searchBackend: backend,
      env: { EDITOR: `"${process.execPath}" "${editor}"` },
    });

    expect(result.code, result.stderr).toBe(0);
    expect(backend.upserts.map((d) => [d.relativePath, d.notes])).toEqual([["garden", "needle in notes"]]);
  });
});
