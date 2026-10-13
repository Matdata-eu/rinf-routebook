import type { Schematic, SchematicTrack } from "./layout.js";

/**
 * The polyline the renderer draws for a track, in layout coordinates (x in
 * route metres, y in lanes), with a 45° diagonal taking `diagonal` metres
 * per lane (less when the element is shorter). Same rules as the web
 * renderer's trackPath: end diagonals next to the ends, a lane change of a
 * kinked track on the side of the break nearer the route, a crossover
 * (lane null) as one diagonal in its middle.
 */
export function drawnPolyline(t: SchematicTrack, diagonal = 40): Array<[number, number]> {
  const a: [number, number] = [t.from.x, t.from.y];
  const b: [number, number] = [t.to.x, t.to.y];
  const dir = b[0] >= a[0] ? 1 : -1;
  const w = Math.abs(b[0] - a[0]);
  if (t.lane === null) {
    const rise = Math.abs(b[1] - a[1]) * diagonal;
    if (t.stub || rise < 1e-9 || rise >= w) return [a, b];
    const mid = (a[0] + b[0]) / 2;
    return [a, [mid - (dir * rise) / 2, a[1]], [mid + (dir * rise) / 2, b[1]], b];
  }
  const runs = (t.runs ?? [{ from: t.from.x, to: t.to.x, y: t.lane }]).map((r) => ({ x0: r.from, x1: r.to, y: r.y, start: 0, end: 0 }));
  runs[0]!.start = Math.abs(a[1] - runs[0]!.y) * diagonal;
  runs.at(-1)!.end += Math.abs(b[1] - runs.at(-1)!.y) * diagonal;
  for (let i = 1; i < runs.length; i++) {
    const p = runs[i - 1]!, q = runs[i]!;
    const rise = Math.abs(q.y - p.y) * diagonal;
    if (Math.abs(q.y) < Math.abs(p.y)) q.start += rise;
    else p.end += rise;
  }
  const pts: Array<[number, number]> = [a];
  for (const r of runs) {
    const room = Math.abs(r.x1 - r.x0);
    const k = r.start + r.end > room ? room / (r.start + r.end) : 1;
    const x0 = r.x0 + dir * r.start * k, x1 = r.x1 - dir * r.end * k;
    pts.push([r.start > 1e-9 || pts.length === 1 ? x0 : r.x0, r.y]);
    pts.push([x1, r.y]);
  }
  pts.push(b);
  return pts.filter((p, i) => i === 0 || Math.abs(p[0] - pts[i - 1]![0]) > 1e-6 || Math.abs(p[1] - pts[i - 1]![1]) > 1e-6);
}

export interface LayoutMetrics {
  /** pairs of drawn tracks that cross each other without sharing a node */
  crossings: number;
  /** pairs of horizontal pieces of different tracks on top of each other on the same lane */
  overlaps: number;
  /** direction changes along the drawn tracks */
  bends: number;
}

const orient = (p: [number, number], q: [number, number], r: [number, number]) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);

/** Proper crossing of two segments (interiors cross; touching or collinear pieces do not count). */
function segmentsCross(p1: [number, number], p2: [number, number], q1: [number, number], q2: [number, number]): boolean {
  const eps = 1e-7;
  const d1 = orient(q1, q2, p1), d2 = orient(q1, q2, p2), d3 = orient(p1, p2, q1), d4 = orient(p1, p2, q2);
  return ((d1 > eps && d2 < -eps) || (d1 < -eps && d2 > eps)) && ((d3 > eps && d4 < -eps) || (d3 < -eps && d4 > eps));
}

/** Quality numbers of a layout, computed from what the renderer draws. */
export function layoutMetrics(s: Schematic, diagonal = 40, onCrossing?: (a: SchematicTrack, b: SchematicTrack) => void): LayoutMetrics {
  const lines = s.tracks.map((t) => {
    const pts = drawnPolyline(t, diagonal);
    let lo = Infinity, hi = -Infinity;
    for (const p of pts) {
      lo = Math.min(lo, p[0]);
      hi = Math.max(hi, p[0]);
    }
    return { t, pts, lo, hi };
  });
  const same = (p: { x: number; y: number }, q: { x: number; y: number }) => Math.abs(p.x - q.x) < 0.5 && Math.abs(p.y - q.y) < 1e-6;
  const shareNode = (a: SchematicTrack, b: SchematicTrack) => same(a.from, b.from) || same(a.from, b.to) || same(a.to, b.from) || same(a.to, b.to);

  let bends = 0;
  for (const { pts } of lines) {
    for (let i = 1; i + 1 < pts.length; i++) {
      const [p, q, r] = [pts[i - 1]!, pts[i]!, pts[i + 1]!];
      if (Math.abs(orient(p, q, r)) > 1e-6) bends++;
    }
  }

  // sweep over x: only pairs whose x extents overlap are compared
  const sorted = [...lines].sort((a, b) => a.lo - b.lo);
  let crossings = 0;
  const active: typeof lines = [];
  for (const cur of sorted) {
    for (let i = active.length - 1; i >= 0; i--) if (active[i]!.hi < cur.lo) active.splice(i, 1);
    for (const o of active) {
      if (shareNode(o.t, cur.t)) continue;
      let hit = false;
      for (let i = 1; i < o.pts.length && !hit; i++) {
        const p1 = o.pts[i - 1]!, p2 = o.pts[i]!;
        if (Math.max(p1[0], p2[0]) < cur.lo || Math.min(p1[0], p2[0]) > cur.hi) continue;
        for (let j = 1; j < cur.pts.length && !hit; j++) hit = segmentsCross(p1, p2, cur.pts[j - 1]!, cur.pts[j]!);
      }
      if (hit) {
        crossings++;
        onCrossing?.(o.t, cur.t);
      }
    }
    active.push(cur);
  }

  // horizontal pieces of off-route tracks on one lane, as the eval has always counted them
  const horiz: Array<[number, number, number, string]> = [];
  for (const t of s.tracks) {
    if (t.onRoute || t.lane === null) continue;
    for (const r of t.runs ?? [{ from: t.from.x, to: t.to.x, y: t.lane }]) horiz.push([r.y, Math.min(r.from, r.to), Math.max(r.from, r.to), t.ne]);
  }
  horiz.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  let overlaps = 0;
  for (let i = 1; i < horiz.length; i++) {
    const p = horiz[i - 1]!, q = horiz[i]!;
    if (p[0] === q[0] && q[1] < p[2] - 2 && p[3] !== q[3]) overlaps++;
  }
  return { crossings, overlaps, bends };
}
