import type { RasterLayerSpecification, RasterSourceSpecification, RequestParameters } from "maplibre-gl";
import type { DisclaimerConfig } from "./disclaimer.js";

/**
 * Background maps and overlays.
 *
 * The code is MIT, but every tile service has its own terms, so the app only
 * ships services that need no key and allow commercial use. Everything else
 * (Esri World Imagery, a national orthophoto service, a company WMS/WMTS, ...)
 * is added by whoever deploys the app, in the runtime configuration
 * (config.json, see docs/deployment.md). With `proxy: true` the server
 * fetches the tiles and adds the key, so it never reaches the browser.
 */
export interface Basemap {
  id: string;
  label: string;
  source: RasterSourceSpecification;
  paint: RasterLayerSpecification["paint"];
  /** true for imagery: overlays switch to colours that read on a dark, busy background */
  aerial: boolean;
}

/** One raster layer in config.json (`basemaps` or `overlays`). */
export interface LayerConfig {
  id: string;
  label?: string;
  /** One line under the label in the Map layers menu. */
  description?: string;
  /**
   * Tile URL templates: {z}/{x}/{y}, {quadkey} or {bbox-epsg-3857} (WMS GetMap).
   * Relative URLs (e.g. the server's proxy, `tiles/<id>/{z}/{x}/{y}`) resolve against the app.
   */
  tiles: string[];
  tileSize?: number;
  minzoom?: number;
  maxzoom?: number;
  scheme?: "xyz" | "tms";
  /** [west, south, east, north] in degrees: no requests outside it. */
  bounds?: [number, number, number, number];
  attribution?: string;
  /** Imagery (dark, busy): the railway lines are drawn light on it. Default true for basemaps. */
  imagery?: boolean;
  opacity?: number;
  /** Extra MapLibre raster paint properties. */
  paint?: RasterLayerSpecification["paint"];
  /** Headers the browser sends with each tile request (visible to users: prefer `proxy`). */
  headers?: Record<string, string>;
  /** Overlays only: shown when the app opens. */
  visible?: boolean;
}

/** The runtime configuration (config.json), all optional. See docs/deployment.md. */
export interface RuntimeConfig {
  /** App title in the header and the browser tab. */
  title?: string;
  /** Dataset opened when the URL has none, e.g. "nor". */
  defaultDataset?: string;
  /**
   * Built-in backgrounds to offer: true (default) for the street map, false for none, or a list of
   * ids ("map", and "satellite" for the coarse Sentinel-2 mosaic, which is only offered when named).
   */
  builtinBasemaps?: boolean | string[];
  /** Built-in overlays: true (default) for OpenRailwayMap, false for none, or a list of ids ("orm"). */
  builtinOverlays?: boolean | string[];
  /** Background opened when the URL has none. */
  defaultBasemap?: string;
  basemaps?: LayerConfig[];
  overlays?: LayerConfig[];
  /** Glyph URL template for map labels (MapLibre `glyphs`). */
  glyphs?: string;
  /** Privacy statement, linked in the footer: the server turns a text or file into `privacy.html`. */
  privacy?: { label?: string; url: string };
  /** Example routes on the start panel, per dataset id: [{ from: uopid, to: uopid, label? }]. */
  examples?: Record<string, Array<{ from: string; to: string; label?: string }>>;
  /** RINF Atlas instance the Datasets dialog links to (default: the public one); false for no links. */
  atlasUrl?: string | false;
  /**
   * The demo disclaimer (banner, notice to acknowledge, print stamp): on by default;
   * `{ publisher, banner, title, text, print }` changes the wording, false switches it off.
   */
  disclaimer?: DisclaimerConfig | boolean;
}

/**
 * Plain map: OSM, slightly greyed so the railway lines stand out, as in RINF Atlas. Fine for a
 * demo, not for heavy production use (OSM's tile usage policy).
 */
const osm: Basemap = {
  id: "map",
  label: "Streets",
  source: {
    type: "raster",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    maxzoom: 19,
    attribution: `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors`,
  },
  paint: { "raster-saturation": -0.35 },
  aerial: false,
};

/**
 * Sentinel-2 cloudless 2016 by EOX: the only EOX year under CC BY 4.0 (commercial use allowed
 * with attribution; 2017+ are CC BY-NC-SA). 10 m pixels: good for orientation, too coarse to see
 * tracks, so it is only offered when `builtinBasemaps` names it.
 */
const s2cloudless: Basemap = {
  id: "satellite",
  label: "Satellite",
  source: {
    type: "raster",
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"],
    tileSize: 256,
    maxzoom: 15,
    attribution: `<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 &amp; 2017)`,
  },
  paint: { "raster-saturation": -0.2, "raster-brightness-max": 0.9 },
  aerial: true,
};

export const BUILTIN_BASEMAPS: readonly Basemap[] = [osm, s2cloudless];

/** OpenRailwayMap's standard style: the railway infrastructure from OpenStreetMap, over any background (as in RINF Atlas). */
const orm: Basemap & { visible: boolean; description: string } = {
  id: "orm",
  label: "OpenRailwayMap",
  description: "Railway infrastructure from OpenStreetMap, drawn over the background",
  source: {
    type: "raster",
    tiles: ["a", "b", "c"].map((s) => `https://${s}.tiles.openrailwaymap.org/standard/{z}/{x}/{y}.png`),
    tileSize: 256,
    maxzoom: 19,
    attribution: `Rail overlay: © <a href="https://www.openrailwaymap.org/">OpenRailwayMap</a> (CC-BY-SA 2.0)`,
  },
  paint: {},
  aerial: false,
  visible: false,
};

