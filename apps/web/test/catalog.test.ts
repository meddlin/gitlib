import { describe, expect, it } from "vitest";
import {
  cloneFolderName,
  cloneUrlOf,
  entriesForSource,
  matchesQuery,
  mergeCatalog,
  parseLandingPage,
  parseStoredListing,
  remoteFavoriteId,
  remoteKey,
  type LocalClone,
  type RemoteRepo,
} from "../src/lib/catalog";

const github = (fullName: string, extra: Partial<RemoteRepo> = {}): RemoteRepo => ({
  provider: "github",
  key: remoteKey("github.com", fullName),
  fullName,
  name: fullName.split("/").at(-1)!,
  description: "",
  url: `https://github.com/${fullName}`,
  isPrivate: false,
  isFork: false,
  isArchived: false,
  updatedAt: null,
  language: null,
  ...extra,
});

const gitlab = (fullName: string, extra: Partial<RemoteRepo> = {}): RemoteRepo => ({
  ...github(fullName),
  provider: "gitlab",
  key: remoteKey("gitlab.com", fullName),
  url: `https://gitlab.com/${fullName}`,
  ...extra,
});

const clone = (relativePath: string, remotes: LocalClone["remotes"] = [], description = ""): LocalClone => ({
  relativePath,
  name: relativePath.split("/").at(-1)!,
  description,
  remotes,
});

const remoteOf = (repo: RemoteRepo) => ({
  provider: repo.provider,
  key: repo.key,
  fullName: repo.fullName,
  url: repo.url,
});

describe("remoteKey / parseLandingPage", () => {
  it("ignores case, .git and slashes", () => {
    expect(remoteKey("GitHub.com", "/Meddlin/Gitlib.git/")).toBe("github.com/meddlin/gitlib");
  });

  it("reads the host and path of a landing page, keeping nested GitLab groups", () => {
    expect(parseLandingPage("https://gitlab.com/group/sub/proj")).toEqual({
      key: "gitlab.com/group/sub/proj",
      path: "group/sub/proj",
    });
    expect(parseLandingPage("https://gitlab.com")).toBeNull();
    expect(parseLandingPage(null)).toBeNull();
  });
});

describe("mergeCatalog", () => {
  it("joins a clone with the GitHub repo its remote names", () => {
    const repo = github("me/app", { description: "On GitHub", language: "TypeScript", updatedAt: "2026-01-02T00:00:00Z" });
    const [entry, ...rest] = mergeCatalog([clone("work/app", [remoteOf(repo)])], [repo], []);
    expect(rest).toEqual([]);
    expect(entry).toMatchObject({
      locals: ["work/app"],
      fullName: "me/app",
      description: "On GitHub",
      language: "TypeScript",
      updatedAt: "2026-01-02T00:00:00Z",
    });
    expect(entry!.github).toMatchObject({ listed: true, url: "https://github.com/me/app" });
    expect(entry!.gitlab).toBeNull();
  });

  it("prefers the clone's own description over the host's", () => {
    const repo = github("me/app", { description: "On GitHub" });
    const [entry] = mergeCatalog([clone("app", [remoteOf(repo)], "My notes")], [repo], []);
    expect(entry!.description).toBe("My notes");
  });

  it("links one clone to both hosts when it has a remote on each", () => {
    const gh = github("me/app");
    const gl = gitlab("me/app");
    const entries = mergeCatalog([clone("app", [remoteOf(gh), remoteOf(gl)])], [gh], [gl]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.github?.listed).toBe(true);
    expect(entries[0]!.gitlab?.listed).toBe(true);
  });

  it("lists remote repos nobody has cloned on their own", () => {
    const entries = mergeCatalog([], [github("me/a")], [gitlab("me/b")]);
    expect(entries.map((e) => [e.fullName, e.locals.length, !!e.github, !!e.gitlab])).toEqual([
      ["me/a", 0, true, false],
      ["me/b", 0, false, true],
    ]);
  });

  it("keeps clones with no known remote as local-only", () => {
    const [entry] = mergeCatalog([clone("scratch/thing")], [], []);
    expect(entry).toMatchObject({ locals: ["scratch/thing"], fullName: "scratch/thing", github: null, gitlab: null });
  });

  it("collapses clones of the same remote repo into one entry", () => {
    const repo = github("me/app");
    const entries = mergeCatalog(
      [clone("b/app", [remoteOf(repo)]), clone("a/app", [remoteOf(repo)])],
      [repo],
      [],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.locals).toEqual(["a/app", "b/app"]);
  });

  it("joins a GitHub-only clone and a GitLab-only clone of one project through a shared clone", () => {
    const gh = github("me/app");
    const gl = gitlab("me/app");
    const entries = mergeCatalog(
      [clone("one", [remoteOf(gh), remoteOf(gl)]), clone("two", [remoteOf(gl)])],
      [gh],
      [gl],
    );
    expect(entries).toHaveLength(1);
    expect(entries[0]!.locals).toEqual(["one", "two"]);
  });

  it("only follows the preferred remote per host, so a fork's upstream is not pulled in", () => {
    const fork = github("me/app", { isFork: true });
    const upstream = github("them/app");
    const entries = mergeCatalog([clone("app", [remoteOf(fork), remoteOf(upstream)])], [fork, upstream], []);
    expect(entries.map((e) => e.fullName)).toEqual(["me/app", "them/app"]);
    expect(entries[0]!.locals).toEqual(["app"]);
    expect(entries[1]!.locals).toEqual([]);
  });

  it("still names the host for a clone whose repo is not in the account's listing", () => {
    const other = github("someone/else");
    const [entry] = mergeCatalog([clone("else", [remoteOf(other)])], [], []);
    expect(entry!.github).toMatchObject({ listed: false, fullName: "someone/else", url: "https://github.com/someone/else" });
  });

  it("matches hosts regardless of case in the remote URL", () => {
    const repo = github("Me/App");
    const [entry] = mergeCatalog(
      [clone("app", [{ ...remoteOf(repo), key: remoteKey("GITHUB.com", "me/app.git") }])],
      [repo],
      [],
    );
    expect(entry!.github?.listed).toBe(true);
  });
});

