#!/usr/bin/env node
// Routebook server: the built web app, the RINF data bundles, the runtime configuration
// (config.json) and a tile proxy for map layers whose keys must stay on the server.
// No dependencies besides Node.js, so it runs as is in the Docker image.
//
// Usage: node scripts/serve.mjs [dir=apps/web/dist] [port=4173]
// Environment: PORT, HOST (default 127.0.0.1; 0.0.0.0 in Docker), ROUTEBOOK_DATA_DIR (default ./data),
// and the configuration variables in scripts/runtime-config.mjs.
import { createServer } from "node:http";
import { createReadStream, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { Readable } from "node:stream";
import { createGzip } from "node:zlib";
import { fileURLToPath } from "node:url";
import { inBounds, loadConfig, parseTilePath, privacyPage, proxiedLayers, publicConfig, upstreamUrl } from "./runtime-config.mjs";

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".map": "application/json",
};
const COMPRESS = new Set([".html", ".js", ".mjs", ".css", ".json", ".svg", ".map", ".wasm"]);
const SECURITY = { "X-Content-Type-Options": "nosniff", "Referrer-Policy": "strict-origin-when-cross-origin" };

/**
 * datasets.json: the catalogue the CLI wrote (`routebook fetch` / `index`: status, what ERA
 * published, when the endpoint was last checked) in the first folder that has one, plus any
 * bundle found in the folders that it does not list (first folder wins per id).
 */
export function listDatasets(dirs) {
  const byId = new Map();
  let catalogue = {};
  for (const dir of dirs) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, "datasets.json"), "utf8"));
      const list = Array.isArray(raw) ? raw : Array.isArray(raw?.datasets) ? raw.datasets : [];
      if (!Array.isArray(raw) && raw && typeof raw === "object" && !catalogue.checkedAt) catalogue = { ...(raw.checkedAt ? { checkedAt: raw.checkedAt } : {}), ...(raw.endpoint ? { endpoint: raw.endpoint } : {}) };
      for (const d of list) if (d && typeof d.id === "string" && !byId.has(d.id)) byId.set(d.id, { ...d, name: d.name || d.id, status: d.status ?? "loaded" });
    } catch {
      /* no catalogue here */
    }
  }
  for (const dir of dirs) {
    let entries = [];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const d of entries) {
      if (!d.isDirectory() || byId.has(d.name)) continue;
      try {
        const meta = JSON.parse(readFileSync(join(dir, d.name, "meta.json"), "utf8"));
        const publishedAt = (meta.provenance ?? []).map((g) => g.publishedAt).filter(Boolean).sort().at(-1);
        byId.set(d.name, {
          id: d.name,
          name: meta.name ?? meta.country ?? d.name,
          ...(meta.imName ? { imName: meta.imName } : {}),
          fetchedAt: meta.fetchedAt,
          ops: meta.counts?.ops ?? 0,
          status: "loaded",
          ...(meta.checkedAt ? { checkedAt: meta.checkedAt } : {}),
          ...(publishedAt ? { publishedAt } : {}),
          ...(meta.provenance ? { graphs: meta.provenance } : {}),
          ...(meta.counts ? { counts: meta.counts } : {}),
          ...(meta.endpoint ? { endpoint: meta.endpoint } : {}),
        });
      } catch {
        /* not a bundle */
      }
    }
  }
  const datasets = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  return { version: 2, ...catalogue, datasets };
}

/** The dataset entries alone (the bundles the app can load). */
export function datasetEntries(dirs) {
  return listDatasets(dirs).datasets;
}

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-cache", ...SECURITY }).end(JSON.stringify(body));
}

/** Resolve a URL path inside one of the roots; undefined when it is outside them or missing. */
function findFile(roots, pathname) {
  for (const root of roots) {
    let path = normalize(join(root, decodeURIComponent(pathname)));
    if (!path.startsWith(root + sep) && path !== root) return undefined;
    try {
      if (statSync(path).isDirectory()) path = join(path, "index.html");
      if (statSync(path).isFile()) return path;
    } catch {
      /* try the next root */
    }
  }
  return undefined;
}

