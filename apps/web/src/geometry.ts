import type { Route } from "@routebook/routing";

export type LngLat = [number, number];

/** Approximate planar distance in metres between two lon/lat points. */
export function metres(a: LngLat, b: LngLat): number {
  const k = Math.cos(((a[1] + b[1]) / 2) * (Math.PI / 180));
  const dx = (b[0] - a[0]) * 111_320 * k;
  const dy = (b[1] - a[1]) * 110_574;
  return Math.hypot(dx, dy);
}

function cumulative(coords: LngLat[]): number[] {
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1]! + metres(coords[i - 1]!, coords[i]!));
  return cum;
}

function interpolate(coords: LngLat[], cum: number[], d: number): LngLat {
  if (d <= 0) return coords[0]!;
  const total = cum.at(-1)!;
  if (d >= total) return coords.at(-1)!;
  let i = 1;
  while (cum[i]! < d) i++;
  const a = coords[i - 1]!, b = coords[i]!;
  const t = (d - cum[i - 1]!) / (cum[i]! - cum[i - 1]! || 1);
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

/**
 * Part of an element geometry between two RINF offsets (metres from the
 * origin). Offsets are mapped proportionally onto the drawn line, because
 * the RINF length and the geometric length differ slightly. Returned in
 * travel order (reversed when from > to).
 */
export function sliceElement(coords: LngLat[], length: number, from: number, to: number): LngLat[] {
  if (coords.length < 2 || length <= 0) return coords.slice();
  const cum = cumulative(coords);
  const total = cum.at(-1)!;
  const a = (Math.min(from, to) / length) * total;
  const b = (Math.max(from, to) / length) * total;
  const out: LngLat[] = [interpolate(coords, cum, a)];
  for (let i = 0; i < coords.length; i++) if (cum[i]! > a && cum[i]! < b) out.push(coords[i]!);
  out.push(interpolate(coords, cum, b));
  return from <= to ? out : out.reverse();
}

export interface RouteGeometry {
  /** whole route as one line, in travel order */
  coordinates: LngLat[];
  /** per step: route-distance span and its slice */
  steps: Array<{ start: number; end: number; coords: LngLat[] }>;
}

export function buildRouteGeometry(
  route: Route,
  geometry: Record<string, LngLat[]>,
  lengths: ReadonlyMap<string, number>,
): RouteGeometry {
  const steps: RouteGeometry["steps"] = [];
  const coordinates: LngLat[] = [];
  for (const s of route.steps) {
    const g = geometry[s.ne];
    const len = lengths.get(s.ne);
    const span = Math.abs(s.to - s.from);
    if (!g || len === undefined) continue;
    const coords = sliceElement(g, len, s.from, s.to);
    steps.push({ start: s.startDistance, end: s.startDistance + span, coords });
    for (const c of coords) {
      const last = coordinates.at(-1);
      if (!last || last[0] !== c[0] || last[1] !== c[1]) coordinates.push(c);
    }
  }
  return { coordinates, steps };
}

/** Map position of a point `d` metres along the route. */
export function pointAtDistance(rg: RouteGeometry, d: number): LngLat | undefined {
  const step = rg.steps.find((s) => d >= s.start - 1e-6 && d <= s.end + 1e-6) ?? (d <= 0 ? rg.steps[0] : rg.steps.at(-1));
  if (!step) return undefined;
  const cum = cumulative(step.coords);
  const frac = step.end > step.start ? (d - step.start) / (step.end - step.start) : 0;
  return interpolate(step.coords, cum, Math.max(0, Math.min(1, frac)) * cum.at(-1)!);
}

export function bounds(coords: LngLat[]): [LngLat, LngLat] | undefined {
  if (coords.length === 0) return undefined;
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of coords) {
    w = Math.min(w, x);
    e = Math.max(e, x);
    s = Math.min(s, y);
    n = Math.max(n, y);
  }
  return [[w, s], [e, n]];
}