describe("favorites", () => {
  it("stars a repo that only a host has through its remote favorite, and lists starred repos first", () => {
    const starred = github("me/zeta");
    const entries = mergeCatalog([], [github("me/alpha"), starred], [], new Set([remoteFavoriteId("github", starred.key)]));
    expect(entries.map((e) => [e.fullName, e.isFavorite])).toEqual([
      ["me/zeta", true],
      ["me/alpha", false],
    ]);
  });

  it("matches a remote favorite on the provider as well as the key", () => {
    const repo = gitlab("me/app");
    const [entry] = mergeCatalog([], [], [repo], new Set([remoteFavoriteId("github", repo.key)]));
    expect(entry!.isFavorite).toBe(false);
    const [starred] = mergeCatalog([], [], [repo], new Set([remoteFavoriteId("gitlab", repo.key)]));
    expect(starred!.isFavorite).toBe(true);
  });

  it("uses the clone's own star for a cloned repo and ignores a leftover remote favorite", () => {
    const repo = github("me/app");
    const favorites = new Set([remoteFavoriteId("github", repo.key)]);
    const [plain] = mergeCatalog([clone("app", [remoteOf(repo)])], [repo], [], favorites);
    expect(plain!.isFavorite).toBe(false);
    const [starred] = mergeCatalog([{ ...clone("app", [remoteOf(repo)]), isFavorite: true }], [repo], []);
    expect(starred!.isFavorite).toBe(true);
  });

  it("stars a repo with no host through its clone", () => {
    const [entry] = mergeCatalog([{ ...clone("scratch"), isFavorite: true }], [], []);
    expect(entry!.isFavorite).toBe(true);
  });
});

describe("entriesForSource / matchesQuery", () => {
  const gh = github("me/listed");
  const entries = mergeCatalog(
    [clone("listed", [remoteOf(gh)]), clone("foreign", [remoteOf(github("them/foreign"))]), clone("scratch")],
    [gh, github("me/remote-only")],
    [gitlab("me/lab")],
  );

  it("slices the catalog by source", () => {
    const names = (source: Parameters<typeof entriesForSource>[1]) =>
      entriesForSource(entries, source).map((e) => e.fullName);
    expect(names("combined")).toHaveLength(5);
    expect(names("local")).toEqual(["me/listed", "scratch", "them/foreign"]);
    expect(names("github")).toEqual(["me/listed", "me/remote-only"]);
    expect(names("gitlab")).toEqual(["me/lab"]);
  });

  it("requires every word to appear in the name, full name or description", () => {
    const [entry] = mergeCatalog([], [github("me/widget", { description: "Builds Things" })], []);
    expect(matchesQuery(entry!, "widget things")).toBe(true);
    expect(matchesQuery(entry!, "widget missing")).toBe(false);
    expect(matchesQuery(entry!, "")).toBe(true);
    expect(matchesQuery(entry!, undefined)).toBe(true);
  });
});

describe("parseStoredListing", () => {
  const listing = { scope: "github.com", pages: [{ etag: '"a"', repos: [github("me/app")] }] };

  it("reads back what was stored", () => {
    expect(parseStoredListing(JSON.stringify(listing), "github.com")).toEqual(listing);
  });

  it("ignores a listing made for another host or account", () => {
    expect(parseStoredListing(JSON.stringify(listing), "https://gitlab.com|member")).toBeNull();
  });

  it("ignores unreadable payloads", () => {
    expect(parseStoredListing("not json", "github.com")).toBeNull();
    expect(parseStoredListing("null", "github.com")).toBeNull();
    expect(parseStoredListing(JSON.stringify({ scope: "github.com", pages: [null] }), "github.com")).toBeNull();
  });
});

describe("clone helpers", () => {
  it("builds the clone URL from a landing page", () => {
    expect(cloneUrlOf("https://github.com/me/app")).toBe("https://github.com/me/app.git");
    expect(cloneUrlOf("https://gitlab.com/g/sub/app/")).toBe("https://gitlab.com/g/sub/app.git");
  });

  it("names the clone folder after the repo and refuses path tricks", () => {
    expect(cloneFolderName("g/sub/app")).toBe("app");
    expect(cloneFolderName("..")).toBeNull();
    expect(cloneFolderName("")).toBeNull();
  });
});
