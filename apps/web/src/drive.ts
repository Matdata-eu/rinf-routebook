import type { Routebook, RoutebookItem } from "@routebook/routebook";
import { metres, type LngLat, type RouteGeometry } from "./geometry.js";

/**
 * Drive mode: a simulated train running along a computed route, for the
 * GPS-like follow view. Pure (no DOM, no map) so it can be unit tested.
 * Distances are route distances in metres, as in the routebook.
 */

const DEG = Math.PI / 180;

/** Bearing in degrees (0 = north, clockwise) from a to b. */
export function bearing(a: LngLat, b: LngLat): number {
  const dx = (b[0] - a[0]) * Math.cos(((a[1] + b[1]) / 2) * DEG);
  const dy = b[1] - a[1];
  return (Math.atan2(dx, dy) / DEG + 360) % 360;
}

/** `p` moved `east` and `north` metres. */
export function offset(p: LngLat, east: number, north: number): LngLat {
  return [p[0] + east / (111_320 * Math.cos(p[1] * DEG)), p[1] + north / 110_574];
}

/** Signed smallest difference b − a between two angles, in (−180, 180]. */
export function angleDiff(a: number, b: number): number {
  const d = (((b - a) % 360) + 540) % 360 - 180;
  return d === -180 ? 180 : d;
}

/** Fast lookups along a route geometry, built once per route. */
export interface Along {
  /** route length covered by the geometry (metres, RINF distance) */
  length: number;
  point(d: number): LngLat;
  /** Direction of travel at `d`, taken over a window so simplified geometry does not jitter. */
  heading(d: number, behind?: number, ahead?: number): number;
  /** Share of the drawn line (0..1) before `d`: the `line-progress` of a MapLibre line with lineMetrics. */
  progress(d: number): number;
}

/**
 * Round the corners of a line: each inner vertex is replaced by two points
 * up to `cut` metres before and after it, a few times over. Simplified RINF
 * geometry turns in sharp kinks; a train running through them would jerk.
 */
export function roundCorners(coords: LngLat[], cut = 20, passes = 3): LngLat[] {
  let line = coords;
  for (let pass = 0; pass < passes; pass++) {
    if (line.length < 3) return line;
    const out: LngLat[] = [line[0]!];
    for (let i = 1; i < line.length - 1; i++) {
      const p = line[i - 1]!, c = line[i]!, n = line[i + 1]!;
      const lp = metres(p, c), ln = metres(c, n);
      const tp = lp > 0 ? Math.min(0.4, cut / lp) : 0;
      const tn = ln > 0 ? Math.min(0.4, cut / ln) : 0;
      out.push([c[0] + (p[0] - c[0]) * tp, c[1] + (p[1] - c[1]) * tp], [c[0] + (n[0] - c[0]) * tn, c[1] + (n[1] - c[1]) * tn]);
    }
    out.push(line.at(-1)!);
    line = out;
    cut /= 2;
  }
  return line;
}

