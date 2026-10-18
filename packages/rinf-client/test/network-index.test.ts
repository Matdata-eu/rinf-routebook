import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { borderCandidates, borderRelations, datasetIndex, matchBorders, mergeIndexes, opKey, opRow, parseBordersIndex, parseOpsIndex, parseSolsIndex, solRow, readDatasetIndex, saveWebBundle, transitDatasets, writeDatasetIndex, writeNetworkIndex, type OperationalPoint, type Snapshot } from "@routebook/rinf-client";

const op = (uopid: string, name: string, type = "10", lon?: number, lat?: number, routable = true): OperationalPoint => ({
  id: `https://x.test/op/${uopid}`,
  uopid,
  name,
  type: `http://data.europa.eu/949/concepts/op-types/${type}`,
  ...(lon !== undefined ? { lon, lat } : {}),
  points: routable ? [{ ne: "e", offset: 0 }] : [],
  areas: [],
});

const snapshot = (country: string, name: string, ops: OperationalPoint[]): Snapshot => ({
  meta: { endpoint: "e", graph: "g", country, name, imName: `IM ${country}`, fetchedAt: "2026-10-13T00:00:00Z", counts: { ops: ops.length } },
  ops,
  lines: [],
  sols: [
    { id: "s1", label: "Line 1", opStart: "a", opEnd: "b", wkt: "LINESTRING (10 60, 10.0001 60.0001, 10.0002 60, 11 61)" },
    { id: "s2", opStart: "a", opEnd: "b" }, // no geometry
    { id: "s3", opStart: "a", opEnd: "b", wkt: "LINESTRING (x y)" },
  ],
  topology: {
    netElements: [{ id: "e", length: 1000 }, { id: "f", length: 500 }],
    netRelations: [{ a: "e", b: "f", aAtOrigin: false, bAtOrigin: true, navigable: true }],
  },
  tracks: [],
  features: [],
  tunnels: [],
  geometry: {},
});

