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

/**
 * Points of one element in pixels. Where an end lies on another lane than
 * the element, the element turns into its lane at 45° next to that end
 * (horizontal space = lane difference in pixels, less when the element is
 * shorter). An element with kinks (`runs`) changes lane at 45° at each break,
 * on the side of the break nearer the route. A crossover (lane null) runs
 * horizontally on the lane of each end with a 45° diagonal between them in
 * the middle.
 */
export function trackPath(t: SchematicTrack, sx: (x: number) => number, sy: (y: number) => number): Array<[number, number]> {
  const a: [number, number] = [sx(t.from.x), sy(t.from.y)];
  const b: [number, number] = [sx(t.to.x), sy(t.to.y)];
  const dir = b[0] >= a[0] ? 1 : -1;
  const w = Math.abs(b[0] - a[0]);
  if (t.lane === null) {
    const rise = Math.abs(b[1] - a[1]);
    if (t.stub || rise < 0.5 || rise >= w) return [a, b];
    const mid = (a[0] + b[0]) / 2;
    return [a, [mid - (dir * rise) / 2, a[1]], [mid + (dir * rise) / 2, b[1]], b];
  }
  const runs = (t.runs ?? [{ from: t.from.x, to: t.to.x, y: t.lane }]).map((r) => ({ x0: sx(r.from), x1: sx(r.to), y: sy(r.y), lane: r.y, start: 0, end: 0 }));
  // the diagonals each piece holds: the end diagonals, and a lane change on the side nearer the route
  runs[0]!.start = Math.abs(a[1] - runs[0]!.y);
  runs.at(-1)!.end += Math.abs(b[1] - runs.at(-1)!.y);
  for (let i = 1; i < runs.length; i++) {
    const p = runs[i - 1]!, q = runs[i]!;
    const rise = Math.abs(q.y - p.y);
    if (Math.abs(q.lane) < Math.abs(p.lane)) q.start += rise;
    else p.end += rise;
  }
  const pts: Array<[number, number]> = [a];
  for (const r of runs) {
    const room = Math.abs(r.x1 - r.x0);
    const k = r.start + r.end > room ? room / (r.start + r.end) : 1;
    const x0 = r.x0 + dir * r.start * k, x1 = r.x1 - dir * r.end * k;
    if (r.start > 0.5 || pts.length === 1) pts.push([x0, r.y]);
    else pts.push([r.x0, r.y]);
    pts.push([x1, r.y]);
  }
  pts.push(b);
  // drop repeated points
  return pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1]![0]) > 0.01 || Math.abs(p[1] - pts[i - 1]![1]) > 0.01);
}

export interface SchematicViewOptions {
  zoom: number;
  selectedDistance?: number;
  onPick: (distance: number) => void;
}

export interface SchematicView {
  /** Move the selection marker (undefined hides it). */
  moveMarker: (distance: number | undefined) => void;
  /** Route distance (m) at a horizontal pixel offset in the drawing, and back. */
  distanceAt: (px: number) => number;
  pxAt: (distance: number) => number;
}

const SVG = "http://www.w3.org/2000/svg";
const LANE = 26;
const TOP = 76;
/** Bottom band: rows for the line, speed and gradient, then the km ruler. */
const ROW = 16;
const BAND_ROWS = ["line", "speed", "gradient"] as const;
const BOTTOM = BAND_ROWS.length * ROW + 40;
const PAD = 40;
const OP_ROWS = 3;
/** Zoom from which signal names are shown. */
const SIGNAL_LABEL_ZOOM = 2;

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

/** Rough width (px) of a label: no layout pass needed. */
const textWidth = (text: string, size: number) => text.length * size * 0.62;

/** Boxes taken by labels; a label that would overlap one is left out. */
export class LabelSpace {
  private readonly cells = new Map<number, Array<[number, number, number, number]>>();
  private static readonly CELL = 200;

