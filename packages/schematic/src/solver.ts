import type { Route } from "@routebook/routing";
import { MinHeap } from "@routebook/routing";
import { endKey, otherEnd, type EndRef } from "./network.js";
import { emitSchematic, layoutCore, type Explored, type LayoutInput, type LayoutOptions, type Schematic, type SchematicPoint, type SchematicTrack } from "./layout.js";
import { Lin, LpModel } from "./lp.js";

/**
 * Solver-based schematic layout: a port of railplot's model (Bjørnar
 * Luteberget, https://github.com/luteberget/railplot, MIT licence; Ch. 6 of
 * his thesis) to a mixed-integer program, solved with HiGHS.
 *
 * railplot draws every edge (element) as a horizontal line at its own level
 * `y` with a 45° diagonal at either end where the node it meets lies on
 * another level. The nodes keep the order of their mileage along x; the
 * vertical order of the edges that overlap in x is computed from the
 * topology before solving (edge order: at a switch the right leg lies below
 * the left one, an edge whose end node lies strictly inside the x span of
 * another one hands the order on to the edges at that node, ambiguities are
 * fixed), and the port shapes say which end of a node runs straight through
 * it and which branches off up or down. railplot hands that to a SAT solver
 * modulo difference logic with lexicographic goals (width, height, bends,
 * diagonals, ...); here it is one MIP with a weighted objective in the same
 * order of importance.
 *
 * Differences from railplot:
 *  - x is the distance along the route in metres: the route nodes are fixed
 *    there, the other nodes keep the order of the heuristic placement
 *    (railplot's mileage) and stay close to it; an element needs `minRun`
 *    metres of horizontal room per lane its diagonals change (soft, so that
 *    elements between two fixed route nodes never make a window infeasible).
 *  - The straight leg of a switch is the continuous branch (Bane NOR rule) or
 *    the route; the other leg goes to its side, as in the heuristic.
 *  - A node with two ends (a joint between two elements) may also be the end
 *    of a diagonal, not only lie in the middle of one; a track never turns
 *    back on itself there (no V).
 *  - The route is decomposed into windows: x is cut in the open line, where
 *    no node lies within `cutGap` metres. The tracks that cross a cut keep
 *    their vertical order from one window to the next and may change lane
 *    there (drawn as kinks with `runs`). Each window is solved on its own,
 *    with a time limit; a window that fails keeps the heuristic layout.
 */
export interface SolvedLayoutOptions extends LayoutOptions {
  /** Solves the window models (default: HiGHS in this thread). */
  solver?: LpSolver;
  /** Seconds per window (default 0.5). */
  timeLimit?: number;
  /** Open line (m) without nodes where the route is cut into windows (default 300). */
  cutGap?: number;
  /** Diagnostics per window. */
  onWindow?: (w: WindowReport) => void;
}

export interface LpProblem {
  lp: string;
  /** seconds */
  timeLimit: number;
}

/** Primal values by variable name; undefined = no solution (infeasible, error, or time out without one). */
export type LpSolution = Record<string, number> | undefined;

/** Solves a batch of independent LP-format models. */
export type LpSolver = (problems: LpProblem[]) => Promise<LpSolution[]>;

export interface WindowReport {
  from: number;
  to: number;
  nodes: number;
  pieces: number;
  vars: number;
  rows: number;
  status: "solved" | "order-conflict" | "infeasible-x" | "no-solution";
  /** pairs of edges whose vertical order contradicted the topology (they may cross) */
  conflicts: number;
}

/** One element (or route element) as an edge between two nodes, left to right in x. */
interface GEdge {
  /** index into ex.elems; -1 for a route element */
  elem: number;
  L: number;
  R: number;
  /** element end at L and at R (undefined at a stub's virtual end) */
  endL?: EndRef;
  endR?: EndRef;
  route: boolean;
  lat: number;
}

/** The part of an edge inside one window. */
interface Piece {
  edge: number;
  /** local node index of the left end, -1 when it comes in over the left cut */
  s: number;
  /** local node index of the right end, `nodes.length` when it leaves over the right cut */
  t: number;
}

interface Window {
  /** cut x on the left and on the right (±Infinity at the ends of the route) */
  x0: number;
  x1: number;
  nodes: number[];
  pieces: Piece[];
}

/** A shape port: how a piece meets a node. */
type Port =
  | { kind: "straight" }
  /** branches off to the screen side `s` (+1 = up) */
  | { kind: "branch"; s: 1 | -1 }
  /** a joint between two elements: shape decided by the solver */
  | { kind: "joint" }
  /** a branch whose side contradicts the edge order (a crossing without a node): either way */
  | { kind: "free" };

/** Length (m) an element keeps at least, or its own length when shorter. */
const MIN_LENGTH = 20;

const WEIGHTS = {
  height: 1000,
  bend: 60,
  lane: 20,
  level: 4,
  /** per metre a node moves away from the heuristic x */
  x: 0.02,
  /** per metre of missing room for a diagonal */
  room: 40,
  /** per metre an element is shorter than MIN_LENGTH */
  squeeze: 400,
};

