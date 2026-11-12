import fs from "node:fs";
import path from "node:path";
import type { GitLibApp } from "@gitlib/core";
import { getApp } from "./gitlib.server";

/** Image types a README may show from disk. The type comes from the file's extension, never from its contents. */
export const ASSET_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
};

/** Large enough for a screenshot or an animated demo; keeps a stray multi-gigabyte "image" out of memory. */
export const MAX_ASSET_BYTES = 10 * 1024 * 1024;

const MAX_PATH_CHARS = 1024;

export type AssetResult =
  | { ok: true; data: Buffer; contentType: string }
  | { ok: false; status: 400 | 404 | 413; message: string };

const notFound: AssetResult = { ok: false, status: 404, message: "No such image in this repository." };

/**
 * The bytes of one image file inside `repoRoot`, or why not. `requested` is the path a README wrote, relative to the
 * repository's root. Nothing outside the repository is ever read, whatever it says: `..` is refused outright, the
 * file's real location (symlinks resolved) has to be inside the real repository, `.git` is off limits, and only
 * image extensions are served. Every reason to refuse the path itself answers 404 so the route can't be used to
 * probe for files that exist elsewhere.
 */
export function readRepoAsset(repoRoot: string, requested: string): AssetResult {
  if (!requested || requested.length > MAX_PATH_CHARS || requested.includes("\0") || requested.includes("\\")) {
    return { ok: false, status: 400, message: "Invalid image path." };
  }
  const segments = requested.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return { ok: false, status: 400, message: "Invalid image path." };
  if (segments.some(isGitDirectory)) return notFound;

  let root: string;
  let real: string;
  try {
    root = fs.realpathSync(repoRoot);
    real = fs.realpathSync(path.join(root, ...segments));
  } catch {
    return notFound;
  }

  const relative = path.relative(root, real);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return notFound;
  // A symlink inside the repo can still lead into .git or to a non-image, so judge where it really points.
  if (relative.split(path.sep).some(isGitDirectory)) return notFound;
  const contentType = ASSET_TYPES[path.extname(real).toLowerCase()];
  if (!contentType) return notFound;

  try {
    const stat = fs.statSync(real);
    if (!stat.isFile()) return notFound;
    if (stat.size > MAX_ASSET_BYTES) return { ok: false, status: 413, message: "That image is too large to show." };
    return { ok: true, data: fs.readFileSync(real), contentType };
  } catch {
    return notFound;
  }
}

// Case-insensitive: on a case-insensitive file system `.GIT` is the same directory.
const isGitDirectory = (segment: string): boolean => segment.toLowerCase() === ".git";

function failure(status: number, message: string, extra: HeadersInit = {}): Response {
  return new Response(message, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff", ...extra },
  });
}

/**
 * GET /api/repo-asset?repo=<relativePath>&path=<path inside the repo>: an image from a repository gitlib already
 * knows, for a README's relative `![](docs/logo.png)`.
 *
 * The response is treated as hostile content even though it is an image. SVG can carry script, which is inert inside an
 * `<img>` but would run in this app's origin if someone navigated straight to the URL, so every reply carries a
 * `sandbox` content-security-policy (scripts disabled, unique origin) and `nosniff`; `same-origin` keeps other sites
 * from embedding it.
 */
export async function handleRepoAsset(request: Request, app: GitLibApp = getApp()): Promise<Response> {
  if (request.method !== "GET") return failure(405, "Method not allowed.", { allow: "GET" });

  const params = new URL(request.url).searchParams;
  const repoParam = params.get("repo");
  const pathParam = params.get("path");
  if (!repoParam || !pathParam) return failure(400, "Both repo and path are required.");

  let repoRoot: string;
  try {
    repoRoot = app.getRepository(repoParam).absolutePath;
  } catch {
    return failure(404, "Gitlib doesn't know that repository.");
  }

  const asset = readRepoAsset(repoRoot, pathParam);
  if (!asset.ok) return failure(asset.status, asset.message);

  return new Response(new Uint8Array(asset.data), {
    status: 200,
    headers: {
      "content-type": asset.contentType,
      "content-length": String(asset.data.byteLength),
      "cache-control": "private, max-age=60",
      "x-content-type-options": "nosniff",
      "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; sandbox",
      "cross-origin-resource-policy": "same-origin",
    },
  });
}
