import type { Track } from "@routebook/rinf-client";
import { MinHeap, type Route } from "@routebook/routing";
import { LocalFrame, along, cross, dot, norm, sub, type XY } from "./geo.js";
import { TopoNetwork, endKey, otherEnd, type EndRef } from "./network.js";
import type { SwitchInfo } from "./switches.js";

/**
 * Schematic coordinates: `x` is the distance along the route (metres, same
 * scale as the routebook distances; nodes off the route are projected onto
 * it), `y` is a lane number (0 = the route, positive = left of the direction
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

export interface Schematic {
  length: number;
  tracks: SchematicTrack[];
  switches: SchematicSwitch[];
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
  for (let i = 1; i < rl.pts.length; i++) {
    if (rl.s[i]! < lo || rl.s[i - 1]! > hi) continue;
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

function tangentAt(rl: RouteLine, x: number): XY {
  let i = 1;
  while (i < rl.s.length - 1 && rl.s[i]! < x) i++;
  return sub(rl.pts[i]!, rl.pts[i - 1]!);
}

const sign = (v: number): 1 | -1 => (v < 0 ? -1 : 1);

/**
 * Lay out the tracks around a route as a schematic: the route is a straight
 * line, every other track gets a lane. At a switch the continuous branch
 * keeps the lane of the common leg and the deviating branch moves one lane
 * towards its side (left of travel = up). When the route itself takes the
 * deviating branch, the continuous branch is pushed to the other side.
 */
