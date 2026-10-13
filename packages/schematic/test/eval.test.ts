import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot, type Snapshot } from "@routebook/rinf-client";
import { RoutingGraph, opEndpoint, resolveOp, trackPreferenceCostModel, type CostModel } from "@routebook/routing";
import { classifySwitches, layoutRouteSchematic, TopoNetwork, LocalFrame, type SwitchInfo } from "@routebook/schematic";

/**
 * Layout quality on the Norway snapshot (data/snapshots/nor, `pnpm fetch:nor`);
 * skipped when it is missing. Prints the quality numbers per route and
 * checks them on three routes.
 */
const SNAPSHOT = fileURLToPath(new URL("../../../data/snapshots/nor", import.meta.url));

interface Quality {
  ms: number;
  tracks: number;
  switches: number;
  minLane: number;
  maxLane: number;
  sideOk: number;
  sideChecked: number;
  crossovers: number;
  wideCrossovers: number;
  stubs: number;
  overlaps: number;
  zeroLength: number;
  steep: number;
  omitted: number;
}

describe.skipIf(!existsSync(SNAPSHOT))("schematic layout quality (Norway snapshot)", () => {
  let snap: Snapshot;
  let network: TopoNetwork;
  let switches: SwitchInfo[];
  let graph: RoutingGraph;
  let cost: CostModel;

  beforeAll(async () => {
    snap = await loadSnapshot(SNAPSHOT);
    network = new TopoNetwork(snap);
    graph = new RoutingGraph(snap.topology);
    cost = trackPreferenceCostModel(snap.tracks);
    const t0 = Date.now();
    switches = classifySwitches(snap, { network });
    console.log(`classify ${switches.length} switches in ${Date.now() - t0} ms`);
  }, 120_000);

  it("classifies the switches", () => {
    const spread = switches.map((s) => s.spread).sort((a, b) => a - b);
    console.log("spread quantiles (deg) 1/5/10/50%:", [0.01, 0.05, 0.1, 0.5].map((q) => spread[Math.floor(q * spread.length)]!.toFixed(2)).join(" "));
    const rules = { name: 0, type: 0, curvature: 0 };
    for (const s of switches) rules[s.rule]++;
    console.log("rules", rules);
    const nodeCount = network.nodes.filter((n) => n.length === 3).length;
    console.log("3-end nodes", nodeCount, "classified", switches.length, "(unclassified: no geometry or no common leg)");
    expect(switches.length).toBeGreaterThan(0.95 * nodeCount);
  });

  const measure = (a: string, b: string): Quality => {
    const r = graph.route(opEndpoint(resolveOp(snap.ops, a)).intervals, opEndpoint(resolveOp(snap.ops, b)).intervals, { costModel: cost })!;
    const t1 = performance.now();
    const s = layoutRouteSchematic(r, { network, switches, tracks: snap.tracks });
    const ms = performance.now() - t1;
    const geom = snap.geometry ?? {};
    const frame = new LocalFrame(geom[r.steps[0]!.ne]![0]![1]);
    const routePts = r.steps.flatMap((st) => {
      const g2 = (geom[st.ne] ?? []).map((p) => frame.xy(p));
      return st.forward ? g2 : g2.reverse();
    });
    // side of the route in the geometry vs the lane, for tracks 2..60 m from the route
    let sideOk = 0, sideChecked = 0;
    const horiz: Array<[number, number, number, string]> = [];
    for (const t of s.tracks) {
      if (!t.onRoute && t.lane !== null) horiz.push([t.lane, Math.min(t.from.x, t.to.x), Math.max(t.from.x, t.to.x), t.ne]);
      if (t.onRoute || t.lane === null || t.lane === 0 || t.stub) continue;
      const line = (geom[t.ne] ?? []).map((p) => frame.xy(p));
      const mid = line[Math.floor(line.length / 2)];
      if (!mid) continue;
      let best = Infinity, side = 0;
      for (let i = 1; i < routePts.length; i++) {
        const p = routePts[i - 1]!, q = routePts[i]!;
        const dx = q[0] - p[0], dy = q[1] - p[1];
        const l2 = dx * dx + dy * dy || 1;
        const tt = Math.max(0, Math.min(1, ((mid[0] - p[0]) * dx + (mid[1] - p[1]) * dy) / l2));
        const d = Math.hypot(mid[0] - p[0] - tt * dx, mid[1] - p[1] - tt * dy);
        if (d < best) {
          best = d;
          side = Math.sign(dx * (mid[1] - p[1]) - dy * (mid[0] - p[0]));
        }
      }
      if (best > 60 || best < 2) continue;
      sideChecked++;
      if (side === Math.sign(t.lane)) sideOk++;
    }
    // horizontal runs on the same lane drawn on top of each other
    horiz.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
    let overlaps = 0;
    for (let i = 1; i < horiz.length; i++) {
      const p = horiz[i - 1]!, q = horiz[i]!;
      if (p[0] === q[0] && q[1] < p[2] - 2 && p[3] !== q[3]) overlaps++;
    }
    const diagonals = s.tracks.filter((t) => t.lane === null && !t.stub);
    // elements with less horizontal room than 40 m per lane they change (or their length)
    const steep = s.tracks.filter((t) => {
      const d = t.lane === null ? Math.abs(t.to.y - t.from.y) : Math.abs(t.from.y - t.lane) + Math.abs(t.to.y - t.lane);
      return !t.stub && d > 0 && Math.abs(t.to.x - t.from.x) < Math.min(network.lengths.get(t.ne) ?? 0, 40 * d) - 1;
    }).length;
    const q: Quality = {
      ms,
      tracks: s.tracks.length,
      switches: s.switches.length,
      minLane: s.minLane,
      maxLane: s.maxLane,
      sideOk,
      sideChecked,
      crossovers: diagonals.length,
      wideCrossovers: diagonals.filter((t) => Math.abs(t.to.y - t.from.y) > 1).length,
      stubs: s.tracks.filter((t) => t.stub).length,
      overlaps,
      zeroLength: s.tracks.filter((t) => Math.abs(t.to.x - t.from.x) < 1).length,
      steep,
      omitted: s.omitted ?? 0,
    };
    console.log(
      `${a}-${b}: ${(r.length / 1000).toFixed(0)} km, ${ms.toFixed(0)} ms, ${q.tracks} tracks, ${q.switches} sw, lanes ${q.minLane}..${q.maxLane}, ` +
        `side ok ${sideOk}/${sideChecked}, crossovers ${q.crossovers} (${q.wideCrossovers} over more than one lane), stubs ${q.stubs}, ` +
        `same-lane overlaps ${overlaps}, zero-length ${q.zeroLength}, steep ${steep}, omitted ${q.omitted}`,
    );
    return q;
  };

  for (const [a, b] of [["NOOSL", "NODRM"], ["NOOSL", "NOBRG"], ["NOHMR", "NOTND"]] as const) {
    it(`${a}-${b}: sides agree with the geometry, no overlaps, lanes within -8..8, under 500 ms`, () => {
      const q = measure(a, b);
      expect(q.sideOk / q.sideChecked).toBeGreaterThanOrEqual(0.95);
      expect(q.overlaps).toBe(0);
      expect(q.minLane).toBeGreaterThanOrEqual(-8);
      expect(q.maxLane).toBeLessThanOrEqual(8);
      expect(q.ms).toBeLessThan(500);
    });
  }

  it("prints the numbers for more routes", () => {
    for (const [a, b] of [["NOTND", "NOBO"], ["NODRM", "NOOSL"], ["NOLLS", "NOOSL"], ["NOSTV", "NOEGS"]] as const) {
      try {
        measure(a, b);
      } catch (e) {
        console.log(a, b, "no route", String(e));
      }
    }
  });
});
