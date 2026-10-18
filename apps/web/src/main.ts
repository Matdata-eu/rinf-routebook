import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import type { OperationalPoint } from "@routebook/rinf-client";
import type { IndexOp } from "@routebook/rinf-client/network-index";
import { RouteEngine, loadBundle, type Bundle, type RouteResult } from "./engine.js";
import { bounds, pointAtDistance, type LngLat } from "./geometry.js";
import { buildSearchIndex, searchOps, type SearchEntry } from "./search.js";
import { codeOf, findByCode, loadNetwork, networkFromBundle, opsBounds, opsGeoJson, pickFilter, solsGeoJson, visibleOps, type Network } from "./network.js";
import { markSelected, renderRoutebook } from "./view.js";
import { KIND_LABELS } from "./strip.js";
import { fitZoom, renderSchematic, type SchematicView } from "./schematic.js";
import type { Schematic } from "@routebook/schematic";
import { workerSolver } from "./solver-client.js";
import { DriveView } from "./drive-view.js";
import { basemaps, headerTransform, loadRuntimeConfig, overlays, pickBasemap, type Basemap } from "./basemaps.js";
import { datasetsSummary, fmtDate, loadCatalogue, loadable, pickDataset, provenanceText, rinfAttribution, examplesFor } from "./datasets.js";
import { openDatasetsDialog } from "./datasets-dialog.js";
import { installDisclaimer, resolveDisclaimer } from "./disclaimer.js";

const params = new URLSearchParams(location.search);
const BASE = import.meta.env.BASE_URL;
// runtime configuration (config.json, written by the server from its settings) and the datasets on offer
const [CONFIG, CATALOGUE] = await Promise.all([loadRuntimeConfig(`${BASE}config.json`), loadCatalogue(`${BASE}datasets.json`)]);
const DATASETS = loadable(CATALOGUE.datasets);
/** The dataset the map and the search are limited to; undefined: all of them. Deep links (`?dataset=`) and the Network picker set it. */
let FILTER = pickFilter(DATASETS, params.get("dataset") ?? params.get("country"), CONFIG.defaultDataset);
const datasetName = (id: string) => CATALOGUE.datasets.find((d) => d.id === id)?.name ?? network?.datasets[id]?.name ?? id;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const status = $("status");
const panel = $("routebook");
const fromInput = $<HTMLInputElement>("from");
const toInput = $<HTMLInputElement>("to");

function setState(state: "loading" | "ready" | "routing" | "routed" | "error", message = ""): void {
  document.body.dataset.state = state;
  status.textContent = message;
  status.classList.toggle("error", state === "error");
}

// ---------------------------------------------------------------- map

const BASEMAPS = basemaps(CONFIG, location.href);
const OVERLAYS = overlays(CONFIG, location.href);
let basemap = pickBasemap(BASEMAPS, params.get("base"), CONFIG.defaultBasemap);
const shownOverlays = new Set(params.has("layers") ? (params.get("layers") ?? "").split(",").filter(Boolean) : OVERLAYS.filter((o) => o.visible).map((o) => o.id));

const style: StyleSpecification = {
  version: 8,
  // key-free glyphs for OP labels; without network the labels are simply not drawn
  glyphs: CONFIG.glyphs ?? "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: { basemap: basemap.source, ...Object.fromEntries(OVERLAYS.map((o) => [`overlay-${o.id}`, o.source])) },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#eef1f4" } },
    { id: "basemap", type: "raster", source: "basemap", paint: basemap.paint },
    ...OVERLAYS.map((o) => ({
      id: `overlay-${o.id}`,
      type: "raster" as const,
      source: `overlay-${o.id}`,
      paint: o.paint,
      layout: { visibility: shownOverlays.has(o.id) ? ("visible" as const) : ("none" as const) },
    })),
  ],
};

const transformRequest = headerTransform([...(CONFIG.basemaps ?? []), ...(CONFIG.overlays ?? [])], location.href);
const map = new maplibregl.Map({
  container: "map",
  style,
  center: [10.0, 50.0],
  zoom: 3.5,
  maxPitch: 80,
  attributionControl: { compact: true },
  ...(transformRequest ? { transformRequest } : {}),
});
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
if (import.meta.env.DEV) Object.assign(window, { routebookMap: map });
map.addControl(basemapSwitch(), "top-right");

const SOLS_COLOR = { plain: "#5b6b7b", aerial: "#f2f4f6" };

