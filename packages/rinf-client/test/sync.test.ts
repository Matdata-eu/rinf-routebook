import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { gunzipSync, brotliDecompressSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  compressPart,
  datasetFolder,
  fingerprintsDiffer,
  planSync,
  readCatalogue,
  removeLeftovers,
  runSync,
  saveWebBundle,
  swapDirectory,
  writeDatasetIndex,
  FETCH_VERSION,
  type CountryGraph,
  type GraphProvenance,
  type Snapshot,
} from "@routebook/rinf-client";

const G = "http://data.europa.eu/949/graph/";
const ENDPOINT = "https://sparql.test/repositories/rinf";
const API = "https://explorer.test/api/v1";

const nor: CountryGraph = { code: "NOR", name: "Norway", graph: `${G}0076`, imName: "Bane NOR", country: "NOR" };
const bel: CountryGraph = { code: "BEL", name: "Belgium", graph: `${G}0088`, country: "BEL" };
const fra: CountryGraph = { code: "FRA", name: "France", graph: `${G}0087`, graphs: [`${G}0087`, `${G}0287`], country: "FRA" };

/** ERA as the sync sees it: the explorer's publications and the triple count of each graph. */
function era(publications: Record<string, { id: string; at: string }>, sizes: Record<string, number>, down = false): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (down) return new Response("", { status: 503 });
    if (url.includes("/dataset/published")) {
      return Response.json(Object.entries(publications).map(([code, p]) => ({ id: p.id, datePublished: p.at, account: { code, name: `IM ${code}` } })));
    }
    const m = /size\?context=(.*)$/.exec(url);
    if (m) {
      const graph = decodeURIComponent(m[1]!).replace(/^<|>$/g, "");
      const n = sizes[graph.slice(graph.lastIndexOf("/") + 1)];
      return n === undefined ? new Response("", { status: 500 }) : new Response(String(n));
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

const prov = (code: string, id: string, at: string, triples: number): GraphProvenance => ({ graph: `${G}${code}`, imCode: code, imName: `IM ${code}`, datasetId: id, publishedAt: at, triples, fingerprint: `${id}|${at}|${triples}` });

/** A bundle on disk as a successful fetch leaves it: meta.json with the provenance it saw. */
async function bundle(root: string, dataset: CountryGraph, graphs: GraphProvenance[], fetchedAt = "2026-10-10T00:00:00.000Z", fetchVersion = FETCH_VERSION) {
  const dir = join(root, datasetFolder(dataset.code));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "meta.json"), JSON.stringify({ country: dataset.code, name: dataset.name, imName: dataset.imName, fetchedAt, counts: { ops: 10 }, provenance: graphs, checkedAt: fetchedAt, ...(fetchVersion ? { fetchVersion } : {}) }));
}

describe("fingerprints", () => {
  const a = [prov("0076", "d-1", "2026-10-01T00:00:00.000Z", 100)];
  it("sees a new publication, an added or dropped graph, and nothing else", () => {
    expect(fingerprintsDiffer(a, a)).toBe(false);
    expect(fingerprintsDiffer(a, [prov("0076", "d-2", "2026-10-08T00:00:00.000Z", 100)])).toBe(true);
    expect(fingerprintsDiffer(a, [prov("0076", "d-1", "2026-10-01T00:00:00.000Z", 101)])).toBe(true);
    expect(fingerprintsDiffer(a, [...a, prov("0077", "d-3", "2026-10-01T00:00:00.000Z", 5)])).toBe(true);
    expect(fingerprintsDiffer([...a, prov("0077", "d-3", "2026-10-01T00:00:00.000Z", 5)], a)).toBe(true);
  });
  it("counts what it cannot compare as unchanged, so an unreachable ERA never triggers a refetch", () => {
    expect(fingerprintsDiffer(a, [{ graph: `${G}0076`, imCode: "0076" }])).toBe(false);
    expect(fingerprintsDiffer([{ graph: `${G}0076`, imCode: "0076" }], a)).toBe(false);
    expect(fingerprintsDiffer(undefined, a)).toBe(false);
  });
});

