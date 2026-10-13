import type { SchematicPoint, SchematicTrack } from "./layout.js";

/**
 * Kinks on the tracks next to the route: a second pass over a finished lane
 * layout that lets every off-route track change lane wherever the topology
 * changes, so that it sits as close to the route as the tracks between them
 * allow, and steps outwards only where something appears between it and the
 * route (a siding, a switch, a crossover).
 *
 * The formulation follows railplot's level model (Bjørnar Luteberget,
 * https://github.com/luteberget/railplot, MIT licence): x is cut at every
 * node into slabs, each element gets a level per slab, the vertical order of
 * the tracks in a slab is a constraint (`lower + 1 <= upper`), the straight
 * pair through a node shares its level and a branch lies at least one level
 * to its side. railplot hands those constraints to a SAT solver; here the
 * order comes from the first pass and the levels are the least fixpoint of
 * the constraints (a longest path from the route outwards), which is the
 * lowest drawing that keeps that order and needs no solver.
 *
 * A lane change needs room for its 45° diagonal, drawn on the side of the
 * break that is nearer the route; a dip too short for that is raised again.
 */
export interface KinkOptions {
  /** Metres of horizontal room needed per lane changed (default 40). */
  minRun?: number;
}

interface Item {
  t: SchematicTrack;
  /** slab index range [k0, k1) covered, in the direction from → to */
  k0: number;
  k1: number;
  /** the element runs from `from` towards increasing x */
  fwd: boolean;
  vars: number[];
}

