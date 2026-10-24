import { describe, expect, it } from "vitest";
import type { Routebook, RoutebookItem, Stretch } from "@routebook/routebook";
import { BANDS, bandSegments, gradientSegments, routeCoverage, sectionRows, shortEnergy, stretchAt, stripScale, thinLabels, tunnelSpans } from "../src/line-strip-model.js";

const item = (kind: RoutebookItem["kind"], distance: number, extra: Partial<RoutebookItem> = {}): RoutebookItem => ({ kind, distance, quality: "rinf", ...extra });
const band = (id: string) => BANDS.find((b) => b.id === id)!;

const stretches: Stretch[] = [
  { start: 0, end: 1000, track: "t1", speed: 80, params: { energySupply: "AC 15kV-16.7Hz", contactLine: "Overhead contact line (OCL)" }, notApplicable: ["etcsLevel"] },
  { start: 1000, end: 2500, track: "t2", speed: 80, params: { energySupply: "AC 15kV-16.7Hz", etcsLevel: "2" }, notYetAvailable: ["gsmR"] },
  { start: 2500, end: 3000, track: "t3", params: { contactLine: "Not electrified" }, notYetAvailable: ["speed"] },
  { start: 3000, end: 4000 },
];
const rb = { length: 4000, stretches, items: [] as RoutebookItem[] } as unknown as Routebook;

describe("line strip bands", () => {
  it("shortens energy supply systems", () => {
    expect(shortEnergy("AC 15kV-16.7Hz")).toBe("15 kV ~");
    expect(shortEnergy("DC 3kV")).toBe("3 kV =");
    expect(shortEnergy("DC 750V")).toBe("750 V =");
    expect(shortEnergy("Not electrified")).toBe("none");
  });

  it("joins neighbouring stretches with the same value", () => {
    expect(bandSegments(rb, band("speed"))).toEqual([
      { start: 0, end: 2500, state: "value", value: "80", short: "80" },
      { start: 2500, end: 3000, state: "notYetAvailable" },
      { start: 3000, end: 4000, state: "noTrack" },
    ]);
    expect(bandSegments(rb, band("energy")).map((s) => [s.start, s.end, s.state, s.short])).toEqual([
      [0, 2500, "value", "15 kV ~"],
      [2500, 3000, "value", "none"],
      [3000, 4000, "noTrack", undefined],
    ]);
  });

  it("shows declared states: no ETCS as not applicable, GSM-R not yet available", () => {
    expect(bandSegments(rb, band("etcs")).map((s) => [s.state, s.short])).toEqual([
      ["notApplicable", undefined],
      ["value", "L2"],
      ["notPublished", undefined],
      ["noTrack", undefined],
    ]);
    expect(bandSegments(rb, band("radio")).map((s) => s.state)).toEqual(["notPublished", "notYetAvailable", "notPublished", "noTrack"]);
  });

  it("finds the stretch at a distance", () => {
    expect(stretchAt(rb, 0)?.track).toBe("t1");
    expect(stretchAt(rb, 999)?.track).toBe("t1");
    expect(stretchAt(rb, 1000)?.track).toBe("t2");
    expect(stretchAt(rb, 3999)?.track).toBeUndefined();
    expect(stretchAt({ stretches: [] }, 5)).toBeUndefined();
  });

  it("lists the section card rows with units and states", () => {
    const rows = sectionRows(stretches[0]!);
    expect(rows[0]).toMatchObject({ key: "speed", state: "value", value: "80 km/h" });
    expect(rows.find((r) => r.key === "etcsLevel")?.state).toBe("notApplicable");
    expect(rows.find((r) => r.key === "gsmR")?.state).toBe("notPublished");
    expect(sectionRows(stretches[2]!)[0]?.state).toBe("notYetAvailable");
  });

  it("measures how much of the route each parameter covers", () => {
    const cov = routeCoverage(rb);
    const speed = cov.find((c) => c.key === "speed")!;
    expect(speed.shares.value).toBeCloseTo(0.625);
    expect(speed.shares.notYetAvailable).toBeCloseTo(0.125);
    expect(speed.shares.noTrack).toBeCloseTo(0.25);
    const etcs = cov.find((c) => c.key === "etcsLevel")!;
    expect(etcs.shares.notApplicable + etcs.shares.value).toBeCloseTo(0.625);
  });
});

describe("line strip marks", () => {
  const items = [
    item("gradient", 0, { data: { gradient: 5 } }),
    item("tunnel", 100, { label: "T1", source: "a", data: { boundary: "enter", length: 300 } }),
    item("gradient", 200, { data: { gradient: -3 } }),
    item("tunnel", 400, { label: "T1", source: "a", data: { boundary: "exit" } }),
    item("tunnel", 900, { label: "T2", source: "b", data: { boundary: "enter" } }),
  ];
  it("turns gradient items into spans", () => {
    expect(gradientSegments({ items, length: 1000 })).toEqual([
      { start: 0, end: 200, gradient: 5 },
      { start: 200, end: 1000, gradient: -3 },
    ]);
  });
  it("pairs tunnel boundaries, open ones run to the end", () => {
    expect(tunnelSpans({ items, length: 1000 })).toEqual([
      { start: 100, end: 400, label: "T1", length: 300 },
      { start: 900, end: 1000, label: "T2" },
    ]);
  });

  it("scales ahead up and ahead down", () => {
    const up = stripScale(1000, 10, true, 24);
    expect(up.height).toBe(148);
    expect(up.y(0)).toBe(124);
    expect(up.y(1000)).toBe(24);
    expect(up.d(up.y(420))).toBeCloseTo(420);
    const down = stripScale(1000, 10, false, 24);
    expect(down.y(0)).toBe(24);
    expect(down.d(200)).toBe(1000);
  });

  it("keeps the most important labels that fit", () => {
    const marks = [
      { y: 0, p: 1, n: "a" },
      { y: 5, p: 9, n: "b" },
      { y: 12, p: 1, n: "c" },
      { y: 40, p: 1, n: "d" },
    ];
    expect(thinLabels(marks, (m) => m.y, (m) => m.p, 10).map((m) => m.n)).toEqual(["b", "d"]);
  });
});
