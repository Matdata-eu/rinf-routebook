import type { Schematic, SchematicTrack } from "@routebook/schematic";
import type { Routebook } from "@routebook/routebook";

/**
 * Piecewise-linear x scale for the schematic: around switches and stations
 * one metre is `pxPerM` pixels, open line in between is compressed, so a
 * 500 km route stays scrollable while stations keep their detail.
 */
export class XScale {
  private readonly xs: number[] = [];
  private readonly px: number[] = [];

  constructor(busy: number[], from: number, to: number, opts: { pxPerM: number; margin?: number; compress?: number; minGap?: number; maxGap?: number }) {
    const margin = opts.margin ?? 120;
    const compress = opts.compress ?? 0.04;
    const minGap = opts.minGap ?? 36;
    const maxGap = opts.maxGap ?? 260;
    const spans: Array<[number, number]> = [];
    for (const x of [...busy].sort((a, b) => a - b)) {
      const a = Math.max(from, x - margin), b = Math.min(to, x + margin);
      const last = spans.at(-1);
      if (last && a <= last[1]) last[1] = Math.max(last[1], b);
      else spans.push([a, b]);
    }
    let cx = from, cp = 0;
    this.xs.push(cx);
    this.px.push(cp);
    const quiet = (b: number) => {
      if (b <= cx) return;
      const gap = Math.min(maxGap, Math.max(minGap, (b - cx) * opts.pxPerM * compress));
      cp += Math.min(gap, (b - cx) * opts.pxPerM);
      cx = b;
      this.xs.push(cx);
      this.px.push(cp);
    };
    for (const [a, b] of spans) {
      quiet(a);
      cp += (b - cx) * opts.pxPerM;
      cx = b;
      this.xs.push(cx);
      this.px.push(cp);
    }
    quiet(to);
  }

  get width(): number {
    return this.px.at(-1)!;
  }

  /** metres -> pixels (extrapolates linearly outside the range) */
  map(x: number): number {
    return interp(this.xs, this.px, x);
  }

  /** pixels -> metres */
  invert(p: number): number {
    return interp(this.px, this.xs, p);
  }
}

function interp(a: number[], b: number[], v: number): number {
  const n = a.length;
  if (n === 1) return b[0]!;
  let i = 1;
  if (v <= a[0]!) i = 1;
  else if (v >= a[n - 1]!) i = n - 1;
  else {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (a[mid]! <= v) lo = mid;
      else hi = mid;
    }
    i = hi;
  }
  const a0 = a[i - 1]!, a1 = a[i]!;
  const t = a1 === a0 ? 0 : (v - a0) / (a1 - a0);
  return b[i - 1]! + (b[i]! - b[i - 1]!) * t;
}

/** Points of one element in pixels: diagonals where an end is on another lane. */
export function trackPath(t: SchematicTrack, sx: (x: number) => number, sy: (y: number) => number): Array<[number, number]> {
  const a: [number, number] = [sx(t.from.x), sy(t.from.y)];
  const b: [number, number] = [sx(t.to.x), sy(t.to.y)];
  if (t.lane === null) return [a, b];
  const ly = sy(t.lane);
  const dir = b[0] >= a[0] ? 1 : -1;
  const half = Math.abs(b[0] - a[0]) / 2;
  const pts: Array<[number, number]> = [a];
  if (Math.abs(a[1] - ly) > 0.5) pts.push([a[0] + dir * Math.min(Math.abs(a[1] - ly), half), ly]);
  if (Math.abs(b[1] - ly) > 0.5) pts.push([b[0] - dir * Math.min(Math.abs(b[1] - ly), half), ly]);
  pts.push(b);
  return pts;
}

export interface SchematicViewOptions {
  zoom: number;
  selectedDistance?: number;
  onPick: (distance: number) => void;
}

const SVG = "http://www.w3.org/2000/svg";
const LANE = 26;
const TOP = 58;
const BOTTOM = 40;
const PAD = 40;

function el<K extends keyof SVGElementTagNameMap>(name: K, attrs: Record<string, string | number>, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG, name);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.append(e);
  return e;
}

function title(parent: Element, text: string): void {
  el("title", {}, parent).textContent = text;
}

/** "Nath-Spv140B" -> "140B", "SPV 1" -> "1", "5 Otta" -> "5"; the full name is in the tooltip. */
export function shortSwitchLabel(label: string): string {
  return label.match(/\d+[A-Za-z]?/)?.[0] ?? label;
}

const RULE_TEXT = { name: "same track name", type: "same track type", curvature: "closest curvature" } as const;