  /** Take the box [x0, x1] × [y0, y1] when it is free; false when it overlaps a label already placed. */
  place(x0: number, y0: number, x1: number, y1: number): boolean {
    const c0 = Math.floor(x0 / LabelSpace.CELL), c1 = Math.floor(x1 / LabelSpace.CELL);
    for (let c = c0; c <= c1; c++) {
      for (const [a0, b0, a1, b1] of this.cells.get(c) ?? []) if (a0 < x1 && x0 < a1 && b0 < y1 && y0 < b1) return false;
    }
    for (let c = c0; c <= c1; c++) {
      const l = this.cells.get(c);
      if (l) l.push([x0, y0, x1, y1]);
      else this.cells.set(c, [[x0, y0, x1, y1]]);
    }
    return true;
  }
}

/** Row (0-based, at most `rows` - 1) for each centred label so that labels in a row keep `gap` px apart; -1 = no room. */
export function labelRows(labels: Array<{ x: number; width: number }>, rows: number, gap = 6): number[] {
  const right = Array.from({ length: rows }, () => -Infinity);
  return labels.map(({ x, width }) => {
    const row = right.findIndex((r) => x - width / 2 >= r + gap);
    if (row >= 0) right[row] = x + width / 2;
    return row;
  });
}

const RULE_TEXT = { name: "same track name", type: "same track type", curvature: "closest curvature" } as const;

function stationXs(s: Schematic, rb: Routebook): { busy: number[]; from: number; to: number } {
  const xsAll = s.tracks.flatMap((t) => [t.from.x, t.to.x]);
  const busy = [
    ...s.tracks.filter((t) => !t.onRoute).flatMap((t) => [t.from.x, t.to.x]),
    ...s.switches.map((w) => w.x),
    ...rb.items.filter((i) => i.kind === "op" || i.kind === "origin" || i.kind === "destination").map((i) => i.distance),
  ];
  return { busy, from: Math.min(0, ...xsAll) - 20, to: Math.max(s.length, ...xsAll) + 20 };
}

/** The x scale of the schematic at a zoom level (1 = 0.5 px/m in stations). */
export function schematicScale(s: Schematic, rb: Routebook, zoom: number): XScale {
  const { busy, from, to } = stationXs(s, rb);
  const z = Math.min(1, zoom);
  return new XScale(busy, from, to, { pxPerM: 0.5 * zoom, margin: 120, compress: 0.08 / Math.sqrt(zoom), minGap: 36 * z, maxGap: 260 * z });
}

/** The largest zoom at which the whole route fits into `width` pixels. */
export function fitZoom(s: Schematic, rb: Routebook, width: number, min = 0.005, max = 8): number {
  const avail = width - 2 * PAD;
  if (schematicScale(s, rb, max).width <= avail) return max;
  let lo = min, hi = max;
  for (let i = 0; i < 40; i++) {
    const mid = Math.sqrt(lo * hi);
    if (schematicScale(s, rb, mid).width <= avail) lo = mid;
    else hi = mid;
  }
  return lo;
}

