import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_README_LENGTH, NO_README, isMarkdownFileName, pickReadmeName } from "../src/lib/readme";
import { fetchGitHubReadme } from "../src/server/github.server";
import { fetchGitLabReadme } from "../src/server/gitlab.server";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const text = (body: string, status = 200) => new Response(body, { status, headers: { "Content-Type": "text/plain" } });

const base64 = (value: string) => Buffer.from(value, "utf-8").toString("base64");

const githubReadme = (markdown: string, name = "README.md") => ({ name, content: base64(markdown), encoding: "base64" });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("pickReadmeName", () => {
  it("prefers README.md, then other Markdown names, then any other README", () => {
    expect(pickReadmeName(["LICENSE", "readme.md", "README.md", "README.rst"])).toBe("README.md");
    expect(pickReadmeName(["README.rst", "readme.md"])).toBe("readme.md");
    expect(pickReadmeName(["README.rst", "Readme.markdown"])).toBe("Readme.markdown");
    expect(pickReadmeName(["README", "README.rst"])).toBe("README");
  });

  it("ignores files that only start with readme", () => {
    expect(pickReadmeName(["README-DEV.md", "readme_old.md", "LICENSE"])).toBeNull();
    expect(pickReadmeName([])).toBeNull();
  });

  it("knows which names are Markdown", () => {
    expect(["README.md", "readme.MARKDOWN", "README.mdown"].every(isMarkdownFileName)).toBe(true);
    expect(["README", "README.rst", "README.md.txt"].some(isMarkdownFileName)).toBe(false);
  });
});