/** Render the schematic of a route as an SVG inside `root`. Returns a function that moves the selection marker. */
export function renderSchematic(root: HTMLElement, s: Schematic, rb: Routebook, opts: SchematicViewOptions): (distance: number | undefined) => void {
  const xsAll = s.tracks.flatMap((t) => [t.from.x, t.to.x]);
  const from = Math.min(0, ...xsAll) - 20;
  const to = Math.max(s.length, ...xsAll) + 20;
  const busy = [
    ...s.tracks.filter((t) => !t.onRoute).flatMap((t) => [t.from.x, t.to.x]),
    ...s.switches.map((w) => w.x),
    ...rb.items.filter((i) => i.kind === "op" || i.kind === "origin" || i.kind === "destination").map((i) => i.distance),
  ];
  const scale = new XScale(busy, from, to, { pxPerM: 0.5 * opts.zoom, compress: 0.08 / Math.sqrt(opts.zoom) });
  const sx = (x: number) => PAD + scale.map(x);
  const sy = (y: number) => TOP + (s.maxLane - y + 0.5) * LANE;
  const width = scale.width + 2 * PAD;
  const height = TOP + (s.maxLane - s.minLane + 1) * LANE + BOTTOM;

  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "sch-svg", role: "img", "aria-label": `Schematic track layout ${rb.from.name} to ${rb.to.name}` });

  // km ruler (route distance) and OP columns
  const ruler = el("g", { class: "sch-ruler" }, svg);
  let lastPx = -Infinity;
  for (let km = 0; km * 1000 <= s.length; km++) {
    const p = sx(km * 1000);
    if (p - lastPx < 56) continue;
    lastPx = p;
    el("line", { x1: p, x2: p, y1: height - BOTTOM + 6, y2: height - BOTTOM + 12 }, ruler);
    el("text", { x: p, y: height - BOTTOM + 26, "text-anchor": "middle" }, ruler).textContent = `${km} km`;
  }
  const ops = el("g", { class: "sch-ops" }, svg);
  let opRight = -Infinity, row = 0;
  for (const i of rb.items) {
    if (i.kind !== "op" && i.kind !== "origin" && i.kind !== "destination") continue;
    const p = sx(i.distance);
    el("line", { x1: p, x2: p, y1: TOP - 10, y2: height - BOTTOM, class: `sch-op-line kind-${i.kind}` }, ops);
    const name = (i.label ?? "").replace(/^(Depart|Arrive)\s+/i, "");
    row = p - 6 < opRight ? (row + 1) % 2 : 0;
    const t = el("text", { x: p, y: 18 + row * 18, "text-anchor": "middle", class: `sch-op kind-${i.kind}` }, ops);
    t.textContent = name;
    opRight = p + name.length * 3.6;
    title(t, `${name} · ${(i.distance / 1000).toFixed(2)} km from the start`);
  }

  // tracks: off-route first, the route on top
  const layer = el("g", { class: "sch-tracks" }, svg);
  const labels = el("g", { class: "sch-labels" }, svg);
  const ordered = [...s.tracks.filter((t) => !t.onRoute), ...s.tracks.filter((t) => t.onRoute)];
  for (const t of ordered) {
    const pts = trackPath(t, sx, sy);
    const cls = ["sch-track", t.onRoute ? "on-route" : "", t.kind ? `kind-${t.kind}` : "", t.stub ? "stub" : ""].filter(Boolean).join(" ");
    const line = el("polyline", { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" "), class: cls }, layer);
    title(line, `Track ${t.track ?? "?"}${t.kind ? ` (${t.kind})` : ""}${t.stub ? " · continues outside the view" : ""}\n${t.ne}`);
    // track name on long enough horizontal parts
    if (t.lane !== null && t.track && !t.onRoute) {
      const run = pts.filter((p) => Math.abs(p[1] - sy(t.lane!)) < 0.5);
      if (run.length >= 2) {
        const x0 = Math.min(...run.map((p) => p[0])), x1 = Math.max(...run.map((p) => p[0]));
        if (x1 - x0 > 24 + t.track.length * 7) {
          el("text", { x: (x0 + x1) / 2, y: sy(t.lane) - 4, "text-anchor": "middle", class: "sch-track-label" }, labels).textContent = t.track;
        }
      }
    }
  }

  // switches
  const sw = el("g", { class: "sch-switches" }, svg);
  for (const w of s.switches) {
    const c = el("circle", { cx: sx(w.x), cy: sy(w.y), r: w.onRoute ? 3.5 : 2.5, class: `sch-switch${w.onRoute ? " on-route" : ""}${w.routeDeviates ? " route-deviates" : ""}` }, sw);
    title(
      c,
      `Switch ${w.label ?? "(no RINF switch)"}\n` +
        `Deviating branch: ${w.deviatingSide} of the continuous one (${w.deviates > 0 ? "up" : "down"} here), ${w.facing ? "facing" : "trailing"} in the direction of travel\n` +
        `Continuous branch chosen by: ${RULE_TEXT[w.rule]}` +
        (w.routeDeviates ? "\nThe route takes the deviating branch" : ""),
    );
    if (w.onRoute && w.label) {
      el("text", { x: sx(w.x), y: sy(w.y) + (w.deviates > 0 ? 15 : -7), "text-anchor": "middle", class: "sch-switch-label" }, labels).textContent = shortSwitchLabel(w.label);
    }
  }

  // signals on the route
  const sig = el("g", { class: "sch-signals" }, svg);
  for (const i of rb.items) {
    if (i.kind !== "signal") continue;
    const p = sx(i.distance), y = sy(0);
    const g = el("g", { transform: `translate(${p.toFixed(1)},${y})` }, sig);
    el("path", { d: "M0,-4 V-12 M0,-12 h5", class: "sch-signal" }, g);
    title(g, `Signal ${i.label ?? ""} · ${(i.distance / 1000).toFixed(3)} km`);
  }

  const marker = el("line", { y1: TOP - 10, y2: height - BOTTOM, class: "sch-marker", visibility: "hidden" }, svg);
  const moveMarker = (d: number | undefined) => {
    if (d === undefined) {
      marker.setAttribute("visibility", "hidden");
      return;
    }
    const p = sx(d);
    marker.setAttribute("x1", String(p));
    marker.setAttribute("x2", String(p));
    marker.setAttribute("visibility", "visible");
    const box = root.getBoundingClientRect();
    if (p < root.scrollLeft + 40 || p > root.scrollLeft + box.width - 40) root.scrollTo({ left: p - box.width / 2, behavior: "smooth" });
  };

  svg.addEventListener("click", (e) => {
    const r = svg.getBoundingClientRect();
    const d = scale.invert(e.clientX - r.left - PAD);
    opts.onPick(Math.max(0, Math.min(s.length, d)));
  });

  root.replaceChildren(svg);
  moveMarker(opts.selectedDistance);
  return moveMarker;
}
