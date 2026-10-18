import { describe, expect, it } from "vitest";
import type { OperationalPoint } from "@routebook/rinf-client";
import { RoutingGraph } from "@routebook/routing";
import {
  RoutebookIndex,
  addBorderItems,
  buildRoutebook,
  parseGradientProfile,
  sortItems,
  type RoutebookData,
  type RoutebookItem,
} from "@routebook/routebook";

const op = (id: string, ne: string, start: number, end: number): OperationalPoint => ({
  id, uopid: id.toUpperCase(), name: id, points: [], areas: [{ ne, start, end }],
});

// Two elements in a row: P (1000 m) then Q (1000 m, laid out in reverse: Q.end meets P.end).
const topology = {
  netElements: [{ id: "P", length: 1000 }, { id: "Q", length: 1000 }],
  netRelations: [{ a: "P", b: "Q", aAtOrigin: false, bAtOrigin: false, navigable: true }],
};
const from = op("start", "P", 0, 100);
const mid = op("mid", "Q", 700, 800);
const to = op("end", "Q", 0, 50);

const data: RoutebookData = {
  ops: [from, mid, to],
  lines: [{ id: "L1", label: "B99-Testbanen" }],
  sols: [{ id: "S1", opStart: "start", opEnd: "end", line: "L1" }],
  tracks: [
    { id: "T1", kind: "running", elements: ["P"], partOf: ["S1"], speed: 120, gradientProfile: "+5.0(+10.2), -3.0(+10.6)" },
    { id: "T2", kind: "running", elements: ["Q"], partOf: ["S1"], speed: 80 },
  ],
  features: [
    { id: "km10", kind: "kmPost", ne: "P", offset: 100, km: 10.1, label: "10.1" },
    { id: "km11", kind: "kmPost", ne: "P", offset: 900, km: 10.9, label: "10.9" },
    { id: "sigFwd", kind: "signal", ne: "P", offset: 500, direction: "normal", label: "HS 1", km: 10.5 },
    { id: "sigRev", kind: "signal", ne: "P", offset: 510, direction: "opposite", label: "HS 2" },
    // on Q we travel backwards, so "opposite" applies to us
    { id: "sigQ", kind: "signal", ne: "Q", offset: 300, direction: "opposite", label: "HS 3" },
    { id: "sw", kind: "switch", ne: "Q", offset: 900, label: "Spv 1" },
  ],
  tunnels: [
    { id: "tun", label: "Testtunnelen", start: { ne: "Q", offset: 600 }, end: { ne: "Q", offset: 400 }, areas: [{ ne: "Q", start: 400, end: 600 }] },
  ],
};

describe("buildRoutebook", () => {
  const route = new RoutingGraph(topology).route(from.areas, to.areas)!;
  const rb = buildRoutebook({ index: new RoutebookIndex(data), route, from, to });
  const kinds = rb.items.map((i) => `${i.kind}:${i.label}`);

  it("routes P forward then Q backward", () => {
    expect(route.steps.map((s) => [s.ne, s.forward])).toEqual([["P", true], ["Q", false]]);
    expect(rb.length).toBeCloseTo(900 + 950);
  });

  it("orders items by distance, origin first and destination last", () => {
    const d = rb.items.map((i) => i.distance);
    expect(d).toEqual([...d].sort((a, b) => a - b));
    expect(rb.items[0]!.kind).toBe("origin");
    expect(rb.items.at(-1)!.kind).toBe("destination");
  });

  it("keeps only signals valid for the direction of travel", () => {
    expect(kinds).toContain("signal:HS 1");
    expect(kinds).not.toContain("signal:HS 2");
    expect(kinds).toContain("signal:HS 3");
  });

  it("places features, OPs, tunnel boundaries and speed changes in route order", () => {
    const seq = rb.items
      .filter((i) => ["signal", "switch", "op", "tunnel", "speed", "line"].includes(i.kind))
      .map((i) => `${i.kind}:${i.label}@${Math.round(i.distance)}`);
    expect(seq).toEqual([
      "line:B99-Testbanen@0",
      "speed:120 km/h@0",
      "signal:HS 1@400",
      "speed:80 km/h@900",
      "switch:Spv 1@1000",
      "op:mid@1100",
      "tunnel:Testtunnelen@1300",
      "tunnel:Testtunnelen@1500",
      "signal:HS 3@1600",
    ]);
    const tunnel = rb.items.filter((i) => i.kind === "tunnel").map((i) => i.data?.boundary);
    expect(tunnel).toEqual(["enter", "exit"]);
  });

  it("places gradient changes by km interpolation and marks them approximate", () => {
    const g = rb.items.filter((i) => i.kind === "gradient");
    expect(g.map((i) => [i.label, Math.round(i.distance)])).toEqual([
      ["+5.0 ‰", 100],
      ["-3.0 ‰", 500],
    ]);
    expect(g.every((i) => i.quality === "approximate")).toBe(true);
  });

  it("lists RINF gaps as explicit placeholders", () => {
    expect(rb.gaps.map((g) => g.field)).toEqual(expect.arrayContaining(["speedProfile", "derailers", "noStopZones"]));
  });
});

