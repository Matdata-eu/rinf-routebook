import type { Snapshot } from "@routebook/rinf-client";
import { LocalFrame, dot, norm, sub, type LngLat, type XY } from "./geo.js";

/** End of a micro element: 0 = origin (offset 0), 1 = end (offset = length). */
export type End = 0 | 1;

export interface EndRef {
  ne: string;
  end: End;
}

export const endKey = (r: EndRef): string => `${r.ne}|${r.end}`;
export const parseEndKey = (k: string): EndRef => {
  const i = k.lastIndexOf("|");
  return { ne: k.slice(0, i), end: Number(k.slice(i + 1)) as End };
};
export const otherEnd = (r: EndRef): EndRef => ({ ne: r.ne, end: r.end === 0 ? 1 : 0 });

/**
 * Nodes of the micro topology. A node is a set of element ends joined by
 * NetRelations (navigable or not): a plain joint (2 ends), a switch (3 ends:
 * the common leg is navigable to both branches, the branches are not
 * navigable to each other) or a crossing / slip (4 ends).
 */
export class TopoNetwork {
  readonly lengths = new Map<string, number>();
  readonly nodes: EndRef[][] = [];
  private readonly nodeByEnd = new Map<string, number>();
  private readonly nav = new Map<string, string[]>();
  private readonly geometry: Record<string, LngLat[]>;

  constructor(snapshot: Pick<Snapshot, "topology" | "geometry">) {
    this.geometry = snapshot.geometry ?? {};
    for (const ne of snapshot.topology.netElements) this.lengths.set(ne.id, ne.length);
    // union-find over element ends
    const parent = new Map<string, string>();
    const find = (k: string): string => {
      let r = k;
      while (parent.has(r) && parent.get(r) !== r) r = parent.get(r)!;
      let c = k;
      while (c !== r) {
        const n = parent.get(c)!;
        parent.set(c, r);
        c = n;
      }
      return r;
    };
    for (const id of this.lengths.keys()) for (const end of [0, 1] as const) parent.set(endKey({ ne: id, end }), endKey({ ne: id, end }));
    for (const r of snapshot.topology.netRelations) {
      if (!this.lengths.has(r.a) || !this.lengths.has(r.b)) continue;
      const a = endKey({ ne: r.a, end: r.aAtOrigin ? 0 : 1 });
      const b = endKey({ ne: r.b, end: r.bAtOrigin ? 0 : 1 });
      parent.set(find(a), find(b));
      if (r.navigable) {
        this.link(a, b);
        this.link(b, a);
      }
    }
    const index = new Map<string, number>();
    for (const k of parent.keys()) {
      const root = find(k);
      let n = index.get(root);
      if (n === undefined) {
        n = this.nodes.length;
        index.set(root, n);
        this.nodes.push([]);
      }
      this.nodes[n]!.push(parseEndKey(k));
      this.nodeByEnd.set(k, n);
    }
  }

  private link(a: string, b: string): void {
    const l = this.nav.get(a);
    if (l) l.push(b);
    else this.nav.set(a, [b]);
  }

  nodeOf(r: EndRef): number {
    return this.nodeByEnd.get(endKey(r))!;
  }

  /** Element ends a train can continue into from `r` (navigability Both). */
  navigableFrom(r: EndRef): EndRef[] {
    return (this.nav.get(endKey(r)) ?? []).map(parseEndKey);
  }

  isNavigable(a: EndRef, b: EndRef): boolean {
    return (this.nav.get(endKey(a)) ?? []).includes(endKey(b));
  }

  hasGeometry(ne: string): boolean {
    return (this.geometry[ne]?.length ?? 0) >= 2;
  }

  /** Lon/lat of an element end (its first or last vertex). */
  endPoint(r: EndRef): LngLat | undefined {
    const g = this.geometry[r.ne];
    if (!g || g.length === 0) return undefined;
    return r.end === 0 ? g[0] : g.at(-1);
  }

  /**
   * Element geometry in local metres, starting at end `r` and running into the
   * element. The stored geometry runs from origin to end, so it is reversed
   * when `r` is the end (offset = length).
   */
  lineFrom(r: EndRef, frame: LocalFrame): XY[] {
    const g = this.geometry[r.ne] ?? [];
    const pts = g.map((p) => frame.xy(p));
    return r.end === 0 ? pts : pts.reverse();
  }

  /**
   * The first `distance` metres of track from end `r`, walking into the
   * element and, when it is shorter, on through the far node along the
   * straightest navigable continuation.
   */
  walk(r: EndRef, distance: number, frame: LocalFrame): XY[] {
    const out: XY[] = [];
    let cur: EndRef | undefined = r;
    let rest = distance;
    const seen = new Set<string>();
    while (cur && rest > 0 && !seen.has(cur.ne)) {
      seen.add(cur.ne);
      const line = this.lineFrom(cur, frame);
      if (line.length < 2) break;
      for (let i = out.length ? 1 : 0; i < line.length; i++) {
        const p = line[i]!;
        if (out.length) {
          const seg = norm(sub(p, out.at(-1)!));
          if (seg >= rest) {
            const a = out.at(-1)!;
            const t = rest / seg;
            out.push([a[0] + (p[0] - a[0]) * t, a[1] + (p[1] - a[1]) * t]);
            return out;
          }
          rest -= seg;
        }
        out.push(p);
      }
      // continue through the far node
      const far = otherEnd(cur);
      const dir = sub(out.at(-1)!, out.at(-2) ?? out[0]!);
      let best: EndRef | undefined;
      let bestDot = -Infinity;
      for (const next of this.navigableFrom(far)) {
        const nl = this.lineFrom(next, frame);
        if (nl.length < 2) continue;
        const nd = sub(nl[Math.min(nl.length - 1, 1)]!, nl[0]!);
        const c = dot(dir, nd) / (norm(dir) * norm(nd) || 1);
        if (c > bestDot) {
          bestDot = c;
          best = next;
        }
      }
      cur = best;
    }
    return out;
  }
}
