import { describe, expect, it } from "vitest";
import { SparqlClient, allDatasets, countryGraph, countryName, discoverGraphs, graphIri, resolveDataset, writeDatasetIndex } from "@routebook/rinf-client";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const G = "http://data.europa.eu/949/graph/";
const C = "http://publications.europa.eu/resource/authority/country/";

/** A client whose endpoint answers the discovery query with these rows. */
function fakeClient(rows: Array<{ g: string; country?: string; ops: number }>): SparqlClient {
  const fetchImpl = (async () =>
    new Response(
      JSON.stringify({
        head: { vars: ["g", "country", "ops"] },
        results: {
          bindings: rows.map((r) => ({
            g: { type: "uri", value: r.g },
            ...(r.country ? { country: { type: "uri", value: C + r.country } } : {}),
            ops: { type: "literal", value: String(r.ops) },
          })),
        },
      }),
    )) as unknown as typeof fetch;
  return new SparqlClient({ graph: "", endpoint: "https://sparql.test", fetchImpl });
}

describe("SparqlClient.render", () => {
  const q = "# {{graph}} comment\nSELECT ?s WHERE { GRAPH {{graph}} { ?s a ?c } }";
  it("puts the graph IRI in for one graph", () => {
    expect(new SparqlClient({ graph: `${G}0076` }).render(q)).toContain(`GRAPH <${G}0076> {`);
  });
  it("binds a graph variable to every graph of a multi-graph dataset", () => {
    const out = new SparqlClient({ graph: `${G}0001`, graphs: [`${G}0001`, `${G}0002`] }).render(q);
    expect(out).toContain(`VALUES ?rinfGraph { <${G}0001> <${G}0002> } GRAPH ?rinfGraph { ?s a ?c }`);
    expect(out).not.toContain("{{graph}}");
  });
});

describe("datasets", () => {
  it("knows Norway and turns IM codes into graph IRIs", () => {
    expect(countryGraph("nor").graph).toBe(`${G}0076`);
    expect(graphIri("0084")).toBe(`${G}0084`);
    expect(graphIri("graph/0084")).toBe(`${G}0084`);
    expect(graphIri("https://x.test/g")).toBe("https://x.test/g");
    expect(() => countryGraph("BEL")).toThrow(/resolveDataset/);
  });

  it("lists graphs with their countries, the main country first", async () => {
    const client = fakeClient([
      { g: `${G}0076`, country: "NOR", ops: 730 },
      { g: `${G}0076`, country: "SWE", ops: 4 },
      { g: `${G}0074`, country: "SWE", ops: 900 },
    ]);
    expect(await discoverGraphs(client)).toEqual([
      { graph: `${G}0074`, ops: 900, countries: ["SWE"] },
      { graph: `${G}0076`, ops: 734, countries: ["NOR", "SWE"] },
    ]);
  });

  it("resolves a country to the graphs that are mainly in it, not to its neighbours' border points", async () => {
    const client = fakeClient([
      { g: `${G}0076`, country: "NOR", ops: 730 },
      { g: `${G}0076`, country: "SWE", ops: 4 },
      { g: `${G}0074`, country: "SWE", ops: 900 },
      { g: `${G}0099`, country: "SWE", ops: 20 },
    ]);
    const swe = await resolveDataset("swe", client);
    expect(swe).toMatchObject({ code: "SWE", name: "Sweden", country: "SWE", graphs: [`${G}0074`, `${G}0099`] });
    await expect(resolveDataset("BEL", client)).rejects.toThrow(/No RINF graph/);
    await expect(resolveDataset("nope!", client)).rejects.toThrow(/not a country code/);
  });

  it("takes known datasets, IM codes and explicit graphs without asking the endpoint", async () => {
    const offline = new SparqlClient({ graph: "", fetchImpl: (async () => { throw new Error("offline"); }) as unknown as typeof fetch });
    expect(await resolveDataset("NOR", offline)).toMatchObject({ code: "NOR", imName: "Bane NOR" });
    expect(await resolveDataset("0088", offline, { imName: "Infrabel" })).toMatchObject({ code: "0088", graph: `${G}0088`, imName: "Infrabel" });
    expect(await resolveDataset("benelux", offline, { graphs: ["0088", "0084"], name: "Benelux" })).toMatchObject({
      code: "BENELUX",
      name: "Benelux",
      graphs: [`${G}0088`, `${G}0084`],
    });
  });

  it("names countries and groups every graph on the endpoint into one dataset per country", () => {
    expect(countryName("deu")).toBe("Germany");
    expect(countryName("XYZ")).toBe("XYZ");
    const all = allDatasets([
      { graph: `${G}0074`, ops: 900, countries: ["SWE"] },
      { graph: `${G}0076`, ops: 734, countries: ["NOR", "SWE"] },
      { graph: `${G}0099`, ops: 20, countries: ["SWE"] },
      { graph: `${G}0042`, ops: 3, countries: [] },
    ]);
    expect(all.map((d) => [d.code, d.name, d.graphs ?? [d.graph]])).toEqual([
      ["0042", "RINF graph 0042", [`${G}0042`]],
      ["NOR", "Norway", [`${G}0076`]],
      ["SWE", "Sweden", [`${G}0074`, `${G}0099`]],
    ]);
    // the checked dataset keeps its infrastructure manager while its graphs are unchanged
    expect(all.find((d) => d.code === "NOR")?.imName).toBe("Bane NOR");
    const more = allDatasets([{ graph: `${G}0076`, ops: 5, countries: ["NOR"] }, { graph: `${G}0077`, ops: 5, countries: ["NOR"] }]);
    expect(more[0]).toMatchObject({ code: "NOR", name: "Norway", graphs: [`${G}0076`, `${G}0077`] });
    expect(more[0]?.imName).toBeUndefined();
  });

  it("indexes the web bundles for the dataset picker", async () => {
    const root = await mkdtemp(join(tmpdir(), "rb-"));
    for (const [id, meta] of [
      ["nor", { country: "NOR", name: "Norway", imName: "Bane NOR", fetchedAt: "2026-10-13T00:00:00Z", counts: { ops: 734 } }],
      ["0088", { country: "0088", fetchedAt: "2026-10-14T00:00:00Z", counts: { ops: 5 } }],
    ] as const) {
      await mkdir(join(root, id));
      await writeFile(join(root, id, "meta.json"), JSON.stringify(meta));
    }
    await mkdir(join(root, "junk"));
    const list = await writeDatasetIndex(root);
    expect(list.map((d) => [d.id, d.name])).toEqual([["0088", "0088"], ["nor", "Norway"]]);
    const file = JSON.parse(await readFile(join(root, "datasets.json"), "utf8"));
    expect(file.version).toBe(2);
    expect(file.datasets[1]).toEqual({ id: "nor", name: "Norway", imName: "Bane NOR", fetchedAt: "2026-10-13T00:00:00Z", ops: 734, status: "loaded", counts: { ops: 734 } });
  });
});
