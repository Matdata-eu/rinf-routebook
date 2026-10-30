import type { Topology, TopoInterval } from "@routebook/rinf-client";
import { lengthCostModel, type CostModel } from "./cost.js";
import { MinHeap } from "./heap.js";

/** End of an element: 0 = origin (offset 0), 1 = end (offset = length). */
export type Side = 0 | 1;

/** One traversed piece of a micro element, in travel order. */
export interface RouteStep {
  ne: string;
  /** true when travelling from origin towards the end (increasing offset). */
  forward: boolean;
  /** offset where the route enters this element (m). */
  from: number;
  /** offset where the route leaves this element (m). */
  to: number;
  /** distance from the start of the route to `from` (m). */
  startDistance: number;
}

export interface Route {
  steps: RouteStep[];
  /** physical length (m) */
  length: number;
  /** cost according to the cost model used */
  cost: number;
  costModel: string;
}

export interface RouteOptions {
  costModel?: CostModel;
}

type StateKey = string; // `${ne}|${side}`
interface Prev {
  prev: StateKey | null;
  /** offset at which the first element was entered (start states only). */
  startOffset?: number;
}
interface Arrival {
  /** state we were in before entering the target element; null = target on a start element */
  prev: StateKey | null;
  ne: string;
  enterOffset: number;
  targetOffset: number;
}

const key = (ne: string, side: Side): StateKey => `${ne}|${side}`;
const parseKey = (k: StateKey): [string, Side] => {
  const i = k.lastIndexOf("|");
  return [k.slice(0, i), Number(k.slice(i + 1)) as Side];
};

/**
 * Routing graph on the micro topology. A state is "standing at one end of an
 * element". Travelling along an element costs its length times the cost
 * factor; a navigable NetRelation connects element ends at zero cost, both
 * ways (navigability Both) or one way (AB, BA). Relations with navigability
 * None (switch leg-to-leg) are skipped, which prevents U-turns through switches.
 */
export class RoutingGraph {
  readonly lengths = new Map<string, number>();
  private readonly links = new Map<StateKey, Array<[string, Side]>>();

  constructor(topology: Topology) {
    for (const ne of topology.netElements) this.lengths.set(ne.id, ne.length);
    for (const r of topology.netRelations) {
      if (!r.navigable || !this.lengths.has(r.a) || !this.lengths.has(r.b)) continue;
      const sa: Side = r.aAtOrigin ? 0 : 1;
      const sb: Side = r.bAtOrigin ? 0 : 1;
      if (r.direction !== "BA") this.link(key(r.a, sa), [r.b, sb]);
      if (r.direction !== "AB") this.link(key(r.b, sb), [r.a, sa]);
    }
  }

  private link(from: StateKey, to: [string, Side]): void {
    const l = this.links.get(from);
    if (l) l.push(to);
    else this.links.set(from, [to]);
  }

  /** Connected components (navigable relations only), largest first; each is a list of element ids. */
  components(): string[][] {
    const parent = new Map<string, string>();
    for (const id of this.lengths.keys()) parent.set(id, id);
    const find = (x: string): string => {
      let r = x;
      while (parent.get(r) !== r) r = parent.get(r)!;
      while (parent.get(x) !== r) {
        const n = parent.get(x)!;
        parent.set(x, r);
        x = n;
      }
      return r;
    };
    for (const [k, list] of this.links) {
      const [ne] = parseKey(k);
      for (const [ne2] of list) parent.set(find(ne), find(ne2));
    }
    const groups = new Map<string, string[]>();
    for (const id of this.lengths.keys()) {
      const r = find(id);
      const g = groups.get(r);
      if (g) g.push(id);
      else groups.set(r, [id]);
    }
    return [...groups.values()].sort((a, b) => b.length - a.length);
  }