describe("fetchGitHubReadme", () => {
  beforeEach(() => {
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "");
    vi.stubEnv("GITHUB_TOKEN", "");
  });

  it("decodes the Markdown GitHub sends, as UTF-8", async () => {
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(githubReadme("# Café ✓\n\nHello")));
    vi.stubGlobal("fetch", fetchMock);

    expect(await fetchGitHubReadme("me/app")).toEqual({ fileName: "README.md", markdown: "# Café ✓\n\nHello", error: null });
    expect(String(fetchMock.mock.calls[0]![0])).toBe("https://api.github.com/repos/me/app/readme");
  });

  it("sends the token when there is one", async () => {
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(json(githubReadme("# Private")));
    vi.stubGlobal("fetch", fetchMock);

    await fetchGitHubReadme("me/private");
    expect((fetchMock.mock.calls[0]![1]?.headers as Record<string, string>)["Authorization"]).toBe("Bearer ghp_test");
  });

  it("names a README that isn't Markdown without its text", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json(githubReadme("Title\n=====", "README.rst"))));
    expect(await fetchGitHubReadme("me/app")).toEqual({ fileName: "README.rst", markdown: null, error: null });
  });

  it("treats a 404 as a repository with no README", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ message: "Not Found" }, 404)));
    expect(await fetchGitHubReadme("me/app")).toEqual(NO_README);
  });

  it("reports a rate limit as an error", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({}, 403)));
    expect((await fetchGitHubReadme("me/app")).error).toMatch(/rate limit/i);
  });

  it("reports a README GitHub left out for being too large", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ name: "README.md", content: "", encoding: "none" })));
    const result = await fetchGitHubReadme("me/app");
    expect(result).toMatchObject({ fileName: "README.md", markdown: null });
    expect(result.error).toMatch(/too large/);
  });

  it("caps the text it returns", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json(githubReadme("x".repeat(MAX_README_LENGTH + 10)))));
    expect((await fetchGitHubReadme("me/app")).markdown).toHaveLength(MAX_README_LENGTH);
  });

  it("refuses a name that isn't owner/repo without asking GitHub", async () => {
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);
    for (const name of ["app", "a/b/c", "/app", "me/"]) {
      expect((await fetchGitHubReadme(name)).error).toMatch(/not a GitHub owner\/repo name/);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("fetchGitLabReadme", () => {
  beforeEach(() => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "");
    vi.stubEnv("GITLIB_GITLAB_URL", "");
  });

  /** A GitLab whose project root holds `entries`, and whose raw files come from `files`. */
  const gitlab = (entries: { name: string; type: "blob" | "tree" }[], files: Record<string, string> = {}) => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const { pathname } = new URL(String(input));
      if (pathname.endsWith("/repository/tree")) return json(entries);
      const file = /\/repository\/files\/([^/]+)\/raw$/.exec(pathname)?.[1];
      const body = file === undefined ? undefined : files[decodeURIComponent(file)];
      return body === undefined ? json({ message: "404 File Not Found" }, 404) : text(body);
    });
    vi.stubGlobal("fetch", fetchMock);
    return fetchMock;
  };
  const urls = (fetchMock: ReturnType<typeof gitlab>) => fetchMock.mock.calls.map(([input]) => String(input));

  it("lists the project root, then reads the README it finds there", async () => {
    const fetchMock = gitlab(
      [{ name: "src", type: "tree" }, { name: "README.md", type: "blob" }],
      { "README.md": "# Project" },
    );

    expect(await fetchGitLabReadme("grp/sub/proj")).toEqual({ fileName: "README.md", markdown: "# Project", error: null });
    expect(urls(fetchMock)).toEqual([
      "https://gitlab.com/api/v4/projects/grp%2Fsub%2Fproj/repository/tree?per_page=100",
      "https://gitlab.com/api/v4/projects/grp%2Fsub%2Fproj/repository/files/README.md/raw",
    ]);
  });

  it("sends the token and uses the configured self-hosted GitLab", async () => {
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "glpat_test");
    vi.stubEnv("GITLIB_GITLAB_URL", "https://git.example.com/");
    const fetchMock = gitlab([{ name: "README.md", type: "blob" }], { "README.md": "# Hi" });

    await fetchGitLabReadme("team/app");
    expect(urls(fetchMock)[0]).toMatch(/^https:\/\/git\.example\.com\/api\/v4\/projects\/team%2Fapp\//);
    for (const [, init] of fetchMock.mock.calls) {
      expect((init?.headers as Record<string, string>)["PRIVATE-TOKEN"]).toBe("glpat_test");
    }
  });

  it("finds a README whatever its case, and prefers Markdown to other formats", async () => {
    gitlab(
      [{ name: "README.rst", type: "blob" }, { name: "readme.markdown", type: "blob" }],
      { "readme.markdown": "# Lowercase" },
    );
    expect(await fetchGitLabReadme("me/app")).toMatchObject({ fileName: "readme.markdown", markdown: "# Lowercase" });
  });

  it("names a README that isn't Markdown without reading it", async () => {
    const fetchMock = gitlab([{ name: "README.rst", type: "blob" }], { "README.rst": "Title" });
    expect(await fetchGitLabReadme("me/app")).toEqual({ fileName: "README.rst", markdown: null, error: null });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("is no README when the root has none, only a README folder, or the project is empty", async () => {
    gitlab([{ name: "LICENSE", type: "blob" }]);
    expect(await fetchGitLabReadme("me/app")).toEqual(NO_README);

    gitlab([{ name: "README.md", type: "tree" }]);
    expect(await fetchGitLabReadme("me/app")).toEqual(NO_README);

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({ message: "404 Tree Not Found" }, 404)));
    expect(await fetchGitLabReadme("me/app")).toEqual(NO_README);
  });

  it("is no README when the file disappears between listing and reading", async () => {
    gitlab([{ name: "README.md", type: "blob" }], {});
    expect(await fetchGitLabReadme("me/app")).toEqual(NO_README);
  });

  it("throws a message worth showing for a rejected token and a rate limit", async () => {
    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({}, 401)));
    await expect(fetchGitLabReadme("me/app")).rejects.toThrow("GitLab rejected the token (401).");

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({}, 429)));
    await expect(fetchGitLabReadme("me/app")).rejects.toThrow(/rate limit/i);

    vi.stubGlobal("fetch", vi.fn<typeof fetch>().mockResolvedValue(json({}, 500)));
    await expect(fetchGitLabReadme("me/app")).rejects.toThrow("GitLab responded with 500.");
  });
});