/**
 * Lay out the tracks around a route with the solver. Same output as
 * `layoutRouteSchematic`; that heuristic layout is computed first and kept
 * for every window the solver cannot do.
 */
export async function layoutRouteSchematicSolved(route: Route, input: LayoutInput, opts: SolvedLayoutOptions = {}): Promise<Schematic> {
  const prepared = prepareSolvedLayout(route, input, opts);
  if (!prepared.problems.length) return prepared.heuristic;
  const solver = opts.solver ?? (await import("./highs.js")).highsSolver();
  const solutions = await solver(prepared.problems);
  return prepared.finish(solutions);
}

/**
 * The synchronous half of the solver layout: the heuristic layout, the
 * window models to solve, and `finish` to turn their solutions into the
 * schematic. Lets the caller solve the models elsewhere (a Web Worker).
 */
export function prepareSolvedLayout(route: Route, input: LayoutInput, opts: SolvedLayoutOptions = {}) {
  const core = layoutCore(route, input, opts);
  const { ex, byElem, laid } = core;
  const timeLimit = opts.timeLimit ?? 0.5;
  const cutGap = opts.cutGap ?? 1000;
  const Y = 2 * (Number.isFinite(ex.maxLanes) ? ex.maxLanes : Math.max(-core.schematic.minLane, core.schematic.maxLane, 1)) + 4;
  const M = 2 * Y + 2;
  const minRun = ex.minRun;

  // ---- the graph: route elements, laid off-route elements, a virtual end node per stub
  const pos = new Map<number, number>();
  for (const [n, info] of ex.nodes) pos.set(n, info.x);
  const edges: GEdge[] = [];
  for (const step of route.steps) {
    const entry: EndRef = { ne: step.ne, end: step.forward ? 0 : 1 };
    const exit = otherEnd(entry);
    const [a, b] = [ex.net.nodeOf(entry), ex.net.nodeOf(exit)];
    if (a === b) continue;
    edges.push({ elem: -1, L: a, R: b, endL: entry, endR: exit, route: true, lat: 0 });
  }
  let virt = -1;
  const stubEnd = new Map<number, number>();
  /** elements drawn as a plain diagonal between their nodes (no place in the model) */
  const loose = new Set<number>();
  ex.elems.forEach((e, i) => {
    const t = byElem.get(i);
    if (!t) return; // left out by the heuristic: stays a short stub
    if (e.conflict || e.m === undefined && !e.stub) {
      loose.add(i);
      return;
    }
    let m = e.m;
    if (m === undefined) {
      m = virt--;
      pos.set(m, pos.get(e.n)! + e.dir * Math.min(e.len, ex.stubLength));
      stubEnd.set(i, m);
    }
    const far = e.m !== undefined ? otherEnd(e.a) : undefined;
    const [L, R, endL, endR] = e.dir > 0 ? [e.n, m, e.a, far] : [m, e.n, far, e.a];
    edges.push({ elem: i, L, R, ...(endL ? { endL } : {}), ...(endR ? { endR } : {}), route: false, lat: e.lat });
  });

  // ---- one order of all nodes along x: the heuristic x, kept consistent with the edges where it can be
  const all = [...pos.keys()];
  const out = new Map<number, number[]>();
  const indeg = new Map<number, number>();
  for (const g of edges) {
    out.set(g.L, [...(out.get(g.L) ?? []), g.R]);
    indeg.set(g.R, (indeg.get(g.R) ?? 0) + 1);
  }
  const heap = new MinHeap<number>();
  for (const n of all) if (!indeg.get(n)) heap.push(pos.get(n)!, n);
  const rest = new MinHeap<number>();
  for (const n of all) rest.push(pos.get(n)!, n);
  const seq: number[] = [];
  const done = new Set<number>();
  while (seq.length < all.length) {
    let it = heap.pop();
    while (it && done.has(it[1])) it = heap.pop();
    if (!it) {
      // a cycle: take the leftmost node still waiting
      it = rest.pop();
      while (it && done.has(it[1])) it = rest.pop();
    }
    const n = it![1];
    done.add(n);
    seq.push(n);
    for (const v of out.get(n) ?? []) {
      const d = indeg.get(v)! - 1;
      indeg.set(v, d);
      if (d === 0 && !done.has(v)) heap.push(pos.get(v)!, v);
    }
  }
  // railplot keeps the nodes in mileage order: here the heuristic x, the topological order only breaking ties
  const topo = new Map(seq.map((n, i) => [n, i]));
  seq.sort((a, b) => pos.get(a)! - pos.get(b)! || topo.get(a)! - topo.get(b)!);
  const idx = new Map(seq.map((n, i) => [n, i]));
  // an edge against the order (only in a cycle) is drawn as a diagonal
  const live = edges.filter((g) => {
    if (idx.get(g.L)! < idx.get(g.R)!) return true;
    if (g.elem >= 0) loose.add(g.elem);
    return false;
  });

  // ---- windows: cut where the open line has no node for cutGap metres
  const windows: Window[] = [];
  let startIdx = 0, maxPos = -Infinity, x0 = -Infinity;
  for (let i = 0; i < seq.length; i++) {
    const p = pos.get(seq[i]!)!;
    if (i > startIdx && p - maxPos >= cutGap) {
      const cut = (maxPos + p) / 2;
      windows.push({ x0, x1: cut, nodes: seq.slice(startIdx, i), pieces: [] });
      x0 = cut;
      startIdx = i;
    }
    maxPos = Math.max(maxPos, p);
  }
  windows.push({ x0, x1: Infinity, nodes: seq.slice(startIdx), pieces: [] });
  const winOf = new Map<number, number>();
  windows.forEach((w, k) => w.nodes.forEach((n) => winOf.set(n, k)));
  const local = new Map<number, number>();
  for (const w of windows) w.nodes.forEach((n, i) => local.set(n, i));
  live.forEach((g, gi) => {
    const a = winOf.get(g.L)!, b = winOf.get(g.R)!;
    for (let k = a; k <= b; k++) {
      const w = windows[k]!;
      w.pieces.push({ edge: gi, s: k === a ? local.get(g.L)! : -1, t: k === b ? local.get(g.R)! : w.nodes.length });
    }
  });

  // ---- ports: how each end meets its node
  const included = new Map<number, Array<{ edge: number; end: EndRef; side: 1 | -1 }>>();
  live.forEach((g, gi) => {
    if (g.endL) included.set(g.L, [...(included.get(g.L) ?? []), { edge: gi, end: g.endL, side: 1 }]);
    if (g.endR) included.set(g.R, [...(included.get(g.R) ?? []), { edge: gi, end: g.endR, side: -1 }]);
  });
  const onRoute = (n: number) => ex.nodes.get(n)?.onRoute ?? false;
  const portOf = (n: number, end: EndRef | undefined): Port => {
    if (!end) return { kind: "straight" };
    const inc = included.get(n) ?? [];
    if (!onRoute(n) && inc.length === 2 && inc[0]!.side !== inc[1]!.side) return { kind: "joint" };
    if (inc.length <= 1) return { kind: "straight" };
    if (ex.mainOf(n).has(endKey(end))) return { kind: "straight" };
    return { kind: "branch", s: ex.sigma(n, end) };
  };
  /** screen value of an end at a node for the edge order: straight 0, branch ±1 */
  const screen = (p: Port) => (p.kind === "branch" ? p.s : 0);

  // ---- per window: edge order, then the model
  const problems: Array<{ k: number; model: LpModel; report: WindowReport }> = [];
  const reports: WindowReport[] = [];
  let carry: number[] | undefined; // edges over the left cut, bottom to top
  // what the topology of each window alone says about the order of the tracks over its cuts: handed to the
  // windows on either side, so that a window does not settle the order at a cut against its neighbour
  const derived = windows.map((w) => edgeOrder(w, live, portOf, screen, { derivedOnly: true })?.boundary ?? []);
  windows.forEach((w, k) => {
    const pieces = w.pieces;
    const offRoute = pieces.some((p) => !live[p.edge]!.route);
    const report = (st: WindowReport["status"], size = { vars: 0, rows: 0 }) => {
      const r: WindowReport = {
        from: Number.isFinite(w.x0) ? w.x0 : pos.get(w.nodes[0]!)!,
        to: Number.isFinite(w.x1) ? w.x1 : pos.get(w.nodes.at(-1)!)!,
        nodes: w.nodes.length,
        pieces: pieces.length,
        ...size,
        status: st,
        conflicts: order?.conflicts ?? 0,
      };
      reports.push(r);
      return r;
    };
    const order = edgeOrder(w, live, portOf, screen, { ...(carry ? { carry } : {}), hints: [...(derived[k - 1] ?? []), ...(derived[k + 1] ?? [])] });
    // the order over the right cut, for the next window: from this window's order, or the heuristic lanes
    const crossing = pieces.map((p, i) => [p, i] as const).filter(([p]) => p.t === w.nodes.length);
    if (order) carry = order.top.map((i) => pieces[i]!.edge);
    else {
      const laneAt = (gi: number) => {
        const g = live[gi]!;
        if (g.route) return 0;
        const t = byElem.get(g.elem)!;
        const r = (t.runs ?? []).find((q) => Math.min(q.from, q.to) <= w.x1 && w.x1 <= Math.max(q.from, q.to));
        return r ? r.y : (t.lane ?? 0);
      };
      carry = crossing.map(([p]) => p.edge).sort((a, b) => laneAt(a) - laneAt(b) || live[a]!.lat - live[b]!.lat);
    }
    if (!offRoute) return;
    if (!order) return report("order-conflict");
    const model = buildModel(w, k, order);
    if (!model) return report("infeasible-x");
    problems.push({ k, model, report: report("solved", model.size) });
  });

  function buildModel(w: Window, k: number, order: NonNullable<ReturnType<typeof edgeOrder>>): LpModel | undefined {
    const { pairs, relaxed, inner } = order;
    const m = new LpModel();
    const pieces = w.pieces;
    const N = w.nodes.length;
    // x: route nodes fixed; the others between the fixed ones around them in the order and inside the cuts
    const margin = cutGap / 4;
    const lo = new Array<number>(N), hi = new Array<number>(N);
    let fixed = w.x0 + margin;
    if (!Number.isFinite(fixed)) fixed = Math.min(...w.nodes.map((n) => pos.get(n)!)) - 2000;
    for (let i = 0; i < N; i++) {
      const n = w.nodes[i]!;
      if (onRoute(n)) {
        if (pos.get(n)! < fixed - 1e-6) return undefined;
        fixed = pos.get(n)!;
      }
      lo[i] = fixed;
    }
    fixed = w.x1 - margin;
    if (!Number.isFinite(fixed)) fixed = Math.max(...w.nodes.map((n) => pos.get(n)!)) + 2000;
    for (let i = N - 1; i >= 0; i--) {
      const n = w.nodes[i]!;
      if (onRoute(n)) fixed = pos.get(n)!;
      hi[i] = fixed;
      if (lo[i]! > hi[i]! + 1e-6) return undefined;
    }
    const X = (i: number): Lin => {
      if (i < 0) return Lin.of(w.x0);
      if (i >= N) return Lin.of(w.x1);
      const n = w.nodes[i]!;
      if (onRoute(n)) return Lin.of(pos.get(n)!);
      return Lin.of([m.v(`x${i}`, lo[i]!, hi[i]!), 1]);
    };
    const Yn = (i: number): Lin => (onRoute(w.nodes[i]!) ? Lin.of(0) : Lin.of([m.v(`y${i}`, -Y, Y, "int"), 1]));
    const E = (pi: number): Lin => (live[pieces[pi]!.edge]!.route ? Lin.of(0) : Lin.of([m.v(`e${pi}`, -Y, Y, "int"), 1]));

    // order along x
    for (let i = 1; i < N; i++) m.row(Lin.of().plus(X(i)).plus(X(i - 1), -1), ">=", 0);
    // x close to the heuristic placement
    for (let i = 0; i < N; i++) {
      const n = w.nodes[i]!;
      if (onRoute(n)) continue;
      const d = m.v(`dx${i}`, 0, Infinity);
      m.row(Lin.of([d, 1]).plus(X(i), -1), ">=", -pos.get(n)!);
      m.row(Lin.of([d, 1]).plus(X(i)), ">=", pos.get(n)!);
      m.minimize(d, WEIGHTS.x);
    }
    // stubs: the virtual end lies the stub length from its node
    for (const [i, vn] of stubEnd) {
      const a = local.get(ex.elems[i]!.n), b = local.get(vn);
      if (a === undefined || b === undefined || winOf.get(vn) !== k || winOf.get(ex.elems[i]!.n) !== k) continue;
      m.row(Lin.of().plus(X(b)).plus(X(a), -1), "=", pos.get(vn)! - pos.get(ex.elems[i]!.n)!);
    }

    const hUp = m.v("hup", 0, Y), hDn = m.v("hdn", 0, Y);
    m.minimize(hUp, WEIGHTS.height);
    m.minimize(hDn, WEIGHTS.height);
    const shortVar = new Map<number, string>();

    // joints: the shape of each end there (up, down or straight on)
    const jointVars = new Map<string, { up: string; dn: string }>();
    const jointEnd = (i: number, end: "L" | "R") => {
      // "L": the piece leaves node i to the right; "R": it comes into node i from the left
      const key = `${i}${end}`;
      const v = { up: m.v(`u${key}`, 0, 1, "bin"), dn: m.v(`d${key}`, 0, 1, "bin") };
      jointVars.set(key, v);
      m.minimize(v.up, WEIGHTS.bend);
      m.minimize(v.dn, WEIGHTS.bend);
      m.row(Lin.of([v.up, 1], [v.dn, 1]), "<=", 1);
      return v;
    };

    pieces.forEach((p, pi) => {
      const g = live[p.edge]!;
      const e = E(pi);
      if (!g.route) {
        m.row(Lin.of([hUp, 1]).plus(e, -1), ">=", 0);
        m.row(Lin.of([hDn, 1]).plus(e), ">=", 0);
        const ay = m.v(`ay${pi}`, 0, Y);
        m.row(Lin.of([ay, 1]).plus(e, -1), ">=", 0);
        m.row(Lin.of([ay, 1]).plus(e), ">=", 0);
        m.minimize(ay, WEIGHTS.level);
      }
      // the lanes each end's diagonal changes, as expressions (exact for fixed shapes, bounded below for joints)
      const rise: Lin[] = [];
      const port = (i: number, n: number, end: EndRef | undefined): Port => (relaxed.has(`${pi}:${i}`) ? { kind: "free" } : portOf(n, end));
      const portL = p.s >= 0 ? port(p.s, g.L, g.endL) : undefined;
      const portR = p.t < N ? port(p.t, g.R, g.endR) : undefined;
      const canShort = portL?.kind === "branch" && portR?.kind === "branch" && portL.s === -portR.s && !g.route;
      let sh: string | undefined;
      if (canShort) {
        sh = m.v(`s${pi}`, 0, 1, "bin");
        shortVar.set(pi, sh);
      }
      for (const [end, port, i] of [["L", portL, p.s], ["R", portR, p.t]] as const) {
        if (!port) continue;
        const t = Lin.of().plus(e).plus(Yn(i), -1); // e - y(node)
        if (port.kind === "straight") m.row(t, "=", 0);
        else if (port.kind === "branch") {
          // s * (e - y) >= 1, relaxed to >= 0 at the right end of a short edge
          const st = Lin.of().plus(t, port.s);
          if (sh && end === "R") m.row(Lin.of([sh, 1]).plus(st), ">=", 1);
          else m.row(st, ">=", 1);
          rise.push(st);
        } else if (port.kind === "free") {
          const a = m.v(`a${pi}${end}`, 0, 2 * Y);
          m.row(Lin.of([a, 1]).plus(t, -1), ">=", 0);
          m.row(Lin.of([a, 1]).plus(t), ">=", 0);
          rise.push(Lin.of([a, 1]));
        } else {
          const v = jointEnd(i, end);
          // left end: up = e above the node; right end: up = e below the node (the track climbs into it)
          const k = end === "L" ? 1 : -1;
          // up: k*t >= 1; down: k*t <= -1; neither: t = 0
          m.row(Lin.of().plus(t, k).plus(Lin.of([v.up, -1], [v.dn, M])), ">=", 0);
          m.row(Lin.of().plus(t, k).plus(Lin.of([v.dn, 1], [v.up, -M])), "<=", 0);
          const a = m.v(`a${pi}${end}`, 0, 2 * Y);
          m.row(Lin.of([a, 1]).plus(t, -1), ">=", 0);
          m.row(Lin.of([a, 1]).plus(t), ">=", 0);
          rise.push(Lin.of([a, 1]));
        }
      }
      if (sh) {
        // short: the two nodes one lane apart (the edge is one diagonal)
        const sL = (portL as { s: 1 | -1 }).s;
        m.row(Lin.of().plus(Yn(p.t), sL).plus(Yn(p.s), -sL).plus(Lin.of([sh, M])), "<=", 1 + M);
      }
      // room for the diagonals: minRun metres per lane changed, and some length in any case (soft)
      const slack = m.v(`r${pi}`, 0, Infinity);
      m.minimize(slack, WEIGHTS.room);
      const len = g.route ? 0 : ex.elems[g.elem]!.len;
      if (!g.route) {
        // an element squeezed to (almost) nothing is drawn as a dot inside another track: dearer than height
        const short = m.v(`z${pi}`, 0, Infinity);
        m.minimize(short, WEIGHTS.squeeze);
        m.row(Lin.of([short, 1]).plus(X(p.t)).plus(X(p.s), -1), ">=", Math.min(len, MIN_LENGTH));
      }
      if (rise.length) {
        const lanes = Lin.of();
        for (const r of rise) lanes.plus(r);
        m.row(Lin.of([slack, 1]).plus(X(p.t)).plus(X(p.s), -1).plus(lanes, -minRun), ">=", 0);
        // lanes changed, for the objective
        const lv = m.v(`l${pi}`, 0, 4 * Y);
        m.row(Lin.of([lv, 1]).plus(lanes, -1), ">=", 0);
        m.minimize(lv, WEIGHTS.lane);
      }
    });
    // a node inside a piece's span stays clear of the piece's end diagonals: at height y_n the diagonal
    // towards an end at y_end is minRun * (y_end - y_n) metres from that end (railplot's x/y coupling)
    const clear = new Map<string, string>();
    for (const [a, i, side] of inner) {
      const p = pieces[a]!;
      for (const [end, j] of [["L", p.s], ["R", p.t]] as const) {
        if (j < 0 || j >= N) continue;
        if (Math.abs(pos.get(w.nodes[j]!)! - pos.get(w.nodes[i]!)!) > minRun * 2 * Y + 200) continue;
        let sl = clear.get(`${a}${end}`);
        if (!sl) {
          sl = m.v(`k${a}${end}`, 0, Infinity);
          m.minimize(sl, WEIGHTS.room);
          clear.set(`${a}${end}`, sl);
        }
        const dx = end === "R" ? Lin.of().plus(X(j)).plus(X(i), -1) : Lin.of().plus(X(i)).plus(X(j), -1);
        const dy = Lin.of().plus(Yn(j), side).plus(Yn(i), -side);
        m.row(dx.add(sl, 1).plus(dy, -minRun), ">=", 0);
      }
    }
    // joints: no V (climbing into the node and falling out of it, or the reverse)
    for (let i = 0; i < N; i++) {
      const a = jointVars.get(`${i}R`), b = jointVars.get(`${i}L`);
      if (!a || !b) continue;
      m.row(Lin.of([a.up, 1], [b.dn, 1]), "<=", 1);
      m.row(Lin.of([a.dn, 1], [b.up, 1]), "<=", 1);
    }
    // edge order: the upper edge at least a lane above the lower one (or level with the top of a short one)
    for (const [a, b] of pairs) {
      const ea = E(a), eb = E(b);
      if (live[pieces[a]!.edge]!.route && live[pieces[b]!.edge]!.route) continue;
      const lin = Lin.of().plus(eb).plus(ea, -1);
      const sa = shortVar.get(a);
      if (sa) lin.add(sa, 1);
      m.row(lin, ">=", 1);
    }
    return m;
  }

  const finish = (solutions: LpSolution[]): Schematic => {
    const solved = new Map<number, Record<string, number>>();
    problems.forEach(({ k, report }, i) => {
      const sol = solutions[i];
      if (sol) solved.set(k, sol);
      else report.status = "no-solution";
    });
    for (const r of reports) opts.onWindow?.(r);
    const hp = core.points;
    const points = new Map<number, SchematicPoint>();
    const point = (n: number): SchematicPoint => {
      let p = points.get(n);
      if (p) return p;
      const k = winOf.get(n);
      const sol = k === undefined ? undefined : solved.get(k);
      const i = local.get(n);
      if (sol && i !== undefined && !onRoute(n) && sol[`y${i}`] !== undefined) p = { x: round(sol[`x${i}`] ?? pos.get(n)!), y: Math.round(sol[`y${i}`]!) || 0 };
      else if (onRoute(n)) p = { x: pos.get(n)!, y: 0 };
      else p = { ...(hp.get(n) ?? { x: pos.get(n)!, y: 0 }) };
      points.set(n, p);
      return p;
    };
    // per element: its pieces in the windows it crosses
    const piecesOf = new Map<number, Array<{ k: number; pi: number }>>();
    windows.forEach((w, k) =>
      w.pieces.forEach((p, pi) => {
        const g = live[p.edge]!;
        if (g.route) return;
        piecesOf.set(g.elem, [...(piecesOf.get(g.elem) ?? []), { k, pi }]);
      }),
    );
    type Run = { from: number; to: number; y: number };
    const track = (i: number): { lane: number | null; runs?: Run[] } | undefined => {
      const h = byElem.get(i);
      if (!h) return undefined;
      if (loose.has(i)) return { lane: null };
      const list = piecesOf.get(i);
      if (!list) return { lane: h.lane, ...(h.runs ? { runs: h.runs } : {}) };
      const e = ex.elems[i]!;
      // all in windows the solver did not do: the heuristic track as it is
      if (list.every(({ k }) => !solved.has(k))) return { lane: h.lane, ...(h.runs ? { runs: h.runs } : {}) };
      if (list.length === 1) {
        const { k, pi } = list[0]!;
        const sol = solved.get(k)!;
        if ((sol[`s${pi}`] ?? 0) > 0.5) return { lane: null };
        return { lane: Math.round(sol[`e${pi}`] ?? 0) || 0 };
      }
      // runs left to right, then in the direction of the element
      const runs: Run[] = [];
      for (const { k, pi } of list) {
        const w = windows[k]!;
        const p = w.pieces[pi]!;
        const g = live[p.edge]!;
        const xa = p.s >= 0 ? point(g.L).x : w.x0;
        const xb = p.t < w.nodes.length ? point(g.R).x : w.x1;
        const sol = solved.get(k);
        if (sol) runs.push({ from: xa, to: xb, y: Math.round(sol[`e${pi}`] ?? 0) || 0 });
        else {
          // the heuristic runs inside this window
          const hr = h.runs ?? [{ from: h.from.x, to: h.to.x, y: h.lane ?? 0 }];
          for (const r of hr) {
            const a = Math.max(xa, Math.min(r.from, r.to)), b = Math.min(xb, Math.max(r.from, r.to));
            if (b > a) runs.push({ from: a, to: b, y: r.y });
          }
        }
      }
      if (e.dir < 0) runs.reverse().forEach((r) => ([r.from, r.to] = [r.to, r.from]));
      const merged: Run[] = [];
      for (const r of runs) {
        const last = merged.at(-1);
        if (last && last.y === r.y) last.to = r.to;
        else merged.push({ ...r });
      }
      const longest = merged.reduce((p, q) => (Math.abs(q.to - q.from) > Math.abs(p.to - p.from) ? q : p));
      return merged.length > 1 ? { lane: longest.y, runs: merged } : { lane: longest.y };
    };
    return emitSchematic(ex, { point, track, laid }).schematic;
  };

  return { heuristic: core.schematic, problems: problems.map(({ model }) => ({ lp: model.toString(), timeLimit })), finish, reports };
}