  /**
   * Shortest route from any interval in `from` to any interval in `to`.
   * Intervals may be points (start === end). The route leaves the start
   * interval at the edge facing the direction of travel and stops at the
   * nearest edge of the target interval.
   */
  route(from: TopoInterval[], to: TopoInterval[], opts: RouteOptions = {}): Route | null {
    const cm = opts.costModel ?? lengthCostModel;
    const targets = new Map<string, TopoInterval[]>();
    for (const t of to) {
      if (!this.lengths.has(t.ne)) continue;
      const l = targets.get(t.ne);
      if (l) l.push(t);
      else targets.set(t.ne, [t]);
    }
    if (targets.size === 0) return null;

    const cost = new Map<StateKey, number>();
    const phys = new Map<StateKey, number>();
    const prev = new Map<StateKey, Prev>();
    const heap = new MinHeap<StateKey>();
    // held in an object so TypeScript does not narrow it to null across the closure
    const found: { best: { cost: number; phys: number; arrival: Arrival } | null } = { best: null };

    const offer = (c: number, p: number, arrival: Arrival) => {
      if (!found.best || c < found.best.cost) found.best = { cost: c, phys: p, arrival };
    };

    for (const s of from) {
      const len = this.lengths.get(s.ne);
      if (len === undefined) continue;
      const f = cm.factor(s.ne);
      const lo = Math.max(0, Math.min(s.start, s.end));
      const hi = Math.min(len, Math.max(s.start, s.end));
      // target on the same element as the start
      for (const t of targets.get(s.ne) ?? []) {
        const tlo = Math.min(t.start, t.end), thi = Math.max(t.start, t.end);
        if (tlo >= hi) offer((tlo - hi) * f, tlo - hi, { prev: null, ne: s.ne, enterOffset: hi, targetOffset: tlo });
        else if (thi <= lo) offer((lo - thi) * f, lo - thi, { prev: null, ne: s.ne, enterOffset: lo, targetOffset: thi });
        else offer(0, 0, { prev: null, ne: s.ne, enterOffset: Math.max(lo, tlo), targetOffset: Math.max(lo, tlo) });
      }
      for (const [side, d, startOffset] of [[1, len - hi, hi], [0, lo, lo]] as const) {
        const k = key(s.ne, side);
        const c = d * f;
        if (c < (cost.get(k) ?? Infinity)) {
          cost.set(k, c);
          phys.set(k, d);
          prev.set(k, { prev: null, startOffset });
          heap.push(c, k);
        }
      }
    }

    while (heap.size > 0) {
      const [c, k] = heap.pop()!;
      if (c > (cost.get(k) ?? Infinity)) continue;
      if (found.best && c >= found.best.cost) break;
      const p = phys.get(k)!;
      for (const [ne2, s2] of this.links.get(k) ?? []) {
        const len2 = this.lengths.get(ne2)!;
        const f2 = cm.factor(ne2);
        const enterOffset = s2 === 0 ? 0 : len2;
        for (const t of targets.get(ne2) ?? []) {
          const tlo = Math.min(t.start, t.end), thi = Math.max(t.start, t.end);
          const targetOffset = s2 === 0 ? tlo : thi;
          const d = Math.abs(targetOffset - enterOffset);
          offer(c + d * f2, p + d, { prev: k, ne: ne2, enterOffset, targetOffset });
        }
        const k2 = key(ne2, s2 === 0 ? 1 : 0);
        const c2 = c + len2 * f2;
        if (c2 < (cost.get(k2) ?? Infinity)) {
          cost.set(k2, c2);
          phys.set(k2, p + len2);
          prev.set(k2, { prev: k });
          heap.push(c2, k2);
        }
      }
    }

    const best = found.best;
    if (!best) return null;
    const { arrival } = best;
    const chain: StateKey[] = [];
    for (let k: StateKey | null = arrival.prev; k !== null; k = prev.get(k)!.prev) chain.unshift(k);

    const steps: RouteStep[] = [];
    let dist = 0;
    for (const k of chain) {
      const [ne, side] = parseKey(k);
      const len = this.lengths.get(ne)!;
      const info = prev.get(k)!;
      const forward = side === 1;
      const fromOff = info.prev === null ? info.startOffset! : forward ? 0 : len;
      const toOff = forward ? len : 0;
      steps.push({ ne, forward, from: fromOff, to: toOff, startDistance: dist });
      dist += Math.abs(toOff - fromOff);
    }
    steps.push({
      ne: arrival.ne,
      forward: arrival.targetOffset >= arrival.enterOffset,
      from: arrival.enterOffset,
      to: arrival.targetOffset,
      startDistance: dist,
    });
    dist += Math.abs(arrival.targetOffset - arrival.enterOffset);
    return { steps, length: dist, cost: best.cost, costModel: cm.name };
  }
}