export const BUILTIN_OVERLAYS: readonly (Basemap & { visible: boolean; description: string })[] = [orm];

const aerialPaint: RasterLayerSpecification["paint"] = { "raster-saturation": -0.25, "raster-brightness-max": 0.85 };

/** Resolve a tile template against the page URL, keeping {placeholders} as they are (URL() would encode the braces). */
export function absoluteTemplate(template: string, base: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(template)) return template;
  const origin = new URL(base).origin;
  if (template.startsWith("//")) return new URL(base).protocol + template;
  if (template.startsWith("/")) return origin + template;
  const dir = base.split(/[?#]/)[0]!.replace(/[^/]*$/, "");
  return dir + template.replace(/^\.\//, "");
}

/** A config layer as a MapLibre raster source + paint. */
export function layerFromConfig(c: LayerConfig, opts: { base: string; overlay?: boolean }): Basemap {
  const imagery = c.imagery ?? !opts.overlay;
  const paint: RasterLayerSpecification["paint"] = {
    ...(opts.overlay ? {} : imagery ? aerialPaint : {}),
    ...(c.opacity !== undefined ? { "raster-opacity": c.opacity } : {}),
    ...c.paint,
  };
  const source: RasterSourceSpecification = {
    type: "raster",
    tiles: c.tiles.map((t) => absoluteTemplate(t, opts.base)),
    tileSize: c.tileSize === 512 ? 512 : 256,
    maxzoom: Number.isFinite(c.maxzoom) && c.maxzoom! > 0 ? c.maxzoom! : 19,
    ...(Number.isFinite(c.minzoom) ? { minzoom: c.minzoom! } : {}),
    ...(c.scheme === "tms" ? { scheme: "tms" as const } : {}),
    ...(c.bounds?.length === 4 ? { bounds: c.bounds } : {}),
    ...(c.attribution ? { attribution: c.attribution } : {}),
  };
  return { id: c.id, label: c.label?.trim() || c.id, source, paint, aerial: imagery };
}

const valid = (c: LayerConfig | undefined): c is LayerConfig =>
  !!c && typeof c.id === "string" && c.id.trim() !== "" && Array.isArray(c.tiles) && c.tiles.some((t) => typeof t === "string" && t.trim() !== "");

/**
 * The backgrounds on offer: the built-in street map (and the coarse Sentinel-2 mosaic when
 * `builtinBasemaps` names it), then the configured ones (a configured id replaces a built-in):
 * Esri World Imagery through ESRI_API_KEY, an orthophoto service, ...
 */
export function basemaps(config: RuntimeConfig, base = "http://localhost/"): Basemap[] {
  const own = (config.basemaps ?? []).filter(valid).map((c) => layerFromConfig(c, { base }));
  const keep = config.builtinBasemaps ?? true;
  const wanted = (b: Basemap) => (keep === true ? b.id === "map" : Array.isArray(keep) && keep.includes(b.id));
  const builtins = BUILTIN_BASEMAPS.filter((b) => wanted(b) && !own.some((o) => o.id === b.id));
  const list = [...builtins, ...own];
  return list.length ? list : [osm];
}

/** The overlays, drawn between the background and the railway lines: OpenRailwayMap, then the configured ones. */
export function overlays(config: RuntimeConfig, base = "http://localhost/"): Array<Basemap & { visible: boolean; description?: string }> {
  const own = (config.overlays ?? []).filter(valid).map((c) => ({ ...layerFromConfig(c, { base, overlay: true }), visible: c.visible === true, ...(c.description ? { description: c.description } : {}) }));
  const keep = config.builtinOverlays ?? true;
  const builtins = BUILTIN_OVERLAYS.filter((o) => (keep === true || (Array.isArray(keep) && keep.includes(o.id))) && !own.some((x) => x.id === o.id));
  return [...builtins, ...own];
}

/** Pick by id (the `base` URL parameter, then the configured default); "aerial" falls back to the first imagery. */
export function pickBasemap(list: Basemap[], id: string | null | undefined, fallback?: string): Basemap {
  const find = (x: string | null | undefined) => (x ? list.find((b) => b.id === x) : undefined);
  return find(id) ?? (id === "aerial" ? list.find((b) => b.aerial && b.id !== "satellite") ?? list.find((b) => b.aerial) : undefined) ?? find(fallback) ?? list[0]!;
}

/**
 * MapLibre transformRequest that adds the configured headers to tile requests
 * of the layers that have them (matched on the template up to its first placeholder).
 */
export function headerTransform(layers: LayerConfig[], base = "http://localhost/"): ((url: string) => RequestParameters | undefined) | undefined {
  const rules = layers
    .filter((l) => valid(l) && l.headers && Object.keys(l.headers).length)
    .flatMap((l) => l.tiles.map((t) => ({ prefix: absoluteTemplate(t, base).split("{")[0]!, headers: l.headers! })));
  if (!rules.length) return undefined;
  return (url) => {
    const rule = rules.find((r) => url.startsWith(r.prefix));
    return rule ? { url, headers: rule.headers } : undefined;
  };
}

/** Load config.json next to the app; a missing or broken file gives the defaults. */
export async function loadRuntimeConfig(url: string, fetchImpl: typeof fetch = fetch): Promise<RuntimeConfig> {
  try {
    const res = await fetchImpl(url, { cache: "no-cache" });
    if (!res.ok) return {};
    const json = (await res.json()) as unknown;
    return json && typeof json === "object" && !Array.isArray(json) ? (json as RuntimeConfig) : {};
  } catch {
    return {};
  }
}
