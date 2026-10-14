import type { RasterLayerSpecification, RasterSourceSpecification } from "maplibre-gl";

/**
 * Background maps the user can switch between.
 *
 * The code is MIT, but every tile service has its own terms, so the app only
 * ships services that need no key and allow commercial use. Higher resolution
 * imagery (Esri World Imagery, Norge i bilder, a company WMTS, ...) is opt-in:
 * whoever deploys the app sets it up with their own key in an env file, see
 * apps/web/.env.example. Keys end up in the browser, so use referrer-restricted keys.
 */
export interface Basemap {
  id: string;
  label: string;
  source: RasterSourceSpecification;
  paint: RasterLayerSpecification["paint"];
  /** true for imagery: overlays switch to colours that read on a dark, busy background */
  aerial: boolean;
}

export interface BasemapEnv {
  VITE_ESRI_API_KEY?: string;
  VITE_AERIAL_TILES?: string;
  VITE_AERIAL_LABEL?: string;
  VITE_AERIAL_ATTRIBUTION?: string;
  VITE_AERIAL_MAXZOOM?: string;
  VITE_AERIAL_TILESIZE?: string;
}

const RINF = "RINF © ERA, data: Bane NOR";

/** Plain map: OSM, greyed out so the railway overlay stands out. Fine for a demo, not for heavy production use. */
const osm: Basemap = {
  id: "map",
  label: "Streets",
  source: {
    type: "raster",
    tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
    tileSize: 256,
    maxzoom: 19,
    attribution: `© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · ${RINF}`,
  },
  paint: { "raster-saturation": -0.85, "raster-opacity": 0.75 },
  aerial: false,
};

/**
 * Sentinel-2 cloudless 2016 by EOX: the only EOX year under CC BY 4.0 (commercial use allowed
 * with attribution; 2017+ are CC BY-NC-SA). 10 m pixels: good for orientation, too coarse to see tracks.
 */
const s2cloudless: Basemap = {
  id: "satellite",
  label: "Satellite",
  source: {
    type: "raster",
    tiles: ["https://tiles.maps.eox.at/wmts/1.0.0/s2cloudless_3857/default/g/{z}/{y}/{x}.jpg"],
    tileSize: 256,
    maxzoom: 15,
    attribution: `<a href="https://cloudless.eox.at">EOxCloudless</a> by EOX IT Services GmbH (Contains modified Copernicus Sentinel data 2016 &amp; 2017) · ${RINF}`,
  },
  paint: { "raster-saturation": -0.2, "raster-brightness-max": 0.9 },
  aerial: true,
};

const aerialPaint: RasterLayerSpecification["paint"] = { "raster-saturation": -0.25, "raster-brightness-max": 0.85 };

/** Esri World Imagery through ArcGIS Location Platform; needs the deployer's own API key. */
function esri(key: string): Basemap {
  return {
    id: "aerial",
    label: "Aerial",
    source: {
      type: "raster",
      tiles: [`https://ibasemaps-api.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}?token=${encodeURIComponent(key)}`],
      tileSize: 256,
      maxzoom: 19,
      attribution: `Powered by <a href="https://www.esri.com">Esri</a> · Sources: Esri, Maxar, Earthstar Geographics, and the GIS User Community · ${RINF}`,
    },
    paint: aerialPaint,
    aerial: true,
  };
}

/** Any XYZ raster template ({z}/{x}/{y}, or {quadkey}/{bbox-epsg-3857}), e.g. a Norge i bilder cache for Norge digitalt parties. */
function custom(env: BasemapEnv): Basemap {
  const maxzoom = Number(env.VITE_AERIAL_MAXZOOM);
  const tileSize = Number(env.VITE_AERIAL_TILESIZE);
  return {
    id: "aerial",
    label: env.VITE_AERIAL_LABEL?.trim() || "Aerial",
    source: {
      type: "raster",
      tiles: [env.VITE_AERIAL_TILES!.trim()],
      tileSize: tileSize === 512 ? 512 : 256,
      maxzoom: Number.isFinite(maxzoom) && maxzoom > 0 ? maxzoom : 19,
      attribution: [env.VITE_AERIAL_ATTRIBUTION?.trim(), RINF].filter(Boolean).join(" · "),
    },
    paint: aerialPaint,
    aerial: true,
  };
}

/** The basemaps on offer: always the plain map and Sentinel-2, plus a configured high-resolution aerial if any. */
export function basemaps(env: BasemapEnv): Basemap[] {
  const list = [osm, s2cloudless];
  if (env.VITE_AERIAL_TILES?.trim()) list.push(custom(env));
  else if (env.VITE_ESRI_API_KEY?.trim()) list.push(esri(env.VITE_ESRI_API_KEY.trim()));
  return list;
}

/** Pick by id (the `base` URL parameter); "aerial" falls back to Sentinel-2 when no high-resolution source is set up. */
export function pickBasemap(list: Basemap[], id: string | null | undefined): Basemap {
  return list.find((b) => b.id === id) ?? (id === "aerial" ? list.find((b) => b.aerial) : undefined) ?? list[0]!;
}