export function along(rg: RouteGeometry): Along {
  // route distance -> distance along the drawn (unrounded) line, per step
  const steps: Array<{ start: number; end: number; g0: number; g1: number }> = [];
  const merged: LngLat[] = [];
  let geo = 0;
  for (const s of rg.steps) {
    let len = 0;
    for (let i = 1; i < s.coords.length; i++) len += metres(s.coords[i - 1]!, s.coords[i]!);
    steps.push({ start: s.start, end: s.end, g0: geo, g1: geo + len });
    geo += len;
    for (const c of s.coords) {
      const last = merged.at(-1);
      if (!last || last[0] !== c[0] || last[1] !== c[1]) merged.push(c);
    }
  }
  const length = steps.at(-1)?.end ?? 0;
  const line = roundCorners(merged);
  const cum = [0];
  for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + metres(line[i - 1]!, line[i]!));
  const total = cum.at(-1) ?? 0;

  /** share (0..1) of the line before route distance d */
  const share = (d: number): number => {
    if (steps.length === 0 || geo <= 0) return 0;
    let lo = 0, hi = steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (steps[mid]!.start <= d) lo = mid;
      else hi = mid - 1;
    }
    const s = steps[lo]!;
    const frac = s.end > s.start ? Math.max(0, Math.min(1, (d - s.start) / (s.end - s.start))) : 0;
    return (s.g0 + frac * (s.g1 - s.g0)) / geo;
  };

  const point = (d: number): LngLat => {
    if (line.length === 0) return [0, 0];
    if (line.length === 1) return line[0]!;
    const g = share(d) * total;
    let lo = 1, hi = cum.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < g) lo = mid + 1;
      else hi = mid;
    }
    const a = line[lo - 1]!, b = line[lo]!;
    const t = (g - cum[lo - 1]!) / (cum[lo]! - cum[lo - 1]! || 1);
    return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
  };

  return {
    length,
    point,
    heading(d, behind = 25, ahead = 90) {
      const a = Math.max(0, Math.min(length - 1, d - behind));
      const b = Math.min(length, Math.max(a + 1, d + ahead));
      return bearing(point(a), point(b));
    },
    progress: (d) => Math.max(0, Math.min(1, share(d))),
  };
}

// ---------------------------------------------------------------- speed profile

export interface LimitSpan {
  start: number;
  end: number;
  /** km/h; undefined where RINF has no maximum speed */
  speed?: number;
}

/** Speed in force along the route, from the speed items of the routebook. */
export function speedProfile(rb: Routebook): LimitSpan[] {
  const changes = rb.items
    .filter((i) => i.kind === "speed" || (i.kind === "missing" && i.data?.field === "speed"))
    .sort((a, b) => a.distance - b.distance);
  const spans: LimitSpan[] = [];
  for (const [n, item] of changes.entries()) {
    const start = item.distance;
    const end = changes[n + 1]?.distance ?? rb.length;
    if (end <= start && n < changes.length - 1) continue;
    const speed = item.kind === "speed" ? (item.data?.speed as number | undefined) : undefined;
    const last = spans.at(-1);
    if (last && last.speed === speed) last.end = end;
    else spans.push({ start, end, ...(speed !== undefined ? { speed } : {}) });
  }
  if (spans.length === 0) spans.push({ start: 0, end: rb.length });
  if (spans[0]!.start > 0) spans.unshift({ start: 0, end: spans[0]!.start });
  return spans;
}

export function limitAt(profile: LimitSpan[], d: number): LimitSpan {
  return profile.find((s) => d >= s.start && d < s.end) ?? profile.at(-1)!;
}

export interface TrainParams {
  /** m/s² */
  accel: number;
  /** service braking, m/s² */
  brake: number;
  /** km/h used where RINF has no speed */
  unknownSpeed: number;
  /** km/h, the train's own maximum */
  vmax: number;
}

export const DEFAULT_TRAIN: TrainParams = { accel: 0.5, brake: 0.6, unknownSpeed: 60, vmax: 200 };

/**
 * A simple train: accelerates to the speed in force, brakes ahead of every
 * lower speed so it is reached at the start of its span, and stops at the
 * end of the route. Not a running-time calculation: no train length, no
 * gradient resistance, no stops at stations.
 */
export class TrainSim {
  /** metres along the route */
  d = 0;
  /** m/s */
  v = 0;

  constructor(
    readonly profile: LimitSpan[],
    readonly length: number,
    readonly train: TrainParams = DEFAULT_TRAIN,
  ) {}

  limitMs(span: LimitSpan): number {
    return Math.min(span.speed ?? this.train.unknownSpeed, this.train.vmax) / 3.6;
  }