export function layoutRouteSchematic(
  route: Route,
  input: { network: TopoNetwork; switches: SwitchInfo[]; tracks: Track[] },
  opts: LayoutOptions = {},
): Schematic {
  const net = input.network;
  const corridor = opts.corridor ?? 600;
  const reach = opts.reach ?? 3000;
  const stubLength = opts.stubLength ?? 60;
  const switchAt = new Map(input.switches.map((s) => [s.node, s]));
  const trackOf = new Map<string, Track>();
  for (const t of input.tracks) for (const e of t.elements) if (!trackOf.has(e)) trackOf.set(e, t);

  const first = route.steps[0];
  const p0 = first ? net.endPoint({ ne: first.ne, end: 0 }) : undefined;
  const frame = new LocalFrame(p0?.[1] ?? 60);
  const rl = routeLine(route, net, frame);
  const tracks: SchematicTrack[] = [];
  const pos = new Map<number, SchematicPoint>();
  const cost = new Map<number, number>();
  const drawn = new Set<string>();
  /** horizontal runs per lane: [x0, x1, signed lateral offset of the track from the route in metres] */
  const occupied = new Map<number, Array<[number, number, number]>>();
  const lateral = new Map<number, number>();
  const routeNodes = new Set<number>();

  const occupy = (lane: number, a: number, b: number, lat: number) => {
    const l = occupied.get(lane) ?? [];
    l.push([Math.min(a, b), Math.max(a, b), lat]);
    occupied.set(lane, l);
  };
  const occupants = (lane: number, a: number, b: number) => {
    const lo = Math.min(a, b) + 2, hi = Math.max(a, b) - 2;
    return (occupied.get(lane) ?? []).filter(([x0, x1]) => lo < x1 && x0 < hi);
  };
  /**
   * Free lane for a new run, starting from the one the switch rules ask for.
   * When it is taken, the real lateral offsets decide whether the new track
   * lies beyond the occupant (move one lane further out) or between it and
   * the track it came from (take a lane halfway). Lanes are renumbered to
   * integers at the end.
   */
  const findLane = (wanted: number, from: number, outward: 1 | -1, a: number, b: number, lat: number): number => {
    let inner = from;
    let outer: number | undefined;
    let cand = wanted;
    for (let guard = 0; guard < 40; guard++) {
      const occ = occupants(cand, a, b);
      if (occ.length === 0) return cand;
      const occLat = occ.reduce((sum, o) => sum + o[2], 0) / occ.length;
      if ((lat - occLat) * outward > 0) {
        inner = cand;
        cand = outer === undefined ? cand + outward : (cand + outer) / 2;
      } else {
        outer = cand;
        cand = (inner + cand) / 2;
      }
    }
    return cand;
  };
  const describe = (ne: string) => {
    const t = trackOf.get(ne);
    return { ...(t?.label ? { track: t.label } : {}), ...(t ? { kind: t.kind } : {}) };
  };

  // ---- the route: lane 0
  const heap = new MinHeap<number>();
  for (const step of route.steps) {
    const len = net.lengths.get(step.ne) ?? 0;
    const entry: EndRef = { ne: step.ne, end: step.forward ? 0 : 1 };
    const exit = otherEnd(entry);
    const fromOrigin = step.forward ? step.from : len - step.from; // metres between the entry end and where the route enters
    const xEntry = step.startDistance - fromOrigin;
    const xExit = xEntry + len;
    for (const [end, x] of [[entry, xEntry], [exit, xExit]] as const) {
      const n = net.nodeOf(end);
      if (!pos.has(n)) {
        pos.set(n, { x, y: 0 });
        lateral.set(n, 0);
        cost.set(n, 0);
        routeNodes.add(n);
        heap.push(0, n);
      }
    }
    drawn.add(step.ne);
    tracks.push({ ne: step.ne, ...describe(step.ne), onRoute: true, from: { x: xEntry, y: 0 }, to: { x: xExit, y: 0 }, lane: 0 });
    occupy(0, xEntry, xExit, 0);
  }

  // ---- screen side of each switch's deviating branch, from its geometry
  const screen = new Map<number, { deviates: 1 | -1; facing: boolean }>();
  const switchScreen = (node: number, x = pos.get(node)?.x) => {
    let v = screen.get(node);
    if (v) return v;
    const sw = switchAt.get(node);
    if (!sw || x === undefined) return undefined;
    const tip = net.endPoint(sw.common);
    const back = net.walk(sw.common, 30, frame);
    if (!tip || back.length < 2) return undefined;
    const heading = sub(frame.xy(tip), back.at(-1)!); // common leg -> into the switch
    const o = sign(dot(heading, tangentAt(rl, x)));
    v = { deviates: ((sw.deviatingSide === "left" ? 1 : -1) * o) as 1 | -1, facing: o === 1 };
    screen.set(node, v);
    return v;
  };

  const isCrossing = (node: number) => (net.nodes[node]?.length ?? 0) >= 4;

  // ---- grow outwards from the route, nearest tracks first
  for (let item = heap.pop(); item; item = heap.pop()) {
    const [c, n] = item;
    if (c > (cost.get(n) ?? Infinity)) continue;
    const pn = pos.get(n)!;
    const swN = switchAt.get(n);
    const scrN = swN ? switchScreen(n) : undefined;
    for (const end of net.nodes[n] ?? []) {
      if (drawn.has(end.ne) || !net.hasGeometry(end.ne)) continue;
      const len = net.lengths.get(end.ne) ?? 0;
      const far = otherEnd(end);
      const m = net.nodeOf(far);
      const devN = !!swN && !!scrN && endKey(swN.deviating) === endKey(end);
      const contN = !!swN && !!scrN && endKey(swN.continuous) === endKey(end);
      const dN = devN ? scrN!.deviates : 0;
      // direction of the element along x, leaving n
      const lead = net.walk(end, Math.min(15, Math.max(len, 1)), frame);
      const dir = lead.length >= 2 ? sign(dot(sub(lead.at(-1)!, lead[0]!), tangentAt(rl, pn.x))) : 1;
      const pm = pos.get(m);
      if (pm) {
        const swM = switchAt.get(m);
        const scrM = swM ? switchScreen(m) : undefined;
        const devM = !!swM && !!scrM && endKey(swM.deviating) === endKey(far);
        const dM = devM ? -scrM!.deviates : 0;
        // loop closing on a node that is already placed
        const lane = dN && dM && dN === dM ? null : pn.y + dN;
        drawn.add(end.ne);
        tracks.push({ ne: end.ne, ...describe(end.ne), onRoute: false, from: pn, to: pm, lane });
        if (lane !== null) occupy(lane, pn.x, pm.x, ((lateral.get(n) ?? 0) + (lateral.get(m) ?? 0)) / 2);
        continue;
      }
      const farPt = net.endPoint(far);
      if (!farPt) continue;
      const proj = project(rl, frame.xy(farPt), pn.x - len - 500, pn.x + len + 500);
      const reachM = c + len;
      // the far node: projected onto the route, but never behind the direction the track leaves in
      let xm = proj?.s ?? pn.x + dir * len;
      if (sign(xm - pn.x) !== dir || Math.abs(xm - pn.x) < 1) xm = pn.x + dir * Math.min(len, 10);
      // the far node's switch decides how the element arrives there
      const swM = switchAt.get(m);
      let dM = 0;
      if (swM && endKey(swM.deviating) === endKey(far)) {
        const scrM = switchScreen(m, xm);
        dM = scrM ? -scrM.deviates : 0;
      }
      const leaving = !proj || Math.abs(proj.lateral) > corridor || reachM > reach;
      if (leaving) {
        const y = pn.y + dN;
        drawn.add(end.ne);
        tracks.push({
          ne: end.ne,
          ...describe(end.ne),
          onRoute: false,
          from: pn,
          to: { x: pn.x + dir * Math.min(len, stubLength), y },
          lane: y,
          stub: true,
        });
        continue;
      }
      let lane: number | null;
      let ym: number;
      if (dN && dM && dN === dM) {
        lane = null; // crossover
        ym = pn.y + dN;
      } else if (dN && isCrossing(m)) {
        lane = null;
        ym = pn.y + dN / 2;
      } else if (dM && isCrossing(n)) {
        lane = null;
        ym = pn.y + dM / 2;
      } else {
        lane = pn.y + dN;
        ym = lane + dM;
      }
      const latM = proj!.lateral;
      const latRun = ((lateral.get(n) ?? 0) + latM) / 2;
      if (lane !== null && occupants(lane, pn.x, xm).length) {
        // outwards = towards the deviating side, away from it for the continuous branch, else the side it lies on
        const outward = dN ? dN : contN && scrN ? (-scrN.deviates as 1 | -1) : dM ? sign(dM) : sign(latRun - (lateral.get(n) ?? 0)) ;
        const found = findLane(lane, pn.y, outward, pn.x, xm, latRun);
        ym += found - lane;
        lane = found;
      }
      const pm2 = { x: xm, y: ym };
      pos.set(m, pm2);
      lateral.set(m, latM);
      cost.set(m, reachM);
      heap.push(reachM, m);
      drawn.add(end.ne);
      tracks.push({ ne: end.ne, ...describe(end.ne), onRoute: false, from: pn, to: pm2, lane });
      if (lane !== null) occupy(lane, pn.x, xm, latRun);
    }
  }

  renumberLanes(tracks, pos, routeNodes);

  const switches: SchematicSwitch[] = [];
  for (const [node, p] of pos) {
    const sw = switchAt.get(node);
    const scr = sw ? switchScreen(node) : undefined;
    if (!sw || !scr) continue;
    const onRoute = routeNodes.has(node);
    const routeDeviates = onRoute && route.steps.some((s) => s.ne === sw.deviating.ne);
    switches.push({
      node,
      x: p.x,
      y: p.y,
      deviates: scr.deviates,
      facing: scr.facing,
      onRoute,
      routeDeviates,
      rule: sw.rule,
      deviatingSide: sw.deviatingSide,
      ...(sw.label ? { label: sw.label } : {}),
      ...(sw.switchId ? { switchId: sw.switchId } : {}),
    });
  }
  let minLane = 0, maxLane = 0;
  for (const t of tracks) for (const y of [t.from.y, t.to.y]) {
    minLane = Math.min(minLane, y);
    maxLane = Math.max(maxLane, y);
  }
  return { length: route.length, tracks, switches, minLane, maxLane };
}