describe("sortItems", () => {
  it("is stable and uses kind priority at equal distance", () => {
    const items: RoutebookItem[] = [
      { kind: "kmPost", distance: 10, quality: "rinf", label: "a" },
      { kind: "signal", distance: 10, quality: "rinf", label: "b" },
      { kind: "op", distance: 10, quality: "rinf", label: "c" },
      { kind: "signal", distance: 10, quality: "rinf", label: "d" },
      { kind: "origin", distance: 0, quality: "rinf", label: "o" },
    ];
    expect(sortItems(items).map((i) => i.label)).toEqual(["o", "c", "b", "d", "a"]);
  });
});

describe("parseGradientProfile", () => {
  it("parses permille(+km) pairs", () => {
    expect(parseGradientProfile("-9.0(+110.998), -4.7(+111.045), +12.5(+69.993)")).toEqual([
      { km: 69.993, permille: 12.5 },
      { km: 110.998, permille: -9 },
      { km: 111.045, permille: -4.7 },
    ]);
  });
});

describe("routes across RINF datasets", () => {
  it("tags the items with their dataset, adds a border item and drops the twin border point", () => {
    const graph = new RoutingGraph(topology);
    const route = graph.route([{ ne: "P", start: 0, end: 0 }], [{ ne: "Q", start: 0, end: 0 }])!;
    const border = op("EU1", "P", 1000, 1000);
    const twin = { ...op("EU1", "Q", 1000, 1000), id: "EU1-twin" };
    const index = new RoutebookIndex({ ...data, ops: [from, mid, to, border, twin] });
    const rb = buildRoutebook({ index, route, from, to });
    expect(rb.items.filter((i) => i.kind === "op" && i.data?.uopid === "EU1")).toHaveLength(2);
    const across = addBorderItems(rb, { datasetOf: (ne) => (ne === "P" ? "nor" : "swe"), labelOf: (id) => ({ nor: "Bane NOR", swe: "Trafikverket" })[id] ?? id });
    const borders = across.items.filter((i) => i.kind === "border");
    expect(borders).toHaveLength(1);
    expect(borders[0]).toMatchObject({ distance: 1000, label: "Bane NOR → Trafikverket", quality: "derived", dataset: "swe", data: { from: "nor", to: "swe" } });
    expect(across.items.filter((i) => i.kind === "op" && i.data?.uopid === "EU1")).toHaveLength(1);
    expect(across.items.find((i) => i.kind === "origin")?.dataset).toBe("nor");
    expect(across.items.find((i) => i.kind === "destination")?.dataset).toBe("swe");
    // the border item sorts after the border point at the same distance and before the line of the next dataset
    const at1000 = across.items.filter((i) => i.distance === 1000).map((i) => i.kind);
    expect(at1000.indexOf("op")).toBeLessThan(at1000.indexOf("border"));
    expect(across.items.length).toBe(rb.items.length); // one added, one dropped
  });

  it("adds nothing on a route inside one dataset", () => {
    const graph = new RoutingGraph(topology);
    const route = graph.route([{ ne: "P", start: 0, end: 0 }], [{ ne: "Q", start: 0, end: 0 }])!;
    const rb = buildRoutebook({ index: new RoutebookIndex(data), route, from, to });
    const same = addBorderItems(rb, { datasetOf: () => "nor", labelOf: (id) => id });
    expect(same.items.map((i) => i.kind)).toEqual(rb.items.map((i) => i.kind));
    expect(same.items.every((i) => i.dataset === "nor")).toBe(true);
  });
});
