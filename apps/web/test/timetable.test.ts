import { describe, expect, it } from "vitest";
import type { Routebook, RoutebookItem } from "@routebook/routebook";
import { clockText, elapsedText, parseClock, runSegment, timetable } from "../src/timetable.js";

const item = (kind: RoutebookItem["kind"], distance: number, extra: Partial<RoutebookItem> = {}): RoutebookItem => ({ kind, distance, quality: "rinf", ...extra });

const rb = {
  length: 10_000,
  items: [
    item("origin", 0, { label: "A", data: { uopid: "XA" } }),
    item("speed", 0, { data: { speed: 72 } }),
    item("op", 4000, { label: "B", data: { uopid: "XB" } }),
    item("op", 7000, { label: "C", data: { uopid: "XC" } }),
    item("destination", 10_000, { label: "D", data: { uopid: "XD" } }),
  ],
} as unknown as Routebook;

const train = { accel: 0.5, brake: 0.5, unknownSpeed: 60, vmax: 200 };

describe("timetable", () => {
  it("runs from standstill to standstill", () => {
    // 72 km/h = 20 m/s: 40 s and 400 m to accelerate, the same to brake, 3200 m at 20 m/s
    const { seconds } = runSegment([{ start: 0, end: 4000, speed: 72 }], 4000, train);
    expect(seconds).toBeGreaterThan(234);
    expect(seconds).toBeLessThan(250);
  });

  it("passes the operational points it does not stop at", () => {
    const t = timetable(rb, { departure: 0, stops: new Set(), train });
    expect(t.map((e) => [e.uopid, e.stop])).toEqual([
      ["XA", true],
      ["XB", false],
      ["XC", false],
      ["XD", true],
    ]);
    expect(t[0]!.departure).toBe(0);
    expect(t[1]!.pass!).toBeGreaterThan(200_000);
    expect(t[2]!.pass!).toBeGreaterThan(t[1]!.pass!);
    expect(t[3]!.arrival!).toBeGreaterThan(t[2]!.pass!);
    expect(t[3]!.departure).toBeUndefined();
  });

  it("stops with a dwell time and arrives later", () => {
    const through = timetable(rb, { departure: 0, stops: new Set(), train });
    const stopping = timetable(rb, { departure: 0, stops: new Set(["XB"]), dwell: 120, train });
    const b = stopping[1]!;
    expect(b.stop).toBe(true);
    expect(b.departure! - b.arrival!).toBe(120_000);
    // the stop costs the dwell plus braking and accelerating again
    expect(stopping[3]!.arrival! - through[3]!.arrival!).toBeGreaterThan(120_000 + 20_000);
  });

  it("reads and writes clock times", () => {
    const today = new Date(2026, 9, 24, 12, 0);
    const t = parseClock("08:15", today)!;
    expect(clockText(t)).toBe("08:15");
    expect(clockText(t + 61 * 60_000)).toBe("09:16");
    expect(parseClock("25:00", today)).toBeUndefined();
    expect(parseClock("", today)).toBeUndefined();
    expect(elapsedText(0)).toBe("+0:00");
    expect(elapsedText(83 * 60_000)).toBe("+1:23");
  });
});
