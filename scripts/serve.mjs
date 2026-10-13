#!/usr/bin/env node
// Minimal static file server with gzip, used by `pnpm demo` and the screenshot script.
// Usage: node scripts/serve.mjs [dir=apps/web/dist] [port=4173]
import { createServer } from "node:http";
import { createReadStream, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".map": "application/json",
};
const COMPRESS = new Set([".html", ".js", ".css", ".json", ".svg", ".map"]);

export function startServer(dir, port = 4173, host = "127.0.0.1") {
  const root = resolve(dir);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x");
    let path = normalize(join(root, decodeURIComponent(url.pathname)));
    if (!path.startsWith(root + sep) && path !== root) {
      res.writeHead(403).end();
      return;
    }
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      statSync(path);
    } catch {
      res.writeHead(404, { "Content-Type": "text/plain" }).end("Not found");
      return;
    }
    const ext = extname(path);
    const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": "no-cache" };
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      createReadStream(path).pipe(createGzip()).pipe(res);
    } else {
      res.writeHead(200, headers);
      createReadStream(path).pipe(res);
    }
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "apps/web/dist";
  const port = Number(process.argv[3] ?? 4173);
  await startServer(dir, port);
  console.log(`Routebook demo: http://127.0.0.1:${port}/  (serving ${resolve(dir)}, Ctrl+C to stop)`);
}