  /** Highest speed allowed at `d`, including braking for what lies ahead and for the end of the route. */
  allowed(d = this.d): number {
    const b = this.train.brake;
    let v = Math.sqrt(2 * b * Math.max(0, this.length - d));
    for (const s of this.profile) {
      if (s.end <= d) continue;
      const lim = this.limitMs(s);
      v = Math.min(v, s.start <= d ? lim : Math.sqrt(lim * lim + 2 * b * (s.start - d)));
    }
    return v;
  }

  /** Put the train at `d`, running at the speed allowed there. */
  seek(d: number): void {
    this.d = Math.max(0, Math.min(this.length, d));
    this.v = this.d >= this.length ? 0 : this.allowed();
  }

  get finished(): boolean {
    return this.d >= this.length - 0.5;
  }

  /** Advance `dt` seconds of simulated time (in small sub-steps). */
  step(dt: number): void {
    let left = dt;
    while (left > 0 && !this.finished) {
      const h = Math.min(left, 0.1);
      left -= h;
      const target = this.allowed();
      if (this.v < target) this.v = Math.min(target, this.v + this.train.accel * h);
      else this.v = Math.max(target, this.v - this.train.brake * 1.5 * h);
      // creep the last metres so the train actually arrives
      const v = Math.max(this.v, this.length - this.d < 30 ? 1 : 0);
      this.d = Math.min(this.length, this.d + v * h);
    }
    if (this.finished) this.v = 0;
  }
}

/** Seconds from `from` to `to` at the speed in force (no acceleration): a rough ETA. */
export function runningTime(profile: LimitSpan[], from: number, to: number, train: TrainParams = DEFAULT_TRAIN): number {
  let t = 0;
  for (const s of profile) {
    const a = Math.max(s.start, from), b = Math.min(s.end, to);
    if (b > a) t += (b - a) / (Math.min(s.speed ?? train.unknownSpeed, train.vmax) / 3.6);
  }
  return t;
}

// ---------------------------------------------------------------- what is ahead

/** Kinds a driver is told about ahead, like turn instructions in a satnav. */
export const CUE_KINDS = new Set(["signal", "op", "destination", "speed", "tunnel", "levelCrossing"]);

export interface Cue {
  item: RoutebookItem;
  index: number;
  /** metres from the train */
  ahead: number;
}

function isCue(item: RoutebookItem, prev: RoutebookItem | undefined): boolean {
  if (!CUE_KINDS.has(item.kind)) return false;
  if (item.kind === "signal") return item.data?.signalType !== "shunting";
  // tunnel exits are not worth a cue
  if (item.kind === "tunnel") return item.data?.boundary === "enter";
  // a speed item that repeats the speed in force is not a change
  if (item.kind === "speed") return prev === undefined || prev.data?.speed !== item.data?.speed;
  return true;
}

/** The next cues after `d` (an item exactly under the train still counts for 1 m). */
export function cuesAhead(rb: Routebook, d: number, count = 3): Cue[] {
  const out: Cue[] = [];
  let prevSpeed: RoutebookItem | undefined;
  for (const [index, item] of rb.items.entries()) {
    const wasSpeed = prevSpeed;
    if (item.kind === "speed") prevSpeed = item;
    if (item.distance < d - 1 || !isCue(item, item.kind === "speed" ? wasSpeed : undefined)) continue;
    out.push({ item, index, ahead: Math.max(0, item.distance - d) });
    if (out.length >= count) break;
  }
  return out;
}

/** The next operational point (or the destination) after `d`. */
export function nextStop(rb: Routebook, d: number): Cue | undefined {
  for (const [index, item] of rb.items.entries()) {
    if ((item.kind === "op" || item.kind === "destination") && item.distance > d + 1) return { item, index, ahead: item.distance - d };
  }
  return undefined;
}

/** Index of the last routebook item at or before `d`. */
export function lastPassed(rb: Routebook, d: number, skip: ReadonlySet<string> = new Set()): number | undefined {
  let last: number | undefined;
  for (const [index, item] of rb.items.entries()) {
    if (item.distance > d) break;
    if (!skip.has(item.kind)) last = index;
  }
  return last;
}

