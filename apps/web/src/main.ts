import maplibregl, { type GeoJSONSource, type StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./styles.css";
import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { RouteEngine, loadBundle, type RouteResult } from "./engine.js";
import { bounds, pointAtDistance, type LngLat } from "./geometry.js";
import { buildSearchIndex, searchOps, type SearchEntry } from "./search.js";
import { markSelected, renderRoutebook } from "./view.js";
import { KIND_LABELS } from "./strip.js";

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

const style: StyleSpecification = {
  version: 8,
  // key-free glyphs for OP labels; without network the labels are simply not drawn
  glyphs: "https://demotiles.maplibre.org/font/{fontstack}/{range}.pbf",
  sources: {
    osm: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors · RINF © ERA, data: Bane NOR',
    },
  },
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#eef1f4" } },
    { id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.85, "raster-opacity": 0.75 } },
  ],
};

const map = new maplibregl.Map({ container: "map", style, center: [10.0, 61.5], zoom: 4.6, attributionControl: { compact: true } });
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-left");
map.addControl(new maplibregl.ScaleControl({ unit: "metric" }), "bottom-left");
if (import.meta.env.DEV) Object.assign(window, { routebookMap: map });

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
  map.addSource("route", { type: "geojson", data: empty });
  map.addSource("endpoints", { type: "geojson", data: empty });
  map.addSource("selected", { type: "geojson", data: empty });

  map.addLayer({ id: "sols", type: "line", source: "sols", paint: { "line-color": "#5b6b7b", "line-width": ["interpolate", ["linear"], ["zoom"], 5, 1, 10, 2.5] } });
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

function update(): void {
  const url = new URL(location.href);
  for (const role of ["from", "to"] as const) {
    const op = selection[role];
    if (op) url.searchParams.set(role, op.uopid);
    else url.searchParams.delete(role);
  }
  history.replaceState(null, "", url);

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
    const b = bounds(result.geometry.coordinates);
    if (b) map.fitBounds(b, { padding: 50, duration: 0, maxZoom: 13 });
    drawRoutebook();
    setState("routed", `${(result.routebook.length / 1000).toFixed(1)} km, ${result.routebook.items.length} items (${ms} ms)`);
  } catch (e) {
    result = undefined;
    (map.getSource("route") as GeoJSONSource).setData(empty);
    panel.replaceChildren(intro());
    setState("error", e instanceof Error ? e.message : String(e));
  }
}

function drawRoutebook(): void {
  if (!result) return;
  const rb = result.routebook;
  renderRoutebook(panel, rb, {
    hiddenKinds,
    onSelect: (index) => {
      const item = rb.items[index];
      if (!item || !result) return;
      markSelected(panel, index);
      const p = pointAtDistance(result.geometry, item.distance);
      if (!p) return;
      (map.getSource("selected") as GeoJSONSource).setData({ type: "Feature", geometry: { type: "Point", coordinates: p }, properties: {} });
      map.easeTo({ center: p, zoom: Math.max(map.getZoom(), 14), duration: 500 });
    },
  });
}

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
  .then(([snapshot]) => {
    engine = new RouteEngine(snapshot);
    for (const op of snapshot.ops) opsById.set(op.id, op);
    searchIndex = buildSearchIndex(snapshot.ops);
    addLayers(snapshot);
    $("meta").textContent = `RINF snapshot ${snapshot.meta.country}, fetched ${snapshot.meta.fetchedAt.slice(0, 10)}`;
    const find = (code: string | null) => (code ? snapshot.ops.find((o) => o.uopid.toLowerCase() === code.toLowerCase()) : undefined);
    const from = find(params.get("from"));
    const to = find(params.get("to"));
    if (from) selection.from = from;
    if (to) selection.to = to;
    fromInput.value = from?.name ?? "";
    toInput.value = to?.name ?? "";
    setState("ready");
    update();
  })
  .catch((e: unknown) => setState("error", e instanceof Error ? e.message : String(e)));

// print the gap list expanded
window.addEventListener("beforeprint", () => document.querySelectorAll<HTMLDetailsElement>(".rb-gaps").forEach((d) => (d.open = true)));
