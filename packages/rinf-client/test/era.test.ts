import { describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { datasetsApiFor, fingerprint, graphProvenance, latestPublication, parsePublished, readCatalogue, writeDatasetIndex } from "@routebook/rinf-client";

const G = "http://data.europa.eu/949/graph/";

/** What the ERA dataset explorer answers for `/dataset/published?latest=true&groupBy=im`. */
const explorer = [
  { id: "d-76", fileName: "banenor_2026-10.xml", datePublished: Date.UTC(2026, 9, 6, 8), type: "RINF", status: "PUBLISHED", account: { code: "0076", name: "Bane NOR ", country: { code: "NO" } } },
  { id: "d-88", fileName: "infrabel.xml", dateCreated: "2026-09-30T10:00:00Z", account: { code: "0088", name: "Infrabel" } },
  { id: "junk", account: {} },
];

/** A fetch that serves the explorer and RDF4J /size, or fails for what `down` names. */
function fakeFetch(down: Array<"explorer" | "size"> = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url.includes("/dataset/published")) return down.includes("explorer") ? new Response("nope", { status: 503 }) : Response.json(explorer);
    if (url.includes("/size?context=")) {
      if (down.includes("size")) return new Response("", { status: 500 });
      return new Response(url.includes("0076") ? "1234567\n" : "42");
    }
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("ERA publications", () => {
  it("knows the dataset explorer of the PROD and UAT endpoints", () => {
    expect(datasetsApiFor("https://graph.data.era.europa.eu/repositories/rinf-plus")).toBe("https://rinf.data.era.europa.eu/api/v1");
    expect(datasetsApiFor("https://graph.uat.data.test-era.europa.eu/repositories/rinf-plus")).toBe("https://rinf.uat.data.test-era.europa.eu/api/v1");
    expect(datasetsApiFor("https://sparql.example.org/rinf")).toBeUndefined();
  });

  it("reads the explorer's entries per IM and skips what it cannot place", () => {
    const list = parsePublished(explorer);
    expect(list.map((p) => p.imCode)).toEqual(["0076", "0088"]);
    expect(list[0]).toEqual({ datasetId: "d-76", imCode: "0076", imName: "Bane NOR", country: "NO", fileName: "banenor_2026-10.xml", publishedAt: "2026-10-06T08:00:00.000Z", type: "RINF", status: "PUBLISHED" });
    expect(list[1]!.publishedAt).toBe("2026-09-30T10:00:00.000Z");
    expect(parsePublished({ content: explorer }).length).toBe(2);
    expect(parsePublished("x")).toEqual([]);
  });

  it("fingerprints a graph as dataset id | publication date | triples, like RINF Atlas", () => {
    expect(fingerprint({ datasetId: "d-76", publishedAt: "2026-10-06T08:00:00.000Z" }, 1234567)).toBe("d-76|2026-10-06T08:00:00.000Z|1234567");
    expect(fingerprint(undefined, undefined)).toBe("||");
  });

  it("collects the provenance of every graph of a dataset", async () => {
    const out = await graphProvenance("https://graph.data.era.europa.eu/repositories/rinf-plus", [`${G}0076`, `${G}0099`], { fetchImpl: fakeFetch() });
    expect(out).toEqual([
      { graph: `${G}0076`, imCode: "0076", imName: "Bane NOR", country: "NO", datasetId: "d-76", fileName: "banenor_2026-10.xml", publishedAt: "2026-10-06T08:00:00.000Z", triples: 1234567, fingerprint: "d-76|2026-10-06T08:00:00.000Z|1234567" },
      { graph: `${G}0099`, imCode: "0099", triples: 42, fingerprint: "||42" },
    ]);
    expect(latestPublication(out)).toBe("2026-10-06T08:00:00.000Z");
  });

  it("goes on without the explorer or the sizes, and says so", async () => {
    const warnings: string[] = [];
    const out = await graphProvenance("https://graph.data.era.europa.eu/repositories/rinf-plus", [`${G}0076`], { fetchImpl: fakeFetch(["explorer", "size"]), onWarning: (m) => warnings.push(m) });
    expect(out).toEqual([{ graph: `${G}0076`, imCode: "0076" }]);
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toMatch(/dataset explorer/);
    // an endpoint without a known explorer asks only for sizes
    const other = await graphProvenance("https://sparql.example.org/rinf", [`${G}0076`], { fetchImpl: fakeFetch() });
    expect(other[0]!.fingerprint).toBe("||1234567");
  });
});

describe("dataset catalogue", () => {
  const meta = (country: string, name: string, extra: Record<string, unknown> = {}) => ({ endpoint: "https://graph.data.era.europa.eu/repositories/rinf-plus", graph: `${G}0076`, country, name, fetchedAt: "2026-10-13T12:00:00.000Z", counts: { ops: 7 }, ...extra });

  it("lists the bundles with what ERA published, records failures and keeps them until the next successful fetch", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbcat-"));
    await mkdir(join(root, "nor"));
    await writeFile(join(root, "nor", "meta.json"), JSON.stringify(meta("NOR", "Norway", { imName: "Bane NOR", checkedAt: "2026-10-13T12:00:01.000Z", provenance: [{ graph: `${G}0076`, imCode: "0076", datasetId: "d-76", publishedAt: "2026-10-06T08:00:00.000Z", triples: 5 }] })));
    await mkdir(join(root, "not-a-bundle"));

    let list = await writeDatasetIndex(root, { checkedAt: "2026-10-14T00:00:00.000Z", failures: [{ id: "DEU", name: "Germany", error: "timeout", graphs: [`${G}0080`] }] });
    expect(list.map((d) => `${d.id}:${d.status}`)).toEqual(["deu:failed", "nor:loaded"]);
    expect(list[1]).toMatchObject({ name: "Norway", imName: "Bane NOR", ops: 7, publishedAt: "2026-10-06T08:00:00.000Z", checkedAt: "2026-10-13T12:00:01.000Z", endpoint: "https://graph.data.era.europa.eu/repositories/rinf-plus" });
    expect(list[1]!.graphs![0]!.datasetId).toBe("d-76");
    expect(list[0]).toMatchObject({ name: "Germany", error: "timeout", checkedAt: "2026-10-14T00:00:00.000Z", graphs: [{ graph: `${G}0080`, imCode: "0080" }] });
    const file = JSON.parse(await readFile(join(root, "datasets.json"), "utf8"));
    expect(file.version).toBe(2);
    expect(file.checkedAt).toBe("2026-10-14T00:00:00.000Z");
    expect(file.endpoint).toBe("https://graph.data.era.europa.eu/repositories/rinf-plus");

    // the next run without news keeps the failure; a failed refetch of Norway keeps its bundle on offer
    list = await writeDatasetIndex(root, { failures: [{ id: "nor", error: "endpoint down" }] });
    expect(list.map((d) => `${d.id}:${d.status}`)).toEqual(["deu:failed", "nor:failed"]);
    expect(list[1]).toMatchObject({ fetchedAt: "2026-10-13T12:00:00.000Z", error: "endpoint down", ops: 7 });
    list = await writeDatasetIndex(root);
    expect(list[1]).toMatchObject({ status: "failed", error: "endpoint down" });

    // a new bundle clears the failure; a dataset gone from ERA is marked, not dropped
    await writeFile(join(root, "nor", "meta.json"), JSON.stringify(meta("NOR", "Norway", { fetchedAt: "2026-10-15T00:00:00.000Z" })));
    list = await writeDatasetIndex(root, { removed: ["deu"] });
    expect(list.map((d) => `${d.id}:${d.status}`)).toEqual(["deu:removed", "nor:loaded"]);
    expect(list[1]!.error).toBeUndefined();
    expect((await readCatalogue(root)).datasets).toHaveLength(2);
  });

  it("reads an old bare-list datasets.json", async () => {
    const root = await mkdtemp(join(tmpdir(), "rbcat-"));
    await writeFile(join(root, "datasets.json"), JSON.stringify([{ id: "bel", name: "Belgium", ops: 3 }]));
    expect((await readCatalogue(root)).datasets).toEqual([{ id: "bel", name: "Belgium", ops: 3, status: "loaded" }]);
  });
});
