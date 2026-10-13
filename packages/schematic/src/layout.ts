import type { Track } from "@routebook/rinf-client";
import { MinHeap, type Route } from "@routebook/routing";
import { LocalFrame, along, cross, dot, norm, polylineLength, sub, type XY } from "./geo.js";
import { TopoNetwork, endKey, otherEnd, parseEndKey, type EndRef } from "./network.js";
import type { SwitchInfo } from "./switches.js";
import { addKinks } from "./kinks.js";

/**
 * Schematic coordinates: `x` is the distance along the route (metres, same
 * scale as the routebook distances; nodes off the route are placed by their
 * distance along the track from the route), `y` is a lane number (0 = the route, positive = left of the direction
 * of travel, negative = right).
 */
export interface SchematicPoint {
  x: number;
  y: number;
}

export interface SchematicTrack {
  ne: string;
  /** Track name (era:Track label) and kind. */
  track?: string;
  kind?: Track["kind"];
  onRoute: boolean;
  from: SchematicPoint;
  to: SchematicPoint;
  /**
   * Lane of the horizontal part of the element. Where an end lies on another
   * lane the renderer draws a diagonal there. null = the whole element is one
   * diagonal (a crossover between two lanes).
   */
  lane: number | null;
  /** The element leaves the corridor here: only its first metres are drawn. */
  stub?: boolean;
  /**
   * Where the element changes lane along its length (a kink where the
   * topology next to it changes): its horizontal pieces in order from `from`
   * to `to`, each with the x range (route metres) and lane. `lane` is then
   * the lane of the longest piece.
   */
  runs?: Array<{ from: number; to: number; y: number }>;
}

export interface SchematicSwitch {
  node: number;
  x: number;
  y: number;
  /** Screen side of the deviating branch: +1 = up (left of travel), -1 = down. */
  deviates: 1 | -1;
  /** true when the switch opens in the direction of travel (common leg first). */
  facing: boolean;
  onRoute: boolean;
  /** The route takes the deviating branch here. */
  routeDeviates: boolean;
  rule: SwitchInfo["rule"];
  deviatingSide: SwitchInfo["deviatingSide"];
  label?: string;
  switchId?: string;
}

/** A node with 4 ends: a diamond crossing, or a slip switch when more than the two straight pairs are navigable. */
export interface SchematicCrossing {
  node: number;
  x: number;
  y: number;
  onRoute: boolean;
  slip: boolean;
}

export interface Schematic {
  length: number;
  tracks: SchematicTrack[];
  switches: SchematicSwitch[];
  crossings?: SchematicCrossing[];
  /** Elements left out because their station has more tracks on one side than `maxLanes`. */
  omitted?: number;
  minLane: number;
  maxLane: number;
}

export interface LayoutOptions {
  /** Only nodes within this lateral distance (m) of the route are laid out. */
  corridor?: number;
  /** Only tracks within this path distance (m) of the route are laid out. */
  reach?: number;
  /** Length (in x units) of the stub drawn for a track that leaves the corridor. */
  stubLength?: number;
  /** Minimum horizontal run (m) of an element per lane it changes, or its length when it is shorter. */
  minRun?: number;
  /**
   * Lanes per side. The tracks furthest from the route in a station with
   * more tracks than this are left out, with a short stub where they branch off.
   */
  maxLanes?: number;
  /** Let the tracks next to the route change lane where the topology changes (default true). */
  kinks?: boolean;
}

interface RouteLine {
  pts: XY[];
  s: number[];
}

/** Route polyline in local metres with, per vertex, its distance along the route (routebook scale). */
function routeLine(route: Route, net: TopoNetwork, frame: LocalFrame): RouteLine {
  const pts: XY[] = [];
  const s: number[] = [];
  for (const step of route.steps) {
    const len = net.lengths.get(step.ne) ?? 0;
    const line = net.lineFrom({ ne: step.ne, end: 0 }, frame);
    if (line.length < 2 || len <= 0) continue;
    // vertex offsets along the element, scaled from geometric to RINF length
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1]! + norm(sub(line[i]!, line[i - 1]!)));
    const k = len / (cum.at(-1)! || 1);
    const lo = Math.min(step.from, step.to), hi = Math.max(step.from, step.to);
    const piece: Array<[number, XY]> = [];
    const at = (off: number): XY => along(line, off / k);
    piece.push([lo, at(lo)]);
    for (let i = 0; i < line.length; i++) if (cum[i]! * k > lo && cum[i]! * k < hi) piece.push([cum[i]! * k, line[i]!]);
    piece.push([hi, at(hi)]);
    if (!step.forward) piece.reverse();
    for (const [off, p] of piece) {
      const d = step.startDistance + Math.abs(off - step.from);
      if (s.length && d <= s.at(-1)! + 1e-9) continue;
      pts.push(p);
      s.push(d);
    }
  }
  return { pts, s };
}

