import { describe, expect, it } from "vitest";
import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { fromWebBundle, toWebBundle, simplifyLine, WEB_PARTS } from "@routebook/rinf-client/compact";
import { buildSearchIndex, normalizeName, searchOps } from "../src/search.js";
import { buildRouteGeometry, pointAtDistance, sliceElement, type LngLat } from "../src/geometry.js";
import { RouteEngine, loadBundle } from "../src/engine.js";
import { stripRows } from "../src/strip.js";

const op = (uopid: string, name: string, type = "10", ne = "", start = 0, end = 0): OperationalPoint => ({
  id: `https://data.banenor.no/data/_op_${uopid}`,
  uopid,
  name,
  type: `http://data.europa.eu/949/concepts/op-types/${type}`,
  points: [],
  areas: ne ? [{ ne, start, end }] : [],
});

describe("search", () => {
  const ops = [
    op("NOOSL", "Oslo S"),
    op("NOLLS", "Lillestrøm"),
    op("NOBRT", "Lillestrøm N", "110"),
    op("NODRM", "Drammen"),
    op("NOASR", "Asker"),
    op("NOAAN", "Åndalsnes"),
    op("NOSKO", "Skøyen", "70"),
  ];
  // only routable OPs rank first
  for (const o of ops) o.areas.push({ ne: "x", start: 0, end: 1 });
  const index = buildSearchIndex(ops);

  it("normalises Nordic letters and diacritics", () => {
    expect(normalizeName("Lillestrøm")).toBe("lillestrom");
    expect(normalizeName("Åndalsnes")).toBe("andalsnes");
    expect(normalizeName("Ærøy-Øst")).toBe("aeroy ost");
  });

  it("ranks exact name, then stations, then prefix matches", () => {
    expect(searchOps(index, "lillestrom").map((o) => o.uopid)).toEqual(["NOLLS", "NOBRT"]);
    expect(searchOps(index, "Lille").map((o) => o.uopid)).toEqual(["NOLLS", "NOBRT"]);
  });

  it("finds by OP code and by word prefix", () => {
    expect(searchOps(index, "nodrm")[0]?.name).toBe("Drammen");
    expect(searchOps(index, "s")[0]?.name).toBe("Skøyen"); // name prefix beats word prefix ("Oslo S")
    expect(searchOps(index, "andals")[0]?.name).toBe("Åndalsnes");
  });

  it("returns nothing for an empty query", () => {
    expect(searchOps(index, "  ")).toEqual([]);
  });
});

describe("geometry", () => {
  // 1 km due east at 60°N is ~0.01794°
  const line: LngLat[] = [[10, 60], [10.00897, 60], [10.01794, 60]];

  it("slices an element proportionally and in travel order", () => {
    const fwd = sliceElement(line, 1000, 250, 750);
    expect(fwd[0]![0]).toBeCloseTo(10.004485, 5);
    expect(fwd.at(-1)![0]).toBeCloseTo(10.013455, 5);
    expect(fwd).toHaveLength(3); // includes the middle vertex
    const back = sliceElement(line, 1000, 750, 250);
    expect(back[0]![0]).toBeCloseTo(10.013455, 5);
  });

  it("maps route distance to a map position", () => {
    const route = {
      steps: [
        { ne: "A", forward: true, from: 0, to: 1000, startDistance: 0 },
        { ne: "B", forward: false, from: 1000, to: 0, startDistance: 1000 },
      ],
      length: 2000,
      cost: 2000,
      costModel: "length",
    };
    const geometry = { A: line, B: [[10.03588, 60], [10.01794, 60]] as LngLat[] };
    const rg = buildRouteGeometry(route, geometry, new Map([["A", 1000], ["B", 1000]]));
    expect(rg.coordinates.at(-1)![0]).toBeCloseTo(10.03588, 5);
    expect(pointAtDistance(rg, 500)![0]).toBeCloseTo(10.00897, 4);
    expect(pointAtDistance(rg, 1500)![0]).toBeCloseTo(10.0269, 3);
  });

  it("simplifies collinear vertices away", () => {
    expect(simplifyLine([[0, 0], [1, 0.000001], [2, 0]], 1e-5)).toEqual([[0, 0], [2, 0]]);
  });
});