/** Swap the background imagery in place, under the railway layers. */
function setBasemap(next: Basemap): void {
  if (next.id === basemap.id) return;
  basemap = next;
  if (map.getLayer("basemap")) map.removeLayer("basemap");
  if (map.getSource("basemap")) map.removeSource("basemap");
  map.addSource("basemap", next.source);
  // under the overlays, or under the railway lines when there are none
  const above = OVERLAYS.length ? `overlay-${OVERLAYS[0]!.id}` : map.getLayer("sols") ? "sols" : undefined;
  map.addLayer({ id: "basemap", type: "raster", source: "basemap", paint: next.paint }, above);
  if (map.getLayer("sols")) map.setPaintProperty("sols", "line-color", next.aerial ? SOLS_COLOR.aerial : SOLS_COLOR.plain);
  document.querySelectorAll<HTMLButtonElement>(".basemap-switch button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.id === next.id)));
  syncUrl();
}

function basemapSwitch(): maplibregl.IControl {
  const box = document.createElement("div");
  box.className = "maplibregl-ctrl basemap-switch";
  box.setAttribute("role", "group");
  box.setAttribute("aria-label", "Background map");
  for (const b of BASEMAPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = b.label;
    btn.dataset.id = b.id;
    btn.setAttribute("aria-pressed", String(b.id === basemap.id));
    btn.addEventListener("click", () => setBasemap(b));
    box.append(btn);
  }
  for (const o of OVERLAYS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "overlay";
    btn.textContent = o.label;
    btn.title = `Show or hide ${o.label}`;
    btn.dataset.overlay = o.id;
    btn.setAttribute("aria-pressed", String(shownOverlays.has(o.id)));
    btn.addEventListener("click", () => toggleOverlay(o.id, btn));
    box.append(btn);
  }
  return { onAdd: () => box, onRemove: () => box.remove() };
}

function toggleOverlay(id: string, btn: HTMLButtonElement): void {
  const on = !shownOverlays.has(id);
  if (on) shownOverlays.add(id);
  else shownOverlays.delete(id);
  map.setLayoutProperty(`overlay-${id}`, "visibility", on ? "visible" : "none");
  btn.setAttribute("aria-pressed", String(on));
  syncUrl();
}

/** Satnav-style follow view of the route (the Drive tab). */
const drive = new DriveView(map, document.querySelector(".stage") as HTMLElement, {
  onPassed: (index) => {
    markSelected(panel, index);
    const row = panel.querySelector<HTMLElement>(`.rb-row[data-index="${index}"]`);
    // keep the row in view without fighting someone scrolling the routebook
    if (row && !panel.matches(":hover")) panel.scrollTo({ top: row.offsetTop - panel.clientHeight / 3, behavior: "smooth" });
  },
  onPosition: (d) => {
    driveAt = d;
    syncUrl();
  },
});

const empty = { type: "FeatureCollection" as const, features: [] };

/** The MapLibre filter for the Network picker: only the chosen dataset's features, or everything. */
function datasetFilter(extra?: maplibregl.ExpressionSpecification): maplibregl.ExpressionSpecification | null {
  const own: maplibregl.ExpressionSpecification | undefined = FILTER ? ["==", ["get", "dataset"], FILTER] : undefined;
  if (own && extra) return ["all", own, extra];
  return own ?? extra ?? null;
}

/** `filter` for a layer specification, left out when there is none (MapLibre rejects an undefined filter). */
function withFilter(f: maplibregl.ExpressionSpecification | null): { filter?: maplibregl.ExpressionSpecification } {
  return f ? { filter: f } : {};
}

function applyFilter(): void {
  if (!map.getLayer("ops")) return;
  map.setFilter("sols", datasetFilter());
  map.setFilter("ops", datasetFilter());
  map.setFilter("op-labels", datasetFilter(["==", ["get", "station"], 1]));
}

/** The railway layers from the network index: every section of line and operational point on offer. */
function addLayers(net: Network): void {
  map.addSource("sols", { type: "geojson", data: solsGeoJson(net), attribution: rinfAttribution(credit(imNamesOf(net))) });
  map.addSource("ops", { type: "geojson", data: opsGeoJson(net) });
  // lineMetrics: the Drive view colours the travelled part of the route by line-progress
  map.addSource("route", { type: "geojson", data: empty, lineMetrics: true });
  map.addSource("endpoints", { type: "geojson", data: empty });
  map.addSource("selected", { type: "geojson", data: empty });

  map.addLayer({ id: "sols", type: "line", source: "sols", ...withFilter(datasetFilter()), paint: { "line-color": basemap.aerial ? SOLS_COLOR.aerial : SOLS_COLOR.plain, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2.5] } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 6, 12, 12] } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#d35400", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3.5, 12, 7] } });
  map.addLayer({
    id: "ops",
    type: "circle",
    source: "ops",
    ...withFilter(datasetFilter()),
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 5, ["case", ["==", ["get", "station"], 1], 2.5, 1.5], 11, ["case", ["==", ["get", "station"], 1], 7, 4]],
      "circle-color": ["case", ["==", ["get", "station"], 1], "#1f4e79", "#7f8c8d"],
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
  });
  map.addLayer({
    id: "op-labels",
    type: "symbol",
    source: "ops",
    minzoom: 8,
    ...withFilter(datasetFilter(["==", ["get", "station"], 1])),
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": "#1f2d3a", "text-halo-color": "#fff", "text-halo-width": 1.5 },
  });
  map.addLayer({ id: "endpoints", type: "circle", source: "endpoints", paint: { "circle-radius": 9, "circle-color": ["match", ["get", "role"], "from", "#1e8449", "#922b21"], "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
  map.addLayer({ id: "selected", type: "circle", source: "selected", paint: { "circle-radius": 10, "circle-color": "rgba(241,196,15,0.35)", "circle-stroke-color": "#b7950b", "circle-stroke-width": 3 } });

  map.on("mouseenter", "ops", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "ops", () => (map.getCanvas().style.cursor = ""));
  map.on("click", "ops", (e) => {
    const key = e.features?.[0]?.properties?.key as string | undefined;
    const op = key ? network?.byKey.get(key) : undefined;
    if (op) openOpPopup(op, e.lngLat);
  });
}

/** Argument of rinfAttribution for an optional IM name. */
function credit(imName: string | undefined): { imName?: string; name?: string; country: string } {
  return { country: "", ...(imName ? { imName } : {}) };
}

/** The infrastructure managers of the datasets on offer, for the data credit; one name when there is one dataset. */
function imNamesOf(net: Network): string | undefined {
  const ids = FILTER ? [FILTER] : Object.keys(net.datasets);
  const names = [...new Set(ids.map((id) => net.datasets[id]?.imName ?? CATALOGUE.datasets.find((d) => d.id === id)?.imName).filter((n): n is string => !!n))];
  if (!names.length) return undefined;
  return names.length <= 3 ? names.join(", ") : `${names.length} infrastructure managers`;
}

function openOpPopup(op: IndexOp, at: maplibregl.LngLatLike): void {
  const box = document.createElement("div");
  box.className = "op-popup";
  const name = document.createElement("strong");
  name.textContent = op.name;
  const code = document.createElement("span");
  code.textContent = ` ${op.uopid}${FILTER ? "" : ` · ${datasetName(op.dataset)}`}`;
  const buttons = document.createElement("div");
  const popup = new maplibregl.Popup({ closeButton: true, maxWidth: "280px" });
  for (const [role, label] of [["from", "Route from here"], ["to", "Route to here"]] as const) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = `btn btn-${role}`;
    b.textContent = label;
    b.addEventListener("click", () => {
      popup.remove();
      setEndpoint(role, op);
    });
    buttons.append(b);
  }
  box.append(name, code, buttons);
  popup.setLngLat(at).setDOMContent(box).addTo(map);
}

// ---------------------------------------------------------------- state

/** The network index (search and map); the bundles load on demand into `engines`. */
let network: Network | undefined;
/** Loaded datasets: the routing engine of each, kept for the session. */
const engines = new Map<string, { engine: RouteEngine; bundle: Bundle }>();
const loading = new Map<string, Promise<{ engine: RouteEngine; bundle: Bundle }>>();
/** How many full bundles the browser keeps; the ones a route needs are never dropped. */
const MAX_LOADED = 6;
let searchIndex: SearchEntry<IndexOp>[] = [];
const selection: { from?: IndexOp; to?: IndexOp } = {};
/** The route, with the engine (dataset) that computed it. */
type Routed = RouteResult & { engine: RouteEngine; dataset: string };
let result: Routed | undefined;
/** Routes requested while a bundle was loading are superseded by the next one. */
let computeToken = 0;
type View = "map" | "schematic" | "drive";
let view: View = params.get("view") === "schematic" ? "schematic" : params.get("view") === "drive" ? "drive" : "map";
/** train position and autoplay from the URL, used for the first route only */
let driveStart: { at?: number; play?: boolean } | undefined = {
  ...(params.has("at") ? { at: Number(params.get("at")) || 0 } : {}),
  ...(params.get("play") === "1" ? { play: true } : {}),
};
let driveAt: number | undefined;
let schematic: { result: RouteResult; layout: Schematic } | undefined;
/** HiGHS in a Web Worker: the schematic is drawn with the heuristic layout first, then redrawn with the solver layout. */
const solver = workerSolver();
let schematicZoom = 1;
let schematicView: SchematicView | undefined;
let selectedDistance: number | undefined;

const STORAGE_KEY = "routebook.hiddenKinds";
const hiddenKinds = new Set<string>(
  (() => {
    try {
      return JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as string[];
    } catch {
      return [];
    }
  })(),
);

function setEndpoint(role: "from" | "to", op: IndexOp | undefined): void {
  if (op) selection[role] = op;
  else delete selection[role];
  (role === "from" ? fromInput : toInput).value = op ? op.name : "";
  update();
}

function opLngLat(op: Pick<IndexOp, "lon" | "lat">): LngLat | undefined {
  return op.lon !== undefined && op.lat !== undefined ? [op.lon, op.lat] : undefined;
}

function syncUrl(): void {
  const url = new URL(location.href);
  for (const role of ["from", "to"] as const) {
    const op = selection[role];
    if (op && network) url.searchParams.set(role, codeOf(network, op, FILTER));
    else url.searchParams.delete(role);
  }
  if (view !== "map") url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  if (view === "drive" && driveAt !== undefined && selection.from && selection.to) url.searchParams.set("at", String(Math.round(driveAt)));
  else url.searchParams.delete("at");
  url.searchParams.delete("play");
  const defaultBase = pickBasemap(BASEMAPS, null, CONFIG.defaultBasemap);
  if (basemap.id !== defaultBase.id) url.searchParams.set("base", basemap.id);
  else url.searchParams.delete("base");
  const defaultLayers = OVERLAYS.filter((o) => o.visible).map((o) => o.id).join(",");
  const layers = OVERLAYS.filter((o) => shownOverlays.has(o.id)).map((o) => o.id).join(",");
  if (layers !== defaultLayers) url.searchParams.set("layers", layers);
  else url.searchParams.delete("layers");
  url.searchParams.delete("country");
  // the filter, when it is not what the app would pick on its own
  const own = pickFilter(DATASETS, null, CONFIG.defaultDataset);
  if (FILTER !== own) url.searchParams.set("dataset", FILTER ?? "all");
  else url.searchParams.delete("dataset");
  history.replaceState(null, "", url);
}

function update(): void {
  syncUrl();

  const endpoints = (["from", "to"] as const).flatMap((role) => {
    const op = selection[role];
    const p = op && opLngLat(op);
    return p ? [{ type: "Feature" as const, geometry: { type: "Point" as const, coordinates: p }, properties: { role } }] : [];
  });
  (map.getSource("endpoints") as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: endpoints });
  (map.getSource("selected") as GeoJSONSource | undefined)?.setData(empty);

  if (!network) return;
  if (!selection.from || !selection.to) {
    result = undefined;
    computeToken++;
    (map.getSource("route") as GeoJSONSource | undefined)?.setData(empty);
    panel.replaceChildren(intro());
    drawSchematic();
    if (view === "drive") drive.start(undefined);
    updateProvenance();
    setState("ready", selection.from || selection.to ? "Pick the other end of the route." : "");
    return;
  }
  setState("routing", "Routing…");
  // let the status paint before the (synchronous) routing
  const token = ++computeToken;
  setTimeout(() => void compute(token), 0);
}