/** Render the schematic of a route as an SVG inside `root`. */
export function renderSchematic(root: HTMLElement, s: Schematic, rb: Routebook, opts: SchematicViewOptions): SchematicView {
  const scale = schematicScale(s, rb, opts.zoom);
  const sx = (x: number) => PAD + scale.map(x);
  const sy = (y: number) => TOP + (s.maxLane - y + 0.5) * LANE;
  const width = scale.width + 2 * PAD;
  const height = TOP + (s.maxLane - s.minLane + 1) * LANE + BOTTOM;
  const space = new LabelSpace();

  const svg = el("svg", { width, height, viewBox: `0 0 ${width} ${height}`, class: "sch-svg", role: "img", "aria-label": `Schematic track layout ${rb.from.name} to ${rb.to.name}` });

  // OP columns (their names go in the top band, drawn last)
  const ops = el("g", { class: "sch-ops" }, svg);
  const opLabels: Array<{ x: number; y: number; kind: string; name: string; tip: string }> = [];
  const opItems = rb.items.filter((i) => i.kind === "op" || i.kind === "origin" || i.kind === "destination");
  const opNames = opItems.map((i) => (i.label ?? "").replace(/^(Depart|Arrive)\s+/i, ""));
  const rows = labelRows(opItems.map((i, k) => ({ x: sx(i.distance), width: textWidth(opNames[k]!, 12) })), OP_ROWS);
  opItems.forEach((i, k) => {
    const p = sx(i.distance);
    const name = opNames[k]!;
    const tip = `${name} · ${(i.distance / 1000).toFixed(2)} km from the start`;
    const line = el("line", { x1: p, x2: p, y1: TOP - 10, y2: height - BOTTOM, class: `sch-op-line kind-${i.kind}` }, ops);
    if (rows[k]! < 0) {
      title(line, tip);
      return;
    }
    opLabels.push({ x: p, y: 18 + rows[k]! * 18, kind: i.kind, name, tip });
  });

  // tunnels: a band behind the route
  const tunnels = el("g", { class: "sch-tunnels" }, svg);
  const open = new Map<string, number>();
  for (const i of rb.items) {
    if (i.kind !== "tunnel") continue;
    const b = i.data?.["boundary"];
    const key = i.source ?? i.label ?? "";
    let span: [number, number] | undefined;
    if (b === "enter") open.set(key, i.distance);
    else if (b === "exit") span = [open.get(key) ?? 0, i.distance];
    else if (b === "inside at start") span = [0, Math.max(i.distance, ...rb.items.filter((j) => j.kind === "tunnel" && j.source === i.source && j.data?.["boundary"] === "exit").map((j) => j.distance))];
    else if (b === "inside at end") span = [i.distance, s.length];
    if (b === "exit") open.delete(key);
    if (!span) continue;
    const x0 = sx(span[0]), x1 = sx(span[1]);
    const r = el("rect", { x: x0, y: sy(0) - 9, width: Math.max(2, x1 - x0), height: 18, rx: 3, class: "sch-tunnel" }, tunnels);
    title(r, `Tunnel ${i.label ?? ""} · ${((span[1] - span[0]) / 1000).toFixed(2)} km`);
  }
  for (const [key, d] of open) {
    const it = rb.items.find((j) => j.kind === "tunnel" && (j.source ?? j.label) === key);
    const x0 = sx(d), x1 = sx(s.length);
    title(el("rect", { x: x0, y: sy(0) - 9, width: Math.max(2, x1 - x0), height: 18, rx: 3, class: "sch-tunnel" }, tunnels), `Tunnel ${it?.label ?? ""}`);
  }

  // tracks: off-route first, the route on top
  const layer = el("g", { class: "sch-tracks" }, svg);
  const labels = el("g", { class: "sch-labels" }, svg);
  const ordered = [...s.tracks.filter((t) => !t.onRoute), ...s.tracks.filter((t) => t.onRoute)];
  const trackLabels: Array<{ x0: number; x1: number; y: number; text: string }> = [];
  for (const t of ordered) {
    const pts = trackPath(t, sx, sy);
    const cls = ["sch-track", t.onRoute ? "on-route" : "", t.kind ? `kind-${t.kind}` : "", t.stub ? "stub" : ""].filter(Boolean).join(" ");
    const line = el("polyline", { points: pts.map((p) => p.map((v) => v.toFixed(1)).join(",")).join(" "), class: cls }, layer);
    title(line, `Track ${t.track ?? "?"}${t.kind ? ` (${t.kind})` : ""}${t.stub ? " · continues outside the view" : ""}\n${t.ne}`);
    if (t.lane !== null && t.track && !t.onRoute) {
      // on the longest horizontal piece
      let best: [number, number, number] | undefined;
      for (let i = 1; i < pts.length; i++) {
        const p = pts[i - 1]!, q = pts[i]!;
        if (Math.abs(p[1] - q[1]) < 0.5 && (!best || Math.abs(q[0] - p[0]) > best[1] - best[0])) best = [Math.min(p[0], q[0]), Math.max(p[0], q[0]), p[1]];
      }
      if (best) trackLabels.push({ x0: best[0], x1: best[1], y: best[2], text: t.track });
    }
    if (t.towards) {
      // where a line that leaves the view goes
      const [a, b] = [pts.at(-2) ?? pts[0]!, pts.at(-1)!];
      const right = b[0] >= a[0];
      const tx = el("text", { x: b[0] + (right ? 3 : -3), y: b[1] + 3, "text-anchor": right ? "start" : "end", class: "sch-towards" }, labels);
      tx.textContent = right ? `${t.towards} →` : `← ${t.towards}`;
    }
  }

  // crossings and slips: both tracks straight through, marked with an X
  const sw = el("g", { class: "sch-switches" }, svg);
  for (const c of s.crossings ?? []) {
    const x = sx(c.x), y = sy(c.y);
    const g = el("g", { transform: `translate(${x.toFixed(1)},${y.toFixed(1)})`, class: `sch-crossing${c.onRoute ? " on-route" : ""}` }, sw);
    el("path", { d: "M-4,-4 L4,4 M-4,4 L4,-4" }, g);
    title(g, c.slip ? "Slip switch" : "Crossing");
  }

  // switches; their numbers get the label space first, then track names
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
      const text = shortSwitchLabel(w.label);
      const x = sx(w.x), y = sy(w.y) + (w.deviates > 0 ? 15 : -7);
      const half = textWidth(text, 10) / 2 + 1;
      if (space.place(x - half, y - 9, x + half, y + 1)) el("text", { x, y, "text-anchor": "middle", class: "sch-switch-label" }, labels).textContent = text;
    }
  }
  for (const l of trackLabels) {
    const half = textWidth(l.text, 10) / 2 + 1;
    const x = (l.x0 + l.x1) / 2, y = l.y - 4;
    if (l.x1 - l.x0 < 24 + 2 * half || !space.place(x - half, y - 9, x + half, y + 1)) continue;
    el("text", { x, y, "text-anchor": "middle", class: "sch-track-label" }, labels).textContent = l.text;
  }

  // signals on the route: the mast on the right of the track for the direction it applies to (below = right of travel), the arm towards that direction
  const sig = el("g", { class: "sch-signals" }, svg);
  for (const i of rb.items) {
    if (i.kind !== "signal") continue;
    const p = sx(i.distance), y = sy(0);
    const both = i.data?.["direction"] === "both";
    const type = String(i.data?.["signalType"] ?? "");
    const g = el("g", { transform: `translate(${p.toFixed(1)},${y})`, class: type ? `type-${type}` : "" }, sig);
    el("path", { d: "M0,4 V12 M0,12 h5", class: "sch-signal" }, g);
    if (both) el("path", { d: "M0,-4 V-12 M0,-12 h-5", class: "sch-signal" }, g);
    title(g, `Signal ${i.label ?? ""}${type ? ` (${type})` : ""} · ${(i.distance / 1000).toFixed(3)} km${both ? " · both directions" : ""}`);
    if (opts.zoom >= SIGNAL_LABEL_ZOOM && i.label) {
      const text = i.label.replace(/^[^\s-]+-/, "");
      const half = textWidth(text, 9) / 2 + 1;
      if (space.place(p - half, y + 14, p + half, y + 24)) el("text", { x: p, y: y + 23, "text-anchor": "middle", class: "sch-signal-label" }, labels).textContent = text;
    }
  }

  // level crossings: two bars across the route
  const lcs = el("g", { class: "sch-lcs" }, svg);
  for (const i of rb.items) {
    if (i.kind !== "levelCrossing") continue;
    const g = el("g", { transform: `translate(${sx(i.distance).toFixed(1)},${sy(0)})`, class: "sch-lc" }, lcs);
    el("path", { d: "M-3,-9 V9 M3,-9 V9" }, g);
    title(g, `Level crossing ${i.label ?? ""} · ${(i.distance / 1000).toFixed(3)} km`);
  }

  // top band: OP names, kept at the top of the view while scrolling down
  const top = el("g", { class: "sch-band sch-band-top" }, svg);
  el("rect", { x: 0, y: 0, width, height: TOP - 14, class: "sch-band-bg" }, top);
  for (const l of opLabels) {
    const t = el("text", { x: l.x, y: l.y, "text-anchor": "middle", class: `sch-op kind-${l.kind}` }, top);
    t.textContent = l.name;
    title(t, l.tip);
  }

  // bottom band: line, speed and gradient along the route, and the km ruler, kept at the bottom of the view
  const bottom = el("g", { class: "sch-band sch-band-bottom" }, svg);
  const base = height - BOTTOM;
  el("rect", { x: 0, y: base, width, height: BOTTOM, class: "sch-band-bg" }, bottom);
  el("line", { x1: 0, x2: width, y1: base, y2: base, class: "sch-band-edge" }, bottom);
  const names = el("g", { class: "sch-band-names" });
  el("rect", { x: 0, y: base + 1, width: 34, height: BAND_ROWS.length * ROW, class: "sch-band-bg" }, names);
  BAND_ROWS.forEach((row, r) => {
    const y = base + r * ROW + 13;
    el("text", { x: 4, y, class: "sch-band-name" }, names).textContent = row === "line" ? "Line" : row === "speed" ? "km/h" : "‰";
    let free = PAD - 4;
    for (const i of rb.items) {
      if (i.kind !== row) continue;
      const p = sx(i.distance);
      const text = row === "speed" ? String(i.data?.["speed"] ?? i.label ?? "") : row === "gradient" ? (i.label ?? "").replace(/\s*‰$/, "") : (i.label ?? "");
      el("line", { x1: p, x2: p, y1: y - 10, y2: y + 2, class: "sch-band-tick" }, bottom);
      const w = textWidth(text, 10);
      if (p + 2 < free) continue;
      const t = el("text", { x: p + 2, y, class: `sch-band-value kind-${row}` }, bottom);
      t.textContent = text;
      title(t, `${i.label ?? text} · ${(i.distance / 1000).toFixed(3)} km`);
      free = p + 2 + w + 6;
    }
  });
  bottom.append(names);
  const rulerY = base + BAND_ROWS.length * ROW;
  let lastPx = -Infinity;
  for (let km = 0; km * 1000 <= s.length; km++) {
    const p = sx(km * 1000);
    if (p - lastPx < 56) continue;
    lastPx = p;
    el("line", { x1: p, x2: p, y1: rulerY + 4, y2: rulerY + 10, class: "sch-ruler-tick" }, bottom);
    el("text", { x: p, y: rulerY + 24, "text-anchor": "middle", class: "sch-ruler-text" }, bottom).textContent = `${km} km`;
  }
  // keep both bands in view: the top band moves down with the vertical scroll, the bottom band up
  const stick = () => {
    const down = Math.max(0, Math.min(root.scrollTop, height - BOTTOM - TOP));
    top.setAttribute("transform", `translate(0,${down})`);
    const up = Math.min(0, root.scrollTop + root.clientHeight - height);
    bottom.setAttribute("transform", `translate(0,${Math.max(up, TOP - base)})`);
    names.setAttribute("transform", `translate(${root.scrollLeft},0)`);
  };
  root.onscroll = stick;

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
  stick();
  moveMarker(opts.selectedDistance);
  return { moveMarker, distanceAt: (px) => scale.invert(px - PAD), pxAt: (d) => sx(d) };
}
