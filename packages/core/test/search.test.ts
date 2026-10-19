import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  ConfigError,
  HIGHLIGHT_END,
  HIGHLIGHT_START,
  MeilisearchBackend,
  SearchUnavailableError,
  buildSearchDocument,
  createApplication,
  loadConfig,
  markdownToText,
  parseHighlights,
  readReadmeText,
  renderSegments,
  type BackendHit,
  type SearchBackend,
  type SearchDocument,
} from "../src/index.js";
import { Fixture } from "./fixture.js";

let fx: Fixture;
beforeEach(() => {
  fx = new Fixture();
});
afterEach(() => fx.cleanup());

const mark = (text: string) => `${HIGHLIGHT_START}${text}${HIGHLIGHT_END}`;

class FakeBackend implements SearchBackend {
  readonly label = "fake";
  documents: SearchDocument[] = [];
  upserts: SearchDocument[][] = [];
  hits: BackendHit[] = [];
  failWith: Error | null = null;
  queries: { query: string; limit: number }[] = [];

  async replaceAll(documents: readonly SearchDocument[]) {
    if (this.failWith) throw this.failWith;
    this.documents = [...documents];
  }
  async upsert(documents: readonly SearchDocument[]) {
    if (this.failWith) throw this.failWith;
    this.upserts.push([...documents]);
  }
  async search(query: string, limit: number) {
    if (this.failWith) throw this.failWith;
    this.queries.push({ query, limit });
    return this.hits;
  }
}

describe("highlights", () => {
  it("splits marker-wrapped text into segments", () => {
    expect(parseHighlights(`use ${mark("type")}script today`)).toEqual([
      { text: "use ", match: false },
      { text: "type", match: true },
      { text: "script today", match: false },
    ]);
  });

  it("returns null when nothing matched", () => {
    expect(parseHighlights("plain text")).toBeNull();
  });

  it("never treats markup in the text as markup", () => {
    const segments = parseHighlights(`<script>${mark("alert")}</script>`)!;
    expect(segments.map((s) => s.text).join("")).toBe("<script>alert</script>");
    expect(segments.filter((s) => s.match).map((s) => s.text)).toEqual(["alert"]);
  });

  it("renders matches with a custom wrapper", () => {
    const segments = parseHighlights(`a ${mark("b")} c`)!;
    expect(renderSegments(segments)).toBe("a «b» c");
    expect(renderSegments(segments, (t) => `**${t}**`)).toBe("a **b** c");
  });
});

describe("readme extraction", () => {
  it("strips markdown noise down to readable text", () => {
    const text = markdownToText(
      ["# Title", "", "![badge](https://img.example/b.svg) See [the docs](https://example.com/docs).", "", "- `code` item", "<!-- hidden -->"].join("\n"),
    );
    expect(text).toBe("Title See the docs. code item");
  });

  it("reads README.md case-insensitively and prefers it over README.txt", () => {
    const repo = fx.makeRepo("a", { "readme.md": "# Hello world", "README.txt": "plain" });
    expect(readReadmeText(repo)).toBe("Hello world");
  });

  it("returns an empty string when there is no readme", () => {
    expect(readReadmeText(fx.makeRepo("b"))).toBe("");
    expect(readReadmeText(path.join(fx.base, "nope"))).toBe("");
  });

  it("caps very long readmes", () => {
    const repo = fx.makeRepo("c", { "README.md": "word ".repeat(100_000) });
    expect(readReadmeText(repo).length).toBeLessThanOrEqual(100_000);
  });

  it("builds a document with the readme text, and skips it for missing repos", () => {
    fx.writeConfig();
    fx.makeRepo("d", { "README.md": "# Findable" });
    const app = createApplication(fx.env(), undefined, new FakeBackend());
    const [repo] = app.refresh();
    expect(buildSearchDocument(repo!).readme).toBe("Findable");
    expect(buildSearchDocument({ ...repo!, isMissing: true }).readme).toBe("");
  });
});

describe("search config", () => {
  it("defaults to a local Meilisearch", () => {
    fx.writeConfig({ search: [] });
    expect(loadConfig(fx.env()).search).toEqual({
      enabled: true,
      host: "http://127.0.0.1:7700",
      apiKey: null,
      indexName: "gitlib_repos",
    });
  });

  it("reads the [search] table and lets the environment override it", () => {
    fx.writeConfig({
      search: ["enabled = false", 'host = "http://search:7700"', 'api_key = "from-file"', 'index = "mine"'],
    });
    expect(loadConfig(fx.env()).search).toEqual({
      enabled: false,
      host: "http://search:7700",
      apiKey: "from-file",
      indexName: "mine",
    });
    const overridden = loadConfig(fx.env({ GITLIB_MEILI_HOST: "http://other:1", GITLIB_MEILI_API_KEY: "from-env" }));
    expect(overridden.search.host).toBe("http://other:1");
    expect(overridden.search.apiKey).toBe("from-env");
  });

  it("rejects malformed values", () => {
    fx.writeConfig({ search: ['enabled = "yes"'] });
    expect(() => loadConfig(fx.env())).toThrow(ConfigError);
  });
});

