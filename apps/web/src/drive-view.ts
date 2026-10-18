import maplibregl, { type GeoJSONSource, type Map as MapLibreMap } from "maplibre-gl";
import type { Routebook, RoutebookItem } from "@routebook/routebook";
import type { RouteResult } from "./engine.js";
import type { LngLat } from "./geometry.js";
import { TrainLayer } from "./train-layer.js";
import {
  along,
  angleDiff,
  cuesAhead,
  formatDistance,
  formatDuration,
  gradientAt,
  lastPassed,
  limitAt,
  lineAt,
  nextStop,
  runningTime,
  speedProfile,
  trainParts,
  tunnelAt,
  TrainSim,
  type Along,
  type Cue,
  type LimitSpan,
} from "./drive.js";

/**
 * The Drive view: a satnav-style, heading-up camera that follows a little 3D
 * train along the computed route, with the routebook told as cues ahead
 * (signals, speeds, the next operational point) and a driver's HUD.
 */

export type CameraMode = "chase" | "cab" | "top";

const CAMERAS: Record<CameraMode, { pitch: number; zoom: number; padTop: number; speedZoom: number }> = {
  chase: { pitch: 64, zoom: 17.9, padTop: 0.22, speedZoom: 1.0 },
  cab: { pitch: 76, zoom: 18.6, padTop: 0.26, speedZoom: 0.6 },
  top: { pitch: 0, zoom: 15.8, padTop: 0.2, speedZoom: 0.8 },
};

const RATES = [1, 5, 20, 60];
/** markers are shown for items this far ahead (and a little behind) the train */
const MARKER_AHEAD = 3000;
const MARKER_BEHIND = 80;
const MARKER_KINDS = new Set(["signal", "speed", "op", "origin", "destination", "levelCrossing", "tunnel"]);

const SIGNAL_COLORS: Record<string, string> = {
  home: "#c0392b", exit: "#8e44ad", block: "#27ae60", intermediate: "#e67e22", shunting: "#7f8c8d", distant: "#f1c40f",
};

const emptyFc = { type: "FeatureCollection" as const, features: [] };

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

export interface DriveOptions {
  /** called with the index of the last routebook item the train has passed */
  onPassed?: (index: number) => void;
  /** called when the train position changes enough to be worth keeping (e.g. in the URL) */
  onPosition?: (distance: number) => void;
}

interface Run {
  result: RouteResult;
  rb: Routebook;
  a: Along;
  profile: LimitSpan[];
  sim: TrainSim;
  /** map position of every routebook item, by index */
  itemPoints: LngLat[];
}

export class DriveView {
  private readonly hud: HTMLElement;
  private readonly ui: Record<string, HTMLElement> = {};
  private run: Run | undefined;
  private active = false;
  private playing = false;
  private rate = 1;
  private camera: CameraMode = "chase";
  private zoomBias = 0;
  private camBearing: number | undefined;
  private frame = 0;
  private last = 0;
  private slowTick = 0;
  private passed: number | undefined;
  private readonly markers = new Map<number, maplibregl.Marker>();
  private layersReady = false;
  private readonly train = new TrainLayer("drive-train");
  private saved: { background?: unknown } = {};
  private reportedAt = -Infinity;

  constructor(
    private readonly map: MapLibreMap,
    stage: HTMLElement,
    private readonly opts: DriveOptions = {},
  ) {
    this.hud = this.buildHud();
    this.hud.hidden = true;
    stage.append(this.hud);
    map.getContainer().addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    document.addEventListener("keydown", (e) => {
      if (!this.active || (e.target instanceof HTMLElement && e.target.closest("input, select, textarea"))) return;
      if (e.key === " ") {
        e.preventDefault();
        this.setPlaying(!this.playing);
      }
    });
  }

  get isActive(): boolean {
    return this.active;
  }

  get distance(): number | undefined {
    return this.run?.sim.d;
  }

  // ------------------------------------------------------------ lifecycle