describe("web bundle + RouteEngine", () => {
  const BN = "https://data.banenor.no/data/";
  const snapshot: Snapshot = {
    meta: { endpoint: "e", graph: "g", country: "NOR", fetchedAt: "2026-10-13T00:00:00Z", counts: {} },
    ops: [op("NOAAA", "Aaa", "10", `${BN}_ne_1`, 0, 10), op("NOBBB", "Bbb", "10", `${BN}_ne_2`, 90, 100)],
    lines: [],
    sols: [],
    topology: {
      netElements: [{ id: `${BN}_ne_1`, length: 100 }, { id: `${BN}_ne_2`, length: 100 }],
      netRelations: [{ a: `${BN}_ne_1`, b: `${BN}_ne_2`, aAtOrigin: false, bAtOrigin: true, navigable: true }],
    },
    tracks: Array.from({ length: 60 }, (_, i) => ({ id: `${BN}_track_${i}`, kind: "running" as const, speed: 100, elements: [`${BN}_ne_1`, `${BN}_ne_2`], partOf: [] })),
    features: [{ id: `${BN}_sig`, kind: "signal", ne: `${BN}_ne_2`, offset: 40, label: "HS 1" }],
    tunnels: [],
    geometry: { [`${BN}_ne_1`]: [[10, 60], [10.0018, 60]], [`${BN}_ne_2`]: [[10.0018, 60], [10.0036, 60]] },
  };

  it("round-trips through the compact bundle with IRIs restored", () => {
    const parts = toWebBundle(snapshot);
    const json = JSON.stringify(parts);
    const { meta, ...data } = parts;
    expect(JSON.stringify(data)).not.toContain(BN); // prefix compacted everywhere but the prefix table
    expect(Object.values((meta as { prefixes: Record<string, string> }).prefixes)).toContain(BN);
    const back = fromWebBundle(JSON.parse(json));
    expect(back.topology).toEqual(snapshot.topology);
    expect(back.features).toEqual(snapshot.features);
    expect(Object.keys(back.geometry)).toEqual(Object.keys(snapshot.geometry));
  });

  it("loads a bundle over fetch and routes with it", async () => {
    const parts = toWebBundle(snapshot) as Record<string, unknown>;
    const fakeFetch = (async (url: string) => {
      const part = url.split("/").pop()!.replace(".json", "");
      return new Response(JSON.stringify(parts[part]), { status: WEB_PARTS.includes(part as never) ? 200 : 404 });
    }) as unknown as typeof fetch;
    const loaded = await loadBundle("/nor", fakeFetch);
    const engine = new RouteEngine(loaded);
    const { routebook, geometry } = engine.route(loaded.ops[0]!, loaded.ops[1]!);
    expect(routebook.length).toBeCloseTo(90 + 90);
    expect(routebook.items.map((i) => i.kind)).toEqual(["origin", "speed", "signal", "destination"]);
    expect(geometry.coordinates.length).toBeGreaterThanOrEqual(2);
    expect(() => engine.route(loaded.ops[0]!, loaded.ops[0]!)).toThrow(/same/);
  });

  it("reports a missing bundle clearly", async () => {
    const notFound = (async () => new Response("", { status: 404 })) as unknown as typeof fetch;
    await expect(loadBundle("/xx", notFound)).rejects.toThrow(/fetch:nor/);
  });
});

describe("stripRows", () => {
  it("carries speed and gradient forward and flags missing speed", () => {
    const rb = {
      items: [
        { kind: "origin", distance: 0, quality: "rinf" },
        { kind: "speed", distance: 0, quality: "rinf", data: { speed: 80 } },
        { kind: "gradient", distance: 10, quality: "approximate", data: { gradient: -5 } },
        { kind: "signal", distance: 20, quality: "rinf" },
        { kind: "missing", distance: 30, quality: "missing", data: { field: "speed" } },
        { kind: "destination", distance: 40, quality: "rinf" },
      ],
    } as unknown as Parameters<typeof stripRows>[0];
    const rows = stripRows(rb);
    expect(rows.map((r) => r.speed)).toEqual([undefined, 80, 80, 80, undefined, undefined]);
    expect(rows.map((r) => r.speedMissing)).toEqual([false, false, false, false, true, true]);
    expect(rows.map((r) => r.gradient)).toEqual([undefined, undefined, -5, -5, -5, -5]);
    expect(rows.filter((r) => r.speedChanged).map((r) => r.index)).toEqual([1, 4]);
  });
});
