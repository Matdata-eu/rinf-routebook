#!/usr/bin/env node
// Routebook server: the built web app, the RINF data bundles, the runtime configuration
// (config.json) and a tile proxy for map layers whose keys must stay on the server.
// No dependencies besides Node.js, so it runs as is in the Docker image.
//
// Usage: node scripts/serve.mjs [dir=apps/web/dist] [port=4173]
// Environment: PORT, HOST (default 127.0.0.1; 0.0.0.0 in Docker), ROUTEBOOK_DATA_DIR (default ./data),
// ROUTEBOOK_BASEMAP_DIR (default <data>/basemap: a self-hosted basemap, served at basemap/),
// ROUTEBOOK_SYNC_MINUTES (> 0 runs `routebook sync` next to the server, keeping the data current),
// and the configuration variables in scripts/runtime-config.mjs.
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { createReadStream, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, extname, join, normalize, resolve, sep } from "node:path";
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
  ".webmanifest": "application/manifest+json",
  ".pmtiles": "application/vnd.pmtiles",
  ".pbf": "application/x-protobuf",
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
/** What `GET /healthz` answers: the catalogue's state, for monitoring; `ok` is whether the server runs. */
export function health(dirs, sync) {
  const { checkedAt, datasets } = listDatasets(dirs);
  const count = (status) => datasets.filter((d) => (d.status ?? "loaded") === status).length;
  return {
    ok: true,
    ...(checkedAt ? { checkedAt } : {}),
    datasets: datasets.length,
    loaded: datasets.filter((d) => d.fetchedAt && d.status !== "removed").length,
    failed: count("failed"),
    stale: count("stale"),
    pending: count("pending"),
    removed: count("removed"),
    ...(sync ? { sync: sync.state() } : {}),
  };
}

export function datasetEntries(dirs) {
  return listDatasets(dirs).datasets;
}

function json(res, body, status = 200) {
  res.writeHead(status, { "Content-Type": TYPES[".json"], "Cache-Control": "no-cache", ...SECURITY }).end(JSON.stringify(body));
}

/**
 * A file of the self-hosted basemap (`<basemap dir>/<path>`): a PMTiles file, read by the browser
 * with range requests, and its fonts. Cacheable for a day; a new extract should get a new name.
 */
