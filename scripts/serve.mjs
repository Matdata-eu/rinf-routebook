#!/usr/bin/env node
// Routebook server: the built web app, the RINF data bundles, the runtime configuration
// (config.json) and a tile proxy for map layers whose keys must stay on the server.
// No dependencies besides Node.js, so it runs as is in the Docker image.
//
// Usage: node scripts/serve.mjs [dir=apps/web/dist] [port=4173]
// Environment: PORT, HOST (default 127.0.0.1; 0.0.0.0 in Docker), ROUTEBOOK_DATA_DIR (default ./data),
// ROUTEBOOK_BASEMAP_DIR (default <data>/basemap: a self-hosted basemap, served at basemap/),
// ROUTEBOOK_PLUGINS_DIR (default <data>/plugins: plugin modules for config `plugins`, served at plugins/),
// ROUTEBOOK_SYNC_MINUTES (> 0 runs `routebook sync` next to the server, keeping the data current),
// ROUTEBOOK_TILE_RATE (proxied tiles per minute per client, default 1200, 0 = no limit),
// ROUTEBOOK_TILE_CACHE_MB (memory for proxied tiles, default 64, 0 = none), ROUTEBOOK_TRUST_PROXY
// (1: take the client address from X-Forwarded-For, for a server behind a reverse proxy),
// and the configuration variables in scripts/runtime-config.mjs.
import { createHash } from "node:crypto";
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
 * The Content-Security-Policy of the app: scripts and workers from this server only (plus the
 * inline scripts of index.html, by hash, and WebAssembly for the schematic solver), map tiles,
 * fonts and glyphs from any https or http host (deployers add their own layers), no plugins,
 * no framing. `extra` adds hashes of inline scripts (see inlineScriptHashes).
 */
export function contentSecurityPolicy(extra = []) {
  return [
    "default-src 'self'",
    `script-src 'self' 'wasm-unsafe-eval'${extra.map((h) => ` '${h}'`).join("")}`,
    "worker-src 'self' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https: http:",
    "font-src 'self' data:",
    "connect-src 'self' https: http:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join("; ");
}

/** sha256 hashes of the inline <script> elements of an HTML page, for script-src. */
export function inlineScriptHashes(html) {
  const out = [];
  for (const m of html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi)) {
    if (!m[1].trim()) continue;
    out.push(`sha256-${createHash("sha256").update(m[1], "utf8").digest("base64")}`);
  }
  return out;
}