interface Projection {
  s: number;
  /** signed distance from the route (m), positive = left of the direction of travel */
  lateral: number;
  tangent: XY;
}

/** Project `p` onto the route between distances lo..hi. */
function project(rl: RouteLine, p: XY, lo: number, hi: number): Projection | undefined {
  let best: Projection | undefined;
  let bestD = Infinity;
  // first vertex at or after lo
  let a = 0, b = rl.s.length - 1;
  while (a < b) {
    const mid = (a + b) >> 1;
    if (rl.s[mid]! < lo) a = mid + 1;
    else b = mid;
  }
  for (let i = Math.max(1, a); i < rl.pts.length; i++) {
    if (rl.s[i - 1]! > hi) break;
    const a = rl.pts[i - 1]!, b = rl.pts[i]!;
    const ab = sub(b, a);
    const l2 = dot(ab, ab);
    const t = l2 === 0 ? 0 : Math.max(0, Math.min(1, dot(sub(p, a), ab) / l2));
    const q: XY = [a[0] + ab[0] * t, a[1] + ab[1] * t];
    const d = norm(sub(p, q));
    if (d < bestD) {
      bestD = d;
      best = { s: rl.s[i - 1]! + (rl.s[i]! - rl.s[i - 1]!) * t, lateral: cross(ab, sub(p, q)) < 0 ? -d : d, tangent: ab };
    }
  }
  return best;
}

const sign = (v: number): 1 | -1 => (v < 0 ? -1 : 1);

/** An element laid out off the route, reached from node `n` through end `a`. */
export interface Elem {
  ne: string;
  a: EndRef;
  n: number;
  /** far node; undefined for a stub */
  m?: number;
  len: number;
  /** direction along x in which the element leaves n */
  dir: 1 | -1;
  stub: boolean;
  /** the far node was already placed the other way round (a reversing loop): no x constraint */
  conflict: boolean;
  /** signed distance of its middle from the route (m), positive = left of travel */
  lat: number;
  /** a crossover: deviating at both ends, one lane to the other, drawn as one diagonal */
  diagonal: boolean;
}

export interface NodeInfo {
  x: number;
  /** orientation of the node: the x direction an end leaves in is sgn × its group */
  sgn: 1 | -1;
  onRoute: boolean;
  /** end through which the node was reached */
  arrival?: EndRef;
}

/** Horizontal extent of a set of elements that share a lane, and the lane it gets. */
interface Run {
  lo: number;
  hi: number;
  /** mean signed distance from the route (m), and its smallest and largest value over the elements */
  lat: number;
  weight: number;
  latMin: number;
  latMax: number;
  side: 0 | 1 | -1;
  level: number;
}

/**
 * Lay out the tracks around a route as a schematic: the route is a straight
 * line on lane 0, every other track gets a lane on one side of it.
 *
 * 1. The tracks are explored outwards from the route, nearest first. The x
 *    direction an element leaves a node in follows from the topology (ends a
 *    train can pass between lie on opposite sides of the node), and an
 *    off-route node is placed by its distance along the track from the route
 *    nodes behind and ahead of it, so a chain of tracks keeps x monotone
 *    until it reconnects to the route.
 * 2. Elements that continue each other (a plain joint, the common leg and
 *    the continuous branch of a switch) form a run that shares one lane. The
 *    deviating branch of a switch is a run one lane to its side (left of
 *    travel = up); when the route takes the deviating branch the continuous
 *    branch goes to the other side. A crossover is a diagonal between the
 *    runs at its two ends, which want adjacent lanes.
 * 3. Runs are given lanes per side greedily, nearest the route first, as
 *    intervals in x: a lane is free again where the previous track on it
 *    ends, so stations far apart reuse the same lanes.
 */
export function layoutRouteSchematic(route: Route, input: LayoutInput, opts: LayoutOptions = {}): Schematic {
  return layoutCore(route, input, opts).schematic;
}

export interface LayoutInput {
  network: TopoNetwork;
  switches: SwitchInfo[];
  tracks: Track[];
}

/**
 * The topology around a route that both layouts share: the nodes and
 * elements explored from the route, the x direction each element leaves its
 * node in, the straight pair through each node and the screen side of the
 * ends that branch off it.
 */
export interface Explored {
  route: Route;
  net: TopoNetwork;
  minRun: number;
  maxLanes: number;
  stubLength: number;
  openLine: number;
  ends: (n: number) => EndRef[];
  switchAt: Map<number, SwitchInfo>;
  describe: (ne: string) => { track?: string; kind?: Track["kind"] };
  /** route elements on lane 0 */
  routeTracks: SchematicTrack[];
  routeNe: Set<string>;
  nodes: Map<number, NodeInfo>;
  /** nodes in the order they were reached (route nodes first) */
  order: number[];
  elems: Elem[];
  /** element index by the key of either of its ends */
  elemAt: Map<string, number>;
  /** keys of the ends that form the straight pair through a node */
  mainOf: (n: number) => Set<string>;
  /** screen side (+1 = up) of an end that branches off the straight pair */
  sigma: (n: number, r: EndRef) => 1 | -1;
  screenOf: (n: number, sw: SwitchInfo) => { deviates: 1 | -1; facing: boolean };
  /** number of ends of an element that branch off a straight pair (0..2) */
  branches: (e: Elem) => number;
}

