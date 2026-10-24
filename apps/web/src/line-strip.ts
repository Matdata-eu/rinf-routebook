import type { Routebook, RoutebookItem, Stretch } from "@routebook/routebook";
import { DEFAULT_TRAIN, TrainSim, speedProfile } from "./drive.js";
import { gradientColor } from "./strip.js";
import { separationNotes } from "./view.js";
import { clockText, type TimetableEntry } from "./timetable.js";
import {
  BANDS,
  STATE_LABELS,
  STRIP_ZOOMS,
  bandSegments,
  gradientSegments,
  sectionRows,
  stretchAt,
  stripScale,
  thinLabels,
  tunnelSpans,
  type BandDef,
  type BandSegment,
} from "./line-strip-model.js";

/**
 * The Strip view: the route as vertical bands (speed, gradient, energy, train protection, radio,
 * structures, names, times) like a paper route book, ahead up or down, at 2 to 60 km per screen.
 * Only the part in view is drawn (the strip of a 450 km route is far taller than any SVG should be).
 * A click opens the section card of the stretch there; ▶ runs a train along it that the strip follows.
 */

const NS = "http://www.w3.org/2000/svg";
const PAD = 24;

export interface LineStripOptions {
  /** a click on the strip at route distance `d` */
  onPick: (d: number) => void;
  /** a click on an operational point's time: stop there or not */
  onToggleStop: (uopid: string) => void;
  /** the train position changed (playing, or seeking by a click) */
  onPosition?: (d: number) => void;
  /** settings changed (zoom, direction): for the URL */
  onSettings?: () => void;
  /** the departure time field changed ("08:15", or "" for none) */
  onDeparture?: (text: string) => void;
}

export interface StripSettings {
  /** route km per screen height */
  zoom: number;
  aheadUp: boolean;
  follow: boolean;
}

interface Column {
  id: string;
  label: string;
  x: number;
  width: number;
  band?: BandDef;
}

