// Runtime configuration of a Routebook deployment: map layers, default dataset, title.
// Read by the server (scripts/serve.mjs) at start-up, never baked into the build, so one
// Docker image serves any deployment. See docs/deployment.md.
//
// Sources, merged in this order:
//   1. the file in ROUTEBOOK_CONFIG_FILE (default: config.json in the working directory, if present)
//   2. ROUTEBOOK_CONFIG: the same JSON in an environment variable (its keys replace the file's)
//   3. shorthands: ROUTEBOOK_TITLE, ROUTEBOOK_DEFAULT_DATASET, ROUTEBOOK_DEFAULT_BASEMAP, ESRI_API_KEY,
//      ROUTEBOOK_BASEMAP_PMTILES, ROUTEBOOK_PRIVACY_URL, ROUTEBOOK_PRIVACY_FILE
//
// Strings may contain ${VAR} or ${VAR:-default}: they are replaced by environment variables,
// so keys can stay out of the config file. A layer with "proxy": true is fetched by the server,
// with its headers and keys; the browser only sees tiles/<id>/{z}/{x}/{y}.
import { readFileSync, existsSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

/** Replace ${VAR} and ${VAR:-default} in every string of a JSON value. Unset variables become "" and are reported. */
export function substituteEnv(value, env = process.env, missing = new Set()) {
  if (typeof value === "string") {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_, name, fallback) => {
      const v = env[name];
      if (v !== undefined && v !== "") return v;
      if (fallback !== undefined) return fallback;
      missing.add(name);
      return "";
    });
  }
  if (Array.isArray(value)) return value.map((v) => substituteEnv(v, env, missing));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substituteEnv(v, env, missing)]));
  return value;
}

const ESRI_ATTRIBUTION = 'Powered by <a href="https://www.esri.com">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community';

/** Esri World Imagery through ArcGIS Location Platform, proxied so the key stays on the server. */
export function esriLayer(key) {
  return {
    id: "aerial",
    label: "Aerial",
    tiles: [`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`],
    maxzoom: 19,
    attribution: ESRI_ATTRIBUTION,
    proxy: true,
  };
}

/**
 * A self-hosted vector basemap: a Protomaps PMTiles file in the basemap folder (served at basemap/).
 * It replaces the OpenStreetMap tiles as the street map, so no third-party tile service is used.
 */
export function pmtilesLayer(file) {
  return { id: "map", label: "Streets", type: "pmtiles", url: `basemap/${file.split("/").map(encodeURIComponent).join("/")}` };
}

/**
 * The full (server-side) configuration, with secrets.
 * @param {{ env?: NodeJS.ProcessEnv, cwd?: string, log?: (msg: string) => void }} [opts]
 */
