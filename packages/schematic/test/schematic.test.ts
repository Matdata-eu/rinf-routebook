import { describe, expect, it } from "vitest";
import type { NetRelation, Snapshot, Track } from "@routebook/rinf-client";
import type { Route } from "@routebook/routing";
import {
  TopoNetwork,
  addKinks,
  classifySwitches,
  compactSwitches,
  continuousBranch,
  expandSwitches,
  layoutMetrics,
  layoutRouteSchematic,
  layoutRouteSchematicSolved,
  type Schematic,
  type SchematicTrack,
  type WindowReport,
} from "@routebook/schematic";

type LngLat = [number, number];
type Fixture = Pick<Snapshot, "topology" | "geometry" | "tracks" | "features">;

/**
 * One switch at lon 10.010: the common leg C comes from the west, K carries
 * straight on to the east and D curves away to the north (left when
 * travelling east). `reverseD` stores D from its far end to the switch, so
 * its origin is not at the switch.
 */
function fixture(opts: { reverseD?: boolean; dTrack?: Partial<Track>; kTrack?: Partial<Track> } = {}): Fixture {
  const C: LngLat[] = [[10.0, 60.0], [10.005, 60.0], [10.01, 60.0]];
  const K: LngLat[] = [[10.01, 60.0], [10.015, 60.0], [10.02, 60.0]];
  let D: LngLat[] = [[10.01, 60.0], [10.0105, 60.00003], [10.011, 60.0001], [10.012, 60.0003], [10.02, 60.002]];
  if (opts.reverseD) D = D.slice().reverse();
  const rel = (a: string, aAtOrigin: boolean, b: string, bAtOrigin: boolean, navigable: boolean): NetRelation => ({ a, b, aAtOrigin, bAtOrigin, navigable });
  const dAtOrigin = !opts.reverseD;
  return {
    topology: {
      netElements: [{ id: "C", length: 557 }, { id: "K", length: 557 }, { id: "D", length: 600 }],
      netRelations: [rel("C", false, "K", true, true), rel("C", false, "D", dAtOrigin, true), rel("K", true, "D", dAtOrigin, false)],
    },
    geometry: { C, K, D },
    tracks: [
      { id: "t1", kind: "running", label: "1", elements: ["C"], partOf: [] },
      { id: "t1b", kind: "running", label: "1", elements: ["K"], partOf: [], ...opts.kTrack },
      { id: "t2", kind: "siding", label: "2", elements: ["D"], partOf: [], ...opts.dTrack },
    ],
    features: [{ id: "sw1", kind: "switch", ne: "C", offset: 557, label: "Spv 1" }],
  };
}

const steps = (...s: Array<[string, boolean, number]>): Route => {
  let d = 0;
  const out = s.map(([ne, forward, len]) => {
    const step = { ne, forward, from: forward ? 0 : len, to: forward ? len : 0, startDistance: d };
    d += len;
    return step;
  });
  return { steps: out, length: d, cost: d, costModel: "length" };
};

describe("continuousBranch (Bane NOR rule)", () => {
  const common = { name: "1", kind: "running", curvature: 0 };
  it("1. same name as the common leg wins", () => {
    expect(continuousBranch(common, [{ name: "2", kind: "running", curvature: 0 }, { name: "1", kind: "siding", curvature: 1 / 300 }])).toEqual({ index: 1, rule: "name" });
  });
  it("2. then the same type", () => {
    expect(continuousBranch(common, [{ name: "5", kind: "siding", curvature: 0 }, { name: "2", kind: "running", curvature: 1 / 300 }])).toEqual({ index: 1, rule: "type" });
  });
  it("3. then the closest curvature", () => {
    expect(continuousBranch(common, [{ name: "5", kind: "siding", curvature: 1 / 300 }, { name: "2", kind: "siding", curvature: 0 }])).toEqual({ index: 1, rule: "curvature" });
    expect(continuousBranch(common, [{ name: "1", kind: "siding", curvature: 1 / 500 }, { name: "1", kind: "siding", curvature: 1 / 190 }])).toEqual({ index: 0, rule: "curvature" });
  });
});

describe("classifySwitches", () => {
  it("finds the common leg, the continuous branch and the side of the deviating branch", () => {
    const [sw, ...rest] = classifySwitches(fixture());
    expect(rest).toHaveLength(0);
    expect(sw).toMatchObject({ common: { ne: "C", end: 1 }, continuous: { ne: "K", end: 0 }, deviating: { ne: "D", end: 0 }, deviatingSide: "left", rule: "name", switchId: "sw1", label: "Spv 1" });
  });

  it("uses the element orientation: a branch stored from its far end gives the same answer", () => {
    const [sw] = classifySwitches(fixture({ reverseD: true }));
    expect(sw).toMatchObject({ deviating: { ne: "D", end: 1 }, deviatingSide: "left" });
  });

  it("falls back to curvature when names and types do not decide", () => {
    const [sw] = classifySwitches(fixture({ kTrack: { label: "7", kind: "siding" } }));
    expect(sw).toMatchObject({ continuous: { ne: "K" }, rule: "curvature" });
  });

  it("round-trips through the compact bundle form", () => {
    const f = fixture();
    const net = new TopoNetwork(f);
    const list = classifySwitches(f, { network: net });
    const back = expandSwitches(compactSwitches(list), net);
    expect(back.map(({ spread: _, ...s }) => s)).toEqual(list.map(({ spread: _, ...s }) => s));
  });
});