/** Gradient (‰) in force at `d`. */
export function gradientAt(rb: Routebook, d: number): number | undefined {
  let g: number | undefined;
  for (const item of rb.items) {
    if (item.distance > d) break;
    if (item.kind === "gradient") g = item.data?.gradient as number;
  }
  return g;
}

/** The tunnel the train is in at `d`, if any. */
export function tunnelAt(rb: Routebook, d: number): RoutebookItem | undefined {
  const open = new Map<string, RoutebookItem>();
  for (const item of rb.items) {
    if (item.distance > d) break;
    if (item.kind !== "tunnel" || !item.source) continue;
    const b = item.data?.boundary;
    if (b === "enter" || b === "inside at start") open.set(item.source, item);
    else open.delete(item.source);
  }
  return [...open.values()].at(-1);
}

/** Line name in force at `d`. */
export function lineAt(rb: Routebook, d: number): string | undefined {
  let line: string | undefined;
  for (const item of rb.items) {
    if (item.distance > d) break;
    if (item.kind === "line") line = item.label;
  }
  return line;
}

// ---------------------------------------------------------------- the train

export interface TrainPart {
  ring: LngLat[];
  base: number;
  height: number;
  color: string;
}

export interface TrainStyle {
  cars: number;
  carLength: number;
  gap: number;
  /** drawn wider than real (about 3 m) so it reads at satnav zoom levels */
  width: number;
  body: string;
  windows: string;
  nose: string;
}

export const DEFAULT_TRAIN_STYLE: TrainStyle = { cars: 4, carLength: 24, gap: 1.2, width: 4.2, body: "#e9edf1", windows: "#22313f", nose: "#0563bb" };

/**
 * Footprints of a little train whose front is at `d`, following the curves
 * of the route: one stack of extrusions per car (body, window band, roof).
 * The leading car has a tapered nose in the accent colour.
 */
export function trainParts(a: Along, d: number, style: TrainStyle = DEFAULT_TRAIN_STYLE): TrainPart[] {
  const parts: TrainPart[] = [];
  const half = style.width / 2;
  const at = (s: number, side: number): LngLat => {
    const c = a.point(Math.max(0, s));
    // over ±8 m, so the sides turn gradually where the simplified geometry has a corner
    const h = a.heading(s, 8, 8) * DEG;
    // left of the direction of travel is (−cos, +sin) in (east, north)
    return offset(c, -Math.cos(h) * side, Math.sin(h) * side);
  };
  for (let n = 0; n < style.cars; n++) {
    const front = d - n * (style.carLength + style.gap);
    const back = front - style.carLength;
    const samples = [0, 0.25, 0.5, 0.75, 1].map((t) => front - t * style.carLength);
    const narrowFront = n === 0;
    const width = (s: number) => (narrowFront && s > front - 3 ? half * (0.45 + 0.55 * ((front - s) / 3)) : half);
    const shape = n === 0 ? [front, front - 1.5, ...samples.slice(1)] : samples;
    const left = shape.map((s) => at(s, width(s)));
    const right = shape.map((s) => at(s, -width(s))).reverse();
    const ring = [...left, ...right, left[0]!];
    if (back < -style.carLength) break;
    parts.push({ ring, base: 0.6, height: 2.3, color: n === 0 ? style.nose : style.body });
    parts.push({ ring, base: 2.3, height: 3.3, color: style.windows });
    parts.push({ ring, base: 3.3, height: 4.1, color: n === 0 ? style.nose : style.body });
  }
  return parts;
}

// ---------------------------------------------------------------- formatting

export function formatDistance(m: number): string {
  if (m < 950) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${(m / 1000).toFixed(m < 9950 ? 1 : 0)} km`;
}

export function formatDuration(s: number): string {
  const min = Math.round(s / 60);
  if (min < 1) return "< 1 min";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, "0")}`;
}
