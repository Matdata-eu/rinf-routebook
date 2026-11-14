import { beforeAll, describe, expect, it } from "vitest";
import { layoutQuality, layoutRouteSchematic, loadHighs, prepareSolvedLayout, solveWithHighs, type HighsLike, type QualityMetrics } from "@routebook/schematic";
import { FIXTURES, loadFixture } from "./fixtures.js";

/**
 * The quality gate of the layouter: the solver layout of seven station areas cut out of real RINF data
 * (test/fixtures, written by `node scripts/schematic-lab.mjs fixture`) must stay within the numbers
 * below. They are what the layouter reaches today plus a little room; when a change makes a layout
 * better, tighten them, and when one must give way, say why in the commit.
 *
 * Every window gets a generous time limit, so that the result does not depend on the machine.
 */
type Limits = Pick<QualityMetrics, "crossings" | "overlaps" | "bends" | "squeezed" | "steep"> & { lanes: number };
const LIMITS: Record<(typeof FIXTURES)[number], Limits> = {
  hamar: { crossings: 1, overlaps: 0, bends: 42, squeezed: 2, steep: 0, lanes: 23 },
  skoyen: { crossings: 1, overlaps: 0, bends: 29, squeezed: 1, steep: 0, lanes: 15 },
  drammen: { crossings: 1, overlaps: 0, bends: 53, squeezed: 1, steep: 0, lanes: 23 },
  trondheim: { crossings: 1, overlaps: 0, bends: 64, squeezed: 1, steep: 0, lanes: 33 },
  dalane: { crossings: 1, overlaps: 0, bends: 38, squeezed: 1, steep: 0, lanes: 24 },
  radviliskis: { crossings: 12, overlaps: 0, bends: 128, squeezed: 4, steep: 0, lanes: 41 },
  kongsvinger: { crossings: 1, overlaps: 0, bends: 41, squeezed: 1, steep: 0, lanes: 18 },
};

/**
 * Checked against Bane NOR's published station track plans (banenor.no, "Railway stations"): which side
 * of the route a track lies on.
 */
describe("sides as in Bane NOR's station plans", () => {
  it("Hamar: the tracks through slip switch 39 both lie on the station side of track 1", async () => {
    // plan KO-000078-000: north of switch 8 the route (track 1) takes the curve of slip 39; the track
    // from 5 and the one on to X200 and track 28 (1002 in RINF) are both left of it, none crosses below
    const { route, input } = loadFixture("hamar");
    const highs = await loadHighs();
    const prep = prepareSolvedLayout(route, input, { timeLimit: 60 });
    for (const s of [layoutRouteSchematic(route, input), prep.finish(prep.problems.map((p) => solveWithHighs(highs, p)))]) {
      const t1002 = s.tracks.filter((t) => t.track === "1002");
      expect(t1002.length).toBeGreaterThan(0);
      for (const t of t1002) expect(Math.min(t.from.y, t.to.y, t.lane ?? 0)).toBeGreaterThanOrEqual(0);
    }
    expect(prep.reports.reduce((n, w) => n + w.conflicts, 0)).toBe(0);
  }, 120_000);
});

describe("layout quality on real stations", () => {
  let highs: HighsLike;
  beforeAll(async () => {
    highs = await loadHighs();
  });

  for (const name of FIXTURES) {
    it(name, () => {
      const { route, input, lengthOf } = loadFixture(name);
      const heuristic = layoutRouteSchematic(route, input);
      const prep = prepareSolvedLayout(route, input, { timeLimit: 60 });
      const solved = prep.finish(prep.problems.map((p) => solveWithHighs(highs, p)));
      // every window is solved to the end, none falls back to the heuristic
      expect(prep.reports.filter((w) => w.status !== "solved").map((w) => `${w.from}..${w.to} ${w.status}`)).toEqual([]);
      const q = layoutQuality(solved, lengthOf);
      const got: Limits = { crossings: q.crossings, overlaps: q.overlaps, bends: q.bends, squeezed: q.squeezed, steep: q.steep, lanes: q.maxLane - q.minLane + 1 };
      if (process.env["SCHEMATIC_QUALITY"]) process.stderr.write(`${name} ${JSON.stringify(got)} heuristic ${JSON.stringify(layoutQuality(heuristic, lengthOf))}\n`);
      for (const k of Object.keys(got) as Array<keyof Limits>) expect(got[k], k).toBeLessThanOrEqual(LIMITS[name][k]);
      // the solver never draws more crossings than the heuristic it starts from
      expect(q.crossings).toBeLessThanOrEqual(layoutQuality(heuristic, lengthOf).crossings);
      // the same tracks and switches as the heuristic, and x is still the route distance outside stretched stations
      expect(solved.tracks.length).toBe(heuristic.tracks.length);
      expect(solved.switches.length).toBe(heuristic.switches.length);
      // a wye or a loop is two half stubs with a connection that says they are one track
      expect(solved.connections?.length ?? 0).toBe(q.split);
      for (const [d, x] of solved.scale ?? []) expect(x).toBeGreaterThanOrEqual(d - 0.01);
    }, 120_000);
  }
});
