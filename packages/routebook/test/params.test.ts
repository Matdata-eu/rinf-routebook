import { describe, expect, it } from "vitest";
import type { OperationalPoint } from "@routebook/rinf-client";
import { RoutingGraph } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, changeItems, energyOf, etcsOf, mergeStretches, paramOf, type RoutebookData, type Stretch } from "@routebook/routebook";

const op = (id: string, ne: string, start: number, end: number): OperationalPoint => ({ id, uopid: id.toUpperCase(), name: id, points: [], areas: [{ ne, start, end }] });

// three elements in a row, 1000 m each: electrified, not electrified, electrified with ETCS
const topology = {
  netElements: [{ id: "A", length: 1000 }, { id: "B", length: 1000 }, { id: "C", length: 1000 }],
  netRelations: [
    { a: "A", b: "B", aAtOrigin: false, bAtOrigin: true, navigable: true },
    { a: "B", b: "C", aAtOrigin: false, bAtOrigin: true, navigable: true },
  ],
};
const from = op("start", "A", 0, 0), to = op("end", "C", 1000, 1000);
const ac = { contactLine: "Overhead contact line (OCL)", energySupply: "AC 15kV-16.7Hz" };
const data: RoutebookData = {
  ops: [from, to],
  lines: [{ id: "L1", label: "B99-Testbanen" }],
  sols: [{ id: "S1", opStart: "start", opEnd: "end", line: "L1" }],
  tracks: [
    { id: "T1", kind: "running", elements: ["A"], partOf: ["S1"], speed: 100, params: ac, notApplicable: ["etcsLevel", "etcsBaseline"],
      separations: [{ id: "P1", kind: "phase", km: 10.5, length: 54, switchOffBreaker: true }] },
    { id: "T2", kind: "running", elements: ["B"], partOf: ["S1"], speed: 100, params: { contactLine: "Not electrified" }, notApplicable: ["etcsLevel", "etcsBaseline"], notYetAvailable: ["gauge"] },
    { id: "T3", kind: "running", elements: ["C"], partOf: ["S1"], speed: 100, params: { ...ac, etcsLevel: "2" } },
  ],
  features: [
    { id: "k1", kind: "kmPost", ne: "A", offset: 0, km: 10 },
    { id: "k1b", kind: "kmPost", ne: "A", offset: 900, km: 10.9 },
    { id: "k2", kind: "kmPost", ne: "C", offset: 1000, km: 13 },
  ],
  tunnels: [],
};

describe("section parameters on the route", () => {
  const route = new RoutingGraph(topology).route(from.areas, to.areas)!;
  const rb = buildRoutebook({ index: new RoutebookIndex(data), route, from, to });

  it("has one stretch per track with what is in force", () => {
    expect(rb.stretches!.map((s) => [s.track, Math.round(s.start), Math.round(s.end), s.params?.contactLine])).toEqual([
      ["T1", 0, 1000, "Overhead contact line (OCL)"],
      ["T2", 1000, 2000, "Not electrified"],
      ["T3", 2000, 3000, "Overhead contact line (OCL)"],
    ]);
    expect(rb.stretches![0]!.lineLabel).toBe("B99-Testbanen");
    expect(rb.stretches![0]!.kmStart).toBeCloseTo(10);
  });

  it("adds a change item where energy or ETCS change", () => {
    const changes = rb.items.filter((i) => i.kind === "change").map((i) => `${Math.round(i.distance)} ${i.label}`);
    expect(changes).toEqual([
      "1000 Energy: AC 15kV-16.7Hz → Not electrified",
      "2000 Energy: Not electrified → AC 15kV-16.7Hz",
      "2000 ETCS: No ETCS → ETCS level 2",
    ]);
  });

  it("places a phase separation by its line km", () => {
    const sep = rb.items.find((i) => i.kind === "separation")!;
    expect(sep.distance).toBeCloseTo(500, -1);
    expect(sep).toMatchObject({ label: "Phase separation", quality: "approximate", data: { length: 54, switchOffBreaker: true } });
  });

  it("says why a parameter has no value", () => {
    const [s1, s2] = rb.stretches!;
    expect(paramOf(s1, "energySupply")).toEqual({ state: "value", value: "AC 15kV-16.7Hz" });
    expect(paramOf(s1, "etcsLevel")).toEqual({ state: "notApplicable" });
    expect(paramOf(s2, "gauge")).toEqual({ state: "notYetAvailable" });
    expect(paramOf(s2, "gsmR")).toEqual({ state: "notPublished" });
    expect(paramOf(undefined, "gsmR")).toEqual({ state: "noTrack" });
    expect(energyOf(s2)).toBe("Not electrified");
    expect(etcsOf(s1)).toBe("No ETCS");
    expect(etcsOf({})).toBeUndefined();
  });
});

describe("changeItems and mergeStretches", () => {
  const st = (start: number, end: number, params: Record<string, string>): Stretch => ({ start, end, track: `t${start}`, params });

  it("ignores short stretches and stretches without a value", () => {
    const items = changeItems([st(0, 1000, { energySupply: "AC" }), st(1000, 1050, { energySupply: "DC" }), st(1050, 2000, {}), st(2000, 3000, { energySupply: "AC" })]);
    expect(items).toEqual([]);
  });

  it("joins neighbours with the same parameters", () => {
    const merged = mergeStretches([st(0, 1000, { gauge: "1435" }), st(1000, 2000, { gauge: "1435" }), st(2000, 3000, { gauge: "1668" })]);
    expect(merged.map((s) => [s.start, s.end])).toEqual([[0, 2000], [2000, 3000]]);
  });
});