export function loadConfig({ env = process.env, cwd = process.cwd(), log = console.warn } = {}) {
  let config = {};
  const file = env.ROUTEBOOK_CONFIG_FILE ? resolve(cwd, env.ROUTEBOOK_CONFIG_FILE) : resolve(cwd, "config.json");
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, "utf8"));
    } catch (e) {
      throw new Error(`Cannot read the Routebook configuration ${file}: ${e instanceof Error ? e.message : e}`);
    }
  } else if (env.ROUTEBOOK_CONFIG_FILE) {
    log(`No Routebook configuration at ${file} (it is optional): using the defaults.`);
  }
  if (env.ROUTEBOOK_CONFIG?.trim()) {
    try {
      config = { ...config, ...JSON.parse(env.ROUTEBOOK_CONFIG) };
    } catch (e) {
      throw new Error(`ROUTEBOOK_CONFIG is not valid JSON: ${e instanceof Error ? e.message : e}`);
    }
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new Error("The Routebook configuration must be a JSON object");
  const missing = new Set();
  config = substituteEnv(config, env, missing);
  if (missing.size) log(`Routebook configuration: environment variable(s) ${[...missing].join(", ")} not set.`);

  if (env.ROUTEBOOK_PRIVACY_URL) config.privacy = { ...config.privacy, url: env.ROUTEBOOK_PRIVACY_URL };
  else if (env.ROUTEBOOK_PRIVACY_FILE) config.privacy = { ...config.privacy, file: resolve(cwd, env.ROUTEBOOK_PRIVACY_FILE) };
  config.privacy = loadPrivacy(config.privacy, dirname(file), log);
  if (!config.privacy) delete config.privacy;
  if (env.ROUTEBOOK_TITLE) config.title = env.ROUTEBOOK_TITLE;
  if (env.ROUTEBOOK_DEFAULT_DATASET) config.defaultDataset = env.ROUTEBOOK_DEFAULT_DATASET;
  if (env.ROUTEBOOK_DEFAULT_BASEMAP) config.defaultBasemap = env.ROUTEBOOK_DEFAULT_BASEMAP;
  const basemaps = Array.isArray(config.basemaps) ? [...config.basemaps] : [];
  if (env.ROUTEBOOK_BASEMAP_PMTILES?.trim() && !basemaps.some((b) => b?.type === "pmtiles")) basemaps.unshift(pmtilesLayer(env.ROUTEBOOK_BASEMAP_PMTILES.trim()));
  if (env.ESRI_API_KEY?.trim() && !basemaps.some((b) => b?.id === "aerial")) basemaps.push(esriLayer(env.ESRI_API_KEY.trim()));
  config.basemaps = basemaps;
  if (!Array.isArray(config.overlays)) config.overlays = [];

  for (const kind of ["basemaps", "overlays"]) {
    const seen = new Set();
    config[kind] = config[kind].filter((l) => {
      const pmtiles = kind === "basemaps" && l?.type === "pmtiles";
      const ok = l && typeof l.id === "string" && /^[A-Za-z0-9_-]+$/.test(l.id) && (pmtiles ? typeof l.url === "string" && l.url.trim() !== "" : Array.isArray(l.tiles) && l.tiles.some((t) => typeof t === "string" && t));
      if (!ok) log(`Routebook configuration: skipping ${kind} entry ${JSON.stringify(l?.id ?? l)} (needs an id of letters, digits, - or _, and tiles, or for a basemap type "pmtiles" and a url).`);
      else if (seen.has(l.id)) log(`Routebook configuration: duplicate ${kind} id "${l.id}", skipped.`);
      const keep = ok && !seen.has(l.id);
      if (ok) seen.add(l.id);
      return keep;
    });
  }
  return config;
}

const escapeHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

/**
 * The privacy statement: a link to the deployer's own page ({ url }), or their text, inline
 * ({ text }) or from a file ({ file }, relative to the configuration file), served as privacy.html.
 * HTML is used as it is; plain text becomes paragraphs. A plain string is a URL or a text.
 * Returns { label, url } or { label, html }, or undefined when there is none.
 */
export function loadPrivacy(privacy, baseDir = process.cwd(), log = console.warn) {
  if (!privacy) return undefined;
  if (typeof privacy === "string") privacy = /^https?:\/\//.test(privacy.trim()) ? { url: privacy.trim() } : { text: privacy };
  if (typeof privacy !== "object") return undefined;
  const label = typeof privacy.label === "string" && privacy.label.trim() ? privacy.label.trim() : "Privacy";
  if (typeof privacy.url === "string" && privacy.url.trim()) return { label, url: privacy.url.trim() };
  let text = typeof privacy.text === "string" ? privacy.text : undefined;
  let isHtml = false;
  if (typeof privacy.file === "string" && privacy.file.trim()) {
    const path = resolve(baseDir, privacy.file.trim());
    try {
      text = readFileSync(path, "utf8");
      isHtml = /\.html?$/i.test(extname(path));
    } catch {
      log(`Routebook configuration: privacy statement ${path} not found; no privacy link is shown.`);
      return undefined;
    }
  }
  if (!text?.trim()) return undefined;
  isHtml ||= /<[a-z][\s\S]*>/i.test(text);
  const html = isHtml
    ? text
    : text
        .trim()
        .split(/\r?\n\s*\r?\n/)
        .map((p) => `<p>${escapeHtml(p.trim()).replace(/\r?\n/g, "<br>")}</p>`)
        .join("\n");
  return { label, html };
}

/** A whole HTML page for the privacy statement (a full document is served as it is). */
export function privacyPage(privacy, title = "RouteBook") {
  if (/<html[\s>]/i.test(privacy.html)) return privacy.html;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(privacy.label)} · ${escapeHtml(title)}</title>