/** The routing engine of a dataset: the bundle is fetched the first time a route needs it, then kept. */
function loadEngine(id: string): Promise<{ engine: RouteEngine; bundle: Bundle }> {
  const have = engines.get(id);
  if (have) return Promise.resolve(have);
  let pending = loading.get(id);
  if (!pending) {
    pending = loadBundle(`${BASE}${id}`)
      .then((bundle) => {
        const loaded = { engine: new RouteEngine(bundle.snapshot, bundle.switches ? { switches: bundle.switches } : {}), bundle };
        // keep the browser's memory in check: drop the datasets loaded longest ago, never the route's
        for (const [old] of engines) {
          if (engines.size < MAX_LOADED) break;
          if (old !== result?.dataset) engines.delete(old);
        }
        engines.set(id, loaded);
        return loaded;
      })
      .finally(() => loading.delete(id));
    loading.set(id, pending);
  }
  return pending;
}

/** The full OP behind an index entry, in its loaded bundle (a border point declared twice: the routable one). */
function fullOp(bundle: Bundle, op: IndexOp): OperationalPoint {
  const hits = bundle.snapshot.ops.filter((o) => o.uopid === op.uopid);
  const found = hits.find((o) => o.points.length || o.areas.length) ?? hits[0];
  if (!found) throw new Error(`${op.name} (${op.uopid}) is not in the ${datasetName(op.dataset)} data any more; the index is being updated`);
  return found;
}

