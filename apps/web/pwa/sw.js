/* RouteBook service worker: the app works offline with the routes and data it has seen.
 *
 * - The app shell (index.html and the hashed assets of this build) is cached when the worker installs.
 * - RINF data (config.json, datasets.json, the network index, the dataset bundles) goes to the network
 *   first, so it is always current online, and comes from the cache offline. The bundles of the
 *   datasets used most recently are kept (MAX_DATA_DATASETS), the rest are dropped.
 * - The self-hosted basemap (basemap/: a PMTiles file read with range requests, its fonts) and the
 *   server's proxied tiles (tiles/) are kept as they are fetched, so a map seen once is there offline.
 * - Tiles of third-party services (OpenStreetMap, OpenRailwayMap, ...) are left alone: their terms
 *   decide how they are cached, so the map background is blank offline unless it is self-hosted.
 *
 * The build (vite.config.ts) puts the version and the list of shell files in place of the markers below.
 */
const VERSION = "__VERSION__";
const PRECACHE = __PRECACHE__;
const SHELL = `rb-shell-${VERSION}`;
const ASSETS = "rb-assets";
const DATA = "rb-data";
const MAP = "rb-map";
const FONTS = "rb-fonts";
/** at most this many map tiles and ranges are kept; the oldest go first */
const MAX_MAP_ENTRIES = 4000;
/** the bundles of at most this many datasets are kept (3 to 12 MB each); those used longest ago go first */
const MAX_DATA_DATASETS = 8;
/** folders of the data cache that are not a dataset's bundle */
const NOT_DATASETS = new Set(["index", "plugins", "pwa"]);
/** glyph hosts for map labels: their fonts never change */
const FONT_HOSTS = ["protomaps.github.io", "demotiles.maplibre.org"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(SHELL);
      await cache.addAll(PRECACHE);
      await self.skipWaiting();
    })(),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const key of await caches.keys()) if (key.startsWith("rb-shell-") && key !== SHELL) await caches.delete(key);
      // hashed assets of older builds that this one does not use
      const assets = await caches.open(ASSETS);
      const keep = new Set(PRECACHE.map((p) => new URL(p, self.registration.scope).href));
      for (const req of await assets.keys()) if (!keep.has(req.url)) await assets.delete(req);
      await self.clients.claim();
    })(),
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) {
    if (FONT_HOSTS.includes(url.hostname)) event.respondWith(cacheFirst(req, FONTS));
    return;
  }
  const scope = new URL(self.registration.scope);
  const path = url.pathname.startsWith(scope.pathname) ? url.pathname.slice(scope.pathname.length) : url.pathname;
  if (path === "sw.js" || path.endsWith("/healthz") || path.endsWith("healthz")) return;
  if (path.startsWith("basemap/") && req.headers.has("range")) return event.respondWith(rangeRequest(req));
  if (path.startsWith("assets/")) return event.respondWith(cacheFirst(req, ASSETS, SHELL));
  if (path.startsWith("basemap/") || path.startsWith("tiles/")) return event.respondWith(cacheFirst(req, MAP));
  if (req.mode === "navigate") return event.respondWith(navigation(req));
  event.respondWith(networkFirst(req, DATA));
});

async function cacheFirst(req, name, also) {
  const hit = (also && (await (await caches.open(also)).match(req))) || (await (await caches.open(name)).match(req));
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) await put(name, req, res.clone());
  return res;
}

async function networkFirst(req, name) {
  try {
    const res = await fetch(req);
    if (res.ok) await put(name, req, res.clone());
    return res;
  } catch (e) {
    const hit = await (await caches.open(name)).match(req, { ignoreSearch: false });
    if (hit) return hit;
    throw e;
  }
}

/** The page: online the server's, offline the cached shell (any query string: the route is in it). */
async function navigation(req) {
  try {
    const res = await fetch(req);
    if (res.ok) await put(SHELL, new URL("./", self.registration.scope).href, res.clone());
    return res;
  } catch (e) {
    const shell = await caches.open(SHELL);
    const hit = (await shell.match(new URL("./", self.registration.scope).href)) || (await shell.match(new URL("index.html", self.registration.scope).href));
    if (hit) return hit;
    throw e;
  }
}

/**
 * A byte range of a PMTiles file. The Cache API does not keep partial responses, so each range is
 * kept as a whole response under its own key and given back as a 206 again. The PMTiles reader
 * asks for the same ranges for the same tiles, so a map seen once can be drawn offline.
 */
async function rangeRequest(req) {
  const range = req.headers.get("range");
  const key = `${req.url}${req.url.includes("?") ? "&" : "?"}__range=${encodeURIComponent(range)}`;
  const cache = await caches.open(MAP);
  const hit = await cache.match(key);
  if (hit) {
    const headers = new Headers(hit.headers);
    return new Response(hit.body, { status: 206, statusText: "Partial Content", headers });
  }
  const res = await fetch(req);
  if (res.status === 206) {
    const body = await res.clone().arrayBuffer();
    await put(MAP, key, new Response(body, { status: 200, headers: res.headers }));
  }
  return res;
}

/** The dataset folder of a data URL (`<scope>/<id>/<part>.json`), or undefined for anything else. */
function datasetOf(url) {
  const scope = new URL(self.registration.scope).pathname;
  const path = new URL(url).pathname;
  const rest = path.startsWith(scope) ? path.slice(scope.length) : path;
  const m = /^([^/]+)\/[^/]+$/.exec(rest);
  return m && !NOT_DATASETS.has(m[1]) ? m[1] : undefined;
}

/** Drop the bundles of the datasets used longest ago, keeping MAX_DATA_DATASETS (cache keys are in the order they were written). */
async function trimData(cache) {
  const keys = await cache.keys();
  const lastUse = new Map();
  keys.forEach((req, i) => {
    const id = datasetOf(req.url);
    if (id) lastUse.set(id, i);
  });
  if (lastUse.size <= MAX_DATA_DATASETS) return;
  const drop = new Set([...lastUse.entries()].sort((a, b) => a[1] - b[1]).slice(0, lastUse.size - MAX_DATA_DATASETS).map(([id]) => id));
  for (const req of keys) if (drop.has(datasetOf(req.url))) await cache.delete(req);
}

const puts = new Map();
async function put(name, key, res) {
  const cache = await caches.open(name);
  // a data entry is deleted first so that it moves to the end of the key order: the order tells which were used last
  if (name === DATA) await cache.delete(key);
  await cache.put(key, res);
  if (name === DATA) {
    if (typeof key !== "string" && key.url.endsWith("/meta.json")) await trimData(cache);
    return;
  }
  if (name !== MAP) return;
  // trim now and then, not on every tile
  const n = (puts.get(name) ?? 0) + 1;
  puts.set(name, n);
  if (n % 200 !== 0) return;
  const keys = await cache.keys();
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_MAP_ENTRIES))) await cache.delete(old);
}
