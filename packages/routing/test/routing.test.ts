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