describe("GitLibApp search", () => {
  function appWith(backend: SearchBackend | null) {
    fx.writeConfig();
    fx.makeRepo("alpha", { "package.json": JSON.stringify({ dependencies: { react: "19" } }), "README.md": "# Alpha\nrenders dashboards" });
    fx.makeRepo("beta", { "README.md": "# Beta\nbackups" });
    const app = createApplication(fx.env(), undefined, backend);
    app.refresh();
    app.saveRepositoryNotes("beta", "restic notes");
    return app;
  }

  it("returns backend hits in ranked order with highlights, skipping unknown ids", async () => {
    const backend = new FakeBackend();
    const app = appWith(backend);
    const [alpha, beta] = [app.getRepository("alpha"), app.getRepository("beta")];
    backend.hits = [
      { id: beta.id, highlights: { readme: `${mark("backups")} nightly` } },
      { id: 9999, highlights: {} },
      { id: alpha.id, highlights: {} },
    ];

    const result = await app.searchRepositories("backups");

    expect(result.mode).toBe("meilisearch");
    expect(result.hits.map((hit) => hit.repo.relativePath)).toEqual(["beta", "alpha"]);
    expect(result.hits[0]!.highlights.readme).toEqual([
      { text: "backups", match: true },
      { text: " nightly", match: false },
    ]);
  });

  it("applies technology and notes filters to backend hits", async () => {
    const backend = new FakeBackend();
    const app = appWith(backend);
    backend.hits = [alphaAndBeta(app)[0]!, alphaAndBeta(app)[1]!].map((repo) => ({ id: repo.id, highlights: {} }));

    expect((await app.searchRepositories("x", { technology: "react" })).hits.map((h) => h.repo.relativePath)).toEqual(["alpha"]);
    expect((await app.searchRepositories("x", { notesOnly: true })).hits.map((h) => h.repo.relativePath)).toEqual(["beta"]);
  });

  it("hides linked worktrees from search results unless asked to include them", async () => {
    const backend = new FakeBackend();
    fx.writeConfig();
    fx.initRealGitRepo("main-repo");
    fx.addWorktree("main-repo", "main-repo/.claude/worktrees/feature");
    const app = createApplication(fx.env(), undefined, backend);
    const repos = app.refresh();
    backend.hits = repos.map((repo) => ({ id: repo.id, highlights: {} }));
    const paths = async (options?: { includeWorktrees?: boolean }) =>
      (await app.searchRepositories("main", options)).hits.map((hit) => hit.repo.relativePath);

    expect(await paths()).toEqual(["main-repo"]);
    expect(await paths({ includeWorktrees: true })).toEqual(["main-repo", "main-repo/.claude/worktrees/feature"]);

    // The substring fallback applies the same rule.
    backend.failWith = new SearchUnavailableError("down");
    expect(await paths()).toEqual(["main-repo"]);
    expect(await paths({ includeWorktrees: true })).toEqual(["main-repo", "main-repo/.claude/worktrees/feature"]);
  });

  it("falls back to substring matching when the backend is unavailable", async () => {
    const backend = new FakeBackend();
    backend.failWith = new SearchUnavailableError("Meilisearch at fake is unavailable: refused");
    const app = appWith(backend);

    const result = await app.searchRepositories("restic");

    expect(result.mode).toBe("basic");
    expect(result.hits.map((hit) => hit.repo.relativePath)).toEqual(["beta"]);
    expect(result.notice).toContain("unavailable");
  });

  it("falls back silently when search is disabled", async () => {
    const app = appWith(null);
    const result = await app.searchRepositories("alpha");
    expect(result.mode).toBe("basic");
    expect(result.notice).toBeNull();
    expect(result.hits.map((hit) => hit.repo.relativePath)).toEqual(["alpha"]);
  });

  it("does not hide unexpected errors behind the fallback", async () => {
    const backend = new FakeBackend();
    backend.failWith = new TypeError("boom");
    await expect(appWith(backend).searchRepositories("alpha")).rejects.toThrow("boom");
  });

  it("lists everything when the query is empty without touching the backend", async () => {
    const backend = new FakeBackend();
    const app = appWith(backend);
    const result = await app.searchRepositories("  ");
    expect(result.hits).toHaveLength(2);
    expect(backend.queries).toEqual([]);
  });

  it("reindexes every repository with its readme and syncs single repositories", async () => {
    const backend = new FakeBackend();
    const app = appWith(backend);

    expect(await app.reindexSearch()).toBe(2);
    expect(backend.documents.map((d) => [d.relativePath, d.readme])).toEqual([
      ["alpha", "Alpha renders dashboards"],
      ["beta", "Beta backups"],
    ]);

    await app.syncRepositorySearch("beta");
    expect(backend.upserts[0]![0]!.notes).toBe("restic notes");
  });

  it("refuses to index when search is disabled", async () => {
    await expect(appWith(null).reindexSearch()).rejects.toThrow(SearchUnavailableError);
  });
});