describe("network index", () => {
  it("turns OPs and sections of line into compact rows and back", () => {
    expect(opRow("nor", op("NOOSL", "Oslo S", "10", 10.75, 59.91))).toEqual(["nor", "NOOSL", "Oslo S", "10", 10.75, 59.91, 1]);
    expect(opRow("nor", op("NOX", "Nowhere", "20", undefined, undefined, false))).toEqual(["nor", "NOX", "Nowhere", "20", null, null, 0]);
    const row = solRow("nor", { id: "s", label: "L", opStart: "a", opEnd: "b", wkt: "LINESTRING (10 60, 10.0001 60.0001, 10.0002 60, 11 61)" })!;
    expect(row[0]).toBe("nor");
    expect(row[2]).toEqual([[10, 60], [11, 61]]); // the 10 m wiggle is simplified away at 50 m
    expect(solRow("nor", { id: "s", opStart: "a", opEnd: "b" })).toBeUndefined();
    const parsed = parseOpsIndex({ version: 1, datasets: { nor: { name: "Norway", imName: "Bane NOR" } }, ops: [["nor", "NOOSL", "Oslo S", "10", 10.75, 59.91, 1], ["nor", "NOX", "Nowhere", "", null, null, 0], "junk", ["x"]] });
    expect(parsed.datasets).toEqual({ nor: { name: "Norway", imName: "Bane NOR" } });
    expect(parsed.ops).toEqual([
      { dataset: "nor", uopid: "NOOSL", name: "Oslo S", type: "10", lon: 10.75, lat: 59.91, routable: true },
      { dataset: "nor", uopid: "NOX", name: "Nowhere", type: "", routable: false },
    ]);
    expect(opKey(parsed.ops[0]!)).toBe("nor/NOOSL");
    expect(parseSolsIndex({ sols: [["nor", "L", [[10, 60], [11, 61]]], ["nor", "short", [[1, 1]]], 3] })).toEqual([["nor", "L", [[10, 60], [11, 61]]]]);
    expect(parseOpsIndex(null).ops).toEqual([]);
  });

  it("indexes a dataset and merges datasets", () => {
    const a = datasetIndex("nor", snapshot("NOR", "Norway", [op("NOOSL", "Oslo S", "10", 10.75, 59.91), op("EU1", "Border", "90", 12, 60)]));
    const b = datasetIndex("swe", snapshot("SWE", "Sweden", [op("EU1", "Border", "90", 12, 60)]));
    expect(a.dataset).toEqual({ id: "nor", name: "Norway", imName: "IM NOR" });
    expect(a.sols).toHaveLength(1);
    const merged = mergeIndexes([a, b]);
    expect(Object.keys(merged.ops.datasets)).toEqual(["nor", "swe"]);
    expect(merged.ops.ops.map((r) => `${r[0]}/${r[1]}`)).toEqual(["nor/NOOSL", "nor/EU1", "swe/EU1"]);
    expect(merged.sols.sols).toHaveLength(2);
  });

  it("is written with every bundle and merged into index/ when the catalogue is written", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbindex-"));
    await saveWebBundle(join(root, "nor"), snapshot("NOR", "Norway", [op("NOOSL", "Oslo S", "10", 10.75, 59.91)]), {}, { compress: false });
    // a bundle written before the index existed: derived from its ops.json and sols.json
    await saveWebBundle(join(root, "swe"), snapshot("SWE", "Sweden", [op("SEST", "Stockholm C", "10", 18.06, 59.33)]), {}, { compress: false });
    const { rm } = await import("node:fs/promises");
    await rm(join(root, "swe", "index.json"));
    expect(JSON.parse(await readFile(join(root, "nor", "index.json"), "utf8")).ops).toEqual([["nor", "NOOSL", "Oslo S", "10", 10.75, 59.91, 1]]);
    expect((await readDatasetIndex(root, "swe"))?.ops).toEqual([["swe", "SEST", "Stockholm C", "10", 18.06, 59.33, 1]]);
    expect(await readDatasetIndex(root, "none")).toBeUndefined();

    const entries = await writeDatasetIndex(root);
    expect(entries.map((e) => e.id)).toEqual(["nor", "swe"]);
    const files = (await readdir(join(root, "index"))).sort();
    expect(files).toEqual(["borders.json", "borders.json.br", "borders.json.gz", "ops.json", "ops.json.br", "ops.json.gz", "sols.json", "sols.json.br", "sols.json.gz"]);
    const ops = parseOpsIndex(JSON.parse(await readFile(join(root, "index", "ops.json"), "utf8")));
    expect(ops.datasets).toEqual({ nor: { name: "Norway", imName: "IM NOR" }, swe: { name: "Sweden", imName: "IM SWE" } });
    expect(ops.ops.map((o) => o.uopid)).toEqual(["NOOSL", "SEST"]);
    expect(parseSolsIndex(JSON.parse(await readFile(join(root, "index", "sols.json"), "utf8")))).toHaveLength(2);
    // the index folder is not a dataset
    expect((await writeDatasetIndex(root, { networkIndex: false })).map((e) => e.id)).toEqual(["nor", "swe"]);

    // a dataset without data (failed, never fetched) is not in the index
    await mkdir(join(root, "fra"));
    await writeFile(join(root, "fra", "meta.json"), "not json");
    const result = await writeNetworkIndex(root, [...entries, { id: "fra", name: "France", ops: 0, status: "failed", error: "x" }]);
    expect(result).toMatchObject({ datasets: 2, ops: 2, sols: 2 });
    expect(result.borders.links).toEqual([]);
  });

  it("finds the border candidates of a dataset with the element end that faces out", () => {
    const topology = { netElements: [{ id: "e", length: 1000 }, { id: "f", length: 500 }], netRelations: [{ a: "e", b: "f", aAtOrigin: false, bAtOrigin: true, navigable: true }] };
    const rows = borderCandidates(
      [
        op("NOOSL", "Oslo S", "10", 10.75, 59.91), // home country, a station: not a candidate
        { ...op("EU00237", "Bjørnfjell / Vassijaure", "90", 18.1, 68.4), points: [{ ne: "e", offset: 5 }] }, // origin of e is the dead end
        { ...op("SEKIR", "Foreign coded", "10", 20, 67), points: [{ ne: "f", offset: 400 }] }, // f: origin joined, end free
        { ...op("NOXX", "Domestic border", "140"), points: [] }, // no position
        { ...op("EU00237", "Bjørnfjell again", "90", 18.1, 68.4), points: [] }, // second row of a uopid is dropped
      ],
      topology,
    );
    expect(rows).toEqual([
      ["EU00237", "Bjørnfjell / Vassijaure", "90", 18.1, 68.4, "e", 0],
      ["SEKIR", "Foreign coded", "10", 20, 67, "f", 1],
      ["NOXX", "Domestic border", "140", null, null, null, null],
    ]);
    expect(datasetIndex("nor", snapshot("NOR", "Norway", [op("NOOSL", "Oslo S")])).borders).toEqual([]);
  });

  it("links border points by uopid, then by distance, and lists the rest", () => {
    const nor = { dataset: { id: "nor", name: "Norway" }, borders: [
      ["EU00237", "Bjørnfjell", "90", 18.1, 68.4, "n1", 1],
      ["NOKSJ", "Kornsjø", "90", 11.67, 58.93, "n2", 1],
      ["NOMAG", "Magnor", "90", 12.24, 59.93, "n3", 0],
      ["NOLONE", "Lonely", "90", 5, 60, "n4", 0],
    ] as const };
    const swe = { dataset: { id: "swe", name: "Sweden" }, borders: [
      ["EU00237", "Vassijaure", "90", 18.11, 68.41, "s1", 0],
      ["SEMON", "Mon", "90", 11.671, 58.931, "s2", 0], // 130 m from Kornsjø
      ["SECHA", "Charlottenberg", "90", 12.3, 59.93, "s3", 1], // 3 km from Magnor: too far
      ["SENOPOS", "Unplaced", "90", 12.24, 59.93, null, null], // no position: cannot be linked
    ] as const };
    const b = matchBorders([nor as never, swe as never]);
    expect(b.links.map((l) => `${l.a.uopid}-${l.b.uopid}:${l.method}`)).toEqual(["EU00237-EU00237:uopid", "NOKSJ-SEMON:distance"]);
    expect(b.links[1]!.distance).toBeGreaterThan(100);
    expect(b.links[1]!.distance).toBeLessThan(200);
    expect(b.unmatched.map((u) => `${u.dataset}/${u.uopid}:${u.reason}`)).toEqual(["nor/NOMAG:no partner", "nor/NOLONE:no partner", "swe/SECHA:no partner", "swe/SENOPOS:no position"]);
    expect(b.datasets).toEqual({ nor: { links: 2, with: { swe: 2 }, unmatched: 2 }, swe: { links: 2, with: { nor: 2 }, unmatched: 2 } });
    expect(matchBorders([nor as never, swe as never], 5000).links).toHaveLength(3);
    // round trip through JSON, tolerant of junk
    const parsed = parseBordersIndex(JSON.parse(JSON.stringify({ ...b, links: [...b.links, { a: {} }, "x"] })));
    expect(parsed.links).toEqual(b.links);
    expect(parsed.datasets).toEqual(b.datasets);
    expect(parseBordersIndex(null)).toEqual({ version: 1, threshold: 300, links: [], unmatched: [], datasets: {} });
    expect(borderRelations(b.links, new Set(["nor", "swe"]))).toEqual([
      { a: "n1", b: "s1", aAtOrigin: false, bAtOrigin: true, navigable: true },
      { a: "n2", b: "s2", aAtOrigin: false, bAtOrigin: true, navigable: true },
    ]);
    expect(borderRelations(b.links, new Set(["nor"]))).toEqual([]);
  });

  it("finds the datasets a route runs through", () => {
    const end = (dataset: string, uopid: string, lon: number, lat: number, ne = uopid) => ({ dataset, uopid, name: uopid, ne, side: 0 as const, lon, lat });
    const links = [
      { a: end("nor", "EU1", 18.1, 68.4), b: end("swe", "EU1", 18.1, 68.4), method: "uopid" as const, distance: 0 },
      { a: end("nor", "EU2", 11.7, 58.9), b: end("swe", "EU2", 11.7, 58.9), method: "uopid" as const, distance: 0 },
      { a: end("swe", "EU3", 12.9, 55.6), b: end("dnk", "EU3", 12.9, 55.6), method: "uopid" as const, distance: 0 },
      { a: end("dnk", "EU4", 9.4, 54.8), b: end("deu", "EU4", 9.4, 54.8), method: "uopid" as const, distance: 0 },
      { a: end("fra", "EU5", 2, 49), b: end("bel", "EU5", 2, 49), method: "uopid" as const, distance: 0 },
    ];
    expect(transitDatasets(links, { dataset: "nor", lon: 10.75, lat: 59.9 }, { dataset: "nor", lon: 5.3, lat: 60.4 })).toEqual(["nor"]);
    expect(transitDatasets(links, { dataset: "nor", lon: 10.75, lat: 59.9 }, { dataset: "deu", lon: 10, lat: 53.5 })).toEqual(["nor", "swe", "dnk", "deu"]);
    expect(transitDatasets(links, { dataset: "deu", lon: 10, lat: 53.5 }, { dataset: "swe", lon: 18, lat: 59.3 })).toEqual(["deu", "dnk", "swe"]);
    expect(transitDatasets(links, { dataset: "nor", lon: 10.75, lat: 59.9 }, { dataset: "bel", lon: 4.3, lat: 50.8 })).toBeUndefined();
    expect(transitDatasets([], { dataset: "nor" }, { dataset: "swe" })).toBeUndefined();
  });
});
