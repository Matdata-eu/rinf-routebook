import { describe, expect, it } from "vitest";
import type { NetRelation, Snapshot, Track } from "@routebook/rinf-client";
import type { Route } from "@routebook/routing";
import {
  TopoNetwork,
  classifySwitches,
  compactSwitches,
  continuousBranch,
  expandSwitches,
  layoutRouteSchematic,
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