describe("sync plan", () => {
  it("fetches what is new, changed or failed, and leaves the rest alone", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbsync-"));
    await bundle(root, nor, [prov("0076", "d-76", "2026-10-01T00:00:00.000Z", 1000)]);
    await bundle(root, bel, [prov("0088", "d-88", "2026-09-01T00:00:00.000Z", 500)]);
    await writeDatasetIndex(root, { failures: [{ id: "bel", error: "timeout" }] });
    const fetchImpl = era(
      { "0076": { id: "d-76b", at: "2026-10-08T00:00:00.000Z" }, "0088": { id: "d-88", at: "2026-09-01T00:00:00.000Z" }, "0087": { id: "d-87", at: "2026-10-02T00:00:00.000Z" } },
      { "0076": 1100, "0088": 500, "0087": 9000, "0287": 10 },
    );
    const plan = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [nor, bel, fra], all: true, catalogue: await readCatalogue(root) });
    expect(plan.fetch.map((i) => [i.id, i.reason])).toEqual([["nor", "changed"], ["bel", "failed"], ["fra", "new"]]);
    expect(plan.available.fra?.map((g) => g.fingerprint)).toEqual(["d-87|2026-10-02T00:00:00.000Z|9000", "||10"]);
    expect(plan.removed).toEqual([]);
    expect(plan.warnings).toEqual([]);

    // Belgium fetched fine: only what changed; a dataset gone from the endpoint is reported when the whole endpoint is synced
    await writeDatasetIndex(root, { available: { nor: plan.available.nor! } });
    await bundle(root, bel, [prov("0088", "d-88", "2026-09-01T00:00:00.000Z", 500)], "2026-10-11T00:00:00.000Z");
    await writeDatasetIndex(root);
    const again = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [nor], all: true, catalogue: await readCatalogue(root) });
    expect(again.fetch.map((i) => [i.id, i.reason])).toEqual([["nor", "changed"]]);
    expect(again.current).toEqual([]);
    expect(again.removed).toEqual(["bel"]);
    const forced = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [bel], catalogue: await readCatalogue(root), force: true });
    expect(forced.fetch.map((i) => i.reason)).toEqual(["forced"]);
  });

  it("fetches again what an older version of the queries fetched, once", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbsync-"));
    const graphs = [prov("0076", "d-76", "2026-10-01T00:00:00.000Z", 1000)];
    await bundle(root, nor, graphs, undefined, 0);
    await writeDatasetIndex(root);
    const fetchImpl = era({ "0076": { id: "d-76", at: "2026-10-01T00:00:00.000Z" } }, { "0076": 1000 });
    const plan = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [nor], catalogue: await readCatalogue(root) });
    expect(plan.fetch.map((i) => [i.id, i.reason])).toEqual([["nor", "outdated"]]);
    await bundle(root, nor, graphs, "2026-10-12T00:00:00.000Z");
    await writeDatasetIndex(root);
    const after = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [nor], catalogue: await readCatalogue(root) });
    expect(after.fetch).toEqual([]);
    expect(after.current).toEqual(["nor"]);
  });

  it("only fetches new and failed datasets when ERA cannot be asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbsync-"));
    await bundle(root, nor, [prov("0076", "d-76", "2026-10-01T00:00:00.000Z", 1000)]);
    await writeDatasetIndex(root);
    const warnings: string[] = [];
    const plan = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl: era({}, {}, true), datasets: [nor, bel], catalogue: await readCatalogue(root), onWarning: (w) => warnings.push(w) });
    expect(plan.fetch.map((i) => [i.id, i.reason])).toEqual([["bel", "new"]]);
    expect(plan.current).toEqual(["nor"]);
    expect(warnings.length).toBeGreaterThan(0);
  });
});

