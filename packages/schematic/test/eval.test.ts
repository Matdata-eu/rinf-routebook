import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { loadSnapshot, type Snapshot } from "@routebook/rinf-client";
import { RoutingGraph, opEndpoint, resolveOp, trackPreferenceCostModel, type CostModel } from "@routebook/routing";
import {
  classifySwitches,
  layoutMetrics,
  layoutRouteSchematic,
  layoutRouteSchematicSolved,
  loadHighs,
  TopoNetwork,
  LocalFrame,
  type Schematic,
  type SwitchInfo,
  type WindowReport,
} from "@routebook/schematic";

/**
 * Layout quality on the Norway snapshot (data/snapshots/nor, `pnpm fetch:nor`);
 * skipped when it is missing. Prints the quality numbers per route for the
 * heuristic and the solver layout and checks them on three routes.
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
  kinks: number;
  /** pairs of drawn tracks that cross without sharing a node */
  crossings: number;
  /** direction changes along the drawn tracks */
  bends: number;
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

  const quality = (r: NonNullable<ReturnType<RoutingGraph["route"]>>, s: Schematic, ms: number): Quality => {
    const geom = snap.geometry ?? {};
    const frame = new LocalFrame(geom[r.steps[0]!.ne]![0]![1]);
    const routePts = r.steps.flatMap((st) => {
      const g2 = (geom[st.ne] ?? []).map((p) => frame.xy(p));
      return st.forward ? g2 : g2.reverse();
    });
    // side of the route in the geometry vs the lane, for tracks 2..60 m from the route
    let sideOk = 0, sideChecked = 0;
    for (const t of s.tracks) {
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
    // crossings, same-lane overlaps and bends of the drawn tracks (40 m per lane for a diagonal)
    const m = layoutMetrics(s, 40);
    const diagonals = s.tracks.filter((t) => t.lane === null && !t.stub);
    // elements with less horizontal room than 40 m per lane they change (or their length)
    const steep = s.tracks.filter((t) => {
      const d = t.lane === null ? Math.abs(t.to.y - t.from.y) : Math.abs(t.from.y - t.lane) + Math.abs(t.to.y - t.lane);
      return !t.stub && d > 0 && Math.abs(t.to.x - t.from.x) < Math.min(network.lengths.get(t.ne) ?? 0, 40 * d) - 1;
    }).length;
    return {
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
      overlaps: m.overlaps,
      zeroLength: s.tracks.filter((t) => Math.abs(t.to.x - t.from.x) < 1).length,
      steep,
      omitted: s.omitted ?? 0,
      kinks: s.tracks.reduce((n, t) => n + Math.max(0, (t.runs?.length ?? 1) - 1), 0),
      crossings: m.crossings,
      bends: m.bends,
    };
  };

  const line = (name: string, q: Quality) =>
    `  ${name.padEnd(9)} ${q.ms.toFixed(0).padStart(5)} ms, ${q.tracks} tracks, ${q.switches} sw, lanes ${q.minLane}..${q.maxLane}, ` +
    `side ok ${q.sideOk}/${q.sideChecked}, crossings ${q.crossings}, same-lane overlaps ${q.overlaps}, bends ${q.bends}, ` +
    `crossovers ${q.crossovers} (${q.wideCrossovers} over more than one lane), stubs ${q.stubs}, zero-length ${q.zeroLength}, steep ${q.steep}, omitted ${q.omitted}, kinks ${q.kinks}`;

  /** Both layouts of a route: [heuristic, solver]. */
  const measure = async (a: string, b: string): Promise<[Quality, Quality]> => {
    const r = graph.route(opEndpoint(resolveOp(snap.ops, a)).intervals, opEndpoint(resolveOp(snap.ops, b)).intervals, { costModel: cost })!;
    const input = { network, switches, tracks: snap.tracks };
    const t1 = performance.now();
    const h = layoutRouteSchematic(r, input);
    const hq = quality(r, h, performance.now() - t1);
    const windows: WindowReport[] = [];
    const t2 = performance.now();
    const s = await layoutRouteSchematicSolved(r, input, { onWindow: (w) => windows.push(w) });
    const sq = quality(r, s, performance.now() - t2);
    const solved = windows.filter((w) => w.status === "solved").length;
    console.log(
      `${a}-${b}: ${(r.length / 1000).toFixed(0)} km, ${windows.length} windows (${solved} solved, ${windows.length - solved} kept the heuristic, ` +
        `largest ${Math.max(0, ...windows.map((w) => w.vars))} variables)\n${line("heuristic", hq)}\n${line("solver", sq)}`,
    );
    return [hq, sq];
  };

  for (const [a, b] of [["NOOSL", "NODRM"], ["NOOSL", "NOBRG"], ["NOHMR", "NOTND"]] as const) {
    it(`${a}-${b}: sides agree with the geometry, no overlaps, lanes within -25..25, under 500 ms; the solver crosses and overlaps no more`, async () => {
      await loadHighs(); // load the WebAssembly before timing
      const [q, s] = await measure(a, b);
      expect(q.sideOk / q.sideChecked).toBeGreaterThanOrEqual(0.95);
      expect(q.overlaps).toBe(0);
      expect(q.minLane).toBeGreaterThanOrEqual(-25);
      expect(q.maxLane).toBeLessThanOrEqual(25);
      expect(q.ms).toBeLessThan(500);
      expect(s.crossings).toBeLessThanOrEqual(q.crossings);
      expect(s.overlaps).toBeLessThanOrEqual(q.overlaps);
      expect(s.sideOk / s.sideChecked).toBeGreaterThanOrEqual(0.95);
      expect(s.ms).toBeLessThan(3000);
    }, 60_000);
  }

  it("prints the numbers for more routes", async () => {
    for (const [a, b] of [["NOTND", "NOBO"], ["NODRM", "NOOSL"], ["NOLLS", "NOOSL"], ["NOSTV", "NOEGS"], ["NOSTV", "NOOSL"]] as const) {
      try {
        await measure(a, b);
      } catch (e) {
        console.log(a, b, "no route", String(e));
      }
    }
  }, 120_000);
});
