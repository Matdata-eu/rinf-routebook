import { describe, expect, it } from "vitest";
import type { Routebook, RoutebookItem } from "@routebook/routebook";
import type { RouteGeometry } from "../src/geometry.js";
import { along, angleDiff, bearing, cuesAhead, roundCorners, formatDistance, nextStop, runningTime, speedProfile, trainParts, tunnelAt, TrainSim } from "../src/drive.js";

// a 2 km line due north, then 1 km due east (about 60°N)
const north = 2000 / 110_574;
const east = 1000 / (111_320 * Math.cos(60.018 * (Math.PI / 180)));
const geometry: RouteGeometry = {
  coordinates: [[10, 60], [10, 60 + north], [10 + east, 60 + north]],
  steps: [
    { start: 0, end: 2000, coords: [[10, 60], [10, 60 + north]] },
    { start: 2000, end: 3000, coords: [[10, 60 + north], [10 + east, 60 + north]] },
  ],
};

const item = (kind: RoutebookItem["kind"], distance: number, extra: Partial<RoutebookItem> = {}): RoutebookItem => ({ kind, distance, quality: "rinf", ...extra });

const rb = {
  length: 3000,
  items: [
    item("origin", 0, { label: "A" }),
    item("speed", 0, { data: { speed: 80 } }),
    item("signal", 500, { label: "S1", data: { signalType: "home" } }),
    item("signal", 600, { label: "D1", data: { signalType: "shunting" } }),
    item("tunnel", 900, { label: "T", source: "t1", data: { boundary: "enter", length: 400 } }),
    item("speed", 1000, { data: { speed: 80 } }),
    item("tunnel", 1300, { label: "T", source: "t1", data: { boundary: "exit" } }),
    item("op", 1500, { label: "B" }),
    item("speed", 2000, { data: { speed: 40 } }),
    item("missing", 2500, { data: { field: "speed" } }),
    item("destination", 3000, { label: "C" }),
  ],
} as unknown as Routebook;

describe("drive geometry", () => {
  const a = along(geometry);
  it("follows the route and its heading", () => {
    expect(a.length).toBe(3000);
    // within a few metres: the rounded corner makes the line slightly shorter
    expect(Math.abs(a.point(1000)[1] - (60 + north / 2)) * 110_574).toBeLessThan(10);
    expect(a.heading(1000)).toBeCloseTo(0, 0);
    expect(a.heading(2500)).toBeCloseTo(90, 0);
    expect(a.progress(1500)).toBeCloseTo(0.5, 2);
  });
  it("wraps angle differences", () => {
    expect(angleDiff(350, 10)).toBe(20);
    expect(angleDiff(10, 350)).toBe(-20);
  });
  it("draws a train of closed footprints behind the front", () => {
    const parts = trainParts(a, 1500);
    expect(parts).toHaveLength(12);
    for (const p of parts) expect(p.ring[0]).toEqual(p.ring.at(-1));
    // the whole train is south of its front on a line running north
    const front = a.point(1500)[1];
    for (const p of parts) for (const c of p.ring) expect(c[1]).toBeLessThanOrEqual(front + 1e-9);
  });
});

describe("drive speed profile and train", () => {
  const profile = speedProfile(rb);
  it("merges repeated speeds and keeps missing spans", () => {
    expect(profile).toEqual([
      { start: 0, end: 2000, speed: 80 },
      { start: 2000, end: 2500, speed: 40 },
      { start: 2500, end: 3000 },
    ]);
  });
  it("never exceeds the speed in force and stops at the end", () => {
    const sim = new TrainSim(profile, 3000);
    let t = 0;
    while (!sim.finished && t < 3600) {
      sim.step(0.5);
      t += 0.5;
      const lim = profile.find((s) => sim.d >= s.start && sim.d < s.end);
      if (lim?.speed) expect(sim.v * 3.6).toBeLessThanOrEqual(lim.speed + 0.5);
    }
    expect(sim.finished).toBe(true);
    expect(sim.v).toBe(0);
  });
  it("estimates running time at line speed", () => {
    expect(runningTime(profile, 0, 2000)).toBeCloseTo(2000 / (80 / 3.6), 3);
  });
});

describe("drive cues", () => {
  it("lists what lies ahead, skipping shunting signals, tunnel exits and repeated speeds", () => {
    const cues = cuesAhead(rb, 100, 4).map((c) => `${c.item.kind}:${c.item.label ?? c.item.data?.speed}@${c.ahead}`);
    expect(cues).toEqual(["signal:S1@400", "tunnel:T@800", "op:B@1400", "speed:40@1900"]);
  });
  it("finds the next stop and the tunnel the train is in", () => {
    expect(nextStop(rb, 1600)?.item.label).toBe("C");
    expect(tunnelAt(rb, 1000)?.label).toBe("T");
    expect(tunnelAt(rb, 1400)).toBeUndefined();
  });
  it("formats distances like a satnav", () => {
    expect(formatDistance(123)).toBe("120 m");
    expect(formatDistance(1234)).toBe("1.2 km");
    expect(formatDistance(23_400)).toBe("23 km");
  });
});

describe("drive smoothing", () => {
  it("rounds a right-angle corner without moving the ends", () => {
    const line = roundCorners([[10, 60], [10, 60 + north], [10 + east, 60 + north]]);
    expect(line[0]).toEqual([10, 60]);
    expect(line.at(-1)).toEqual([10 + east, 60 + north]);
    expect(line.length).toBeGreaterThan(5);
    // the corner itself is cut: no point is at the original vertex
    expect(line.some((p) => p[0] === 10 && p[1] === 60 + north)).toBe(false);
    // and the heading turns gradually: no step of more than 30° between segments
    for (let i = 2; i < line.length; i++) {
      const turn = Math.abs(angleDiff(bearing(line[i - 2]!, line[i - 1]!), bearing(line[i - 1]!, line[i]!)));
      expect(turn).toBeLessThan(30);
    }
  });
});
