// Minimal production server for the built TanStack Start app (`npm run build -w @gitlib/web`).
// The build emits a fetch handler (dist/server/server.js) but no HTTP listener, so this bridges
// node:http to it and serves the static client assets from dist/client.
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const clientDir = path.join(root, "dist", "client");
const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? "0.0.0.0";

const { default: app } = await import(pathToFileURL(path.join(root, "dist", "server", "server.js")).href);

const MIME = {
  ".js": "text/javascript",
  ".css": "text/css",
  ".html": "text/html",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain",
};

function serveStatic(req, res) {
  if (req.method !== "GET" && req.method !== "HEAD") return false;
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  const file = path.join(clientDir, pathname);
  if (!file.startsWith(clientDir + path.sep)) return false;
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    return false;
  }
  if (!stat.isFile()) return false;
  res.writeHead(200, {
    "content-type": MIME[path.extname(file)] ?? "application/octet-stream",
    "content-length": stat.size,
    // Vite fingerprints everything under /assets/, so it is safe to cache forever.
    ...(pathname.startsWith("/assets/") && { "cache-control": "public, max-age=31536000, immutable" }),
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  try {
    if (serveStatic(req, res)) return;

    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);
    const hasBody = req.method !== "GET" && req.method !== "HEAD";
    const response = await app.fetch(
      new Request(url, {
        method: req.method,
        headers: req.headers,
        body: hasBody ? Readable.toWeb(req) : undefined,
        duplex: "half",
      }),
    );

    const headers = {};
    for (const [key, value] of response.headers) if (key !== "set-cookie") headers[key] = value;
    const cookies = response.headers.getSetCookie();
    if (cookies.length > 0) headers["set-cookie"] = cookies;
    res.writeHead(response.status, headers);
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (error) {
    console.error(error);
    if (!res.headersSent) res.writeHead(500, { "content-type": "text/plain" });
    res.end("Internal Server Error");
  }
});

server.listen(port, host, () => console.log(`gitlib web listening on http://${host}:${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => server.close(() => process.exit(0)));