describe("layoutRouteSchematic", () => {
  const f = fixture();
  const network = new TopoNetwork(f);
  const switches = classifySwitches(f, { network });
  const lay = (route: Route) => layoutRouteSchematic(route, { network, switches, tracks: f.tracks });
  const laneOf = (s: ReturnType<typeof lay>, ne: string) => s.tracks.find((t) => t.ne === ne);

  it("draws the route on lane 0 and the deviating branch on its side (left of travel = up)", () => {
    const s = lay(steps(["C", true, 557], ["K", true, 557]));
    expect(laneOf(s, "C")).toMatchObject({ onRoute: true, lane: 0 });
    expect(laneOf(s, "D")).toMatchObject({ onRoute: false, lane: 1 });
    expect(s.switches[0]).toMatchObject({ facing: true, deviates: 1, routeDeviates: false, label: "Spv 1" });
  });

  it("mirrors the layout when travelling the other way", () => {
    const s = lay(steps(["K", false, 557], ["C", false, 557]));
    expect(laneOf(s, "D")!.lane).toBe(-1);
    expect(s.switches[0]).toMatchObject({ facing: false, deviates: -1 });
  });

  it("pushes the continuous branch away when the route takes the deviating branch", () => {
    const s = lay(steps(["C", true, 557], ["D", true, 600]));
    expect(laneOf(s, "D")).toMatchObject({ onRoute: true, lane: 0 });
    expect(laneOf(s, "K")!.lane).toBe(-1);
    expect(s.switches[0]).toMatchObject({ routeDeviates: true });
  });
});

/**
 * A passing loop, in metres east and north of lon 10 / lat 60. The main
 * track 1 (M1..M4) runs east; the loop track 2 (L1..L3) leaves it to the
 * north at switch A (x 100, facing when travelling east) and rejoins it at
 * switch B (x 500, trailing). A crossover XO runs from switch X1 on the main
 * track (x 250) to switch X2 on the loop (x 280), and the siding 3 (SD)
 * leaves the loop at switch S (x 400) westwards, further north (trailing).
 */
function station(): Fixture {
  const P = (mx: number, my: number): LngLat => [10 + mx / (111_320 * Math.cos((60 * Math.PI) / 180)), 60 + my / 110_574];
  const geometry: Record<string, LngLat[]> = {
    M1: [P(0, 0), P(100, 0)],
    M2: [P(100, 0), P(250, 0)],
    M3: [P(250, 0), P(500, 0)],
    M4: [P(500, 0), P(600, 0)],
    L1: [P(100, 0), P(130, 1.5), P(160, 4.5), P(280, 4.5)],
    XO: [P(250, 0), P(265, 2.25), P(280, 4.5)],
    L2: [P(280, 4.5), P(400, 4.5)],
    L3: [P(400, 4.5), P(440, 4.5), P(470, 1.5), P(500, 0)],
    SD: [P(400, 4.5), P(370, 7.5), P(340, 9), P(300, 9)],
  };
  const metres = (line: LngLat[]) => {
    let s = 0;
    for (let i = 1; i < line.length; i++) {
      const [a, b] = [line[i - 1]!, line[i]!];
      s += Math.hypot((b[0] - a[0]) * 111_320 * Math.cos((60 * Math.PI) / 180), (b[1] - a[1]) * 110_574);
    }
    return Math.round(s);
  };
  const rel = (a: string, aAtOrigin: boolean, b: string, bAtOrigin: boolean, navigable = true): NetRelation => ({ a, b, aAtOrigin, bAtOrigin, navigable });
  // switch: common leg end, continuous branch end, deviating branch end
  const sw = (c: [string, boolean], k: [string, boolean], d: [string, boolean]) => [rel(...c, ...k), rel(...c, ...d), rel(...k, ...d, false)];
  return {
    topology: {
      netElements: Object.entries(geometry).map(([id, g]) => ({ id, length: metres(g) })),
      netRelations: [
        ...sw(["M1", false], ["M2", true], ["L1", true]), // A
        ...sw(["M2", false], ["M3", true], ["XO", true]), // X1
        ...sw(["L2", true], ["L1", false], ["XO", false]), // X2
        ...sw(["L3", true], ["L2", false], ["SD", true]), // S
        ...sw(["M4", true], ["M3", false], ["L3", false]), // B
      ],
    },
    geometry,
    tracks: [
      { id: "t1", kind: "running", label: "1", elements: ["M1", "M2", "M3", "M4"], partOf: [] },
      { id: "t2", kind: "running", label: "2", elements: ["L1", "L2", "L3"], partOf: [] },
      { id: "t3", kind: "siding", label: "3", elements: ["SD"], partOf: [] },
      { id: "tx", kind: "running", label: "1-2", elements: ["XO"], partOf: [] },
    ],
    features: [],
  };
}

