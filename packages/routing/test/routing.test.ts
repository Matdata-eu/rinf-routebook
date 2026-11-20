import { describe, expect, it } from "vitest";
import type { NetRelation, Topology, Track } from "@routebook/rinf-client";
import { RoutingGraph, lengthCostModel, trackPreferenceCostModel } from "@routebook/routing";

/**
 * Fixture (lengths in m):
 *
 *            B (1000, running)
 *   A ──┬──────────────────────┬── D
 *  (100)│                      │ (100)
 *       └──────── C ───────────┘
 *             (800, siding)
 *
 * A.end meets B.origin and C.origin at a switch (B<->C not navigable),
 * B.end and C.end meet D.origin at a switch (B<->C not navigable).
 * E (50) hangs off A.origin.
 */
const rel = (a: string, aAtOrigin: boolean, b: string, bAtOrigin: boolean, navigable = true): NetRelation => ({
  a, b, aAtOrigin, bAtOrigin, navigable,
});

const topology: Topology = {
  netElements: [
    { id: "A", length: 100 },
    { id: "B", length: 1000 },
    { id: "C", length: 800 },
    { id: "D", length: 100 },
    { id: "E", length: 50 },
  ],
  netRelations: [
    rel("A", false, "B", true),
    rel("A", false, "C", true),
    rel("B", true, "C", true, false),
    rel("B", false, "D", true),
    rel("C", false, "D", true),
    rel("B", false, "C", false, false),
    rel("E", false, "A", true),
  ],
};

const tracks: Track[] = [
  { id: "t-main", kind: "running", elements: ["A", "B", "D", "E"], partOf: [] },
  { id: "t-siding", kind: "siding", elements: ["C"], partOf: [] },
];

const point = (ne: string, offset: number) => [{ ne, start: offset, end: offset }];

