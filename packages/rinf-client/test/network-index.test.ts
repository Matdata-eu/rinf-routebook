import { describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datasetIndex, mergeIndexes, opKey, opRow, parseOpsIndex, parseSolsIndex, solRow, readDatasetIndex, saveWebBundle, writeDatasetIndex, writeNetworkIndex, type OperationalPoint, type Snapshot } from "@routebook/rinf-client";

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
  topology: { netElements: [], netRelations: [] },
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
    expect(files).toEqual(["ops.json", "ops.json.br", "ops.json.gz", "sols.json", "sols.json.br", "sols.json.gz"]);
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
    expect(result).toEqual({ datasets: 2, ops: 2, sols: 2 });
  });
});