describe("sync pass", () => {
  it("records pending, stale, fetched, failed and removed in the catalogue as it goes", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbsync-"));
    await bundle(root, nor, [prov("0076", "d-76", "2026-10-01T00:00:00.000Z", 1000)]);
    await bundle(root, fra, [prov("0087", "d-87", "2026-10-02T00:00:00.000Z", 9000), prov("0287", "d-287", "2026-10-02T00:00:00.000Z", 10)]);
    await writeDatasetIndex(root);
    await mkdir(join(root, "bel.tmp"));
    const fetchImpl = era({ "0076": { id: "d-76b", at: "2026-10-08T00:00:00.000Z" }, "0088": { id: "d-88", at: "2026-09-01T00:00:00.000Z" }, "0087": { id: "d-87", at: "2026-10-02T00:00:00.000Z" }, "0287": { id: "d-287", at: "2026-10-02T00:00:00.000Z" } }, { "0076": 1100, "0088": 500, "0087": 9000, "0287": 10 });
    const seen: string[] = [];
    const log: string[] = [];
    const result = await runSync({
      endpoint: ENDPOINT,
      datasetsApi: API,
      fetchImpl,
      datasets: [nor, bel],
      all: true,
      webRoot: root,
      attempts: 1,
      log: (m) => log.push(m),
      fetchDataset: async (item) => {
        seen.push(item.id);
        // while Norway is being fetched, the catalogue already says what is coming
        const during = await readCatalogue(root);
        if (item.id === "nor") {
          expect(during.datasets.find((d) => d.id === "nor")).toMatchObject({ status: "stale", publishedAt: "2026-10-01T00:00:00.000Z" });
          expect(during.datasets.find((d) => d.id === "nor")?.latest?.[0]?.fingerprint).toBe("d-76b|2026-10-08T00:00:00.000Z|1100");
          expect(during.datasets.find((d) => d.id === "bel")).toMatchObject({ status: "pending", ops: 0, publishedAt: "2026-09-01T00:00:00.000Z" });
          expect(during.datasets.find((d) => d.id === "fra")).toMatchObject({ status: "removed" });
          await bundle(root, nor, item.latest, "2026-10-12T00:00:00.000Z");
          return { ops: 11 };
        }
        throw new Error("endpoint timed out");
      },
    });
    expect(seen).toEqual(["nor", "bel"]);
    expect(result.fetched.map((f) => f.id)).toEqual(["nor"]);
    expect(result.failed).toEqual([{ id: "bel", reason: "new", error: "endpoint timed out" }]);
    expect(result.peakMemoryMb).toBeGreaterThan(0);
    expect(await readdir(root)).not.toContain("bel.tmp");
    const after = await readCatalogue(root);
    expect(after.checkedAt).toBe(result.checkedAt);
    expect(after.endpoint).toBe(ENDPOINT);
    const nordic = after.datasets.find((d) => d.id === "nor")!;
    expect(nordic.status).toBe("loaded");
    expect(nordic.latest).toBeUndefined();
    expect(nordic.publishedAt).toBe("2026-10-08T00:00:00.000Z");
    expect(after.datasets.find((d) => d.id === "bel")).toMatchObject({ status: "failed", error: "endpoint timed out", ops: 0 });
    expect(after.datasets.find((d) => d.id === "fra")?.status).toBe("removed");
    expect(log.some((l) => /2 to fetch/.test(l))).toBe(true);

    // the next pass: Belgium failed, so it is tried again; Norway is current
    const next = await planSync({ endpoint: ENDPOINT, datasetsApi: API, fetchImpl, datasets: [nor, bel], catalogue: after });
    expect(next.fetch.map((i) => [i.id, i.reason])).toEqual([["bel", "failed"]]);
  });

  it("stops between datasets when asked", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbsync-"));
    let stopped = false;
    const result = await runSync({
      endpoint: ENDPOINT,
      datasetsApi: API,
      fetchImpl: era({}, { "0076": 1, "0088": 1 }),
      datasets: [nor, bel],
      webRoot: root,
      stopped: () => stopped,
      fetchDataset: async (item) => {
        stopped = true;
        await bundle(root, item.dataset, item.latest);
        return { ops: 1 };
      },
    });
    expect(result.fetched.map((f) => f.id)).toEqual(["nor"]);
    expect((await readCatalogue(root)).datasets.find((d) => d.id === "bel")?.status).toBe("pending");
  });
});

describe("bundles on disk", () => {
  const snapshot: Snapshot = {
    meta: { endpoint: "e", graph: "g", country: "NOR", fetchedAt: "2026-10-13T00:00:00.000Z", counts: { ops: 0 } },
    ops: [],
    lines: [],
    sols: [],
    topology: { netElements: [], netRelations: [] },
    tracks: [],
    features: [],
    tunnels: [],
    geometry: {},
  };

  it("writes the bundle with precompressed parts and swaps it into place", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbbundle-"));
    const dir = join(root, "nor");
    await mkdir(dir);
    await writeFile(join(dir, "stale.json"), "old");
    await saveWebBundle(dir, snapshot, { switches: [] });
    const files = (await readdir(dir)).sort();
    expect(files).toContain("meta.json");
    expect(files).toContain("meta.json.gz");
    expect(files).toContain("meta.json.br");
    expect(files).toContain("switches.json.br");
    expect(files).not.toContain("stale.json");
    expect(await readdir(root)).toEqual(["nor"]);
    const plain = await readFile(join(dir, "ops.json"), "utf8");
    expect(gunzipSync(await readFile(join(dir, "ops.json.gz"))).toString()).toBe(plain);
    expect(brotliDecompressSync(await readFile(join(dir, "ops.json.br"))).toString()).toBe(plain);
    expect((await stat(join(dir, "ops.json.br"))).mtimeMs).toBeGreaterThanOrEqual((await stat(join(dir, "ops.json"))).mtimeMs);

    await saveWebBundle(dir, snapshot, {}, { compress: false, atomic: false });
    expect(await readdir(dir)).not.toContain("meta.json.gz");
  });

  it("compresses a part both ways", () => {
    const { gz, br } = compressPart(JSON.stringify({ a: "x".repeat(1000) }));
    expect(gz.length).toBeLessThan(200);
    expect(br.length).toBeLessThan(200);
  });

  it("swaps directories and cleans up leftovers", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbswap-"));
    await mkdir(join(root, "a.tmp"));
    await writeFile(join(root, "a.tmp", "f"), "new");
    await swapDirectory(join(root, "a.tmp"), join(root, "a"));
    expect(await readFile(join(root, "a", "f"), "utf8")).toBe("new");
    await mkdir(join(root, "a.tmp"));
    await mkdir(join(root, "b.old"));
    expect((await removeLeftovers(root)).sort()).toEqual(["a.tmp", "b.old"]);
    expect(await readdir(root)).toEqual(["a"]);
  });
});
