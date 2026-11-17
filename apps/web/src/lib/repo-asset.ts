/** Where the web app serves image files from inside a local repository (see `server/repo-asset.server.ts`). */
export const REPO_ASSET_ROUTE = "/api/repo-asset";

/**
 * The URL for an image a README names with a relative path (`docs/logo.png`, `./logo.png`, `/logo.png`), or null
 * when `src` isn't a path inside the repository: a scheme (`https:`, `data:`, `javascript:`), a protocol-relative
 * `//host/x.png`, or anything that climbs out with `..`. The server checks again; this only avoids pointless requests
 * and keeps a hostile README from building a URL that points anywhere but at the one route.
 */
export function repoAssetUrl(relativePath: string, src: string): string | null {
  const trimmed = src.trim();
  if (!trimmed || trimmed.startsWith("//") || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return null;

  let path = trimmed.replace(/[?#].*$/, "");
  try {
    // Markdown writes a space as %20; decode once, so %252e stays a literal "%2e" filename instead of becoming "..".
    path = decodeURI(path);
  } catch {
    return null;
  }

  const segments = path.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (segments.length === 0 || segments.includes("..")) return null;

  const query = new URLSearchParams({ repo: relativePath, path: segments.join("/") });
  return `${REPO_ASSET_ROUTE}?${query.toString()}`;
}
