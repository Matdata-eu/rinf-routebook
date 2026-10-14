import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { RouteEngine, loadBundle, type RouteResult } from "./engine.js";
import { bounds, pointAtDistance, type LngLat } from "./geometry.js";
import { buildSearchIndex, searchOps, type SearchEntry } from "./search.js";
import { markSelected, renderRoutebook } from "./view.js";
import { KIND_LABELS } from "./strip.js";
import { fitZoom, renderSchematic, type SchematicView } from "./schematic.js";
import type { Schematic } from "@routebook/schematic";
import { workerSolver } from "./solver-client.js";
import { DriveView } from "./drive-view.js";
import { basemaps, pickBasemap, type Basemap } from "./basemaps.js";

const params = new URLSearchParams(location.search);
const COUNTRY = (params.get("country") ?? "nor").toLowerCase();
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

const BASEMAPS = basemaps(import.meta.env);
let basemap = pickBasemap(BASEMAPS, params.get("base"));

const style: StyleSpecification = {
  version: 8,
  // key-free glyphs for OP labels; without network the labels are simply not drawn
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: { basemap: basemap.source },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#eef1f4" } },
    { id: "basemap", type: "raster", source: "basemap", paint: basemap.paint },
  ],
};

const map = new maplibregl.Map({ container: "map", style, center: [10.0, 61.5], zoom: 4.6, maxPitch: 80, attributionControl: { compact: true } });
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
  map.addLayer({ id: "basemap", type: "raster", source: "basemap", paint: next.paint }, map.getLayer("sols") ? "sols" : undefined);
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
  return { onAdd: () => box, onRemove: () => box.remove() };
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

