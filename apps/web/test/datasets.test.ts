import { describe, expect, it } from "vitest";
import { atlasLink, datasetsSummary, examplesFor, loadCatalogue, loadDatasets, loadable, parseCatalogue, pickDataset, provenanceText, readiness, rinfAttribution } from "../src/datasets.js";

const list = [
  { id: "bel", name: "Belgium" },
  { id: "nor", name: "Norway", imName: "Bane NOR" },
];

describe("datasets", () => {
  it("picks the requested dataset, then the configured default, then the first", () => {
    expect(pickDataset(list, "NOR")).toBe("nor");
    expect(pickDataset(list, "xxx", "nor")).toBe("nor");
    expect(pickDataset(list, null)).toBe("bel");
    // no datasets.json (static hosting of a single bundle): trust the URL, default nor
    expect(pickDataset([], "swe")).toBe("swe");
    expect(pickDataset([], null)).toBe("nor");
  });

  it("credits ERA and the infrastructure manager", () => {
    expect(rinfAttribution({ country: "NOR", imName: "Bane NOR" }, { html: false })).toBe("RINF data © European Union Agency for Railways, provided by Bane NOR");
    expect(rinfAttribution({ country: "BEL" })).toMatch(/^RINF data © <a href="https:\/\/graph\.data\.era\.europa\.eu\/">/);
  });

  it("has examples for Norway and lets the configuration replace them", () => {
    expect(examplesFor("nor").map((e) => e.from)).toContain("NOOSL");
    expect(examplesFor("bel")).toEqual([]);
    expect(examplesFor("bel", { bel: [{ from: "BEBRU", to: "BEANT" }] })).toEqual([{ from: "BEBRU", to: "BEANT" }]);
  });

  it("reads datasets.json and tolerates its absence", async () => {
    const res = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await loadDatasets("datasets.json", res(JSON.stringify([{ id: "nor", name: "" }, { nope: 1 }])))).toEqual([{ id: "nor", name: "nor" }]);
    expect(await loadDatasets("datasets.json", res("", 404))).toEqual([]);
  });

  it("reads the catalogue with its check time and tolerates the old list", async () => {
    const res = (body: string) => (async () => new Response(body)) as unknown as typeof fetch;
    const cat = await loadCatalogue("datasets.json", res(JSON.stringify({ version: 2, checkedAt: "2026-10-17T06:00:00Z", endpoint: "https://e.test", datasets: [{ id: "nor", name: "Norway", status: "failed", error: "x" }] })));
    expect(cat).toEqual({ checkedAt: "2026-10-17T06:00:00Z", endpoint: "https://e.test", datasets: [{ id: "nor", name: "Norway", status: "failed", error: "x" }] });
    expect(parseCatalogue([{ id: "bel" }])).toEqual({ datasets: [{ id: "bel", name: "bel" }] });
    expect(parseCatalogue(null)).toEqual({ datasets: [] });
  });

  it("offers only datasets that have data, and counts the problems", () => {
    const all = [
      { id: "nor", name: "Norway", fetchedAt: "t", status: "loaded" as const },
      { id: "deu", name: "Germany", status: "failed" as const, error: "timeout" },
      { id: "bel", name: "Belgium", fetchedAt: "t", status: "failed" as const, error: "later failure" },
      { id: "xxx", name: "Gone", fetchedAt: "t", status: "removed" as const },
      { id: "swe", name: "Sweden", fetchedAt: "t", status: "stale" as const },
      { id: "fra", name: "France", status: "pending" as const },
    ];
    expect(loadable(all).map((d) => d.id)).toEqual(["nor", "bel", "xxx", "swe"]);
    expect(datasetsSummary(all)).toEqual({ label: "3/5 datasets", problems: 2, updating: 2 });
    expect(datasetsSummary([all[0]!])).toEqual({ label: "1 dataset", problems: 0, updating: 0 });
    expect(datasetsSummary([all[5]!])).toEqual({ label: "1 dataset, fetching", problems: 0, updating: 1 });
    expect(datasetsSummary([])).toEqual({ label: "", problems: 0, updating: 0 });
  });

  it("says where the data comes from, for the footer and the print", () => {
    const text = provenanceText({
      name: "Norway",
      graphs: [{ graph: "http://data.europa.eu/949/graph/0076", imCode: "0076", imName: "Bane NOR", datasetId: "d-76", publishedAt: "2026-10-06T08:00:00Z" }],
      publishedAt: "2026-10-06T08:00:00Z",
      fetchedAt: "2026-10-13T12:00:00Z",
    });
    expect(text).toMatch(/^Norway: RINF dataset d-76, published by ERA on .*2026, fetched .*2026$/);
    expect(provenanceText({ name: "Belgium", status: "failed" })).toBe("Belgium: RINF dataset, ERA publication date unknown, not fetched yet, the last update failed");
    expect(provenanceText({ name: "Sweden", status: "stale", fetchedAt: "2026-10-13T12:00:00Z", publishedAt: "2026-10-01T00:00:00Z", latest: [{ graph: "g", imCode: "0074", publishedAt: "2026-10-15T00:00:00Z" }] })).toMatch(/newer data published by ERA on .*2026, update on its way$/);
  });

  it("links a dataset's graphs to RINF Atlas", () => {
    const graphs = [{ graph: "http://data.europa.eu/949/graph/0076" }, { graph: "http://data.europa.eu/949/graph/0084" }];
    expect(atlasLink(undefined, graphs)).toBe("https://rinf-atlas.matdata.eu/?ds=era:graph/0076,era:graph/0084");
    expect(atlasLink("https://atlas.example.org/", graphs.slice(0, 1))).toBe("https://atlas.example.org/?ds=era:graph/0076");
    expect(atlasLink(false, graphs)).toBeUndefined();
    expect(atlasLink(undefined, [])).toBeUndefined();
  });
});

describe("readiness", () => {
  const norway = { fetchedAt: "2026-10-17T00:00:00.000Z", counts: { ops: 734, netElements: 7759, netRelations: 12884, routableOps: 734, signals: 5291, trackKm: 5322 } };

  it("is ready with OPs on the tracks and about as many signals as Norway", () => {
    expect(readiness(norway).level).toBe("ready");
    expect(readiness(norway).detail).toContain("5,291 signals on 5,322 km");
  });

  it("warns when no route is possible, and says why", () => {
    expect(readiness({ ...norway, counts: { ...norway.counts, netElements: 0 } })).toMatchObject({ level: "unusable", label: "No track network" });
    expect(readiness({ ...norway, counts: { ...norway.counts, netRelations: 0 } })).toMatchObject({ level: "unusable", label: "Tracks not connected" });
    expect(readiness({ ...norway, counts: { ...norway.counts, routableOps: 0 } })).toMatchObject({ level: "unusable", label: "OPs not on the track network" });
    // data fetched before the catalogue counted them: the network index tells
    const { routableOps: _r, ...older } = norway.counts;
    expect(readiness({ ...norway, counts: older }, 0).level).toBe("unusable");
  });

  it("is not green with few signals, or before they are counted", () => {
    expect(readiness({ ...norway, counts: { ...norway.counts, signals: 400 } })).toMatchObject({ level: "limited", label: "Few signals" });
    expect(readiness({ ...norway, counts: { ...norway.counts, signals: 0 } })).toMatchObject({ level: "limited", label: "No signals" });
    const { signals: _s, ...older } = norway.counts;
    expect(readiness({ ...norway, counts: older }, 734).level).toBe("unknown");
    expect(readiness({ status: "pending" }).level).toBe("unknown");
  });
});