describe("loadRemoteReadme", () => {
  let base: string;

  const githubListing = [
    { full_name: "me/app", name: "app", description: "Cloned", html_url: "https://github.com/me/app", private: false, fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", updated_at: null, language: null },
    { full_name: "me/remote-only", name: "remote-only", description: "Not cloned", html_url: "https://github.com/me/remote-only", private: false, fork: false, archived: false, pushed_at: "2026-01-01T00:00:00Z", updated_at: null, language: null },
  ];
  const gitlabListing = [
    { path_with_namespace: "grp/sub/proj", path: "proj", description: "On GitLab", web_url: "https://gitlab.com/grp/sub/proj", visibility: "private", archived: false, last_activity_at: null },
  ];

  /** GitHub and GitLab as far as the catalog and the README fetchers can tell; every request is recorded. */
  function fakeHosts() {
    const requests: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = new URL(String(input));
      requests.push(`${url.host}${url.pathname}`);
      if (url.host === "api.github.com" && url.pathname === "/user/repos") return json(githubListing);
      if (url.host === "api.github.com" && url.pathname === "/repos/me/remote-only/readme") {
        return json(githubReadme("# Remote only"));
      }
      if (url.host === "gitlab.com" && url.pathname === "/api/v4/projects") return json(gitlabListing);
      if (url.pathname === "/api/v4/projects/grp%2Fsub%2Fproj/repository/tree") return json([{ name: "README.md", type: "blob" }]);
      if (url.pathname === "/api/v4/projects/grp%2Fsub%2Fproj/repository/files/README.md/raw") return text("# On GitLab");
      return json({ message: "Not Found" }, 404);
    });
    vi.stubGlobal("fetch", fetchMock);
    return { requests, fetchMock };
  }
  const readmeRequests = (requests: string[]) => requests.filter((request) => /\/readme$|\/repository\//.test(request));

  beforeEach(() => {
    base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-remote-readme-")));
    const root = path.join(base, "git");
    const clone = path.join(root, "app");
    fs.mkdirSync(clone, { recursive: true });
    execFileSync("git", ["init", "-q", clone]);
    execFileSync("git", ["-C", clone, "remote", "add", "origin", "https://github.com/me/app.git"]);
    fs.mkdirSync(path.join(base, "home"));
    fs.writeFileSync(path.join(base, "home", "config.toml"), `roots = ["${root}"]\n\n[search]\nenabled = false\n`);

    vi.stubEnv("GITLIB_HOME", path.join(base, "home"));
    vi.stubEnv("GITLIB_GITHUB_TOKEN", "ghp_test");
    vi.stubEnv("GITHUB_TOKEN", "");
    vi.stubEnv("GITLIB_GITLAB_TOKEN", "glpat_test");
    vi.stubEnv("GITLIB_GITLAB_USERNAME", "");
    vi.stubEnv("GITLIB_GITLAB_URL", "");
    vi.stubEnv("GITLIB_REPO_REFRESH_HOURS", "");
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  /** Fresh server modules, with both hosts' listings already stored. */
  async function startServer() {
    const shared = globalThis as Record<string, unknown>;
    delete shared["__gitlib"];
    delete shared["__gitlibCatalog"];
    vi.resetModules();
    const { buildCatalog, loadRemoteReadme } = await import("../src/server/catalog.server");
    await buildCatalog();
    await vi.waitFor(async () => {
      const view = await buildCatalog();
      expect(view.github.refreshing || view.gitlab.refreshing).toBe(false);
      expect(view.entries.length).toBeGreaterThan(1);
    });
    return loadRemoteReadme;
  }

  it("reads the README of a repo only GitHub has", async () => {
    const { requests } = fakeHosts();
    const loadRemoteReadme = await startServer();

    expect(await loadRemoteReadme("github", "me/remote-only")).toEqual({ fileName: "README.md", markdown: "# Remote only", error: null });
    expect(readmeRequests(requests)).toEqual(["api.github.com/repos/me/remote-only/readme"]);
  });

  it("reads the README of a repo only GitLab has, including its subgroup path", async () => {
    const { requests } = fakeHosts();
    const loadRemoteReadme = await startServer();

    expect(await loadRemoteReadme("gitlab", "grp/sub/proj")).toEqual({ fileName: "README.md", markdown: "# On GitLab", error: null });
    expect(readmeRequests(requests)).toHaveLength(2);
  });

  it("asks the host about the listed spelling of the name, not the caller's", async () => {
    const { requests } = fakeHosts();
    const loadRemoteReadme = await startServer();

    expect((await loadRemoteReadme("github", "ME/Remote-Only")).markdown).toBe("# Remote only");
    expect(readmeRequests(requests)).toEqual(["api.github.com/repos/me/remote-only/readme"]);
  });

  it("never reads a repository the catalog doesn't list, so the tokens can't be aimed elsewhere", async () => {
    const { requests } = fakeHosts();
    const loadRemoteReadme = await startServer();

    for (const [provider, name] of [["github", "someone-else/secrets"], ["gitlab", "../../admin"], ["github", "me/remote-only/../app"]] as const) {
      expect((await loadRemoteReadme(provider, name)).error).toMatch(/not on a host gitlib lists/);
    }
    expect(readmeRequests(requests)).toEqual([]);
  });

  it("leaves a repo that is already cloned to its local detail page", async () => {
    const { requests } = fakeHosts();
    const loadRemoteReadme = await startServer();

    expect((await loadRemoteReadme("github", "me/app")).error).toMatch(/already cloned/);
    expect(readmeRequests(requests)).toEqual([]);
  });

  it("returns a failure as a message instead of throwing", async () => {
    const { fetchMock } = fakeHosts();
    const loadRemoteReadme = await startServer();

    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect(await loadRemoteReadme("github", "me/remote-only")).toEqual({ fileName: null, markdown: null, error: "fetch failed" });

    fetchMock.mockRejectedValueOnce(Object.assign(new Error("The operation was aborted due to timeout"), { name: "TimeoutError" }));
    expect((await loadRemoteReadme("github", "me/remote-only")).error).toBe("The host took too long to answer.");
  });
});