function svgEl<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, text?: string): SVGElementTagNameMap[K] {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (text !== undefined) e.textContent = text;
  return e;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** A value's colour slot in a band: the same value always gets the same colour. */
function slot(value: string | undefined): number {
  if (!value) return 0;
  let h = 0;
  for (const c of value) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return h % 6;
}

const fmtKm = (m: number, digits = 1) => (m / 1000).toFixed(digits);

/** Names column: what is labelled, most important first. */
const NAME_PRIORITY: Record<string, number> = { origin: 100, destination: 100, op: 80, border: 75, change: 70, separation: 60, signal: 30, levelCrossing: 20 };

export class LineStrip {
  readonly settings: StripSettings = { zoom: 10, aheadUp: true, follow: true };
  private rb: Routebook | undefined;
  private times = new Map<number, TimetableEntry>();
  private timesOn = false;
  private timeText: (ms: number | undefined) => string = clockText;
  private position: number | undefined;
  private selected: number | undefined;
  private columns: Column[] = [];
  private segments = new Map<string, BandSegment[]>();
  private names: Array<{ item: RoutebookItem; index: number }> = [];
  private labelled: Array<{ item: RoutebookItem; index: number }> = [];
  private tunnels: ReturnType<typeof tunnelSpans> = [];
  private gradients: ReturnType<typeof gradientSegments> = [];
  private scale = stripScale(0, 1, true);
  private frame = 0;
  private sim: TrainSim | undefined;
  private playing = false;
  private rate = 30;
  private lastTick = 0;
  private readonly scroll: HTMLElement;
  private readonly spacer: HTMLElement;
  private readonly svg: SVGSVGElement;
  /** fill patterns of the data states, kept across redraws */
  private readonly defs: SVGDefsElement;
  private readonly head: HTMLElement;
  private readonly card: HTMLElement;
  private readonly empty: HTMLElement;
  private readonly playBtn: HTMLButtonElement;
  private readonly zoomBtns = new Map<number, HTMLButtonElement>();
  private readonly dirBtn: HTMLButtonElement;
  private readonly followBox: HTMLInputElement;
  private readonly depInput: HTMLInputElement;

  constructor(readonly root: HTMLElement, readonly opts: LineStripOptions) {
    root.replaceChildren();
    const tools = el("div", "ls-tools");
    const zooms = el("div", "ls-seg");
    zooms.setAttribute("role", "group");
    zooms.setAttribute("aria-label", "Route km per screen");
    for (const z of STRIP_ZOOMS) {
      const b = el("button", "ls-seg-btn", `${z} km`);
      b.type = "button";
      b.title = `${z} km of route per screen height`;
      b.addEventListener("click", () => this.setZoom(z));
      this.zoomBtns.set(z, b);
      zooms.append(b);
    }
    this.dirBtn = el("button", "btn small", "");
    this.dirBtn.type = "button";
    this.dirBtn.addEventListener("click", () => {
      const keep = this.anchorDistance();
      this.settings.aheadUp = !this.settings.aheadUp;
      this.layout();
      this.scrollTo(keep);
      this.opts.onSettings?.();
    });
    this.playBtn = el("button", "btn small ls-play", "▶ Run");
    this.playBtn.type = "button";
    this.playBtn.title = "Run a train along the route at the RINF maximum speeds; the strip follows it";
    this.playBtn.addEventListener("click", () => (this.playing ? this.pause() : this.play()));
    const rate = el("select", "ls-rate");
    rate.title = "Simulation speed";
    for (const r of [1, 10, 30, 60]) rate.append(Object.assign(document.createElement("option"), { value: String(r), textContent: `${r}×`, selected: r === this.rate }));
    rate.addEventListener("change", () => (this.rate = Number(rate.value)));
    const follow = el("label", "ls-follow");
    this.followBox = Object.assign(document.createElement("input"), { type: "checkbox", checked: this.settings.follow });
    this.followBox.addEventListener("change", () => {
      this.settings.follow = this.followBox.checked;
      if (this.settings.follow && this.position !== undefined) this.scrollTo(this.position);
    });
    follow.append(this.followBox, document.createTextNode(" Follow"));
    follow.title = "Keep the train in view";
    const legend = el("span", "ls-legend");
    for (const [state, label] of Object.entries(STATE_LABELS)) {
      if (state === "value" || state === "noTrack") continue;
      const s = el("span");
      s.append(el("i", `ls-sw st-${state}`), document.createTextNode(label));
      legend.append(s);
    }
    const dep = el("label", "ls-dep");
    dep.title = "Departure time from the origin. Without one the times column shows the running time from the start.";
    this.depInput = Object.assign(document.createElement("input"), { type: "time", step: 60 });
    this.depInput.addEventListener("change", () => this.opts.onDeparture?.(this.depInput.value));
    dep.append(document.createTextNode("Departs "), this.depInput);
    tools.append(zooms, this.dirBtn, this.playBtn, rate, follow, dep);
    this.head = el("div", "ls-head");
    this.head.setAttribute("aria-hidden", "true");
    this.scroll = el("div", "ls-scroll");
    this.scroll.tabIndex = 0;
    this.scroll.setAttribute("aria-label", "Line strip of the route");
    this.spacer = el("div", "ls-spacer");
    this.svg = svgEl("svg", { class: "ls-svg" });
    this.defs = svgEl("defs");
    const hatch = svgEl("pattern", { id: "ls-hatch", width: 6, height: 6, patternUnits: "userSpaceOnUse", patternTransform: "rotate(45)" });
    hatch.append(svgEl("rect", { width: 6, height: 6, class: "ls-pat-bg" }), svgEl("line", { x1: 0, y1: 0, x2: 0, y2: 6, class: "ls-pat-line" }));
    const dots = svgEl("pattern", { id: "ls-dots", width: 5, height: 5, patternUnits: "userSpaceOnUse" });
    dots.append(svgEl("rect", { width: 5, height: 5, class: "ls-pat-bg amber" }), svgEl("circle", { cx: 2.5, cy: 2.5, r: 1.1, class: "ls-pat-dot" }));
    this.defs.append(hatch, dots);
    this.spacer.append(this.svg);
    this.scroll.append(this.spacer);
    this.card = el("aside", "ls-card");
    this.card.hidden = true;
    this.empty = el("p", "sch-empty", "Choose a route to see its line strip: speed, gradient, energy, train protection and radio along the route, with the stations and their times.");
    const foot = el("div", "ls-foot");
    foot.append(legend, el("span", "muted", "Click the strip for the section card; click a time to stop there or pass."));
    root.append(tools, this.head, this.scroll, foot, this.card, this.empty);
    this.scroll.addEventListener("scroll", () => this.schedule());
    this.svg.addEventListener("click", (e) => this.onClick(e));
    new ResizeObserver(() => {
      if (!this.rb || !root.isConnected || root.hidden) return;
      const keep = this.anchorDistance();
      this.layout();
      this.scrollTo(keep);
    }).observe(this.scroll);
    this.syncTools();
  }

  /** Show a routebook (undefined: none) with its timetable, when there is one. */
  set(rb: Routebook | undefined, times?: TimetableEntry[]): void {
    const same = rb === this.rb;
    this.rb = rb;
    this.setTimes(times, false);
    if (!same) {
      this.pause();
      this.sim = undefined;
      this.position = undefined;
      this.selected = undefined;
      this.card.hidden = true;
    }
    this.empty.hidden = !!rb;
    this.scroll.hidden = this.head.hidden = !rb;
    if (!rb) return;
    for (const b of BANDS) this.segments.set(b.id, bandSegments(rb, b));
    this.gradients = gradientSegments(rb);
    this.tunnels = tunnelSpans(rb);
    this.names = rb.items.map((item, index) => ({ item, index })).filter(({ item }) => NAME_PRIORITY[item.kind] !== undefined && !(item.kind === "signal" && item.data?.signalType === "shunting"));
    const keep = same ? this.anchorDistance() : 0;
    this.layout();
    this.scrollTo(same ? keep : this.position ?? 0, !same);
  }

  /** The departure shown in the time field. */
  setDepartureText(text: string): void {
    this.depInput.value = text;
  }

  /** The timetable shown in the times column (undefined: no column), and how a time reads. */
  setTimes(times: TimetableEntry[] | undefined, redraw = true, timeText: (ms: number | undefined) => string = this.timeText): void {
    this.timeText = timeText;
    const had = this.timesOn;
    this.timesOn = !!times;
    this.times = new Map((times ?? []).map((t) => [t.index, t]));
    if (!redraw || !this.rb) return;
    if (had !== this.timesOn) {
      const keep = this.anchorDistance();
      this.layout();
      this.scrollTo(keep);
    } else this.draw();
  }

  /** Mark a route distance (a selected item) and bring it into view. */
  select(d: number | undefined): void {
    this.selected = d;
    if (d !== undefined && this.rb && !this.root.hidden) this.scrollTo(d);
    this.draw();
  }

  /** The train position (from the Drive view or the strip's own run). */
  setPosition(d: number | undefined): void {
    this.position = d;
    if (d !== undefined && this.settings.follow && !this.root.hidden) this.scrollTo(d);
    else this.draw();
  }

  /** Apply settings from the URL. */
  configure(s: Partial<StripSettings>): void {
    Object.assign(this.settings, s);
    this.followBox.checked = this.settings.follow;
    this.syncTools();
  }

  /** The view became visible: lay out at its real size. */
  shown(): void {
    if (!this.rb) return;
    this.layout();
    this.scrollTo(this.selected ?? this.position ?? 0);
  }

  setZoom(z: number): void {
    const keep = this.anchorDistance();
    this.settings.zoom = z;
    this.layout();
    this.scrollTo(keep);
    this.opts.onSettings?.();
  }

  play(): void {
    if (!this.rb) return;
    if (!this.sim || this.sim.finished) {
      this.sim = new TrainSim(speedProfile(this.rb), this.rb.length, DEFAULT_TRAIN);
      this.sim.seek(this.position !== undefined && this.position < this.rb.length - 1 ? this.position : 0);
    }
    this.playing = true;
    this.playBtn.textContent = "❚❚ Pause";
    this.lastTick = performance.now();
    const tick = (now: number) => {
      if (!this.playing || !this.sim) return;
      const dt = Math.min(0.5, (now - this.lastTick) / 1000);
      this.lastTick = now;
      this.sim.step(dt * this.rate);
      this.setPosition(this.sim.d);
      this.opts.onPosition?.(this.sim.d);
      if (this.sim.finished) return this.pause();
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  pause(): void {
    this.playing = false;
    this.playBtn.textContent = "▶ Run";
  }

  // ---------------------------------------------------------------- layout and drawing

  private syncTools(): void {
    for (const [z, b] of this.zoomBtns) b.setAttribute("aria-pressed", String(z === this.settings.zoom));
    this.dirBtn.textContent = this.settings.aheadUp ? "Ahead ↑" : "Ahead ↓";
    this.dirBtn.title = this.settings.aheadUp ? "Ahead is up: the train moves up the strip. Click for ahead down." : "Ahead is down: the train moves down the strip. Click for ahead up.";
  }

  private layout(): void {
    if (!this.rb) return;
    this.syncTools();
    const width = Math.max(320, this.scroll.clientWidth || 800);
    const view = Math.max(200, this.scroll.clientHeight || 600);
    // the bands that fit: on a narrow screen radio and class B go first, then the times
    const want = [...BANDS];
    let fixed = 64 + 34 + 46 + want.reduce((s, b) => s + b.width, 0) + (this.timesOn ? 120 : 0);
    for (const drop of ["radio", "classB"]) {
      if (width - fixed >= 150) break;
      const i = want.findIndex((b) => b.id === drop);
      if (i >= 0) {
        fixed -= want[i]!.width;
        want.splice(i, 1);
      }
    }
    const cols: Column[] = [];
    let x = 0;
    const add = (id: string, label: string, w: number, band?: BandDef) => {
      cols.push({ id, label, x, width: w, ...(band ? { band } : {}) });
      x += w;
    };
    add("km", "km", 64);
    add("grad", "‰", 34);
    for (const b of want) add(b.id, b.label, b.width, b);
    add("struct", "Tunnel", 46);
    const timesW = this.timesOn ? 120 : 0;
    add("names", "Operational points, signals, changes", Math.max(150, width - x - timesW));
    if (this.timesOn) add("times", "Time", timesW);
    this.columns = cols;
    const mpp = (this.settings.zoom * 1000) / view;
    this.scale = stripScale(this.rb.length, mpp, this.settings.aheadUp, PAD);
    this.spacer.style.height = `${this.scale.height}px`;
    this.svg.setAttribute("width", String(x));
    this.labelled = thinLabels(this.names, (n) => this.scale.y(n.item.distance), (n) => NAME_PRIORITY[n.item.kind] ?? 0, 15);
    this.head.replaceChildren(
      ...cols.map((c) => {
        const h = el("span", `ls-h ls-h-${c.id}`, c.label);
        h.style.width = `${c.width}px`;
        if (c.band) h.title = `${c.label}: from the RINF track parameters`;
        return h;
      }),
    );
    this.draw();
  }

  /** The route distance at the reference line of the view (a third up from the bottom, ahead up). */
  private anchorDistance(): number {
    if (!this.rb) return 0;
    const h = this.scroll.clientHeight;
    const y = this.scroll.scrollTop + (this.settings.aheadUp ? h * (2 / 3) : h / 3);
    return this.scale.d(y);
  }

  private scrollTo(d: number, instant = true): void {
    const h = this.scroll.clientHeight;
    const y = this.scale.y(d) - (this.settings.aheadUp ? h * (2 / 3) : h / 3);
    this.scroll.scrollTo({ top: Math.max(0, y), behavior: instant ? "auto" : "smooth" });
    this.draw();
  }

  private schedule(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      this.draw();
    });
  }

  private col(id: string): Column | undefined {
    return this.columns.find((c) => c.id === id);
  }

  /** Draw the part of the strip in view (and a screen above and below). */
  private draw(): void {
    const rb = this.rb;
    if (!rb || this.root.hidden) return;
    const h = this.scroll.clientHeight || 600;
    // the scroll position can still be the one of a taller layout until the browser clamps it
    const scrollTop = Math.min(this.scroll.scrollTop, Math.max(0, this.scale.height - h));
    const top = Math.max(0, scrollTop - h);
    const bottom = Math.min(this.scale.height, scrollTop + 2 * h);
    this.svg.setAttribute("height", String(bottom - top));
    this.svg.style.top = `${top}px`;
    this.svg.setAttribute("viewBox", `0 ${top} ${this.svg.getAttribute("width")} ${bottom - top}`);
    // distances in view
    const dA = this.scale.d(this.settings.aheadUp ? bottom : top), dB = this.scale.d(this.settings.aheadUp ? top : bottom);
    const lo = Math.min(dA, dB), hi = Math.max(dA, dB);
    const g = svgEl("g");
    const y = this.scale.y;
    const span = (a: number, b: number) => {
      const y1 = y(a), y2 = y(b);
      return { y: Math.min(y1, y2), h: Math.max(0.75, Math.abs(y2 - y1)) };
    };
    const inView = (a: number, b: number) => b >= lo && a <= hi;

    // column backgrounds and separators
    for (const c of this.columns) {
      g.append(svgEl("rect", { x: c.x, y: top, width: c.width, height: bottom - top, class: `ls-col ls-col-${c.id}` }));
    }
    const y0 = y(0), yL = y(rb.length);
    const routeTop = Math.min(y0, yL), routeH = Math.abs(yL - y0);

    // km grid: route km every 1, 5 or 10 km
    const step = this.settings.zoom <= 5 ? 1000 : this.settings.zoom <= 10 ? 5000 : 10000;
    const km = this.col("km")!;
    for (let d = Math.ceil(lo / step) * step; d <= hi; d += step) {
      const yy = y(d);
      g.append(svgEl("line", { x1: km.x + km.width - 8, x2: this.columns.at(-1)!.x + this.columns.at(-1)!.width, y1: yy, y2: yy, class: "ls-grid" }));
      g.append(svgEl("text", { x: km.x + km.width - 10, y: yy + 4, class: "ls-km", "text-anchor": "end" }, fmtKm(d, 0)));
    }

    // gradient
    const gr = this.col("grad")!;
    for (const s of this.gradients) {
      if (!inView(s.start, s.end)) continue;
      const r = span(s.start, s.end);
      g.append(svgEl("rect", { x: gr.x + 4, y: r.y, width: gr.width - 8, height: r.h, fill: gradientColor(s.gradient), class: "ls-grad" }));
      if (r.h > 18) g.append(svgEl("text", { x: gr.x + gr.width / 2, y: this.labelY(s.start, s.end), class: "ls-val small", "text-anchor": "middle" }, `${s.gradient > 0 ? "+" : ""}${Math.round(s.gradient)}`));
    }
    if (!this.gradients.length) g.append(svgEl("rect", { x: gr.x + 4, y: routeTop, width: gr.width - 8, height: routeH, class: "st-notPublished" }));

    // parameter bands
    for (const c of this.columns) {
      if (!c.band) continue;
      for (const s of this.segments.get(c.band.id) ?? []) {
        if (!inView(s.start, s.end)) continue;
        const r = span(s.start, s.end);
        // the speed as a bar: wider is faster, like a printed speed band
        const bar = c.band.id === "speed" && s.state === "value";
        const rect = bar
          ? svgEl("rect", { x: c.x + 4, y: r.y, width: Math.max(6, Math.min(1, Number(s.value) / 200) * (c.width - 8)), height: r.h, class: "ls-speed" })
          : svgEl("rect", { x: c.x + 4, y: r.y, width: c.width - 8, height: r.h, class: s.state === "value" ? `ls-v c${slot(s.value)}` : `st-${s.state}` });
        rect.append(svgEl("title", {}, `${c.label}: ${s.state === "value" ? s.value : STATE_LABELS[s.state]} (km ${fmtKm(s.start, 2)}–${fmtKm(s.end, 2)})`));
        g.append(rect);
        if (r.h > 16) {
          const text = s.state === "value" ? s.short ?? s.value ?? "" : s.state === "notApplicable" ? "n/a" : "";
          if (text) g.append(svgEl("text", { x: c.x + c.width / 2, y: this.labelY(s.start, s.end), class: `ls-val${c.band.id === "speed" ? " speed" : ""}`, "text-anchor": "middle" }, text));
        }
      }
    }

    // structures: tunnels, separations, level crossings
    const st = this.col("struct")!;
    for (const t of this.tunnels) {
      if (!inView(t.start, t.end)) continue;
      const r = span(t.start, t.end);
      const rect = svgEl("rect", { x: st.x + 8, y: r.y, width: st.width - 16, height: r.h, rx: 3, class: "ls-tunnel" });
      rect.append(svgEl("title", {}, `${t.label ?? "Tunnel"}${t.length ? `, ${Math.round(t.length)} m` : ""}`));
      g.append(rect);
    }

    // the line itself in the names column, with ticks for OPs, signals and points
    const nm = this.col("names")!;
    const lineX = nm.x + 14;
    g.append(svgEl("line", { x1: lineX, x2: lineX, y1: routeTop, y2: routeTop + routeH, class: "ls-track" }));
    for (const { item } of this.names) {
      if (item.distance < lo || item.distance > hi) continue;
      const yy = y(item.distance);
      if (item.kind === "separation") {
        g.append(svgEl("line", { x1: st.x + 4, x2: st.x + st.width - 4, y1: yy, y2: yy, class: "ls-sep" }));
      } else if (item.kind === "levelCrossing") {
        g.append(svgEl("path", { d: `M${st.x + 11} ${yy - 5} l10 10 m0 -10 l-10 10`, class: "ls-lc" }));
      } else if (item.kind === "op" || item.kind === "origin" || item.kind === "destination") {
        g.append(svgEl("line", { x1: lineX - 9, x2: lineX + 9, y1: yy, y2: yy, class: "ls-op-tick" }));
      } else if (item.kind === "signal") {
        g.append(svgEl("circle", { cx: lineX + 7, cy: yy, r: 3, class: `ls-sig type-${String(item.data?.signalType ?? "")}` }));
      } else if (item.kind === "change" || item.kind === "border") {
        g.append(svgEl("line", { x1: gr.x, x2: nm.x + nm.width, y1: yy, y2: yy, class: "ls-change" }));
      }
    }
    // labels that fit
    for (const { item, index } of this.labelled) {
      if (item.distance < lo || item.distance > hi) continue;
      const yy = y(item.distance);
      const big = item.kind === "op" || item.kind === "origin" || item.kind === "destination";
      const text = item.kind === "separation" ? `${item.label ?? "Separation"}${separationNotes(item.data).length ? ` · ${separationNotes(item.data).join(", ")}` : ""}` : item.label ?? item.kind;
      // a change sits on its dashed line, so its label goes just above it
      const above = item.kind === "change" || item.kind === "border";
      const label = svgEl("text", { x: lineX + (item.kind === "signal" ? 14 : 18), y: above ? yy - 4 : yy + 4, class: `ls-name k-${item.kind}${big ? " big" : ""}`, "data-index": index }, text);
      g.append(label);
      const t = this.times.get(index);
      const tc = this.col("times");
      if (t && tc) {
        const txt = t.stop ? [t.arrival !== undefined ? `a ${this.timeText(t.arrival)}` : "", t.departure !== undefined ? `d ${this.timeText(t.departure)}` : ""].filter(Boolean).join(" ") : this.timeText(t.pass);
        const cell = svgEl("text", { x: tc.x + tc.width - 8, y: yy + 4, class: `ls-time${t.stop ? " stop" : ""}`, "text-anchor": "end", "data-stop": t.uopid ?? "" }, txt);
        if (item.kind === "op") cell.append(svgEl("title", {}, t.stop ? "Stop here. Click: pass without stopping" : "Passing time. Click: stop here"));
        g.append(cell);
      }
    }

    // selection and train
    if (this.selected !== undefined && this.selected >= lo && this.selected <= hi) {
      const yy = y(this.selected);
      g.append(svgEl("line", { x1: 0, x2: nm.x + nm.width, y1: yy, y2: yy, class: "ls-selected" }));
    }
    if (this.position !== undefined && this.position >= lo && this.position <= hi) {
      const yy = y(this.position);
      g.append(svgEl("line", { x1: 0, x2: this.columns.at(-1)!.x + this.columns.at(-1)!.width, y1: yy, y2: yy, class: "ls-pos" }));
      g.append(svgEl("rect", { x: 2, y: yy - 10, width: 56, height: 20, rx: 10, class: "ls-pos-badge" }));
      g.append(svgEl("text", { x: 30, y: yy + 4, class: "ls-pos-text", "text-anchor": "middle" }, fmtKm(this.position, 1)));
    }
    this.svg.replaceChildren(this.defs, g);
  }

  /** Where a segment's label goes: at its start in the direction of travel, kept inside the view. */
  private labelY(a: number, b: number): number {
    const ya = this.scale.y(a), yb = this.scale.y(b);
    return this.settings.aheadUp ? Math.max(ya - 6, yb + 14) : Math.min(ya + 14, yb - 6);
  }

  private onClick(e: MouseEvent): void {
    if (!this.rb) return;
    const target = e.target as Element;
    const stop = target.closest("[data-stop]")?.getAttribute("data-stop");
    if (stop) {
      this.opts.onToggleStop(stop);
      return;
    }
    const box = this.svg.getBoundingClientRect();
    const top = Number(this.svg.style.top.replace("px", "")) || 0;
    const yy = e.clientY - box.top + top;
    const d = this.scale.d(yy);
    this.selected = d;
    this.opts.onPick(d);
    const s = stretchAt(this.rb, d);
    if (s) this.openCard(s);
    this.draw();
  }

  /** The section card: what is in force on a stretch, and why a value is missing. */
  openCard(s: Stretch): void {
    this.card.replaceChildren();
    const close = el("button", "btn icon ls-card-close", "×");
    close.type = "button";
    close.setAttribute("aria-label", "Close the section card");
    close.addEventListener("click", () => (this.card.hidden = true));
    const title = el("h3", "ls-card-title", s.lineLabel ?? "Section");
    const sub = el("p", "ls-card-sub");
    sub.textContent = [
      `Route km ${fmtKm(s.start, 2)}–${fmtKm(s.end, 2)}`,
      s.kmStart !== undefined && s.kmEnd !== undefined ? `line km ${s.kmStart.toFixed(2)}–${s.kmEnd.toFixed(2)}` : undefined,
      s.trackLabel ? `track ${s.trackLabel}` : s.track ? undefined : "no RINF track",
    ].filter(Boolean).join(" · ");
    const table = el("table", "ls-card-table");
    for (const row of sectionRows(s)) {
      const tr = el("tr", `st-row-${row.state}`);
      const th = el("th", undefined, row.label);
      if (row.rinf) th.title = `RINF ${row.rinf}`;
      const td = el("td");
      if (row.state === "value") td.textContent = row.value ?? "";
      else {
        const chip = el("span", `ls-chip chip-${row.state}`);
        chip.append(el("i", `ls-sw st-${row.state}`), document.createTextNode(STATE_LABELS[row.state]));
        td.append(chip);
      }
      tr.append(th, td);
      table.append(tr);
    }
    const note = el("p", "ls-card-note", "Not applicable and not yet available are what the infrastructure manager declares in RINF. Not published: RINF says nothing about it here.");
    this.card.append(close, title, sub, table, note);
    this.card.hidden = false;
  }
}