/** Explore the tracks around the route (step 1 of the layout). */
export function exploreRoute(route: Route, input: LayoutInput, opts: LayoutOptions = {}): Explored {
  const net = input.network;
  const corridor = opts.corridor ?? 600;
  const reach = opts.reach ?? 3000;
  const stubLength = opts.stubLength ?? 60;
  const minRun = opts.minRun ?? 40;
  const maxLanes = opts.maxLanes ?? 6;
  const openLine = 400;
  const ends = (n: number) => net.nodes[n] ?? [];
  const switchAt = new Map(input.switches.filter((s) => ends(s.node).length === 3).map((s) => [s.node, s]));
  const trackOf = new Map<string, Track>();
  for (const t of input.tracks) for (const e of t.elements) if (!trackOf.has(e)) trackOf.set(e, t);
  const describe = (ne: string) => {
    const t = trackOf.get(ne);
    return { ...(t?.label ? { track: t.label } : {}), ...(t ? { kind: t.kind } : {}) };
  };

  const first = route.steps[0];
  const p0 = first ? net.endPoint({ ne: first.ne, end: 0 }) : undefined;
  const frame = new LocalFrame(p0?.[1] ?? 60);
  const rl = routeLine(route, net, frame);

  const leads = new Map<string, XY>();
  /** direction of the first metres of track from an end */
  const lead = (r: EndRef): XY => {
    const k = endKey(r);
    let v = leads.get(k);
    if (!v) {
      const w = net.walk(r, 15, frame);
      v = w.length >= 2 ? sub(w.at(-1)!, w[0]!) : [0, 0];
      leads.set(k, v);
    }
    return v;
  };

  // ---- the two sides of a node: ends a train can pass between lie on opposite sides
  const groupCache = new Map<number, Map<string, 1 | -1>>();
  const groups = (n: number): Map<string, 1 | -1> => {
    let g = groupCache.get(n);
    if (g) return g;
    g = new Map();
    const list = ends(n);
    if (list.length === 2) {
      g.set(endKey(list[0]!), 1);
      g.set(endKey(list[1]!), -1);
    } else {
      for (const start of list) {
        if (g.has(endKey(start))) continue;
        // not connected to the ends seen so far: compare its geometry with one of them
        const ref = list.find((e) => g!.has(endKey(e)));
        g.set(endKey(start), ref ? ((dot(lead(start), lead(ref)) > 0 ? 1 : -1) * g.get(endKey(ref))!) as 1 | -1 : 1);
        const queue = [start];
        for (let a = queue.pop(); a; a = queue.pop()) {
          for (const b of list) {
            if (g.has(endKey(b)) || !(net.isNavigable(a, b) || net.isNavigable(b, a))) continue;
            g.set(endKey(b), -g.get(endKey(a))! as 1 | -1);
            queue.push(b);
          }
        }
      }
    }
    groupCache.set(n, g);
    return g;
  };
  const nodes = new Map<number, NodeInfo>();
  /** x direction (+1 / -1) in which the element at end `r` leaves node `n` */
  const side = (n: number, r: EndRef): 1 | -1 => ((nodes.get(n)?.sgn ?? 1) * (groups(n).get(endKey(r)) ?? 1)) as 1 | -1;

  // ---- the route: lane 0
  const tracks: SchematicTrack[] = [];
  const drawn = new Set<string>();
  const routeEnds = new Map<number, EndRef[]>();
  const order: number[] = [];
  const heap = new MinHeap<number>();
  for (const step of route.steps) {
    const len = net.lengths.get(step.ne) ?? 0;
    const entry: EndRef = { ne: step.ne, end: step.forward ? 0 : 1 };
    const exit = otherEnd(entry);
    const fromOrigin = step.forward ? step.from : len - step.from; // metres between the entry end and where the route enters
    const xEntry = step.startDistance - fromOrigin;
    const xExit = xEntry + len;
    for (const [end, x, s] of [[entry, xEntry, 1], [exit, xExit, -1]] as const) {
      const n = net.nodeOf(end);
      routeEnds.set(n, [...(routeEnds.get(n) ?? []), end]);
      if (nodes.has(n)) continue;
      nodes.set(n, { x, sgn: (s * (groups(n).get(endKey(end)) ?? 1)) as 1 | -1, onRoute: true });
      order.push(n);
      heap.push(0, n);
    }
    drawn.add(step.ne);
    tracks.push({ ne: step.ne, ...describe(step.ne), onRoute: true, from: { x: xEntry, y: 0 }, to: { x: xExit, y: 0 }, lane: 0 });
  }

  // ---- explore outwards from the route, nearest tracks first
  const elems: Elem[] = [];
  for (let item = heap.pop(); item; item = heap.pop()) {
    const [c, n] = item;
    const info = nodes.get(n)!;
    for (const end of ends(n)) {
      if (drawn.has(end.ne) || !net.hasGeometry(end.ne)) continue;
      drawn.add(end.ne);
      const len = net.lengths.get(end.ne) ?? 0;
      const far = otherEnd(end);
      const m = net.nodeOf(far);
      const dir = side(n, end);
      const e: Elem = { ne: end.ne, a: end, n, len, dir, stub: false, conflict: false, lat: 0, diagonal: false };
      elems.push(e);
      if (nodes.has(m)) {
        e.m = m;
        e.conflict = m === n || side(m, far) !== -dir;
      } else {
        const farPt = net.endPoint(far);
        const proj = farPt ? project(rl, frame.xy(farPt), info.x - len - 500, info.x + len + 500) : undefined;
        if (!proj || Math.abs(proj.lateral) > corridor || c + len > reach) e.stub = true;
        else {
          e.m = m;
          nodes.set(m, { x: info.x + dir * len, sgn: (-dir * (groups(m).get(endKey(far)) ?? 1)) as 1 | -1, onRoute: false, arrival: far });
          order.push(m);
          heap.push(c + len, m);
        }
      }
      const line = net.lineFrom(end, frame);
      const l = polylineLength(line);
      e.lat = project(rl, along(line, e.stub ? Math.min(l, stubLength) / 2 : l / 2), info.x - len - 500, info.x + len + 500)?.lateral ?? 0;
    }
  }

  // ---- the straight pair through each node (the run continues there), the other ends branch off it
  const straightest = (n: number, r: EndRef): EndRef | undefined => {
    const g = groups(n);
    const lr = lead(r);
    let best: EndRef | undefined;
    let bestCos = Infinity;
    for (const e of ends(n)) {
      if (g.get(endKey(e)) === g.get(endKey(r))) continue;
      const le = lead(e);
      const c = dot(lr, le) / (norm(lr) * norm(le) || 1);
      if (c < bestCos) {
        bestCos = c;
        best = e;
      }
    }
    return best;
  };
  const mainCache = new Map<number, Set<string>>();
  const mainOf = (n: number): Set<string> => {
    let s = mainCache.get(n);
    if (s) return s;
    const sw = switchAt.get(n);
    const re = routeEnds.get(n);
    const pair = (r: EndRef): Array<EndRef | undefined> => [r, sw ? (endKey(r) === endKey(sw.common) ? sw.continuous : sw.common) : straightest(n, r)];
    let list: Array<EndRef | undefined>;
    if (re && re.length >= 2) list = re;
    else if (re) list = pair(re[0]!);
    else if (ends(n).length <= 2) list = ends(n);
    else if (sw) list = [sw.common, sw.continuous];
    else list = pair(nodes.get(n)?.arrival ?? ends(n)[0]!);
    s = new Set(list.filter((r): r is EndRef => !!r).map(endKey));
    mainCache.set(n, s);
    return s;
  };
  const screenOf = (n: number, sw: SwitchInfo) => {
    const o = -side(n, sw.common); // +1: the common leg comes first in the direction of travel
    return { deviates: ((sw.deviatingSide === "left" ? 1 : -1) * o) as 1 | -1, facing: o === 1 };
  };
  /** screen side (+1 = up) of a branching end relative to the straight pair through the node */
  const sigma = (n: number, r: EndRef): 1 | -1 => {
    const sw = switchAt.get(n);
    if (sw) {
      const d = screenOf(n, sw).deviates;
      return endKey(r) === endKey(sw.deviating) ? d : (-d as 1 | -1);
    }
    const mk = mainOf(n).values().next().value;
    if (mk === undefined) return 1;
    const me = parseEndKey(mk);
    const u = lead(me), s = side(n, me);
    return sign(cross([u[0] * s, u[1] * s], lead(r)));
  };
  const branches = (e: Elem): number =>
    (mainOf(e.n).has(endKey(e.a)) ? 0 : 1) + (e.m !== undefined && !mainOf(e.m).has(endKey(otherEnd(e.a))) ? 1 : 0);
  for (const e of elems) {
    if (e.m === undefined || e.conflict || branches(e) < 2) continue;
    e.diagonal = sigma(e.n, e.a) === -sigma(e.m, otherEnd(e.a));
  }
  const routeNe = new Set(route.steps.map((s) => s.ne));
  const elemAt = new Map<string, number>();
  elems.forEach((e, i) => {
    elemAt.set(endKey(e.a), i);
    if (e.m !== undefined) elemAt.set(endKey(otherEnd(e.a)), i);
  });
  return {
    route, net, minRun, maxLanes, stubLength, openLine, ends, switchAt, describe, routeTracks: tracks, routeNe, nodes, order, elems, elemAt,
    mainOf, sigma, screenOf, branches,
  };
}