async function compute(token: number): Promise<void> {
  const { from, to } = selection;
  if (!network || !from || !to) return;
  try {
    if (from.dataset !== to.dataset) {
      throw new Error(`${from.name} is in ${datasetName(from.dataset)} and ${to.name} in ${datasetName(to.dataset)}: routes across networks come in the next release, when the border links between the RINF datasets are in place.`);
    }
    if (!engines.has(from.dataset)) setState("routing", `Loading ${datasetName(from.dataset)}…`);
    const { engine, bundle } = await loadEngine(from.dataset);
    if (token !== computeToken) return;
    const t0 = performance.now();
    result = { ...engine.route(fullOp(bundle, from), fullOp(bundle, to)), engine, dataset: from.dataset };
    drive.setNetwork(bundle.snapshot.geometry ?? {});
    const ms = Math.round(performance.now() - t0);
    (map.getSource("route") as GeoJSONSource).setData({
      type: "Feature",
      geometry: { type: "LineString", coordinates: result.geometry.coordinates },
      properties: {},
    });
    fitRoute();
    selectedDistance = undefined;
    drawRoutebook();
    drawSchematic();
    if (view === "drive") {
      drive.start(result, { at: 0, play: false, ...driveStart });
      driveStart = undefined;
    }
    updateProvenance(result.dataset);
    setState("routed", `${(result.routebook.length / 1000).toFixed(1)} km, ${result.routebook.items.length} items (${ms} ms)`);
  } catch (e) {
    if (token !== computeToken) return;
    result = undefined;
    updateProvenance();
    (map.getSource("route") as GeoJSONSource).setData(empty);
    panel.replaceChildren(intro());
    drawSchematic();
    if (view === "drive") drive.start(undefined);
    setState("error", e instanceof Error ? e.message : String(e));
  }
}