export function addKinks(tracks: SchematicTrack[], opts: KinkOptions = {}): void {
  const minRun = opts.minRun ?? 40;
  const items: Item[] = [];
  const pts = new Map<SchematicPoint, number>();
  const old: number[] = [];
  const newVar = (level: number) => old.push(level) - 1;
  const pointVar = (p: SchematicPoint) => {
    let v = pts.get(p);
    if (v === undefined) pts.set(p, (v = newVar(p.y)));
    return v;
  };
  const laid = tracks.filter((t) => !t.onRoute && !(t.stub && t.lane === null));
  for (const t of laid) {
    pointVar(t.from);
    pointVar(t.to);
  }
  // breakpoints: the x of every node, rounded so that coincident nodes share one
  const key = (x: number) => Math.round(x * 100) / 100;
  const xs = [...new Set([...pts.keys()].map((p) => key(p.x)))].sort((a, b) => a - b);
  const at = new Map(xs.map((x, i) => [x, i]));
  const slabs: Array<Array<number>> = Array.from({ length: Math.max(0, xs.length - 1) }, () => []);

  // ---- union-find over the variables: a level shared by several of them
  const parent: number[] = [];
  const find = (i: number): number => {
    while ((parent[i] ?? i) !== i) i = parent[i] = parent[parent[i]!] ?? parent[i]!;
    return i;
  };
  const merge = (a: number, b: number) => {
    const ra = find(a), rb = find(b);
    if (ra !== rb && old[ra] === old[rb]) parent[ra] = rb;
  };

  const flat: Array<[SchematicTrack, number, number]> = [];
  for (const t of laid) {
    const ia = at.get(key(t.from.x))!, ib = at.get(key(t.to.x))!;
    if (ia === ib) {
      if (t.lane !== null) flat.push([t, pointVar(t.from), pointVar(t.to)]);
      continue;
    }
    const fwd = ib > ia;
    const k0 = Math.min(ia, ib), k1 = Math.max(ia, ib);
    const item: Item = { t, k0, k1, fwd, vars: [] };
    const va = pointVar(t.from), vb = pointVar(t.to);
    // a node takes part in the order of the slabs its elements leave it into
    slabs[fwd ? k0 : k1 - 1]!.push(va);
    slabs[fwd ? k1 - 1 : k0]!.push(vb);
    if (t.lane === null) {
      // a crossover: on the lane of the nearer end on either side of its middle, both in the slab of the middle
      const mid = (t.from.x + t.to.x) / 2;
      for (let k = k0; k < k1; k++) {
        const near = (x: number) => (Math.abs(x - t.from.x) < Math.abs(x - t.to.x) ? va : vb);
        const [x0, x1] = [xs[k]!, xs[k + 1]!];
        if (x0 < mid && mid < x1) slabs[k]!.push(va, vb);
        else slabs[k]!.push(near((x0 + x1) / 2));
      }
      continue;
    }
    for (let k = k0; k < k1; k++) {
      const v = newVar(t.lane);
      item.vars.push(v);
      slabs[k]!.push(v);
    }
    if (!fwd) item.vars.reverse();
    // where an end is on the lane of the element, the element runs straight through the node there
    if (t.from.y === t.lane) merge(item.vars[0]!, va);
    if (t.to.y === t.lane) merge(item.vars.at(-1)!, vb);
    items.push(item);
  }
  // ---- order constraints: per slab and side, each occupant above the next one inwards
  const edges = new Map<number, Array<[number, number]>>(); // outer root -> [inner root, gap]
  const addEdge = (inner: number, outer: number, gap: number) => {
    const a = find(inner), b = find(outer);
    if (a === b) return;
    const l = edges.get(b);
    if (l) l.push([a, gap]);
    else edges.set(b, [[a, gap]]);
  };
  for (const occ of slabs) {
    const roots = [...new Set(occ.map(find))].filter((r) => old[r] !== 0);
    for (const s of [1, -1]) {
      const side = roots.filter((r) => Math.sign(old[r]!) === s).sort((a, b) => Math.abs(old[a]!) - Math.abs(old[b]!));
      for (let i = 1; i < side.length; i++) {
        const a = side[i - 1]!, b = side[i]!;
        addEdge(a, b, Math.abs(old[b]!) > Math.abs(old[a]!) ? 1 : 0);
      }
    }
  }

  // ---- levels: least fixpoint from the route outwards, then dips too short for their diagonals are raised
  const roots = [...new Set(old.map((_, i) => find(i)))].filter((r) => old[r] !== 0);
  roots.sort((a, b) => Math.abs(old[a]!) - Math.abs(old[b]!));
  const forced = new Map<number, number>();
  const level = new Map<number, number>();
  const solve = () => {
    level.clear();
    for (let i = 0; i < roots.length; ) {
      // a group of equal old level: its gap-0 edges are relaxed until stable
      let j = i;
      while (j < roots.length && Math.abs(old[roots[j]!]!) === Math.abs(old[roots[i]!]!)) j++;
      for (let changed = true, round = 0; changed && round <= j - i; round++) {
        changed = false;
        for (let k = i; k < j; k++) {
          const r = roots[k]!;
          let m = Math.max(1, forced.get(r) ?? 0);
          for (const [a, gap] of edges.get(r) ?? []) m = Math.max(m, (level.get(a) ?? 0) + gap);
          m = Math.min(m, Math.abs(old[r]!));
          if (m !== level.get(r)) {
            level.set(r, m);
            changed = true;
          }
        }
      }
      i = j;
    }
  };
  const mag = (v: number) => level.get(find(v)) ?? 0;
  for (let round = 0; round < 8; round++) {
    solve();
    let raised = false;
    for (const it of items) {
      const m = it.vars.map(mag);
      const width = (k: number) => {
        const s = it.fwd ? it.k0 + k : it.k1 - 1 - k;
        return xs[s + 1]! - xs[s]!;
      };
      const ya = mag(pts.get(it.t.from)!), yb = mag(pts.get(it.t.to)!);
      for (let a = 0; a < m.length; ) {
        let b = a;
        let len = 0;
        while (b < m.length && m[b] === m[a]) len += width(b++);
        // the diagonals drawn inside this piece: lane changes to a higher neighbour, and the end diagonals
        const left = a > 0 ? m[a - 1]! : undefined, right = b < m.length ? m[b]! : undefined;
        let need = 0;
        if (left !== undefined && left > m[a]!) need += left - m[a]!;
        if (right !== undefined && right > m[a]!) need += right - m[a]!;
        if (a === 0) need += Math.abs(ya - m[a]!);
        if (b === m.length && !it.t.stub) need += Math.abs(yb - m[a]!);
        const higher = [left, right].filter((v): v is number => v !== undefined && v > m[a]!);
        if (higher.length && len < minRun * need) {
          const to = Math.min(...higher);
          for (let k = a; k < b; k++) {
            const r = find(it.vars[k]!);
            if ((forced.get(r) ?? 0) < to) {
              forced.set(r, to);
              raised = true;
            }
          }
        }
        a = b;
      }
    }
    if (!raised) break;
  }

  // ---- write the levels back
  const lv = (v: number) => {
    const r = find(v);
    return old[r] === 0 ? 0 : Math.sign(old[r]!) * mag(r);
  };
  for (const [p, v] of pts) p.y = lv(v);
  // no room for a lane of its own: the element keeps to the end it ran straight from
  for (const [t, va, vb] of flat) t.lane = old[va] === t.lane ? lv(va) : old[vb] === t.lane ? lv(vb) : t.lane;
  for (const it of items) {
    const ys = it.vars.map(lv);
    const runs: Array<{ from: number; to: number; y: number }> = [];
    ys.forEach((y, k) => {
      const s = it.fwd ? it.k0 + k : it.k1 - 1 - k;
      const [x0, x1] = it.fwd ? [xs[s]!, xs[s + 1]!] : [xs[s + 1]!, xs[s]!];
      const last = runs.at(-1);
      if (last && last.y === y) last.to = x1;
      else runs.push({ from: x0, to: x1, y });
    });
    const longest = runs.reduce((p, q) => (Math.abs(q.to - q.from) > Math.abs(p.to - p.from) ? q : p));
    it.t.lane = longest.y;
    if (runs.length > 1) it.t.runs = runs;
  }
}