function alphaAndBeta(app: ReturnType<typeof createApplication>) {
  return [app.getRepository("alpha"), app.getRepository("beta")];
}

// Exercises the real Meilisearch client against a throwaway server. Skipped when the binary is absent.
const hasMeilisearch = spawnSync("meilisearch", ["--version"], { stdio: "ignore" }).status === 0;

describe.skipIf(!hasMeilisearch)("Meilisearch integration", () => {
  let server: ChildProcess;
  let dataDir: string;
  let host: string;

  beforeAll(async () => {
    const port = await new Promise<number>((resolve) => {
      const probe = net.createServer().listen(0, "127.0.0.1", () => {
        const { port } = probe.address() as net.AddressInfo;
        probe.close(() => resolve(port));
      });
    });
    host = `http://127.0.0.1:${port}`;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-meili-"));
    server = spawn("meilisearch", ["--http-addr", `127.0.0.1:${port}`, "--db-path", path.join(dataDir, "data.ms"), "--no-analytics", "--env", "development"], {
      cwd: dataDir,
      stdio: "ignore",
    });
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        if ((await fetch(`${host}/health`)).ok) return;
      } catch {
        /* not up yet */
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error("Meilisearch did not start");
  }, 30_000);

  afterAll(() => {
    server?.kill();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  function liveApp() {
    fx.writeConfig({ search: [`host = "${host}"`, `index = "t_${path.basename(fx.base).replace(/\W/g, "_")}"`] });
    fx.makeRepo("billing", { "README.md": "# Billing\nHandles invoices and subscription renewals for customers." });
    fx.makeRepo("garden", { "README.md": "# Garden\nA tomato planting planner." });
    fx.makeRepo("tools/zeta", { "README.md": "# Zeta\nInternal helpers." });
    const app = createApplication(fx.env());
    app.refresh();
    return app;
  }

  it("finds repositories by README content, with a highlighted snippet", async () => {
    const app = liveApp();
    await app.reindexSearch();

    const result = await app.searchRepositories("invoices");

    expect(result.mode).toBe("meilisearch");
    expect(result.hits.map((hit) => hit.repo.relativePath)).toEqual(["billing"]);
    const snippet = result.hits[0]!.highlights.readme!;
    expect(snippet.filter((s) => s.match).map((s) => s.text)).toEqual(["invoices"]);
  });

  it("tolerates typos and ranks name matches above README matches", async () => {
    const app = liveApp();
    await app.reindexSearch();

    expect((await app.searchRepositories("subscripton")).hits.map((h) => h.repo.relativePath)).toEqual(["billing"]);

    const ranked = await app.searchRepositories("garden");
    expect(ranked.hits[0]!.repo.relativePath).toBe("garden");
  });

  it("picks up note edits via syncRepositorySearch and drops deleted repos on reindex", async () => {
    const app = liveApp();
    await app.reindexSearch();

    app.saveRepositoryNotes("garden", "remember the quokka migration");
    await app.syncRepositorySearch("garden");
    expect((await app.searchRepositories("quokka")).hits.map((h) => h.repo.relativePath)).toEqual(["garden"]);

    fs.rmSync(path.join(fx.gitRoot, "garden"), { recursive: true });
    app.refresh();
    await app.reindexSearch();
    expect((await app.searchRepositories("quokka")).hits).toEqual([]);
  });

  it("does not create a partial index when syncing a single repository", async () => {
    const app = liveApp();
    await expect(app.syncRepositorySearch("garden")).rejects.toThrow(/gitlib reindex/);
    expect((await app.searchRepositories("garden")).notice).toContain("gitlib reindex");
  });

  it("reports a missing index instead of crashing", async () => {
    const app = liveApp();
    const result = await app.searchRepositories("anything");
    expect(result.mode).toBe("basic");
    expect(result.notice).toContain("gitlib reindex");
  });

  it("falls back when the server is unreachable", async () => {
    const backend = new MeilisearchBackend({ host: "http://127.0.0.1:1", apiKey: null, indexName: "x" });
    await expect(backend.search("a", 5)).rejects.toThrow(SearchUnavailableError);
  });
});