/** Pipe a file into a response; a file that vanished or cannot be read ends the response instead of the server. */
function sendFile(res, path, opts) {
  const stream = createReadStream(path, opts);
  stream.on("error", () => {
    if (!res.headersSent) res.writeHead(500, SECURITY);
    res.destroy();
  });
  return stream;
}

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
function serveBasemapFile(req, res, dir, rel, headersExtra = {}) {
  const path = findFile([dir], `/${rel}`);
  if (!path) return void res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
  const stat = statSync(path);
  const etag = etagOf(stat);
  const headers = { "Content-Type": TYPES[extname(path)] ?? "application/octet-stream", "Cache-Control": "public, max-age=86400", ETag: etag, "Accept-Ranges": "bytes", ...SECURITY, ...headersExtra };
  const range = byteRange(req.headers.range, stat.size);
  if (range === null) return void res.writeHead(416, { ...headers, "Content-Range": `bytes */${stat.size}` }).end();
  if (!range && req.headers["if-none-match"]?.split(",").some((t) => t.trim() === etag)) return void res.writeHead(304, headers).end();
  if (range) {
    res.writeHead(206, { ...headers, "Content-Range": `bytes ${range.start}-${range.end}/${stat.size}`, "Content-Length": range.end - range.start + 1 });
    if (req.method === "HEAD") return void res.end();
    return void sendFile(res, path, range).pipe(res);
  }
  res.writeHead(200, { ...headers, "Content-Length": stat.size });
  if (req.method === "HEAD") return void res.end();
  sendFile(res, path).pipe(res);
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

/** Resolve a URL path inside one of the roots; undefined when it is outside them, missing or not a valid URL path. */
function findFile(roots, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return undefined; // malformed percent-encoding: no such file
  }
  if (decoded.includes("\0")) return undefined;
  for (const root of roots) {
    let path = normalize(join(root, decoded));
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

/**
 * Requests per minute per client for proxied tiles: a token bucket that refills continuously, so a
 * map being panned is never slowed down while a script pulling the whole layer through the proxy
 * (and spending the deployer's key) is.
 */
export function createRateLimiter(perMinute, now = () => Date.now()) {
  const buckets = new Map();
  let sweep = now();
  return (client) => {
    if (!(perMinute > 0)) return true;
    const t = now();
    if (t - sweep > 600_000) {
      for (const [k, b] of buckets) if (t - b.at > 600_000) buckets.delete(k);
      sweep = t;
    }
    const b = buckets.get(client) ?? { tokens: perMinute, at: t };
    b.tokens = Math.min(perMinute, b.tokens + ((t - b.at) / 60_000) * perMinute);
    b.at = t;
    buckets.set(client, b);
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

/**
 * Proxied tiles kept in memory, least recently used out first, for as long as the provider's
 * Cache-Control allows (at most a day; nothing with no-store, no-cache or private, as for any
 * shared HTTP cache). Many users looking at the same area then cost the provider one request.
 */
export function createTileCache(maxBytes, now = () => Date.now()) {
  const entries = new Map();
  let bytes = 0;
  const drop = (key) => {
    const e = entries.get(key);
    if (!e) return;
    bytes -= e.body.length;
    entries.delete(key);
  };
  return {
    get(key) {
      const e = entries.get(key);
      if (!e) return undefined;
      if (e.expires <= now()) return void drop(key);
      entries.delete(key);
      entries.set(key, e);
      return e;
    },
    set(key, contentType, cacheControl, body) {
      if (!(maxBytes > 0) || body.length > maxBytes / 8) return;
      const cc = (cacheControl ?? "").toLowerCase();
      if (/no-store|no-cache|private/.test(cc)) return;
      const m = /(?:s-maxage|max-age)=(\d+)/.exec(cc);
      const seconds = Math.min(86_400, m ? Number(m[1]) : 3600);
      if (!(seconds > 0)) return;
      drop(key);
      entries.set(key, { contentType, cacheControl, body, expires: now() + seconds * 1000 });
      bytes += body.length;
      for (const k of entries.keys()) {
        if (bytes <= maxBytes) break;
        drop(k);
      }
    },
    get size() {
      return entries.size;
    },
  };
}

/** The client's address: the socket's, or with trustProxy the last X-Forwarded-For hop the reverse proxy added. */
function clientOf(req, trustProxy) {
  if (trustProxy) {
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((h) => h.trim()).filter(Boolean);
    if (hops.length) return hops.at(-1);
  }
  return req.socket?.remoteAddress ?? "?";
}

async function proxyTile(req, res, layer, t, ctx) {
  // the proxy serves this app's pages, not other sites' maps (browsers say where a request comes from)
  if (req.headers["sec-fetch-site"] === "cross-site") {
    res.writeHead(403, { "Content-Type": "text/plain", ...SECURITY }).end("Tiles of this server are for its own app");
    return;
  }
  if (!inBounds(layer, t.z, t.x, t.y)) {
    res.writeHead(204, SECURITY).end();
    return;
  }
  if (!ctx.allow(clientOf(req, ctx.trustProxy))) {
    res.writeHead(429, { "Content-Type": "text/plain", "Retry-After": "10", ...SECURITY }).end("Too many tile requests");
    return;
  }
  const key = `${layer.id}/${t.z}/${t.x}/${t.y}`;
  const hit = ctx.cache.get(key);
  if (hit) {
    res.writeHead(200, { "Content-Type": hit.contentType, "Cache-Control": hit.cacheControl ?? "public, max-age=86400", "Content-Length": hit.body.length, ...SECURITY });
    return void res.end(req.method === "HEAD" ? undefined : hit.body);
  }
  try {
    const upstream = await fetch(upstreamUrl(layer, t.z, t.x, t.y), {
      headers: { "User-Agent": "Routebook tile proxy (+https://github.com/Matdata-eu/rinf-routebook)", ...(layer.headers ?? {}) },
      signal: AbortSignal.timeout(20_000),
    });
    const contentType = upstream.headers.get("content-type") ?? "application/octet-stream";
    const cacheControl = upstream.headers.get("cache-control");
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": upstream.ok ? (cacheControl ?? "public, max-age=86400") : "no-cache",
      ...SECURITY,
    };
    if (!upstream.ok && upstream.status !== 404) warnOnce(layer, `upstream answered ${upstream.status} ${upstream.statusText}`);
    if (!upstream.ok || !upstream.body) {
      res.writeHead(upstream.ok ? 200 : upstream.status === 404 ? 404 : 502, headers);
      return void res.end();
    }
    const body = Buffer.from(await upstream.arrayBuffer());
    ctx.cache.set(key, contentType, cacheControl, body);
    res.writeHead(200, { ...headers, "Content-Length": body.length });
    res.end(req.method === "HEAD" ? undefined : body);
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
 * @param {{ dataDir?: string, basemapDir?: string, pluginsDir?: string, config?: object, tileRate?: number, tileCacheMb?: number, trustProxy?: boolean }} [opts] data folder with web/<dataset> bundles; self-hosted basemap folder; plugin modules folder; configuration (default: loadConfig()); tile proxy limits (default: the environment)
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
  const pluginsDir = resolve(opts.pluginsDir ?? process.env.ROUTEBOOK_PLUGINS_DIR ?? join(opts.dataDir ?? process.env.ROUTEBOOK_DATA_DIR ?? "data", "plugins"));
  const roots = [dataWeb, root];
  const config = opts.config ?? loadConfig();
  const browserConfig = publicConfig(config);
  const proxied = proxiedLayers(config);
  const sync = opts.sync;
  const env = opts.env ?? process.env;
  const num = (v, d) => (v === undefined || v === "" || !Number.isFinite(Number(v)) ? d : Number(v));
  const tiles = {
    allow: createRateLimiter(num(opts.tileRate ?? env.ROUTEBOOK_TILE_RATE, 1200)),
    cache: createTileCache(num(opts.tileCacheMb ?? env.ROUTEBOOK_TILE_CACHE_MB, 64) * 1048576),
    trustProxy: (opts.trustProxy ?? env.ROUTEBOOK_TRUST_PROXY) === true || ["1", "true", "yes"].includes(String(opts.trustProxy ?? env.ROUTEBOOK_TRUST_PROXY ?? "").toLowerCase()),
  };
  // the policy for HTML pages; config `contentSecurityPolicy`: false for none, a string for your own
  let csp;
  const cspFor = () => {
    if (config.contentSecurityPolicy === false) return {};
    if (typeof config.contentSecurityPolicy === "string" && config.contentSecurityPolicy.trim()) return { "Content-Security-Policy": config.contentSecurityPolicy.trim() };
    if (csp === undefined) {
      let html = "";
      try {
        html = readFileSync(join(root, "index.html"), "utf8");
      } catch {
        /* no build here (dev server, tests) */
      }
      csp = contentSecurityPolicy(inlineScriptHashes(html));
    }
    return { "Content-Security-Policy": csp };
  };

  const handle = (req, res, next) => {
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
      res.writeHead(200, { "Content-Type": TYPES[".html"], "Cache-Control": "no-cache", ...SECURITY, ...cspFor() });
      return void res.end(req.method === "HEAD" ? undefined : privacyPage(config.privacy, config.title));
    }
    const tile = p.includes("/tiles/") ? parseTilePath(p) : undefined;
    if (tile) {
      const layer = proxied.get(tile.id);
      if (layer) return void proxyTile(req, res, layer, tile, tiles);
      res.writeHead(404, SECURITY).end();
      return;
    }
    const bm = /\/basemap\/(.+)$/.exec(p);
    if (bm) return serveBasemapFile(req, res, basemapDir, bm[1]);
    // plugin modules (config `plugins`): from their own folder, so that a deployment adds them without rebuilding the app
    const plugin = /\/plugins\/(.+)$/.exec(p);
    if (next && !plugin) return next();

    const path = plugin ? findFile([pluginsDir], `/${plugin[1]}`) : findFile(roots, p);
    if (!path) {
      res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
      return;
    }
    const ext = extname(path);
    let stat;
    try {
      stat = statSync(path);
    } catch {
      // swapped out by the sync between the lookup and now
      res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
      return;
    }
    const etag = etagOf(stat);
    // Vite puts a content hash in asset names: those can be cached for good
    const immutable = /[\\/]assets[\\/]/.test(path) && path.startsWith(root);
    const headers = { "Content-Type": TYPES[ext] ?? "application/octet-stream", "Cache-Control": immutable ? "public, max-age=31536000, immutable" : "no-cache", ETag: etag, ...SECURITY, ...(ext === ".html" ? cspFor() : {}) };
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
      let size;
      try {
        size = statSync(ready.path).size;
      } catch {
        res.writeHead(404, { "Content-Type": "text/plain", ...SECURITY }).end("Not found");
        return;
      }
      res.writeHead(200, { ...headers, "Content-Encoding": ready.encoding, "Content-Length": size });
      if (req.method === "HEAD") return void res.end();
      sendFile(res, ready.path).pipe(res);
    } else if (COMPRESS.has(ext) && /\bgzip\b/.test(acceptEncoding)) {
      res.writeHead(200, { ...headers, "Content-Encoding": "gzip", Vary: "Accept-Encoding" });
      if (req.method === "HEAD") return void res.end();
      sendFile(res, path).pipe(createGzip()).pipe(res);
    } else {
      res.writeHead(200, headers);
      if (req.method === "HEAD") return void res.end();
      sendFile(res, path).pipe(res);
    }
  };

  // one bad request must never stop the server (and the sync running next to it)
  return (req, res, next) => {
    try {
      handle(req, res, next);
    } catch (e) {
      if (!(e instanceof URIError)) console.error(`Request ${req.method} ${req.url} failed: ${e?.stack ?? e}`);
      if (!res.headersSent) res.writeHead(e instanceof URIError ? 400 : 500, { "Content-Type": "text/plain", ...SECURITY });
      res.end(e instanceof URIError ? "Bad request" : "Server error");
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