describe("RoutingGraph", () => {
  const g = new RoutingGraph(topology);

  it("finds the physically shortest route with the length cost model", () => {
    const r = g.route(point("A", 30), point("D", 20), { costModel: lengthCostModel })!;
    expect(r.steps.map((s) => s.ne)).toEqual(["A", "C", "D"]);
    expect(r.length).toBeCloseTo(70 + 800 + 20);
  });

  it("prefers running tracks over sidings with the default cost model", () => {
    const r = g.route(point("A", 30), point("D", 20), { costModel: trackPreferenceCostModel(tracks) })!;
    expect(r.steps.map((s) => s.ne)).toEqual(["A", "B", "D"]);
    expect(r.length).toBeCloseTo(70 + 1000 + 20);
    expect(r.steps.map((s) => s.startDistance)).toEqual([0, 70, 1070]);
  });

  it("keeps to the through track rather than a slightly shorter slow loop", () => {
    // Blaker on Kongsvingerbanen: the passing loop (track 2, 40 km/h, not electrified) is 2 m
    // shorter than the through track (track 1, 90 km/h); the route must not run over the loop
    const station: Topology = {
      netElements: [
        { id: "in", length: 200 },
        { id: "through", length: 614 },
        { id: "loop", length: 612 },
        { id: "out", length: 200 },
      ],
      netRelations: [
        rel("in", false, "through", true),
        rel("in", false, "loop", true),
        rel("through", true, "loop", true, false),
        rel("through", false, "out", true),
        rel("loop", false, "out", true),
        rel("through", false, "loop", false, false),
      ],
    };
    const stationTracks: Track[] = [
      { id: "t1", kind: "running", label: "1", speed: 90, elements: ["in", "through", "out"], partOf: [] },
      { id: "t2", kind: "running", label: "2", speed: 40, elements: ["loop"], partOf: [] },
    ];
    const sg = new RoutingGraph(station);
    expect(sg.route(point("in", 0), point("out", 200), { costModel: lengthCostModel })!.steps.map((s) => s.ne)).toEqual(["in", "loop", "out"]);
    const r = sg.route(point("in", 0), point("out", 200), { costModel: trackPreferenceCostModel(stationTracks) })!;
    expect(r.steps.map((s) => s.ne)).toEqual(["in", "through", "out"]);
    expect(sg.breaks(r)).toEqual([]);
    // slowSpeed 0 turns the speed preference off
    expect(sg.route(point("in", 0), point("out", 200), { costModel: trackPreferenceCostModel(stationTracks, { slowSpeed: 0 }) })!.steps.map((s) => s.ne)).toEqual(["in", "loop", "out"]);
  });

  it("starts at the platform point on the fastest track when an OP has several", () => {
    // Sørumsand: one centre point per platform track; the one on track 3 (40 km/h, not electrified,
    // joining the line through a switch) is nearer, but the train starts on the through track
    const station: Topology = {
      netElements: [
        { id: "p1", length: 700 },
        { id: "p3", length: 500 },
        { id: "line", length: 3000 },
      ],
      netRelations: [rel("p1", false, "line", true), rel("p3", false, "line", true), rel("p1", false, "p3", false, false)],
    };
    const stationTracks: Track[] = [
      { id: "t1", kind: "running", label: "1", speed: 80, elements: ["p1", "line"], partOf: [] },
      { id: "t3", kind: "running", label: "3", speed: 40, elements: ["p3"], partOf: [] },
    ];
    const sg = new RoutingGraph(station);
    const from = [{ ne: "p1", start: 150, end: 150 }, { ne: "p3", start: 100, end: 100 }];
    expect(sg.route(from, point("line", 3000), { costModel: lengthCostModel })!.steps[0]!.ne).toBe("p3");
    expect(sg.route(from, point("line", 3000), { costModel: trackPreferenceCostModel(stationTracks) })!.steps[0]!.ne).toBe("p1");
  });

  it("reports the steps of a route that do not join the step before them", () => {
    const r = g.route(point("A", 30), point("D", 20), { costModel: trackPreferenceCostModel(tracks) })!;
    expect(g.breaks(r)).toEqual([]);
    // jump from A straight onto D: no relation joins them
    const jumped = { steps: [r.steps[0]!, { ...r.steps[2]!, startDistance: 70 }] };
    expect(g.breaks(jumped)).toEqual([1]);
    // leaves B in the middle instead of at an end
    const midway = { steps: [r.steps[0]!, { ...r.steps[1]!, to: 500 }, { ...r.steps[2]!, startDistance: 570 }] };
    expect(g.breaks(midway)).toEqual([2]);
    // C entered from the A end but A was left at its origin
    const wrongEnd = { steps: [{ ...r.steps[0]!, to: 0, forward: false }, { ...r.steps[1]!, startDistance: 30 }] };
    expect(g.breaks(wrongEnd)).toEqual([1]);
  });

  it("follows one-way relations (navigability AB / BA) in their direction only", () => {
    const oneWay = (direction: "AB" | "BA"): Topology => ({
      netElements: [{ id: "P", length: 100 }, { id: "Q", length: 100 }],
      netRelations: [{ ...rel("P", false, "Q", true), direction }],
    });
    const ab = new RoutingGraph(oneWay("AB"));
    expect(ab.route(point("P", 50), point("Q", 50))?.steps.map((s) => s.ne)).toEqual(["P", "Q"]);
    expect(ab.route(point("Q", 50), point("P", 50))).toBeNull();
    const ba = new RoutingGraph(oneWay("BA"));
    expect(ba.route(point("P", 50), point("Q", 50))).toBeNull();
    expect(ba.route(point("Q", 50), point("P", 50))?.steps.map((s) => s.ne)).toEqual(["Q", "P"]);
  });

  it("does not U-turn through a switch (navigability None)", () => {
    // B -> C would need a reversal at the A/B/C switch or the B/C/D switch
    expect(g.route(point("B", 500), point("C", 400))).toBeNull();
  });

  it("travels backwards along elements when needed", () => {
    const r = g.route(point("D", 50), point("E", 10))!;
    expect(r.steps.map((s) => [s.ne, s.forward])).toEqual([
      ["D", false],
      ["C", false],
      ["A", false],
      ["E", false],
    ]);
    expect(r.length).toBeCloseTo(50 + 800 + 100 + 40);
  });

  it("routes within a single element", () => {
    const r = g.route(point("B", 100), point("B", 400))!;
    expect(r.steps).toHaveLength(1);
    expect(r.length).toBeCloseTo(300);
  });

  it("stops at the near edge of a target area", () => {
    const r = g.route(point("A", 0), [{ ne: "D", start: 40, end: 90 }], { costModel: lengthCostModel })!;
    expect(r.length).toBeCloseTo(100 + 800 + 40);
  });

  it("reports connected components", () => {
    const comps = new RoutingGraph({
      netElements: [...topology.netElements, { id: "X", length: 10 }],
      netRelations: topology.netRelations,
    }).components();
    expect(comps.map((c) => c.length)).toEqual([5, 1]);
  });
});