function serveBasemapFile(req, res, dir, rel) {
  const path = findFile([dir], `/${rel}`);
  if (!path) return void res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
  const stat = statSync(path);
  const etag = etagOf(stat);
  const headers = { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "public, max-age=86400", ETag: etag, "Accept-Ranges": "bytes", ...SECURITY };
  const range = byteRange(req.headers.range, stat.size);
  if (range === null) return void res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
  if (!range && req.headers["if-none-match"]?.split(",").some((t) => t.trim() === etag)) return void res.writeHead(304, headers).end();
  if (range) {
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`, "Content-Length": range.end - range.start + 1 });
    if (req.method === "HEAD") return void res.end();
    return void createReadStream(path, range).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return void res.end();
  createReadStream(path).pipe(res);
}

/** One `Range: bytes=a-b` (or `a-`, `-n`) of a file of `size` bytes: undefined for none, null when it cannot be satisfied. */
export function byteRange(header, size) {
  if (!header) return undefined;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m || (m[1] === "" && m[2] === "")) return undefined; // several ranges or junk: send the whole file
  let start, end;
  if (m[1] === "") {
    start = Math.max(0, size - Number(m[2]));
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === "" ? size - 1 : Math.min(size - 1, Number(m[2]));
  }
  if (start > end || start >= size) return null;
  return { start, end };
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
 * @param {{ dataDir?: string, basemapDir?: string, config?: object }} [opts] data folder with web/<dataset> bundles; self-hosted basemap folder; configuration (default: loadConfig())
 */
export function startServer(dir, port = 4173, host = "127.0.0.1", opts = {}) {
  const handler = createHandler(dir, opts);
  const server = createServer(handler);
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

/**
 * Run `routebook sync` as a child process for as long as the server runs: it keeps the data in
 * the data folder current (see docs/datasets.md). Restarted a minute after it exits, stopped with
 * the server. `minutes` <= 0 runs nothing.
 * @param {{ minutes?: number, cli?: string, log?: (message: string) => void, env?: NodeJS.ProcessEnv }} [opts]
 */
export function startSync({ minutes = 0, cli = defaultCli(), log = console.error, env = process.env } = {}) {
  const state = { running: false, restarts: 0 };
  if (!(minutes > 0)) return { state: () => ({ enabled: false }), stop() {} };
  if (!cli || !existsSync(cli)) {
    log(`Sync: the CLI was not found at ${cli ?? "(unset)"}; set ROUTEBOOK_SYNC_CLI or build apps/cli. The data is not kept current.`);
    return { state: () => ({ enabled: true, running: false, error: "CLI not found" }), stop() {} };
  }
  let child;
  let stopped = false;
  let timer;
  const start = () => {
    if (stopped) return;
    child = spawn(process.execPath, [...process.execArgv, cli, "sync", "--minutes", String(minutes)], { stdio: "inherit", env });
    state.running = true;
    state.startedAt = new Date().toISOString();
    delete state.exitCode;
    child.on("exit", (code, signal) => {
      state.running = false;
      state.exitCode = code ?? signal;
      state.exitedAt = new Date().toISOString();
      if (stopped) return;
      state.restarts++;
      log(`Sync exited (${code ?? signal}); starting it again in 60 s`);
      timer = setTimeout(start, 60_000);
      timer.unref?.();
    });
  };
  start();
  const stop = () => {
    stopped = true;
    clearTimeout(timer);
    child?.kill("SIGTERM");
  };
  return { state: () => ({ enabled: true, minutes, ...state }), stop };
}

/** apps/cli/dist/index.js next to this script's repository, as laid out in the image and the checkout. */
function defaultCli() {
  if (process.env.ROUTEBOOK_SYNC_CLI) return resolve(process.env.ROUTEBOOK_SYNC_CLI);
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "apps", "cli", "dist", "index.js");
}

/** A weak validator from the file's size and modification time, enough for If-None-Match. */
function etagOf(stat) {
  return `W/"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * `<file>.br` or `<file>.gz` written by `routebook fetch` (saveWebBundle), when the client accepts
 * it and it is not older than the file itself (a bundle written without them leaves stale ones behind).
 */
function precompressed(path, stat, acceptEncoding) {
  for (const [ext, encoding] of [[".br", "br"], [".gz", "gzip"]]) {
    if (!new RegExp(`\\b${encoding}\\b`).test(acceptEncoding)) continue;
    try {
      const cs = statSync(`${path}${ext}`);
      if (cs.isFile() && cs.mtimeMs >= stat.mtimeMs) return { path: `${path}${ext}`, encoding };
    } catch {
      /* not there */
    }
  }
  return undefined;
}

/** The request handler, also used as middleware by the Vite dev server (`next` for anything it doesn't serve). */
export function createHandler(dir, opts = {}) {
  const root = resolve(dir);
  const dataWeb = resolve(opts.dataDir ?? process.env.ROUTEBOOK_DATA_DIR ?? "data", "web");
  const basemapDir = resolve(opts.basemapDir ?? process.env.ROUTEBOOK_BASEMAP_DIR ?? join(opts.dataDir ?? process.env.ROUTEBOOK_DATA_DIR ?? "data", "basemap"));
  const roots = [dataWeb, root];
  const config = opts.config ?? loadConfig();
  const browserConfig = publicConfig(config);
  const proxied = proxiedLayers(config);
  const sync = opts.sync;

  return (req, res, next) => {
    const url = new URL(req.url ?? "/", "http://x");
    // the app can be served under a sub-path: match on the end of the path
    const p = url.pathname;
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.writeHead(405, SECURITY).end();
      return;
    }
    if (p.endsWith("/healthz")) return json(res, health(roots, sync));
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
    const bm = /\/basemap\/(.+)$/.exec(p);
    if (bm) return serveBasemapFile(req, res, basemapDir, bm[1]);
    if (next) return next();

    const path = findFile(roots, p);
    if (!path) {
      res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
      return;
    }
    const ext = extname(path);
    const stat = statSync(path);
    const etag = etagOf(stat);
    // Vite puts a content hash in asset names: those can be cached for good
    const immutable = /[\\/]assets[\\/]/.test(path) && path.startsWith(root);
    const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ETag: etag, ...SECURITY };
    const acceptEncoding = req.headers["accept-encoding"] ?? "";
    const ready = COMPRESS.has(ext) ? precompressed(path, stat, acceptEncoding) : undefined;
    if (ready) headers.Vary = "Accept-Encoding";
    const ifNoneMatch = req.headers["if-none-match"];
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === etag)) {
      res.writeHead(304, headers).end();
      return;
    }
    if (ready) {
      // the bundle was precompressed when it was written: send it as it is
      res.writeHead(200, { ...headers, "Content-Encoding": ready.encoding, "Content-Length": statSync(ready.path).size });
      if (req.method === "HEAD") return void res.end();
      createReadStream(ready.path).pipe(res);
    } else if (COMPRESS.has(ext) && /\bgzip\b/.test(acceptEncoding)) {
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
  const minutes = Number(process.env.ROUTEBOOK_SYNC_MINUTES ?? 0);
  const sync = startSync({ minutes });
  const server = await startServer(dir, port, host, { sync });
  console.log(`Routebook: http://${host === "0.0.0.0" ? "localhost" : host}:${port}/  (serving ${resolve(dir)}${minutes > 0 ? `, syncing the RINF data every ${minutes} min` : ""}, Ctrl+C to stop)`);
  const shutdown = () => {
    sync.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 5000).unref();
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