describe("layoutRouteSchematic: a station", () => {
  const f = station();
  const network = new TopoNetwork(f);
  const switches = classifySwitches(f, { network });
  const len = (ne: string) => f.topology.netElements.find((e) => e.id === ne)!.length;
  const lay = (forward: boolean) => {
    const main = ["M1", "M2", "M3", "M4"];
    const order = forward ? main : [...main].reverse();
    return layoutRouteSchematic(steps(...order.map((ne) => [ne, forward, len(ne)] as [string, boolean, number])), { network, switches, tracks: f.tracks });
  };
  const byNe = (s: Schematic) => new Map(s.tracks.map((t) => [t.ne, t]));
  const overlaps = (s: Schematic) => {
    const runs = s.tracks.filter((t) => !t.onRoute && t.lane !== null).map((t) => ({ lane: t.lane, lo: Math.min(t.from.x, t.to.x), hi: Math.max(t.from.x, t.to.x) }));
    return runs.flatMap((a, i) => runs.slice(i + 1).filter((b) => a.lane === b.lane && a.lo < b.hi - 2 && b.lo < a.hi - 2));
  };

  it("classifies the five switches", () => {
    expect(switches).toHaveLength(5);
    expect(switches.map((s) => [s.common.ne, s.continuous.ne, s.deviating.ne, s.deviatingSide])).toEqual(
      expect.arrayContaining([
        ["M1", "M2", "L1", "left"],
        ["M2", "M3", "XO", "left"],
        ["L2", "L1", "XO", "left"],
        ["L3", "L2", "SD", "right"],
        ["M4", "M3", "L3", "right"],
      ]),
    );
  });

  it("puts the loop on lane 1, the siding beyond it and the crossover between adjacent lanes", () => {
    const s = lay(true);
    const t = byNe(s);
    for (const ne of ["M1", "M2", "M3", "M4"]) expect(t.get(ne)).toMatchObject({ onRoute: true, lane: 0 });
    for (const ne of ["L1", "L2", "L3"]) expect(t.get(ne)!.lane).toBe(1);
    expect(t.get("SD")!.lane).toBe(2);
    expect(t.get("XO")).toMatchObject({ lane: null, from: { y: 0 }, to: { y: 1 } });
    expect(overlaps(s)).toEqual([]);
    expect([s.minLane, s.maxLane]).toEqual([0, 2]);
    // x follows the track: the siding leaves its switch westwards, about as long as it is
    expect(t.get("SD")!.from.x - t.get("SD")!.to.x).toBeCloseTo(len("SD"), 0);
    // no element changes lanes on less than its length or 40 m per lane
    for (const e of s.tracks) {
      const d = e.lane === null ? Math.abs(e.to.y - e.from.y) : Math.abs(e.from.y - e.lane) + Math.abs(e.to.y - e.lane);
      expect(Math.abs(e.to.x - e.from.x)).toBeGreaterThanOrEqual(Math.min(len(e.ne), 40 * d) - 1);
    }
    const facing = new Map(s.switches.map((w) => [w.x, w.facing]));
    expect([...facing.values()].filter(Boolean)).toHaveLength(2);
  });

  it("mirrors the station when travelling the other way", () => {
    const s = lay(false);
    const t = byNe(s);
    for (const ne of ["L1", "L2", "L3"]) expect(t.get(ne)!.lane).toBe(-1);
    expect(t.get("SD")!.lane).toBe(-2);
    expect(t.get("XO")!.lane).toBeNull();
    expect(Math.abs(t.get("XO")!.to.y - t.get("XO")!.from.y)).toBe(1);
    expect(overlaps(s)).toEqual([]);
    expect([s.minLane, s.maxLane]).toEqual([-2, 0]);
    expect(t.get("SD")!.to.x - t.get("SD")!.from.x).toBeCloseTo(len("SD"), 0);
  });
});

