import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApplication, type GitLibApp } from "@gitlib/core";
import { MAX_ASSET_BYTES, handleRepoAsset, readRepoAsset } from "../src/server/repo-asset.server";

// Not a real PNG; the route serves bytes by extension and never looks inside.
const PNG = Buffer.from("\x89PNG fake image bytes");

let base: string;
let repo: string;
let outside: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "gitlib-repo-asset-")));
  repo = path.join(base, "git", "alpha");
  outside = path.join(base, "outside");
  fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "img"), { recursive: true });
  fs.mkdirSync(outside);

  fs.writeFileSync(path.join(repo, "logo.png"), PNG);
  fs.writeFileSync(path.join(repo, "LOUD.PNG"), PNG);
  fs.writeFileSync(path.join(repo, "my logo.png"), PNG);
  fs.writeFileSync(path.join(repo, "..dots.png"), PNG);
  fs.writeFileSync(path.join(repo, "docs", "img", "shot.jpg"), PNG);
  fs.writeFileSync(path.join(repo, "icon.svg"), '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><script>alert(1)</script></svg>');
  fs.writeFileSync(path.join(repo, "notes.txt"), "private notes");
  fs.writeFileSync(path.join(repo, ".env"), "SECRET=1");
  fs.writeFileSync(path.join(repo, "README.md"), "# Alpha");
  fs.writeFileSync(path.join(repo, ".git", "config"), "[core]");
  fs.writeFileSync(path.join(repo, ".git", "hidden.png"), PNG);
  fs.mkdirSync(path.join(repo, "folder.png"));

  fs.writeFileSync(path.join(outside, "secret.png"), PNG);
  fs.writeFileSync(path.join(outside, "secret.txt"), "top secret");
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

const ok = (result: ReturnType<typeof readRepoAsset>) => {
  if (!result.ok) throw new Error(`expected an image, got ${result.status}: ${result.message}`);
  return result;
};