/** Lanes of the heuristic layout (steps 2 and 3). */
function heuristicLanes(ex: Explored): { nodeLane: (n: number) => number | undefined; elemLane: (i: number) => number | null | undefined; laid: (n: number) => boolean } {
  const { nodes, elems, order, ends, mainOf, sigma, branches, routeNe, elemAt, minRun, maxLanes, stubLength, openLine } = ex;
  // ---- runs: elements joined by the straight pair of a node share a lane
  const ROUTE = elems.length;
  const parent = Array.from({ length: elems.length + 1 }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const indexOf = (k: string): number | undefined => (routeNe.has(parseEndKey(k).ne) ? ROUTE : elemAt.get(k));
  // a track that runs on through open line (an element of at least openLine metres) is cut there, so
  // that it can move to another lane between stations; the pieces prefer to keep each other's lane
  const links: Array<[number, number]> = [];
  for (const n of order) {
    const [a, b] = [...mainOf(n)].map(indexOf);
    const joins = (i: number | undefined) => i !== undefined && !elems[i]?.diagonal && !elems[i]?.conflict;
    if (!joins(a) || !joins(b)) continue;
    if (a !== ROUTE && b !== ROUTE && Math.max(elems[a!]!.len, elems[b!]!.len) >= openLine) links.push([a!, b!]);
    else parent[find(a!)] = find(b!);
  }
  /** run of the track straight through a node; where a track is cut, the shorter element's, so the long one changes lane */
  const mainRun = (n: number): number | undefined => {
    let best: number | undefined;
    const rank = (i: number) => (i === ROUTE ? -1 : elems[i]!.conflict ? Infinity : elems[i]!.len);
    for (const k of mainOf(n)) {
      const i = indexOf(k);
      if (i !== undefined && (best === undefined || rank(i) < rank(best))) best = i;
    }
    return best === undefined ? undefined : find(best);
  };
  // [upper, lower]: the first run lies above (left of travel of) the second
  const rels: Array<[number, number]> = [];
  const relate = (r: number, base: number, s: 1 | -1) => {
    if (r !== base) rels.push(s > 0 ? [r, base] : [base, r]);
  };
  for (const n of order) {
    const base = mainRun(n);
    if (base === undefined) continue;
    const main = mainOf(n);
    for (const end of ends(n)) {
      const k = endKey(end);
      const i = elemAt.get(k);
      if (main.has(k) || i === undefined) continue;
      const e = elems[i]!;
      if (!e.diagonal) relate(find(i), base, sigma(n, end));
      else if (k === endKey(e.a)) {
        const other = mainRun(e.m!);
        if (other !== undefined) relate(other, base, sigma(n, end));
      }
    }
  }

  const routeRun = find(ROUTE);
  const pieces = links.map(([a, b]) => [find(a), find(b)] as [number, number]);
  const linked = new Map<number, Set<number>>();
  for (const [a, b] of pieces) {
    linked.set(a, (linked.get(a) ?? new Set()).add(b));
    linked.set(b, (linked.get(b) ?? new Set()).add(a));
  }
  const gap = 15;
  const lateralGap = 3;
  let runs = new Map<number, Run>();
  let folded = new Set<number>();
  // lanes changed per element: estimated from the switches first, then the real ones of the first pass
  const changes = new Map<Elem, number>();
  const laneOfRun = (id: number | undefined): number | undefined => {
    if (id === undefined) return undefined;
    if (id === routeRun) return 0;
    const r = runs.get(id);
    return r && r.level ? r.side * r.level : undefined;
  };
  /** lane of a node: that of the track straight through it */
  const nodeLane = (n: number): number | undefined => {
    let y = nodes.get(n)!.onRoute ? 0 : laneOfRun(mainRun(n));
    for (const end of ends(n)) {
      const i = elemAt.get(endKey(end));
      if (y === undefined && i !== undefined && !elems[i]!.diagonal) y = laneOfRun(find(i));
    }
    return y;
  };
  for (let pass = 0; pass < 2; pass++) {
    // ---- x of the off-route nodes: distance along the track, between the route nodes behind and ahead
    type Edge = [node: number, len: number, min: number];
    const fwd = new Map<number, Edge[]>(), bwd = new Map<number, Edge[]>();
    const add = (map: Map<number, Edge[]>, k: number, v: Edge) => {
      const l = map.get(k);
      if (l) l.push(v);
      else map.set(k, [v]);
    };
    for (const e of elems) {
      if (e.m === undefined || e.conflict) continue;
      const min = Math.min(e.len, Math.max(2, minRun * (changes.get(e) ?? (e.diagonal ? 1 : branches(e)))));
      const [u, v] = e.dir > 0 ? [e.n, e.m] : [e.m, e.n];
      add(fwd, u, [v, e.len, min]);
      add(bwd, v, [u, e.len, min]);
    }
    const onRoute = (n: number) => nodes.get(n)!.onRoute;
    /** nearest route node along the edges: [path length, its x] */
    const anchored = (adj: Map<number, Edge[]>) => {
      const best = new Map<number, [number, number]>();
      const h = new MinHeap<number>();
      for (const [n, info] of nodes) {
        if (!info.onRoute) continue;
        best.set(n, [0, info.x]);
        h.push(0, n);
      }
      for (let it = h.pop(); it; it = h.pop()) {
        const [d, u] = it;
        const bu = best.get(u)!;
        if (d > bu[0]) continue;
        for (const [v, len] of adj.get(u) ?? []) {
          if (onRoute(v) || d + len >= (best.get(v)?.[0] ?? Infinity)) continue;
          best.set(v, [d + len, bu[1]]);
          h.push(d + len, v);
        }
      }
      return best;
    };
    const behind = anchored(fwd), ahead = anchored(bwd);
    // topological order along x (a cycle is broken anywhere)
    const indeg = new Map<number, number>();
    for (const es of fwd.values()) for (const [v] of es) indeg.set(v, (indeg.get(v) ?? 0) + 1);
    const all = [...nodes.keys()];
    const ord: number[] = [];
    const seen = new Set<number>();
    const queue = all.filter((n) => !indeg.get(n));
    for (let next = 0; ord.length < all.length; ) {
      let u = queue.pop();
      if (u === undefined) {
        while (seen.has(all[next]!)) next++;
        u = all[next]!;
      }
      if (seen.has(u)) continue;
      seen.add(u);
      ord.push(u);
      for (const [v] of fwd.get(u) ?? []) {
        const d = indeg.get(v)! - 1;
        indeg.set(v, d);
        if (d === 0) queue.push(v);
      }
    }
    // bounds that keep the minimum runs from the route nodes behind and ahead
    const lo = new Map<number, number>(), hi = new Map<number, number>();
    for (const u of ord) {
      const xu = onRoute(u) ? nodes.get(u)!.x : lo.get(u);
      if (xu === undefined) continue;
      for (const [v, , min] of fwd.get(u) ?? []) if (!onRoute(v)) lo.set(v, Math.max(lo.get(v) ?? -Infinity, xu + min));
    }
    for (const w of [...ord].reverse()) {
      const xw = onRoute(w) ? nodes.get(w)!.x : hi.get(w);
      if (xw === undefined) continue;
      for (const [u, , min] of bwd.get(w) ?? []) if (!onRoute(u)) hi.set(u, Math.min(hi.get(u) ?? Infinity, xw - min));
    }
    for (const n of ord) {
      const info = nodes.get(n)!;
      if (info.onRoute) continue;
      const b = behind.get(n), f = ahead.get(n);
      let x = info.x;
      if (b && f && f[1] > b[1]) x = b[1] + ((f[1] - b[1]) * b[0]) / (b[0] + f[0] || 1);
      else if (b) x = b[1] + b[0];
      else if (f) x = f[1] - f[0];
      const l = lo.get(n) ?? -Infinity, h = hi.get(n) ?? Infinity;
      info.x = l <= h ? Math.min(h, Math.max(l, x)) : (l + h) / 2;
    }
    for (const u of ord) {
      for (const [v, , min] of fwd.get(u) ?? []) {
        if (onRoute(v)) continue;
        const iv = nodes.get(v)!;
        iv.x = Math.max(iv.x, Math.min(nodes.get(u)!.x + min, hi.get(v) ?? Infinity));
      }
    }

    runs = new Map<number, Run>();
    elems.forEach((e, i) => {
      const id = find(i);
      if (e.diagonal || id === routeRun) return;
      const xa = nodes.get(e.n)!.x;
      const xb = e.m !== undefined ? nodes.get(e.m)!.x : xa + e.dir * Math.min(e.len, stubLength);
      let r = runs.get(id);
      if (!r) runs.set(id, (r = { lo: Infinity, hi: -Infinity, lat: 0, weight: 0, latMin: Infinity, latMax: -Infinity, side: 0, level: 0 }));
      r.lo = Math.min(r.lo, xa, xb);
      r.hi = Math.max(r.hi, xa, xb);
      const w = Math.max(1, Math.abs(xb - xa));
      r.lat += e.lat * w;
      r.weight += w;
      r.latMin = Math.min(r.latMin, e.lat);
      r.latMax = Math.max(r.latMax, e.lat);
    });

    // ---- sides: from the switches at the route, then carried along to the runs hanging off them
    for (const [up, low] of rels) {
      const a = runs.get(up), b = runs.get(low);
      if (a && !a.side && low === routeRun) a.side = 1;
      if (b && !b.side && up === routeRun) b.side = -1;
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (const [up, low] of [...rels, ...pieces]) {
        const a = runs.get(up), b = runs.get(low);
        if (!a || !b || !a.side === !b.side) continue;
        if (a.side) b.side = a.side;
        else a.side = b.side;
        changed = true;
      }
    }
    for (const r of runs.values()) if (!r.side) r.side = sign(r.lat / r.weight);

    // ---- lanes: per side, inner runs first, each on the lowest free lane outside the runs it must be outside of
    const occupied = new Map<number, Array<[number, number, number]>>();
    folded = new Set<number>();
    for (const s of [1, -1] as const) {
      const ids = [...runs.keys()].filter((id) => runs.get(id)!.side === s);
      // distance from the route where the run comes closest to it: a track that curves away to another line is ordered by where it starts
      const key = (id: number) => (s > 0 ? runs.get(id)!.latMin : -runs.get(id)!.latMax);
      const inner = new Map<number, number[]>(), outer = new Map<number, number[]>();
      const waiting = new Map<number, number>();
      for (const [up, low] of rels) {
        if (runs.get(up)?.side !== s || runs.get(low)?.side !== s) continue;
        const [i, o] = s > 0 ? [low, up] : [up, low];
        inner.set(o, [...(inner.get(o) ?? []), i]);
        outer.set(i, [...(outer.get(i) ?? []), o]);
        waiting.set(o, (waiting.get(o) ?? 0) + 1);
      }
      const ready = new MinHeap<number>();
      for (const id of ids) if (!waiting.get(id)) ready.push(key(id), id);
      const placed: number[] = [];
      const done = new Set<number>();
      while (done.size < ids.length) {
        let it = ready.pop();
        while (it && done.has(it[1])) it = ready.pop();
        // a cycle of constraints: take the innermost remaining run
        const id = it ? it[1] : ids.filter((x) => !done.has(x)).reduce((p, q) => (key(q) < key(p) ? q : p));
        done.add(id);
        const run = runs.get(id)!;
        const lowest = (k: number) => {
          // pieces of the same track may touch, other tracks keep a gap
          const clear = (o: number) => (linked.get(id)?.has(o) ? 1 : -gap);
          while ((occupied.get(s * k) ?? []).some(([a, b, o]) => a < run.hi - clear(o) && run.lo < b - clear(o))) k++;
          return k;
        };
        let k = 1;
        for (const i of inner.get(id) ?? []) k = Math.max(k, runs.get(i)!.level + 1);
        let byLateral = k;
        for (const p of placed) {
          const q = runs.get(p)!;
          if (q.lo < run.hi && run.lo < q.hi && key(p) < key(id) - lateralGap) byLateral = Math.max(byLateral, q.level + 1);
        }
        // the lane of the piece of the same track next to it, when that is free; beyond the lane limit the
        // lateral order gives way, then the run is left out
        const near = [...(linked.get(id) ?? [])].map((o) => runs.get(o)).flatMap((r) => (r?.side === s && r.level ? [r.level] : []));
        k = lowest(byLateral);
        if (near.length) {
          const free = (l: number) => l >= byLateral && lowest(l) === l;
          const want = Math.min(...near);
          for (let d = 0; d <= Math.abs(want - k); d++) {
            if (free(want - d)) k = want - d;
            else if (free(want + d)) k = want + d;
            else continue;
            break;
          }
        }
        if (k > maxLanes) k = lowest((inner.get(id) ?? []).reduce((m, i) => Math.max(m, runs.get(i)!.level + 1), 1));
        if (k > maxLanes || (inner.get(id) ?? []).some((i) => folded.has(i))) folded.add(id);
        else {
          run.level = k;
          occupied.set(s * k, [...(occupied.get(s * k) ?? []), [run.lo, run.hi, id]]);
          placed.push(id);
        }
        for (const o of outer.get(id) ?? []) {
          const w = waiting.get(o)! - 1;
          waiting.set(o, w);
          if (w === 0) ready.push(key(o), o);
        }
      }
    }

    if (pass > 0) break;
    let steep = false;
    elems.forEach((e, i) => {
      if (e.m === undefined || e.conflict) return;
      const ya = nodeLane(e.n), yb = nodeLane(e.m);
      const lane = e.diagonal ? ya : laneOfRun(find(i));
      if (ya === undefined || yb === undefined || lane === undefined) return;
      const c = Math.abs(ya - lane) + Math.abs(yb - lane);
      if (c > (e.diagonal ? 1 : branches(e))) steep = true;
      changes.set(e, c);
    });
    if (!steep) break;
  }

  const laid = (n: number) => nodes.get(n)!.onRoute || laneOfRun(mainRun(n)) !== undefined;
  const elemLane = (i: number): number | null | undefined => {
    const e = elems[i]!;
    if (e.diagonal) return laid(e.n) && laid(e.m!) ? null : undefined;
    return laneOfRun(find(i));
  };
  return { nodeLane, elemLane, laid };
}
/** How a layout places the nodes and elements explored from the route. */
export interface Placement {
  point: (n: number) => SchematicPoint;
  /** lane (null = a diagonal) and kinks of a laid element; undefined = left out */
  track: (i: number) => { lane: number | null; runs?: SchematicTrack["runs"] } | undefined;
  /** the track straight through the node is laid out */
  laid: (n: number) => boolean;
}

/** Turn a placement into the output: tracks, stubs for the tracks left out, switches and crossings. */
export function emitSchematic(ex: Explored, place: Placement, opts: { kinks?: boolean } = {}): { schematic: Schematic; byElem: Map<number, SchematicTrack> } {
  const { nodes, elems, order, ends, mainOf, sigma, screenOf, switchAt, describe, net, routeNe, route, stubLength, minRun } = ex;
  const { point, laid } = place;
  const tracks: SchematicTrack[] = ex.routeTracks.map((t) => ({ ...t, from: { ...t.from }, to: { ...t.to } }));
  const byElem = new Map<number, SchematicTrack>();
  let omitted = 0;
  elems.forEach((e, i) => {
    const placed = place.track(i);
    const far = otherEnd(e.a);
    if (!placed) {
      omitted++;
      // left out: a short stub where it branches off a track that is laid out
      const at: [number, EndRef, 1 | -1] | undefined =
        laid(e.n) && !mainOf(e.n).has(endKey(e.a)) ? [e.n, e.a, e.dir]
        : e.m !== undefined && laid(e.m) && !mainOf(e.m).has(endKey(far)) ? [e.m, far, -e.dir as 1 | -1]
        : undefined;
      if (!at) return;
      const from = point(at[0]);
      const to = { x: from.x + at[2] * Math.min(e.len, stubLength / 2), y: from.y + sigma(at[0], at[1]) / 2 };
      tracks.push({ ne: e.ne, ...describe(e.ne), onRoute: false, from, to, lane: null, stub: true });
      return;
    }
    const { lane, runs } = placed;
    const from = point(e.n);
    const to = e.m !== undefined ? point(e.m) : { x: from.x + e.dir * Math.min(e.len, stubLength), y: runs?.at(-1)?.y ?? lane ?? 0 };
    const t: SchematicTrack = { ne: e.ne, ...describe(e.ne), onRoute: false, from, to, lane, ...(e.stub ? { stub: true } : {}), ...(runs && runs.length > 1 ? { runs } : {}) };
    byElem.set(i, t);
    tracks.push(t);
  });

  if (opts.kinks) addKinks(tracks, { minRun });

  const switches: SchematicSwitch[] = [];
  const crossings: SchematicCrossing[] = [];
  for (const n of order) {
    const p = point(n);
    const onR = nodes.get(n)!.onRoute;
    const sw = switchAt.get(n);
    if (sw) {
      const scr = screenOf(n, sw);
      switches.push({
        node: n,
        x: p.x,
        y: p.y,
        deviates: scr.deviates,
        facing: scr.facing,
        onRoute: onR,
        routeDeviates: onR && routeNe.has(sw.deviating.ne),
        rule: sw.rule,
        deviatingSide: sw.deviatingSide,
        ...(sw.label ? { label: sw.label } : {}),
        ...(sw.switchId ? { switchId: sw.switchId } : {}),
      });
    } else if (ends(n).length === 4) {
      const list = ends(n);
      let pairs = 0;
      for (const a of list) for (const b of list) if (endKey(a) < endKey(b) && (net.isNavigable(a, b) || net.isNavigable(b, a))) pairs++;
      crossings.push({ node: n, x: p.x, y: p.y, onRoute: onR, slip: pairs > 2 });
    }
  }
  let minLane = 0, maxLane = 0;
  for (const t of tracks) for (const y of [t.from.y, t.to.y]) {
    minLane = Math.min(minLane, y);
    maxLane = Math.max(maxLane, y);
  }
  return { schematic: { length: route.length, tracks, switches, crossings, omitted, minLane, maxLane }, byElem };
}

/** The heuristic layout together with the exploration it was made from (shared with the solver layout). */
export function layoutCore(route: Route, input: LayoutInput, opts: LayoutOptions = {}) {
  const ex = exploreRoute(route, input, opts);
  const h = heuristicLanes(ex);
  const points = new Map<number, SchematicPoint>();
  const point = (n: number): SchematicPoint => {
    let p = points.get(n);
    if (!p) points.set(n, (p = { x: ex.nodes.get(n)!.x, y: h.nodeLane(n) ?? 0 }));
    return p;
  };
  const { schematic, byElem } = emitSchematic(
    ex,
    {
      point,
      laid: h.laid,
      track: (i) => {
        const lane = h.elemLane(i);
        return lane === undefined ? undefined : { lane };
      },
    },
    { kinks: opts.kinks !== false },
  );
  return { ex, schematic, byElem, points, laid: h.laid };
}