describe("kinks on the tracks next to the route", () => {
  it("lets a track step out only where another track lies between it and the route", () => {
    const route = { ne: "r", onRoute: true, from: { x: 0, y: 0 }, to: { x: 1000, y: 0 }, lane: 0 };
    // a loop from the route on lane 2 over the whole station, and a siding on lane 1 in the middle of it
    const a = { x: 0, y: 0 }, b = { x: 1000, y: 0 }, s0 = { x: 400, y: 0 }, s1 = { x: 600, y: 1 };
    const loop = { ne: "loop", onRoute: false, from: a, to: b, lane: 2 };
    const siding = { ne: "siding", onRoute: false, from: s0, to: s1, lane: 1 };
    const s0r = { ne: "r2", onRoute: true, from: { x: 0, y: 0 }, to: { x: 400, y: 0 }, lane: 0 };
    addKinks([route, s0r, loop, siding]);
    expect(siding.lane).toBe(1);
    expect(loop.lane).toBe(1);
    expect((loop as { runs?: unknown }).runs).toEqual([
      { from: 0, to: 400, y: 1 },
      { from: 400, to: 600, y: 2 },
      { from: 600, to: 1000, y: 1 },
    ]);
  });

  it("keeps a dip that is too short for its diagonals on the outer lane", () => {
    const a = { x: 0, y: 0 }, b = { x: 1000, y: 0 }, s0 = { x: 400, y: 0 }, s1 = { x: 450, y: 1 }, s2 = { x: 500, y: 0 }, s3 = { x: 600, y: 1 };
    const loop = { ne: "loop", onRoute: false, from: a, to: b, lane: 2 } as SchematicTrack;
    addKinks([
      loop,
      { ne: "s1", onRoute: false, from: s0, to: s1, lane: 1 },
      { ne: "s2", onRoute: false, from: s2, to: s3, lane: 1 },
    ]);
    // between 450 and 500 there is no room to come down a lane and go up again
    expect(loop.runs).toEqual([
      { from: 0, to: 400, y: 1 },
      { from: 400, to: 600, y: 2 },
      { from: 600, to: 1000, y: 1 },
    ]);
  });
});

describe("layoutRouteSchematicSolved: a station (railplot model, HiGHS)", () => {
  const f = station();
  const network = new TopoNetwork(f);
  const switches = classifySwitches(f, { network });
  const len = (ne: string) => f.topology.netElements.find((e) => e.id === ne)!.length;
  const route = (forward: boolean) => {
    const main = ["M1", "M2", "M3", "M4"];
    const order = forward ? main : [...main].reverse();
    return steps(...order.map((ne) => [ne, forward, len(ne)] as [string, boolean, number]));
  };
  const byNe = (s: Schematic) => new Map(s.tracks.map((t) => [t.ne, t]));

  for (const forward of [true, false]) {
    it(`puts the loop, the siding and the crossover on their sides without crossings (${forward ? "east" : "west"}bound)`, async () => {
      const r = route(forward);
      const reports: WindowReport[] = [];
      const s = await layoutRouteSchematicSolved(r, { network, switches, tracks: f.tracks }, { onWindow: (w) => reports.push(w) });
      expect(reports.map((w) => w.status)).toEqual(["solved"]);
      const t = byNe(s);
      const side = forward ? 1 : -1;
      for (const ne of ["M1", "M2", "M3", "M4"]) expect(t.get(ne)).toMatchObject({ onRoute: true, lane: 0 });
      for (const ne of ["L1", "L2", "L3"]) expect(t.get(ne)!.lane).toBe(side);
      expect(t.get("SD")!.lane).toBe(2 * side);
      // the crossover is one diagonal between the route and the loop
      expect(t.get("XO")!.lane).toBeNull();
      expect(Math.abs(t.get("XO")!.to.y - t.get("XO")!.from.y)).toBe(1);
      expect(layoutMetrics(s)).toMatchObject({ crossings: 0, overlaps: 0 });
      // the route keeps its distances (x of the route nodes); the siding still points west from its switch
      const h = layoutRouteSchematic(r, { network, switches, tracks: f.tracks });
      for (const ne of ["M1", "M2", "M3", "M4"]) expect([t.get(ne)!.from.x, t.get(ne)!.to.x]).toEqual([byNe(h).get(ne)!.from.x, byNe(h).get(ne)!.to.x]);
      const sd = t.get("SD")!;
      expect((sd.to.x - sd.from.x) * side).toBeLessThan(0);
      // the same switches with the same sides; those on the route stay at their distance
      expect(s.switches.map((w) => [w.node, w.deviates, w.facing, w.onRoute ? w.x : 0])).toEqual(h.switches.map((w) => [w.node, w.deviates, w.facing, w.onRoute ? w.x : 0]));
    });
  }

  it("falls back to the heuristic layout when the solver gives no solution", async () => {
    const r = route(true);
    const s = await layoutRouteSchematicSolved(r, { network, switches, tracks: f.tracks }, { solver: async (ps) => ps.map(() => undefined) });
    expect(s).toEqual(layoutRouteSchematic(r, { network, switches, tracks: f.tracks }));
  });
});