/** Tell the operator once per layer and problem when the upstream tile service fails (wrong key, blocked host, ...). */
const warned = new Set();
function warnOnce(layer, problem) {
  const key = `${layer.id} ${problem}`;
  if (warned.has(key)) return;
  warned.add(key);
  console.warn(`Tile proxy "${layer.id}": ${problem}`);
}

async function proxyTile(req, res, layer, t) {
  if (!inBounds(layer, t.z, t.x, t.y)) {
    res.writeHead(204, SECURITY).end();
    return;
  }
  try {
    const upstream = await fetch(upstreamUrl(layer, t.z, t.x, t.y), {
      headers: { "User-Agent": "Routebook tile proxy (+https://github.com/Matdata-eu/rinf-routebook)", ...(layer.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const headers = {
      "Content-Type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "Cache-Control": upstream.ok ? (upstream.headers.get("cache-control") ?? "public, max-age=86400") : "no-cache",
      ...SECURITY,
    };
    if (!upstream.ok && upstream.status !== 404) warnOnce(layer, `upstream answered ${upstream.status} ${upstream.statusText}`);
    res.writeHead(upstream.ok ? 200 : upstream.status === 404 ? 404 : 502, headers);
    if (upstream.body && req.method !== "HEAD") Readable.fromWeb(upstream.body).pipe(res);
    else res.end();
  } catch (e) {
    warnOnce(layer, `cannot reach the tile service (${e?.cause?.message ?? e?.message ?? e})`);
    if (!res.headersSent) res.writeHead(502, SECURITY);
    res.end();
  }
}

/**
 * @param {string} dir built web app (apps/web/dist)
 * @param {number} [port]
 * @param {string} [host]
 * @param {{ dataDir?: string, config?: object }} [opts] data folder with web/<dataset> bundles; configuration (default: loadConfig())
 */
export function startServer(dir, port = 4173, host = "127.0.0.1", opts = {}) {
  const handler = createHandler(dir, opts);
  const server = createServer(handler);
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

/** The request handler, also used as middleware by the Vite dev server (`next` for anything it doesn't serve). */
export function createHandler(dir, opts = {}) {
  const root = resolve(dir);
  const dataWeb = resolve(opts.dataDir ?? process.env.ROUTEBOOK_DATA_DIR ?? "data", "web");
  const roots = [dataWeb, root];
  const config = opts.config ?? loadConfig();
  const browserConfig = publicConfig(config);
  const proxied = proxiedLayers(config);

  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://x");
    // the app can be served under a sub-path: match on the end of the path
    const p = url.pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, SECURITY).end();
      return;
    }
    if (p.endsWith("/healthz")) return json(res, { ok: true });
    if (p.endsWith("/config.json")) return json(res, browserConfig);
    if (p.endsWith("/datasets.json")) return json(res, listDatasets(roots));
    if (p.endsWith("/privacy.html") && config.privacy?.html) {
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", ...SECURITY });
      return void res.end(req.method === "HEAD" ? undefined : privacyPage(config.privacy, config.title));
    }
    const tile = p.includes("/tiles/") ? parseTilePath(p) : undefined;
    if (tile) {
      const layer = proxied.get(tile.id);
      if (layer) return void proxyTile(req, res, layer, tile);
      res.writeHead(404, SECURITY).end();
      return;
    }
    if (next) return next();

    const path = findFile(roots, p);
    if (!path) {
      res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
      return;
    }
    const ext = extname(path);
    // Vite puts a content hash in asset names: those can be cached for good
    const immutable = /[\\/]assets[\\/]/.test(path) && path.startsWith(root);
    const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ...SECURITY };
    if (COMPRESS.has(ext) && /\bgzip\b/.test(req.headers["accept-encoding"] ?? "")) {
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      if (req.method === "HEAD") return void res.end();
      createReadStream(path).pipe(createGzip()).pipe(res);
    } else {
      res.writeHead(200, headers);
      if (req.method === "HEAD") return void res.end();
      createReadStream(path).pipe(res);
    }
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] ?? "apps/web/dist";
  const port = Number(process.argv[3] ?? process.env.PORT ?? 4173);
  const host = process.env.HOST ?? "127.0.0.1";
  await startServer(dir, port, host);
  console.log(`Routebook: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/  (serving ${resolve(dir)}, Ctrl+C to stop)`);
}