/**
 * Turn the (possibly fractional) lanes into consecutive integers, keeping
 * their order and the route on 0. Each group of tracks hanging off the route
 * (a station, a yard) is renumbered on its own, so a crowded station does not
 * spread the lanes of the others.
 */
function renumberLanes(tracks: SchematicTrack[], pos: Map<number, SchematicPoint>, routeNodes: Set<number>): void {
  // group off-route tracks that share an off-route node
  const parent = new Map<number, number>();
  const find = (a: number): number => {
    while (parent.get(a) !== undefined && parent.get(a) !== a) a = parent.get(a)!;
    return a;
  };
  const nodeOf = new Map<SchematicPoint, number>();
  for (const [n, p] of pos) nodeOf.set(p, n);
  const offRoute = tracks.filter((t) => !t.onRoute);
  const groupKey = (t: SchematicTrack, i: number): number => {
    const ends = [nodeOf.get(t.from), nodeOf.get(t.to)].filter((n): n is number => n !== undefined && !routeNodes.has(n));
    return ends.length ? find(ends[0]!) : -1 - i;
  };
  for (const t of offRoute) {
    const ends = [nodeOf.get(t.from), nodeOf.get(t.to)].filter((n): n is number => n !== undefined && !routeNodes.has(n));
    for (const n of ends) if (!parent.has(n)) parent.set(n, n);
    if (ends.length === 2) parent.set(find(ends[0]!), find(ends[1]!));
  }
  const groups = new Map<number, SchematicTrack[]>();
  offRoute.forEach((t, i) => {
    const k = groupKey(t, i);
    const g = groups.get(k);
    if (g) g.push(t);
    else groups.set(k, [t]);
  });
  const done = new Set<SchematicPoint>();
  for (const group of groups.values()) {
    const values = new Set<number>();
    for (const t of group) {
      values.add(t.from.y);
      values.add(t.to.y);
      if (t.lane !== null) values.add(t.lane);
    }
    const neg = [...values].filter((v) => v < 0).sort((a, b) => b - a);
    const posv = [...values].filter((v) => v > 0).sort((a, b) => a - b);
    const map = new Map<number, number>([[0, 0]]);
    neg.forEach((v, i) => map.set(v, -(i + 1)));
    posv.forEach((v, i) => map.set(v, i + 1));
    for (const t of group) {
      for (const p of [t.from, t.to]) {
        if (done.has(p)) continue;
        done.add(p);
        p.y = map.get(p.y) ?? p.y;
      }
      if (t.lane !== null) t.lane = map.get(t.lane) ?? t.lane;
    }
  }
}