function drawRoutebook(): void {
  if (!result) return;
  const rb = result.routebook;
  renderRoutebook(panel, rb, { hiddenKinds, onSelect: selectItem });
}

/** Select a routebook item: highlight the row, mark it on the map and in the schematic. */
function selectItem(index: number): void {
  const item = result?.routebook.items[index];
  if (!item || !result) return;
  markSelected(panel, index);
  if (view === "drive") {
    drive.seek(item.distance);
    return;
  }
  selectedDistance = item.distance;
  schematicView?.moveMarker(item.distance);
  const p = pointAtDistance(result.geometry, item.distance);
  if (!p) return;
  (map.getSource("selected") as GeoJSONSource).setData({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} });
  if (view === "map") map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 14), duration: 500 });
  else map.jumpTo({ center: p, zoom: Math.max(map.getZoom(), 14) });
}

let mapNeedsFit = false;

function fitRoute(): void {
  const b = result && bounds(result.geometry.coordinates);
  if (!b) return;
  if (view !== "map") {
    mapNeedsFit = view !== "drive" || mapNeedsFit; // a hidden map has no size to fit into
    return;
  }
  mapNeedsFit = false;
  map.fitBounds(b, { padding: 50, duration: 0, maxZoom: 13 });
}

// ---------------------------------------------------------------- schematic

const schematicScroll = $("sch-scroll");