  /** Enter the view (or switch it to a new route). `at` puts the train somewhere along the route. */
  start(result: RouteResult | undefined, opts: { at?: number; play?: boolean } = {}): void {
    if (!this.active) this.enter();
    if (!result) {
      this.clearRun();
      this.ui.empty!.hidden = false;
      return;
    }
    this.ui.empty!.hidden = true;
    if (this.run?.result !== result) {
      this.clearRun();
      const rb = result.routebook;
      const a = along(result.geometry);
      const profile = speedProfile(rb);
      this.run = { result, rb, a, profile, sim: new TrainSim(profile, rb.length), itemPoints: rb.items.map((i) => a.point(i.distance)) };
      (this.ui.scrub as HTMLInputElement).max = String(Math.round(rb.length));
      this.ui.dest!.textContent = rb.to.name;
      this.camBearing = undefined;
    }
    if (opts.at !== undefined) this.seek(opts.at);
    this.setPlaying(opts.play ?? this.playing);
    this.render(true);
  }

  /** Leave the view: restore the map to the plain overview. */
  stop(): void {
    if (!this.active) return;
    this.active = false;
    this.setPlaying(false);
    cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.hud.hidden = true;
    document.body.classList.remove("driving");
    this.clearMarkers();
    const m = this.map;
    for (const id of ["drive-tracks", "drive-route-casing", "drive-route", "drive-train"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
    for (const id of ["route", "route-casing", "sols"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "visible");
    if (this.saved.background !== undefined) m.setPaintProperty("bg", "background-color", this.saved.background);
    for (const h of [m.dragPan, m.dragRotate, m.scrollZoom, m.touchZoomRotate, m.doubleClickZoom, m.keyboard]) h.enable();
    m.setPadding({ top: 0, bottom: 0, left: 0, right: 0 });
    m.jumpTo({ pitch: 0, bearing: 0 });
  }

  /** Move the train to `d` metres along the route (e.g. a routebook row was clicked). */
  seek(d: number): void {
    const run = this.run;
    if (!run) return;
    run.sim.seek(d);
    this.camBearing = undefined;
    this.passed = undefined;
    this.render(true);
  }

  private enter(): void {
    this.active = true;
    this.hud.hidden = false;
    document.body.classList.add("driving");
    const m = this.map;
    this.ensureLayers();
    for (const id of ["drive-tracks", "drive-route-casing", "drive-route", "drive-train"]) m.setLayoutProperty(id, "visibility", "visible");
    for (const id of ["route", "route-casing", "sols"]) if (m.getLayer(id)) m.setLayoutProperty(id, "visibility", "none");
    this.saved.background = m.getPaintProperty("bg", "background-color");
    m.setPaintProperty("bg", "background-color", "#e3e8df");
    // the camera is ours while driving; the mouse wheel zooms around the train
    for (const h of [m.dragPan, m.dragRotate, m.scrollZoom, m.touchZoomRotate, m.doubleClickZoom, m.keyboard]) h.disable();
    m.setMaxPitch(80);
    this.last = performance.now();
    const loop = (now: number) => {
      this.frame = requestAnimationFrame(loop);
      const dt = Math.min(0.25, (now - this.last) / 1000);
      this.last = now;
      if (this.playing && this.run) {
        this.run.sim.step(dt * this.rate);
        if (this.run.sim.finished) this.setPlaying(false);
      }
      this.render(false, dt);
    };
    this.frame = requestAnimationFrame(loop);
  }

  private clearRun(): void {
    this.run = undefined;
    this.passed = undefined;
    this.clearMarkers();
    this.train.setParts([]);
  }

  private ensureLayers(): void {
    if (this.layersReady) return;
    this.layersReady = true;
    const m = this.map;
    const before = m.getLayer("route-casing") ? "route-casing" : undefined;
    // every micro track of the network, so stations show their track fans around the train
    m.addSource("drive-tracks", { type: "geojson", data: emptyFc });
    m.addLayer(
      {
        id: "drive-tracks",
        type: "line",
        source: "drive-tracks",
        layout: { "line-cap": "round", "line-join": "round" },
        paint: { "line-color": "#7c8a97", "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 1, 16, 2.5, 19, 9] },
      },
      before,
    );
    m.addLayer({
      id: "drive-route-casing",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#ffffff", "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 6, 16, 14, 19, 46] },
    });
    m.addLayer({
      id: "drive-route",
      type: "line",
      source: "route",
      layout: { "line-cap": "round", "line-join": "round" },
      paint: {
        "line-width": ["interpolate", ["exponential", 2], ["zoom"], 12, 3.5, 16, 8, 19, 30],
        "line-gradient": this.routeGradient(0),
      },
    });
    m.addLayer(this.train);
    m.setSky({ "sky-color": "#9fc5e8", "horizon-color": "#e8f1f8", "fog-color": "#e3e8df", "sky-horizon-blend": 0.6, "horizon-fog-blend": 0.7, "fog-ground-blend": 0.92, "atmosphere-blend": 0.6 });
  }

  /** Load the network tracks for the background once the snapshot is known. */
  setNetwork(geometry: Record<string, LngLat[]>): void {
    this.ensureLayers();
    const features = Object.values(geometry)
      .filter((c) => c.length >= 2)
      .map((coordinates) => ({ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates }, properties: {} }));
    (this.map.getSource("drive-tracks") as GeoJSONSource).setData({ type: "FeatureCollection", features });
    if (!this.active) for (const id of ["drive-tracks", "drive-route-casing", "drive-route", "drive-train"]) this.map.setLayoutProperty(id, "visibility", "none");
  }

  private routeGradient(p: number): maplibregl.ExpressionSpecification {
    // travelled part grey, the part ahead in the accent colour
    const at = Math.min(0.999999, Math.max(0.000001, p));
    return ["step", ["line-progress"], "#808893", at, "#0563bb"];
  }

  // ------------------------------------------------------------ controls

  setPlaying(on: boolean): void {
    if (on && this.run?.sim.finished) this.seek(0);
    this.playing = on && this.run !== undefined;
    const b = this.ui.play as HTMLButtonElement | undefined;
    if (b) {
      b.textContent = this.playing ? "❚❚" : "▶";
      b.setAttribute("aria-label", this.playing ? "Pause" : "Play");
      b.title = this.playing ? "Pause (space)" : "Play (space)";
    }
  }

  setCamera(mode: CameraMode): void {
    this.camera = mode;
    this.zoomBias = 0;
    for (const b of this.hud.querySelectorAll<HTMLButtonElement>("[data-camera]")) b.setAttribute("aria-pressed", String(b.dataset.camera === mode));
    this.render(true);
  }

  private onWheel(e: WheelEvent): void {
    if (!this.active) return;
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 400 : 1;
    this.zoomBias = Math.max(-4, Math.min(2, this.zoomBias - e.deltaY * unit * 0.002));
    this.render(true);
  }

  private buildHud(): HTMLElement {
    const hud = el("div", "drive-hud");
    const ui = this.ui;

    const empty = el("p", "drv-empty", "Choose a route to drive it: the camera follows a train along the route, and the routebook is read out as what lies ahead.");
    ui.empty = empty;

    // next cue, like a satnav's next turn
    const cue = el("section", "drv-cue");
    cue.setAttribute("aria-live", "polite");
    ui.cueIcon = el("div", "drv-cue-icon");
    ui.cueDist = el("div", "drv-cue-dist");
    ui.cueLabel = el("div", "drv-cue-label");
    const cueText = el("div", "drv-cue-text");
    cueText.append(ui.cueDist, ui.cueLabel);
    const cueMain = el("div", "drv-cue-main");
    cueMain.append(ui.cueIcon, cueText);
    ui.cueThen = el("ol", "drv-cue-then");
    cue.append(cueMain, ui.cueThen);
    ui.cue = cue;

    ui.tunnel = el("div", "drv-tunnel");

    // speed cluster
    const cluster = el("section", "drv-cluster");
    const speedo = el("div", "drv-speedo");
    ui.speed = el("span", "drv-speed", "0");
    speedo.append(ui.speed, el("small", undefined, "km/h"));
    ui.limit = el("div", "drv-limit", "–");
    ui.limit.title = "Maximum speed in force (RINF)";
    const facts = el("div", "drv-facts");
    ui.grad = el("span", "drv-grad");
    ui.line = el("span", "drv-line");
    facts.append(ui.grad, ui.line);
    cluster.append(speedo, ui.limit, facts);

    // bottom bar
    const bar = el("section", "drv-bar");
    const play = el("button", "btn drv-play", "▶");
    play.type = "button";
    play.addEventListener("click", () => this.setPlaying(!this.playing));
    ui.play = play;
    const rate = el("select", "drv-rate");
    rate.title = "Playback speed";
    rate.setAttribute("aria-label", "Playback speed");
    for (const r of RATES) {
      const o = el("option", undefined, `${r}×`);
      o.value = String(r);
      rate.append(o);
    }
    rate.addEventListener("change", () => (this.rate = Number(rate.value)));
    const cams = el("div", "drv-cams");
    cams.setAttribute("role", "group");
    cams.setAttribute("aria-label", "Camera");
    for (const [mode, label, title] of [["chase", "Chase", "Behind the train"], ["cab", "Cab", "Low, close behind the cab"], ["top", "Top", "From above, heading up"]] as const) {
      const b = el("button", "btn", label);
      b.type = "button";
      b.title = title;
      b.dataset.camera = mode;
      b.setAttribute("aria-pressed", String(mode === this.camera));
      b.addEventListener("click", () => this.setCamera(mode));
      cams.append(b);
    }
    const scrub = el("input", "drv-scrub") as HTMLInputElement;
    scrub.type = "range";
    scrub.min = "0";
    scrub.step = "10";
    scrub.value = "0";
    scrub.setAttribute("aria-label", "Position along the route");
    scrub.addEventListener("input", () => this.seek(Number(scrub.value)));
    ui.scrub = scrub;
    const where = el("div", "drv-where");
    ui.pos = el("span", "drv-pos");
    ui.next = el("span", "drv-next");
    ui.dest = el("span", "drv-dest");
    where.append(ui.pos, ui.next);
    bar.append(play, rate, cams, scrub, where);

    const note = el("p", "drv-note", "Simulated run at the RINF maximum speeds. Not for operational use.");
    hud.append(empty, cue, ui.tunnel, cluster, bar, note);
    return hud;
  }

  // ------------------------------------------------------------ rendering

  private render(force: boolean, dt = 0): void {
    const run = this.run;
    if (!this.active || !run) return;
    const { sim, a, rb } = run;
    const d = sim.d;
    const m = this.map;

    // camera: heading-up, smoothed so simplified geometry does not shake it
    const cam = CAMERAS[this.camera];
    const look = 60 + Math.min(300, sim.v * 4);
    const target = a.heading(d, 20, look);
    if (this.camBearing === undefined || force) this.camBearing = target;
    else this.camBearing = (this.camBearing + angleDiff(this.camBearing, target) * (1 - Math.exp(-dt / 0.45)) + 360) % 360;
    const zoom = cam.zoom - cam.speedZoom * Math.min(1, sim.v / 55) + this.zoomBias;
    const h = m.getContainer().clientHeight;
    // train and camera change in the same frame, so the train stands still on screen
    this.train.setParts(trainParts(a, d));
    m.jumpTo({ center: a.point(d), bearing: this.camBearing, pitch: cam.pitch, zoom, padding: { top: h * cam.padTop, bottom: 0, left: 0, right: 0 } });

    // speed cluster, every frame
    const kmh = Math.round(sim.v * 3.6);
    this.ui.speed!.textContent = String(kmh);
    const span = limitAt(run.profile, d);
    this.ui.limit!.textContent = span.speed !== undefined ? String(span.speed) : "?";
    this.ui.limit!.classList.toggle("unknown", span.speed === undefined);
    this.ui.speed!.parentElement!.classList.toggle("over", span.speed !== undefined && kmh > span.speed + 2);
    (this.ui.scrub as HTMLInputElement).value = String(Math.round(d));

    // the rest a few times a second
    this.slowTick += dt;
    if (!force && this.slowTick < 0.2) return;
    this.slowTick = 0;

    m.setPaintProperty("drive-route", "line-gradient", this.routeGradient(a.progress(d)));
    this.renderCues(cuesAhead(rb, d, 4));

    const g = gradientAt(rb, d);
    this.ui.grad!.textContent = g === undefined ? "" : `${g > 0 ? "↗ +" : g < 0 ? "↘ " : ""}${g.toFixed(1)} ‰`;
    this.ui.line!.textContent = lineAt(rb, d) ?? "";
    const t = tunnelAt(rb, d);
    this.ui.tunnel!.hidden = !t;
    this.hud.classList.toggle("in-tunnel", !!t);
    if (t) this.ui.tunnel!.textContent = `In tunnel: ${t.label ?? "tunnel"}`;

    this.ui.pos!.textContent = `${(d / 1000).toFixed(1)} / ${(rb.length / 1000).toFixed(1)} km`;
    const stop = nextStop(rb, d);
    this.ui.next!.textContent = stop
      ? `${stop.item.label ?? "next point"} in ${formatDistance(stop.ahead)} · ${formatDuration(runningTime(run.profile, d, stop.item.distance))}`
      : sim.finished
        ? `Arrived at ${rb.to.name}`
        : "";

    this.renderMarkers(run, d);

    const p = lastPassed(rb, d, new Set(["kmPost", "switch", "gradient"]));
    if (p !== undefined && p !== this.passed) {
      this.passed = p;
      this.opts.onPassed?.(p);
    }
    if (Math.abs(d - this.reportedAt) > 200 || force) {
      this.reportedAt = d;
      this.opts.onPosition?.(d);
    }
  }

  private renderCues(cues: Cue[]): void {
    const [first, ...rest] = cues;
    this.ui.cue!.hidden = !first;
    if (!first) return;
    this.ui.cueIcon!.replaceChildren(cueIcon(first.item));
    this.ui.cueIcon!.dataset.kind = first.item.kind;
    this.ui.cueDist!.textContent = formatDistance(first.ahead);
    this.ui.cueLabel!.textContent = cueText(first.item);
    this.ui.cueThen!.replaceChildren(
      ...rest.map((c) => {
        const li = el("li");
        const ic = el("span", "drv-then-icon");
        ic.append(cueIcon(c.item));
        li.append(ic, el("span", "drv-then-label", cueText(c.item)), el("span", "drv-then-dist", formatDistance(c.ahead)));
        return li;
      }),
    );
  }

  private renderMarkers(run: Run, d: number): void {
    const keep = new Set<number>();
    for (const [index, item] of run.rb.items.entries()) {
      if (item.distance < d - MARKER_BEHIND) continue;
      if (item.distance > d + MARKER_AHEAD) break;
      if (!MARKER_KINDS.has(item.kind)) continue;
      if (item.kind === "tunnel" && item.data?.boundary !== "enter") continue;
      keep.add(index);
      let mk = this.markers.get(index);
      if (!mk) {
        mk = new maplibregl.Marker({ element: markerElement(item), anchor: "bottom" }).setLngLat(run.itemPoints[index]!).addTo(this.map);
        this.markers.set(index, mk);
      }
      // nearer is bigger and more opaque, like objects along the line
      const ahead = item.distance - d;
      const inner = mk.getElement().firstElementChild as HTMLElement;
      const s = this.camera === "top" ? 1 : Math.max(0.55, Math.min(1.25, 1.3 - ahead / 2200));
      inner.style.transform = `scale(${s.toFixed(3)})`;
      inner.style.opacity = ahead < -20 ? "0.35" : ahead > 2200 ? String(Math.max(0.15, 1 - (ahead - 2200) / 800)) : "1";
    }
    for (const [index, mk] of this.markers) {
      if (keep.has(index)) continue;
      mk.remove();
      this.markers.delete(index);
    }
  }

  private clearMarkers(): void {
    for (const mk of this.markers.values()) mk.remove();
    this.markers.clear();
  }
}

// ---------------------------------------------------------------- cue text and symbols

function cueText(item: RoutebookItem): string {
  switch (item.kind) {
    case "signal": {
      const t = item.data?.signalType ? `${String(item.data.signalType)} signal` : "Signal";
      return item.label ? `${t[0]!.toUpperCase()}${t.slice(1)} ${item.label}` : t;
    }
    case "speed":
      return `Speed ${String(item.data?.speed)} km/h`;
    case "op":
      return item.label ?? "Operational point";
    case "destination":
      return `Arrive at ${item.label ?? "destination"}`;
    case "tunnel":
      return `Tunnel ${item.label ?? ""}${typeof item.data?.length === "number" ? ` (${formatDistance(item.data.length as number)})` : ""}`;
    case "levelCrossing":
      return item.label ? `Level crossing ${item.label}` : "Level crossing";
    default:
      return item.label ?? item.kind;
  }
}

const NS = "http://www.w3.org/2000/svg";

function svg(viewBox: string, body: string, cls: string): SVGSVGElement {
  const s = document.createElementNS(NS, "svg");
  s.setAttribute("viewBox", viewBox);
  s.setAttribute("class", cls);
  s.setAttribute("aria-hidden", "true");
  s.innerHTML = body;
  return s;
}

function cueIcon(item: RoutebookItem): Element {
  if (item.kind === "speed") {
    const sign = el("span", "drv-sign", String(item.data?.speed ?? "?"));
    return sign;
  }
  const color = SIGNAL_COLORS[String(item.data?.signalType)] ?? "#c0392b";
  const bodies: Record<string, string> = {
    signal: `<rect x="13" y="2" width="14" height="24" rx="7" fill="#1c2633"/><circle cx="20" cy="9" r="4.2" fill="${color}"/><circle cx="20" cy="19" r="4.2" fill="#3d4a57"/><rect x="18.5" y="26" width="3" height="12" fill="#1c2633"/>`,
    op: `<rect x="5" y="9" width="30" height="20" rx="4" fill="#1c2633"/><path d="M11 23 h18" stroke="#fff" stroke-width="2.5"/><path d="M20 29 v9" stroke="#1c2633" stroke-width="3"/>`,
    destination: `<path d="M10 37 V4" stroke="#1c2633" stroke-width="3"/><path d="M11 5 h22 l-5 7 l5 7 h-22 z" fill="#0563bb"/>`,
    tunnel: `<path d="M3 36 V20 A17 17 0 0 1 37 20 V36" fill="#56606c"/><path d="M10 36 V22 A10 10 0 0 1 30 22 V36" fill="#1c2633"/>`,
    levelCrossing: `<path d="M7 7 L33 33 M33 7 L7 33" stroke="#c0392b" stroke-width="6" stroke-linecap="round"/><path d="M7 7 L33 33 M33 7 L7 33" stroke="#fff" stroke-width="2" stroke-linecap="round"/>`,
  };
  return svg("0 0 40 40", bodies[item.kind] ?? `<circle cx="20" cy="20" r="8" fill="#56606c"/>`, "drv-icon");
}

/** DOM for a map marker standing at an item; the inner element is scaled with distance. */
function markerElement(item: RoutebookItem): HTMLElement {
  const root = el("div", `drv-mk drv-k-${item.kind}`);
  const inner = el("div", "drv-mk-inner");
  if (item.kind === "speed") {
    inner.append(el("span", "drv-sign", String(item.data?.speed ?? "?")), el("i", "drv-mk-pole"));
  } else if (item.kind === "signal") {
    const color = SIGNAL_COLORS[String(item.data?.signalType)] ?? "#c0392b";
    inner.append(
      svg("0 0 20 44", `<rect x="3" y="1" width="14" height="24" rx="7" fill="#1c2633"/><circle cx="10" cy="8" r="4" fill="${color}"/><circle cx="10" cy="18" r="4" fill="#3d4a57"/><rect x="8.5" y="25" width="3" height="19" fill="#1c2633"/>`, "drv-mk-signal"),
    );
    if (item.label) inner.append(el("span", "drv-mk-label", item.label));
  } else {
    const flag = el("span", "drv-mk-flag", item.kind === "levelCrossing" ? "✕ level crossing" : item.kind === "tunnel" ? `⌒ ${item.label ?? "tunnel"}` : (item.label ?? ""));
    inner.append(flag, el("i", "drv-mk-pole"));
  }
  root.append(inner);
  return root;
}