function addLayers(snapshot: Snapshot): void {
  const sols = {
    type: "FeatureCollection" as const,
    features: snapshot.sols.flatMap((s) => {
      const m = s.wkt?.match(/LINESTRING\s*\(([^)]*)\)/i);
      if (!m) return [];
      const coordinates = m[1]!.split(",").map((p) => p.trim().split(/\s+/).map(Number));
      return [{ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates }, properties: { label: s.label ?? "" } }];
    }),
  };
  const ops = {
    type: "FeatureCollection" as const,
    features: snapshot.ops
      .filter((o) => o.lon !== undefined && o.lat !== undefined)
      .map((o) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [o.lon!, o.lat!] },
        properties: { id: o.id, name: o.name, uopid: o.uopid, station: o.type?.endsWith("/10") ? 1 : 0 },
      })),
  };
  map.addSource("sols", { type: "geojson", data: sols });
  map.addSource("ops", { type: "geojson", data: ops });
  // lineMetrics: the Drive view colours the travelled part of the route by line-progress
  map.addSource("route", { type: "geojson", data: empty, lineMetrics: true });
  map.addSource("endpoints", { type: "geojson", data: empty });
  map.addSource("selected", { type: "geojson", data: empty });

  map.addLayer({ id: "sols", type: "line", source: "sols", paint: { "line-color": basemap.aerial ? SOLS_COLOR.aerial : SOLS_COLOR.plain, "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2.5] } });
  map.addLayer({ id: "route-casing", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 6, 12, 12] } });
  map.addLayer({ id: "route", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" }, paint: { "line-color": "#d35400", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 3.5, 12, 7] } });
  map.addLayer({
    id: "ops",
    type: "circle",
    source: "ops",
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
    filter: ["==", ["get", "station"], 1],
    layout: { "text-field": ["get", "name"], "text-font": ["Open Sans Semibold"], "text-size": 12, "text-offset": [0, 1.1], "text-anchor": "top", "text-optional": true },
    paint: { "text-color": "#1f2d3a", "text-halo-color": "#fff", "text-halo-width": 1.5 },
  });
  map.addLayer({ id: "endpoints", type: "circle", source: "endpoints", paint: { "circle-radius": 9, "circle-color": ["match", ["get", "role"], "from", "#1e8449", "#922b21"], "circle-stroke-color": "#fff", "circle-stroke-width": 3 } });
  map.addLayer({ id: "selected", type: "circle", source: "selected", paint: { "circle-radius": 10, "circle-color": "rgba(241,196,15,0.35)", "circle-stroke-color": "#b7950b", "circle-stroke-width": 3 } });

  map.on("mouseenter", "ops", () => (map.getCanvas().style.cursor = "pointer"));
  map.on("mouseleave", "ops", () => (map.getCanvas().style.cursor = ""));
  map.on("click", "ops", (e) => {
    const id = e.features?.[0]?.properties?.id as string | undefined;
    const op = id ? opsById.get(id) : undefined;
    if (op) openOpPopup(op, e.lngLat);
  });
}

function openOpPopup(op: OperationalPoint, at: maplibregl.LngLatLike): void {
  const box = document.createElement("div");
  box.className = "op-popup";
  const name = document.createElement("strong");
  name.textContent = op.name;
  const code = document.createElement("span");
  code.textContent = ` ${op.uopid}`;
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

let engine: RouteEngine | undefined;
let searchIndex: SearchEntry[] = [];
const opsById = new Map<string, OperationalPoint>();
const selection: { from?: OperationalPoint; to?: OperationalPoint } = {};
let result: RouteResult | undefined;
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

function setEndpoint(role: "from" | "to", op: OperationalPoint | undefined): void {
  if (op) selection[role] = op;
  else delete selection[role];
  (role === "from" ? fromInput : toInput).value = op ? op.name : "";
  update();
}

function opLngLat(op: OperationalPoint): LngLat | undefined {
  return op.lon !== undefined && op.lat !== undefined ? [op.lon, op.lat] : undefined;
}

function syncUrl(): void {
  const url = new URL(location.href);
  for (const role of ["from", "to"] as const) {
    const op = selection[role];
    if (op) url.searchParams.set(role, op.uopid);
    else url.searchParams.delete(role);
  }
  if (view !== "map") url.searchParams.set("view", view);
  else url.searchParams.delete("view");
  if (view === "drive" && driveAt !== undefined && selection.from && selection.to) url.searchParams.set("at", String(Math.round(driveAt)));
  else url.searchParams.delete("at");
  url.searchParams.delete("play");
  if (basemap.id !== BASEMAPS[0]!.id) url.searchParams.set("base", basemap.id);
  else url.searchParams.delete("base");
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

  if (!engine) return;
  if (!selection.from || !selection.to) {
    result = undefined;
    (map.getSource("route") as GeoJSONSource | undefined)?.setData(empty);
    panel.replaceChildren(intro());
    drawSchematic();
    if (view === "drive") drive.start(undefined);
    setState("ready", selection.from || selection.to ? "Pick the other end of the route." : "");
    return;
  }
  setState("routing", "Routing…");
  // let the status paint before the (synchronous) routing
  setTimeout(compute, 0);
}

function compute(): void {
  if (!engine || !selection.from || !selection.to) return;
  try {
    const t0 = performance.now();
    result = engine.route(selection.from, selection.to);
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
    setState("routed", `${(result.routebook.length / 1000).toFixed(1)} km, ${result.routebook.items.length} items (${ms} ms)`);
  } catch (e) {
    result = undefined;
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
  if (!engine || !result) {
    const d = document.createElement("p");
    d.className = "sch-empty";
    d.textContent = "Choose a route to see its schematic track layout: the route as a straight line, with every track around it in its own lane.";
    schematicScroll.replaceChildren(d);
    return;
  }
  if (schematic?.result !== result) {
    const { heuristic, solved } = engine.schematics(result, solver);
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
  } else if (next === "drive" && engine) {
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
    <p class="muted">Examples: <a href="?from=NOOSL&amp;to=NODRM">Oslo S → Drammen</a> · <a href="?from=NOOSL&amp;to=NOBRG">Oslo S → Bergen</a> · <a href="?from=NOTND&amp;to=NOBO">Trondheim S → Bodø</a></p>`;
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
  let options: OperationalPoint[] = [];
  let active = -1;

  const close = () => {
    list.replaceChildren();
    list.hidden = true;
    input.setAttribute("aria-expanded", "false");
    active = -1;
  };
  const pick = (op: OperationalPoint) => {
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
        c.textContent = op.uopid;
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

setState("loading", "Loading RINF snapshot…");
const snapshotPromise = loadBundle(`${import.meta.env.BASE_URL}${COUNTRY}`);
const stylePromise = new Promise<void>((resolve) => {
  if (map.isStyleLoaded()) resolve();
  else map.once("style.load", () => resolve());
});

Promise.all([snapshotPromise, stylePromise])
  .then(([{ snapshot, switches }]) => {
    engine = new RouteEngine(snapshot, switches ? { switches } : {});
    for (const op of snapshot.ops) opsById.set(op.id, op);
    searchIndex = buildSearchIndex(snapshot.ops);
    addLayers(snapshot);
    drive.setNetwork(snapshot.geometry ?? {});
    $("meta").textContent = `RINF snapshot ${snapshot.meta.country}, fetched ${snapshot.meta.fetchedAt.slice(0, 10)}`;
    const find = (code: string | null) => (code ? snapshot.ops.find((o) => o.uopid.toLowerCase() === code.toLowerCase()) : undefined);
    const from = find(params.get("from"));
    const to = find(params.get("to"));
    if (from) selection.from = from;
    if (to) selection.to = to;
    fromInput.value = from?.name ?? "";
    toInput.value = to?.name ?? "";
    setState("ready");
    setView(view);
    update();
  })
  .catch((e: unknown) => setState("error", e instanceof Error ? e.message : String(e)));

// print the gap list expanded
window.addEventListener("beforeprint", () => document.querySelectorAll<HTMLDetailsElement>(".rb-gaps").forEach((d) => (d.open = true)));