const round = (x: number) => Math.round(x * 100) / 100;

/**
 * railplot's edge order for one window (edgeorder.rs): the legs at a node
 * by their screen side, propagated to the edges at a node that lies strictly
 * inside another edge's x span, made total in every slab between two
 * consecutive nodes (ties by the lateral offset from the route in the
 * geometry). Returns the explicit pairs [lower, upper] (piece indices) and
 * the order of the pieces over the right cut; undefined when the topology
 * gives contradicting orders.
 */
function edgeOrder(
  w: Window,
  live: GEdge[],
  portOf: (n: number, end: EndRef | undefined) => Port,
  screen: (p: Port) => number,
  opts: {
    /** the edges over the left cut, bottom to top, as the window before has them */
    carry?: number[];
    /** pairs of edges [lower, upper] to keep where they cross a cut, unless the topology says otherwise */
    hints?: Array<[number, number]>;
    /** stop before the ambiguities are fixed (`boundary` only) */
    derivedOnly?: boolean;
  },
): {
  pairs: Array<[number, number]>;
  top: number[];
  conflicts: number;
  relaxed: Set<string>;
  inner: Array<[number, number, 1 | -1]>;
  boundary: Array<[number, number]>;
} | undefined {
  const P = w.pieces.length;
  const N = w.nodes.length;
  const at = Array.from({ length: N }, () => [] as number[]);
  w.pieces.forEach((p, i) => {
    if (p.s >= 0) at[p.s]!.push(i);
    if (p.t < N) at[p.t]!.push(i);
  });
  const portAt = (pi: number, i: number): Port => {
    const g = live[w.pieces[pi]!.edge]!;
    return portOf(w.nodes[i]!, w.pieces[pi]!.s === i ? g.endL : g.endR);
  };
  // pieces that must share a level (the route; the straight pieces through a node) form one class
  const parent = Array.from({ length: P }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
    return i;
  };
  const routePiece = w.pieces.findIndex((p) => live[p.edge]!.route);
  w.pieces.forEach((p, i) => {
    if (live[p.edge]!.route) parent[find(i)] = find(routePiece);
  });
  for (let i = 0; i < N; i++) {
    const straight = at[i]!.filter((pi) => portAt(pi, i).kind === "straight");
    if (straight.length > 1) for (const pi of straight) parent[find(pi)] = find(straight[0]!);
  }
  const ids = new Map<number, number>();
  const cls = w.pieces.map((_, i) => {
    const r = find(i);
    if (!ids.has(r)) ids.set(r, ids.size);
    return ids.get(r)!;
  });
  const C = ids.size;
  const words = (C + 31) >>> 5;
  const succ = Array.from({ length: C }, () => new Uint32Array(words));
  const pred = Array.from({ length: C }, () => new Uint32Array(words));
  const has = (set: Uint32Array, i: number) => (set[i >>> 5]! & (1 << (i & 31))) !== 0;
  const set = (s: Uint32Array, i: number) => (s[i >>> 5]! |= 1 << (i & 31));
  /** piece a lies below piece b */
  const below = (a: number, b: number) => has(succ[cls[a]!]!, cls[b]!);
  const explicit = new Set<number>();
  const pairs: Array<[number, number]> = [];
  // an order that contradicts the ones known (tracks that cross without a node, e.g. on a bridge) is left
  // out: those two tracks are then free to cross
  let conflicts = 0;
  const queue: Array<[number, number]> = [];
  let head = 0;
  const insert = (a: number, b: number): boolean => {
    const ca = cls[a]!, cb = cls[b]!;
    if (ca === cb || has(succ[cb]!, ca)) {
      conflicts++;
      return false;
    }
    const key = a * P + b;
    if (explicit.has(key)) return true;
    explicit.add(key);
    pairs.push([a, b]);
    queue.push([a, b]);
    if (has(succ[ca]!, cb)) return true;
    // closure: everything at or below a is below everything at or above b
    const lower = Uint32Array.from(pred[ca]!);
    set(lower, ca);
    const upper = Uint32Array.from(succ[cb]!);
    set(upper, cb);
    for (let x = 0; x < C; x++) {
      if (has(lower, x)) for (let k = 0; k < words; k++) succ[x]![k]! |= upper[k]!;
      if (has(upper, x)) for (let k = 0; k < words; k++) pred[x]![k]! |= lower[k]!;
    }
    return true;
  };
  const inside = (i: number, n: number) => w.pieces[i]!.s < n && n < w.pieces[i]!.t;
  const propagate = () => {
    while (head < queue.length) {
      const [a, b] = queue[head++]!;
      for (const n of [w.pieces[b]!.s, w.pieces[b]!.t]) if (n >= 0 && n < N && inside(a, n)) for (const c of at[n]!) if (c !== a) insert(a, c);
      for (const n of [w.pieces[a]!.s, w.pieces[a]!.t]) if (n >= 0 && n < N && inside(b, n)) for (const c of at[n]!) if (c !== b) insert(c, b);
    }
  };

  // the ends at a node by screen side: on each side, and a branch against the straight track through the node
  // on the other side too (its level is tied to the node's); a branch whose order contradicts what is known
  // loses its port shape (the model then lets it leave the node either way)
  const relaxed = new Set<string>();
  for (let i = 0; i < N; i++) {
    const straight = at[i]!.find((pi) => portAt(pi, i).kind === "straight");
    for (const side of [1, -1] as const) {
      const list = at[i]!.filter((pi) => (side > 0 ? w.pieces[pi]!.s === i : w.pieces[pi]!.t === i)).map((pi) => [pi, screen(portAt(pi, i))] as const);
      for (const [a, va] of list) for (const [b, vb] of list) if (va < vb && !insert(a, b)) relaxed.add(`${va ? a : b}:${i}`);
      if (straight === undefined) continue;
      for (const [b, vb] of list) if (vb && b !== straight && !(vb > 0 ? insert(straight, b) : insert(b, straight))) relaxed.add(`${b}:${i}`);
    }
  }
  // the order over the left cut, from the window before; then what the neighbours' topology says at the cuts
  const pieceOf = new Map(w.pieces.map((p, i) => [p.edge, i] as const));
  if (opts.carry) {
    const list = opts.carry.map((e) => pieceOf.get(e)).filter((i): i is number => i !== undefined && w.pieces[i]!.s < 0);
    for (let i = 1; i < list.length; i++) insert(list[i - 1]!, list[i]!);
  }
  propagate();
  for (const [ea, eb] of opts.hints ?? []) {
    const a = pieceOf.get(ea), b = pieceOf.get(eb);
    if (a === undefined || b === undefined || below(a, b)) continue;
    const crossLeft = (i: number) => w.pieces[i]!.s < 0, crossRight = (i: number) => w.pieces[i]!.t >= N;
    if ((crossLeft(a) && crossLeft(b)) || (crossRight(a) && crossRight(b))) {
      insert(a, b);
      propagate();
    }
  }
  // the order of the tracks over the cuts that this window's topology decides
  const boundary: Array<[number, number]> = [];
  for (const cut of [(i: number) => w.pieces[i]!.s < 0, (i: number) => w.pieces[i]!.t >= N]) {
    const list = w.pieces.map((_, i) => i).filter(cut);
    for (const a of list) for (const b of list) if (a !== b && below(a, b)) boundary.push([w.pieces[a]!.edge, w.pieces[b]!.edge]);
  }
  if (opts.derivedOnly) return { pairs, top: [], conflicts, relaxed, inner: [], boundary };

  // ambiguities: each slab totally ordered, ties by the lateral offset
  const lat = (i: number) => live[w.pieces[i]!.edge]!.lat;
  const sortSlab = (active: number[]): number[] => {
    const left = new Set(active);
    const res: number[] = [];
    while (left.size) {
      let best: number | undefined;
      for (const i of left) {
        let minimal = true;
        for (const j of left) if (j !== i && below(j, i)) minimal = false;
        if (minimal && (best === undefined || lat(i) < lat(best))) best = i;
      }
      if (best === undefined) return [];
      res.push(best);
      left.delete(best);
    }
    return res;
  };
  let top: number[] = [];
  for (let k = -1; k < N; k++) {
    const active: number[] = [];
    w.pieces.forEach((p, i) => {
      if (p.s <= k && k < p.t) active.push(i);
    });
    for (let round = 0; round <= active.length; round++) {
      const ord = sortSlab(active);
      if (ord.length !== active.length) return undefined;
      let changed = false;
      for (let i = 1; i < ord.length; i++) {
        if (below(ord[i - 1]!, ord[i]!) || cls[ord[i - 1]!] === cls[ord[i]!]) continue;
        insert(ord[i - 1]!, ord[i]!);
        propagate();
        changed = true;
        break;
      }
      if (!changed) {
        if (k === N - 1) top = ord;
        break;
      }
    }
  }
  // the nodes inside each piece's x span that lie above (+1) or below (-1) it
  const inner: Array<[piece: number, node: number, side: 1 | -1]> = [];
  w.pieces.forEach((p, a) => {
    if (live[p.edge]!.route) return;
    for (let i = Math.max(0, p.s + 1); i < Math.min(N, p.t); i++) {
      const c = at[i]!.find((c) => below(a, c) || below(c, a));
      if (c !== undefined) inner.push([a, i, below(a, c) ? 1 : -1]);
    }
  });
  return { pairs, top, conflicts, relaxed, inner, boundary };
}