<style>
  body { font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1f2d3a; background: #fff; margin: 0; }
  main { max-width: 720px; margin: 0 auto; padding: 32px 16px 64px; }
  a { color: #1f4e79; }
  h1 { font-size: 1.6rem; }
</style>
</head>
<body>
<main>
<p><a href="./">← ${escapeHtml(title)}</a></p>
${/<h1[\s>]/i.test(privacy.html) ? "" : `<h1>${escapeHtml(privacy.label)}</h1>\n`}${privacy.html}
</main>
</body>
</html>
`;
}

/** Proxied layers by id (server side, with their upstream templates and headers). */
export function proxiedLayers(config) {
  const map = new Map();
  for (const l of [...(config.basemaps ?? []), ...(config.overlays ?? [])]) if (l.proxy) map.set(l.id, l);
  return map;
}

/** The configuration as the browser gets it: proxied layers point at the server, without their headers. */
export function publicConfig(config) {
  const strip = (l) => {
    const { proxy, headers, ...rest } = l;
    if (!proxy) return headers ? { ...rest, headers } : rest;
    return { ...rest, tiles: [`tiles/${encodeURIComponent(l.id)}/{z}/{x}/{y}`] };
  };
  const out = { ...config, basemaps: (config.basemaps ?? []).map(strip), overlays: (config.overlays ?? []).map(strip) };
  if (config.privacy) out.privacy = { label: config.privacy.label, url: config.privacy.url ?? "privacy.html" };
  return out;
}

const R = 6378137;
const HALF = Math.PI * R;

function quadkey(z, x, y) {
  let q = "";
  for (let i = z; i > 0; i--) {
    let d = 0;
    const mask = 1 << (i - 1);
    if (x & mask) d += 1;
    if (y & mask) d += 2;
    q += d;
  }
  return q;
}

/** Tile -> [minx, miny, maxx, maxy] in EPSG:3857 (XYZ tile numbering, y down). */
export function tileBbox3857(z, x, y) {
  const size = (2 * HALF) / 2 ** z;
  return [-HALF + x * size, HALF - (y + 1) * size, -HALF + (x + 1) * size, HALF - y * size];
}

/** Tile -> [west, south, east, north] in degrees. */
export function tileBounds(z, x, y) {
  const lon = (v) => (v / HALF) * 180;
  const lat = (v) => (Math.atan(Math.sinh(v / R)) * 180) / Math.PI;
  const [a, b, c, d] = tileBbox3857(z, x, y);
  return [lon(a), lat(b), lon(c), lat(d)];
}

/**
 * Upstream URL of a proxied tile. `y` is as the browser requested it: for a TMS layer that is
 * already the TMS row, and the bbox and quadkey use the XYZ row.
 */
export function upstreamUrl(layer, z, x, y) {
  const tiles = layer.tiles.filter(Boolean);
  const template = tiles[(x + y) % tiles.length];
  const yXyz = layer.scheme === "tms" ? 2 ** z - 1 - y : y;
  return template
    .replaceAll("{z}", String(z))
    .replaceAll("{x}", String(x))
    .replaceAll("{y}", String(y))
    .replaceAll("{quadkey}", quadkey(z, x, yXyz))
    .replaceAll("{bbox-epsg-3857}", tileBbox3857(z, x, yXyz).join(","))
    .replaceAll("{ratio}", "1");
}

/** Parse /tiles/<id>/<z>/<x>/<y>[.ext]; undefined when it isn't a valid tile path. */
export function parseTilePath(pathname) {
  const m = pathname.match(/\/tiles\/([A-Za-z0-9_-]+)\/(\d{1,2})\/(\d{1,9})\/(\d{1,9})(?:\.[a-z0-9]+)?$/);
  if (!m) return undefined;
  const [z, x, y] = [Number(m[2]), Number(m[3]), Number(m[4])];
  if (z > 30 || x >= 2 ** z || y >= 2 ** z) return undefined;
  return { id: m[1], z, x, y };
}

/** Whether a tile overlaps the layer's bounds (no bounds: always). */
export function inBounds(layer, z, x, y) {
  if (!Array.isArray(layer.bounds) || layer.bounds.length !== 4) return true;
  const yXyz = layer.scheme === "tms" ? 2 ** z - 1 - y : y;
  const [w, s, e, n] = tileBounds(z, x, yXyz);
  const [bw, bs, be, bn] = layer.bounds;
  return w <= be && e >= bw && s <= bn && n >= bs;
}