describe("readRepoAsset", () => {
  it("reads an image at the repository's root, in a folder, and with a space in its name", () => {
    expect(ok(readRepoAsset(repo, "logo.png")).data.equals(PNG)).toBe(true);
    expect(ok(readRepoAsset(repo, "docs/img/shot.jpg")).contentType).toBe("image/jpeg");
    expect(ok(readRepoAsset(repo, "my logo.png")).contentType).toBe("image/png");
  });

  it("treats leading slashes, ./ and doubled slashes as the repository's root", () => {
    for (const requested of ["/logo.png", "./logo.png", "//logo.png", "././logo.png", "docs//img/./shot.jpg"]) {
      expect(readRepoAsset(repo, requested).ok, requested).toBe(true);
    }
  });

  it("picks the type from the extension, case-insensitively", () => {
    expect(ok(readRepoAsset(repo, "LOUD.PNG")).contentType).toBe("image/png");
    expect(ok(readRepoAsset(repo, "icon.svg")).contentType).toBe("image/svg+xml");
  });

  it("serves a file whose name merely starts with two dots", () => {
    expect(readRepoAsset(repo, "..dots.png").ok).toBe(true);
  });

  describe("path traversal", () => {
    it.each([
      "../outside/secret.png",
      "docs/../../outside/secret.png",
      "docs/img/../../../outside/secret.png",
      "..",
      "docs/..",
      "./../outside/secret.png",
      "/../outside/secret.png",
    ])("refuses %j", (requested) => {
      const result = readRepoAsset(repo, requested);
      expect(result).toMatchObject({ ok: false, status: 400 });
    });

    it("does not decode percent-escapes itself, so an encoded .. is just an odd, missing file name", () => {
      expect(readRepoAsset(repo, "%2e%2e/outside/secret.png")).toMatchObject({ ok: false, status: 404 });
      expect(readRepoAsset(repo, "docs/%2e%2e/%2e%2e/outside/secret.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("does not read an absolute path as one", () => {
      // "/etc/hosts.png" is read as <repo>/etc/hosts.png, which does not exist.
      expect(readRepoAsset(repo, path.join(outside, "secret.png"))).toMatchObject({ ok: false, status: 404 });
    });

    it.each([
      ["a backslash", "docs\\img\\shot.jpg"],
      ["a NUL byte", "logo.png\0.txt"],
      ["nothing", ""],
      ["only dots and slashes", "./."],
      ["a very long path", `${"a/".repeat(600)}x.png`],
    ])("refuses %s", (_name, requested) => {
      expect(readRepoAsset(repo, requested)).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe("symbolic links", () => {
    it("refuses a link to an image outside the repository", () => {
      fs.symlinkSync(path.join(outside, "secret.png"), path.join(repo, "escape.png"));
      expect(readRepoAsset(repo, "escape.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses a file reached through a link to a folder outside the repository", () => {
      fs.symlinkSync(outside, path.join(repo, "linked"));
      expect(readRepoAsset(repo, "linked/secret.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses a relative link that climbs out", () => {
      // docs/ is <base>/git/alpha/docs, so three levels up is <base>, where outside/ lives.
      fs.symlinkSync("../../../outside/secret.png", path.join(repo, "docs", "climb.png"));
      expect(fs.realpathSync(path.join(repo, "docs", "climb.png"))).toBe(path.join(outside, "secret.png"));
      expect(readRepoAsset(repo, "docs/climb.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses an image-named link to a file that is not an image", () => {
      fs.symlinkSync(path.join(repo, "notes.txt"), path.join(repo, "disguised.png"));
      fs.symlinkSync(path.join(outside, "secret.txt"), path.join(repo, "disguised2.png"));
      expect(readRepoAsset(repo, "disguised.png")).toMatchObject({ ok: false, status: 404 });
      expect(readRepoAsset(repo, "disguised2.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses a link into .git", () => {
      fs.symlinkSync(path.join(repo, ".git", "hidden.png"), path.join(repo, "viagit.png"));
      expect(readRepoAsset(repo, "viagit.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("follows a link that stays inside the repository", () => {
      fs.symlinkSync(path.join(repo, "docs", "img", "shot.jpg"), path.join(repo, "alias.jpg"));
      expect(ok(readRepoAsset(repo, "alias.jpg")).contentType).toBe("image/jpeg");
    });

    it("works when the repository itself is reached through a link", () => {
      const viaLink = path.join(base, "repo-link");
      fs.symlinkSync(repo, viaLink);
      expect(readRepoAsset(viaLink, "logo.png").ok).toBe(true);
      expect(readRepoAsset(viaLink, "../outside/secret.png")).toMatchObject({ ok: false, status: 400 });
    });
  });

  describe("what may be read", () => {
    it.each([".git/hidden.png", ".GIT/hidden.png", ".Git/hidden.png", "docs/.git/hidden.png"])("never reads from %s", (requested) => {
      expect(readRepoAsset(repo, requested)).toMatchObject({ ok: false, status: 404 });
    });

    it.each(["notes.txt", ".env", "README.md", ".git/config", "docs", "folder.png"])("does not serve %s", (requested) => {
      expect(readRepoAsset(repo, requested)).toMatchObject({ ok: false, status: 404 });
    });

    it("answers 404 for a file that is not there", () => {
      expect(readRepoAsset(repo, "missing.png")).toMatchObject({ ok: false, status: 404 });
      expect(readRepoAsset(path.join(base, "no-such-repo"), "logo.png")).toMatchObject({ ok: false, status: 404 });
    });

    it("refuses an image over the size limit", () => {
      fs.writeFileSync(path.join(repo, "huge.png"), Buffer.alloc(MAX_ASSET_BYTES + 1));
      expect(readRepoAsset(repo, "huge.png")).toMatchObject({ ok: false, status: 413 });
    });

    it("serves an image exactly at the size limit", () => {
      fs.writeFileSync(path.join(repo, "edge.png"), Buffer.alloc(MAX_ASSET_BYTES));
      expect(ok(readRepoAsset(repo, "edge.png")).data.byteLength).toBe(MAX_ASSET_BYTES);
    });
  });
});

function makeApp(): GitLibApp {
  const home = path.join(base, "home");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(path.join(base, "git", "beta", ".git"), { recursive: true });
  fs.writeFileSync(path.join(base, "git", "beta", "own.png"), PNG);
  fs.writeFileSync(path.join(home, "config.toml"), [`roots = ["${path.join(base, "git")}"]`, "", "[search]", "enabled = false", ""].join("\n"));
  const app = createApplication({ GITLIB_HOME: home }, undefined, null, null);
  app.refresh();
  return app;
}

const get = (query: Record<string, string>, init: RequestInit = {}) =>
  new Request(`http://localhost/api/repo-asset?${new URLSearchParams(query).toString()}`, init);

describe("GET /api/repo-asset", () => {
  it("serves a repository's image with headers that make it harmless to open directly", async () => {
    const response = await handleRepoAsset(get({ repo: "alpha", path: "icon.svg" }), makeApp());

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toMatch(/(^|; )sandbox($|;)/);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(response.headers.get("cross-origin-resource-policy")).toBe("same-origin");
    expect(response.headers.get("content-length")).toBe(String(fs.statSync(path.join(repo, "icon.svg")).size));
  });

  it("returns the file's bytes", async () => {
    const response = await handleRepoAsset(get({ repo: "alpha", path: "docs/img/shot.jpg" }), makeApp());
    expect(response.headers.get("content-type")).toBe("image/jpeg");
    expect(Buffer.from(await response.arrayBuffer()).equals(PNG)).toBe(true);
  });

  it("serves each repository from its own folder", async () => {
    const app = makeApp();
    expect((await handleRepoAsset(get({ repo: "beta", path: "own.png" }), app)).status).toBe(200);
    // alpha's logo is not in beta, and beta's image is not in alpha.
    expect((await handleRepoAsset(get({ repo: "beta", path: "logo.png" }), app)).status).toBe(404);
    expect((await handleRepoAsset(get({ repo: "alpha", path: "own.png" }), app)).status).toBe(404);
  });

  it("answers 404 for a repository gitlib does not know, even when the folder exists on disk", async () => {
    const app = makeApp();
    for (const unknown of ["nope", outside, repo, "../outside", "alpha/../../outside"]) {
      const response = await handleRepoAsset(get({ repo: unknown, path: "secret.png" }), app);
      expect(response.status, unknown).toBe(404);
    }
  });

  it("refuses traversal, symlink escapes and non-images through the route", async () => {
    fs.symlinkSync(path.join(outside, "secret.png"), path.join(repo, "escape.png"));
    const app = makeApp();
    const cases: [string, number][] = [
      ["../outside/secret.png", 400],
      ["docs/../../outside/secret.png", 400],
      ["escape.png", 404],
      ["notes.txt", 404],
      [".env", 404],
      [".git/hidden.png", 404],
    ];
    for (const [requested, status] of cases) {
      const response = await handleRepoAsset(get({ repo: "alpha", path: requested }), app);
      expect(response.status, requested).toBe(status);
      expect(response.headers.get("content-type")).toMatch(/^text\/plain/);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.text()).not.toContain("top secret");
    }
  });

  it("requires both repo and path", async () => {
    const app = makeApp();
    expect((await handleRepoAsset(get({ repo: "alpha" }), app)).status).toBe(400);
    expect((await handleRepoAsset(get({ path: "logo.png" }), app)).status).toBe(400);
    expect((await handleRepoAsset(get({ repo: "", path: "" }), app)).status).toBe(400);
  });

  it.each(["POST", "PUT", "DELETE", "PATCH"])("does not answer %s", async (method) => {
    const response = await handleRepoAsset(get({ repo: "alpha", path: "logo.png" }, { method }), makeApp());
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
  });
});