function drawSchematic(): void {
  schematicView = undefined;
  if (view !== "schematic") return;
  if (!result) {
    const d = document.createElement("p");
    d.className = "sch-empty";
    d.textContent = "Choose a route to see its schematic track layout: the route as a straight line, with every track around it in its own lane.";
    schematicScroll.replaceChildren(d);
    return;
  }
  if (schematic?.result !== result) {
    const { heuristic, solved } = result.engine.schematics(result, solver);
    const entry = { result, layout: heuristic };
    schematic = entry;
    schematicScroll.dataset.layout = "heuristic";
    void solved.then((layout) => {
      if (schematic !== entry) return;
      entry.layout = layout;
      schematicScroll.dataset.layout = "solved";
      if (view !== "schematic" || !schematicView) return;
      // keep the route distance at the left edge (or in the middle) of the view where it is
      const box = schematicScroll;
      const anchorPx = box.scrollLeft > 0 ? box.clientWidth / 2 : 0;
      const at = schematicView.distanceAt(box.scrollLeft + anchorPx);
      drawSchematic();
      if (schematicView) box.scrollLeft = schematicView.pxAt(at) - anchorPx;
    });
  }
  const rb = result.routebook;
  const visible = rb.items.map((item, index) => ({ item, index })).filter(({ item }) => !hiddenKinds.has(item.kind));
  schematicView = renderSchematic(schematicScroll, schematic.layout, rb, {
    zoom: schematicZoom,
    ...(selectedDistance !== undefined ? { selectedDistance } : {}),
    onPick: (distance) => {
      // nearest visible routebook item
      let best = visible[0];
      for (const v of visible) if (Math.abs(v.item.distance - distance) < Math.abs((best?.item.distance ?? Infinity) - distance)) best = v;
      if (!best) return;
      selectItem(best.index);
      panel.querySelector(`.rb-row[data-index="${best.index}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    },
  });
}

function setView(next: View): void {
  const leavingDrive = view === "drive" && next !== "drive";
  view = next;
  $("map").hidden = next === "schematic";
  $("schematic").hidden = next !== "schematic";
  for (const v of ["map", "schematic", "drive"] as const) $(`tab-${v}`).setAttribute("aria-selected", String(next === v));
  if (next !== "drive") drive.stop();
  if (next === "map") {
    map.resize();
    if (mapNeedsFit || leavingDrive) fitRoute();
  } else if (next === "drive" && network) {
    map.resize();
    if (selection.from && selection.to && result) {
      drive.start(result, driveStart ?? {});
      driveStart = undefined;
    } else drive.start(undefined);
  }
  drawSchematic();
  syncUrl();
}

const MIN_ZOOM = 0.005;
const MAX_ZOOM = 8;

/** Zoom the schematic, keeping the route distance under `anchorPx` (default: the middle of the view) in place. */
function zoomSchematic(factor: number, anchorPx = schematicScroll.clientWidth / 2): void {
  const box = schematicScroll;
  const at = schematicView?.distanceAt(box.scrollLeft + anchorPx);
  schematicZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, schematicZoom * factor));
  drawSchematic();
  if (at !== undefined && schematicView) box.scrollLeft = schematicView.pxAt(at) - anchorPx;
}

function fitSchematic(): void {
  if (!schematic || !result) return;
  schematicZoom = fitZoom(schematic.layout, result.routebook, schematicScroll.clientWidth, MIN_ZOOM, MAX_ZOOM);
  drawSchematic();
  schematicScroll.scrollLeft = 0;
}

// Ctrl / Cmd + wheel (and pinch on a touchpad) zooms at the cursor; wheel events are gathered per frame
let wheelFactor = 1;
let wheelAnchor = 0;
let wheelFrame = 0;
schematicScroll.addEventListener(
  "wheel",
  (e) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    wheelFactor *= Math.exp(-e.deltaY * unit * 0.002);
    wheelAnchor = e.clientX - schematicScroll.getBoundingClientRect().left;
    if (wheelFrame) return;
    wheelFrame = requestAnimationFrame(() => {
      wheelFrame = 0;
      const f = wheelFactor;
      wheelFactor = 1;
      zoomSchematic(f, wheelAnchor);
    });
  },
  { passive: false },
);

function intro(): HTMLElement {
  const d = document.createElement("div");
  d.className = "intro";
  d.innerHTML = `<h2>Routebook</h2>
    <p>Choose an origin and a destination: type a station name above, or click an operational point on the map.</p>
    <p>The route is computed on the RINF micro topology (track level). The routebook lists what you meet along the way: lines, speed, gradient, tunnels, signals, switches and km posts.</p>
`;
  // the examples of the chosen dataset, or of every dataset on offer that has some
  const ids = FILTER ? [FILTER] : DATASETS.map((d) => d.id);
  const examples = ids.flatMap((id) => examplesFor(id, CONFIG.examples).map((e) => ({ ...e, dataset: id })));
  if (examples.length) {
    const p = document.createElement("p");
    p.className = "muted";
    p.append("Examples: ");
    examples.forEach((e, i) => {
      if (i) p.append(" · ");
      const a = document.createElement("a");
      const q = new URLSearchParams({ ...(DATASETS.length > 1 ? { dataset: e.dataset } : {}), from: e.from, to: e.to });
      a.href = `?${q}`;
      a.textContent = e.label ?? `${e.from} → ${e.to}`;
      p.append(a);
    });
    d.append(p);
  }
  return d;
}

// ---------------------------------------------------------------- controls

function attachAutocomplete(input: HTMLInputElement, role: "from" | "to"): void {
  const list = document.createElement("ul");
  list.className = "ac-list";
  list.id = `${role}-list`;
  list.setAttribute("role", "listbox");
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-controls", list.id);
  input.setAttribute("aria-autocomplete", "list");
  input.after(list);
  let options: IndexOp[] = [];
  let active = -1;

  const close = () => {
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const pick = (op: IndexOp) => {
    close();
    setEndpoint(role, op);
    input.blur();
  };
  const render = () => {
    list.replaceChildren(
      ...options.map((op, i) => {
        const li = document.createElement("li");
        li.setAttribute("role", "option");
        li.className = i === active ? "active" : "";
        const n = document.createElement("span");
        n.textContent = op.name;
        const c = document.createElement("small");
        c.textContent = FILTER ? op.uopid : `${op.uopid} · ${datasetName(op.dataset)}`;
        li.append(n, c);
        li.addEventListener("mousedown", (e) => {
          e.preventDefault();
          pick(op);
        });
        return li;
      }),
    );
    list.hidden = options.length === 0;
    input.setAttribute("aria-expanded", String(options.length > 0));
  };
  input.addEventListener("input", () => {
    options = searchOps(searchIndex, input.value);
    active = options.length ? 0 : -1;
    render();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!options.length) return;
      active = (active + (e.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
      render();
    } else if (e.key === "Enter") {
      const op = options[active];
      if (op) {
        e.preventDefault();
        pick(op);
      }
    } else if (e.key === "Escape") {
      close();
    }
  });
  input.addEventListener("blur", () => {
    setTimeout(close, 100);
    const cur = selection[role];
    if (!input.value.trim()) {
      if (cur) setEndpoint(role, undefined);
    } else if (cur && input.value !== cur.name) {
      input.value = cur.name;
    }
  });
  input.addEventListener("focus", () => input.select());
  close();
}

function buildFilters(): void {
  const box = $("filters");
  for (const kind of ["line", "speed", "gradient", "op", "tunnel", "signal", "switch", "levelCrossing", "kmPost"]) {
    const label = document.createElement("label");
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = !hiddenKinds.has(kind);
    cb.addEventListener("change", () => {
      if (cb.checked) hiddenKinds.delete(kind);
      else hiddenKinds.add(kind);
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify([...hiddenKinds]));
      } catch {
        /* storage unavailable: keep in memory */
      }
      drawRoutebook();
      drawSchematic();
    });
    label.append(cb, document.createTextNode(` ${KIND_LABELS[kind] ?? kind}`));
    box.append(label);
  }
}

$("swap").addEventListener("click", () => {
  const { from, to } = selection;
  delete selection.from;
  delete selection.to;
  if (to) selection.from = to;
  if (from) selection.to = from;
  fromInput.value = selection.from?.name ?? "";
  toInput.value = selection.to?.name ?? "";
  update();
});
$("clear").addEventListener("click", () => {
  delete selection.from;
  delete selection.to;
  fromInput.value = toInput.value = "";
  update();
});
$("tab-map").addEventListener("click", () => setView("map"));
$("tab-schematic").addEventListener("click", () => setView("schematic"));
$("tab-drive").addEventListener("click", () => setView("drive"));
$("sch-in").addEventListener("click", () => zoomSchematic(1.5));
$("sch-out").addEventListener("click", () => zoomSchematic(1 / 1.5));
$("sch-fit").addEventListener("click", fitSchematic);
attachAutocomplete(fromInput, "from");
attachAutocomplete(toInput, "to");
buildFilters();
panel.replaceChildren(intro());

// ---------------------------------------------------------------- boot

if (CONFIG.title) {
  document.title = CONFIG.title;
  $("brand").textContent = CONFIG.title;
}
const DISCLAIMER = resolveDisclaimer(CONFIG.disclaimer);
if (DISCLAIMER) installDisclaimer(DISCLAIMER);
if (CONFIG.privacy?.url) {
  const box = $("privacy");
  const link = box.querySelector("a")!;
  link.href = CONFIG.privacy.url;
  link.textContent = CONFIG.privacy.label || "Privacy";
  box.hidden = false;
}

/** Network picker in the header, when there is more than one dataset: a filter on the map and the search. */
function buildDatasetPicker(): void {
  const select = $<HTMLSelectElement>("dataset");
  if (DATASETS.length < 2) return;
  select.replaceChildren();
  const all = document.createElement("option");
  all.value = "all";
  all.textContent = "All networks";
  all.selected = FILTER === undefined;
  select.append(all);
  for (const d of DATASETS) {
    const o = document.createElement("option");
    o.value = d.id;
    o.textContent = d.name;
    o.selected = d.id === FILTER;
    select.append(o);
  }
  select.closest<HTMLElement>(".field")!.hidden = false;
  select.addEventListener("change", () => openDataset(select.value === "all" ? undefined : select.value));
}
buildDatasetPicker();

/**
 * Limit the map and the search to one dataset (undefined: all). With an index this is a filter; a data
 * folder without one holds a single bundle, so another dataset means a reload.
 */
function openDataset(id: string | undefined): void {
  if (network?.fromBundle && id !== network.fromBundle) {
    const url = new URL(location.href);
    for (const k of ["from", "to", "at", "play", "country"]) url.searchParams.delete(k);
    url.searchParams.set("dataset", id ?? "all");
    location.assign(url);
    return;
  }
  FILTER = id;
  $<HTMLSelectElement>("dataset").value = id ?? "all";
  applyFilter();
  if (network) searchIndex = buildSearchIndex(visibleOps(network, FILTER));
  // a selection outside the filter is dropped
  for (const role of ["from", "to"] as const) {
    const op = selection[role];
    if (op && FILTER && op.dataset !== FILTER) setEndpoint(role, undefined);
  }
  buildDatasetsButton();
  if (network && !(selection.from && selection.to)) fitNetwork();
  update();
}

/** The Datasets button: which RINF publication the shown network comes from, and how many datasets are on offer. */
function buildDatasetsButton(): void {
  const btn = $<HTMLButtonElement>("datasets-btn");
  const currentId = FILTER ?? result?.dataset;
  const current = currentId ? CATALOGUE.datasets.find((d) => d.id === currentId) : undefined;
  const summary = datasetsSummary(CATALOGUE.datasets);
  if (!current && !summary.label) return;
  btn.replaceChildren();
  if (current) {
    btn.append(Object.assign(document.createElement("b"), { textContent: current.name }));
    btn.append(` RINF ${current.publishedAt ? fmtDate(current.publishedAt) : current.fetchedAt ? `fetched ${fmtDate(current.fetchedAt)}` : ""}`.trimEnd());
  } else {
    btn.append(Object.assign(document.createElement("b"), { textContent: "All networks" }));
    const latest = CATALOGUE.datasets.map((d) => d.publishedAt).filter((d): d is string => !!d).sort().at(-1);
    if (latest) btn.append(` RINF up to ${fmtDate(latest)}`);
  }
  if (summary.label && CATALOGUE.datasets.length > 1) {
    const badge = document.createElement("span");
    badge.className = `badge${summary.problems ? " warn" : summary.updating ? " updating" : ""}`;
    badge.textContent = summary.label;
    if (summary.updating) badge.title = `${summary.updating} dataset${summary.updating === 1 ? "" : "s"} being updated`;
    btn.append(" ", badge);
  }
  btn.hidden = false;
  btn.onclick = () => openDatasetsDialog(CATALOGUE, { ...(currentId ? { current: currentId } : {}), atlasUrl: CONFIG.atlasUrl, onOpen: openDataset });
}

/**
 * The footer and the print: which RINF publication the route (or the chosen dataset) comes from, or,
 * with every network on the map, how many datasets there are and how current they are.
 */
function updateProvenance(dataset: string | undefined = FILTER): void {
  const listed = dataset ? CATALOGUE.datasets.find((d) => d.id === dataset) : undefined;
  const loaded = dataset ? engines.get(dataset)?.bundle.snapshot.meta : undefined;
  if (dataset && (listed || loaded)) {
    $("meta").textContent = provenanceText({
      name: listed?.name ?? loaded?.name ?? loaded?.country ?? datasetName(dataset),
      ...(listed?.graphs ? { graphs: listed.graphs } : loaded?.provenance ? { graphs: loaded.provenance } : {}),
      ...(listed?.publishedAt ? { publishedAt: listed.publishedAt } : {}),
      ...(listed?.fetchedAt ?? loaded?.fetchedAt ? { fetchedAt: (listed?.fetchedAt ?? loaded?.fetchedAt)! } : {}),
      ...(listed?.status ? { status: listed.status } : {}),
      ...(listed?.latest ? { latest: listed.latest } : {}),
    });
    $("rinf-credit").textContent = rinfAttribution(credit(listed?.imName ?? loaded?.imName), { html: false });
  } else {
    const withData = DATASETS.length;
    const latest = CATALOGUE.datasets.map((d) => d.publishedAt).filter((d): d is string => !!d).sort().at(-1);
    $("meta").textContent = `${withData} RINF dataset${withData === 1 ? "" : "s"}${latest ? `, ERA publications up to ${fmtDate(latest)}` : ""}${CATALOGUE.checkedAt ? `, checked ${fmtDate(CATALOGUE.checkedAt, true)}` : ""}`;
    $("rinf-credit").textContent = rinfAttribution(credit(network ? imNamesOf(network) : undefined), { html: false });
  }
}

/** Show the whole network (the chosen dataset, or all of them) when there is no route. */
function fitNetwork(): void {
  const b = network && opsBounds(visibleOps(network, FILTER));
  if (!b) return;
  map.resize(); // the header may have changed height since the map was created (banner, picker)
  map.fitBounds(b, { padding: 30, duration: 0, maxZoom: 9 });
}

setState("loading", "Loading the RINF network…");
const stylePromise = new Promise<void>((resolve) => {
  if (map.isStyleLoaded()) resolve();
  else map.once("style.load", () => resolve());
});

/** The network index, or, for a data folder without one, the one bundle it holds (the old single-dataset mode). */
async function loadIndexOrBundle(): Promise<Network> {
  const indexed = await loadNetwork(BASE);
  if (indexed && indexed.ops.length) return indexed;
  const id = pickDataset(DATASETS, FILTER ?? params.get("dataset") ?? params.get("country"), CONFIG.defaultDataset);
  const bundle = await loadBundle(`${BASE}${id}`);
  engines.set(id, { engine: new RouteEngine(bundle.snapshot, bundle.switches ? { switches: bundle.switches } : {}), bundle });
  FILTER = id;
  return networkFromBundle(id, bundle.snapshot);
}

Promise.all([loadIndexOrBundle(), stylePromise])
  .then(([net]) => {
    network = net;
    if (FILTER && !net.datasets[FILTER] && !net.fromBundle) FILTER = undefined;
    if (net.fromBundle) $<HTMLSelectElement>("dataset").value = net.fromBundle;
    searchIndex = buildSearchIndex(visibleOps(net, FILTER));
    addLayers(net);
    buildDatasetsButton();
    updateProvenance();
    const from = findByCode(net, params.get("from"), FILTER);
    const to = findByCode(net, params.get("to"), from?.dataset ?? FILTER);
    if (from) selection.from = from;
    if (to) selection.to = to;
    fromInput.value = from?.name ?? "";
    toInput.value = to?.name ?? "";
    setState("ready");
    if (!from || !to) fitNetwork();
    setView(view);
    update();
  })
  .catch((e: unknown) => setState("error", e instanceof Error ? e.message : String(e)));

// print the gap list expanded
window.addEventListener("beforeprint", () => document.querySelectorAll<HTMLDetailsElement>(".rb-gaps").forEach((d) => (d.open = true)));
