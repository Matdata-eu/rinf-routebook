import { describe, expect, it } from "vitest";
import type { Snapshot } from "@routebook/rinf-client";
import { codeOf, findByCode, loadNetwork, networkFromBundle, opsBounds, opsGeoJson, pickFilter, solsGeoJson, visibleOps } from "../src/network.js";
import { buildSearchIndex, searchOps } from "../src/search.js";

const index = {
  version: 1,
  datasets: { nor: { name: "Norway", imName: "Bane NOR" }, swe: { name: "Sweden" } },
  ops: [
    ["nor", "NOOSL", "Oslo S", "10", 10.75, 59.91, 1],
    ["nor", "EU1", "Riksgränsen", "90", 18.1, 68.4, 0],
    ["swe", "EU1", "Riksgränsen", "90", 18.11, 68.41, 1],
    ["swe", "SEST", "Stockholm C", "10", 18.06, 59.33, 1],
  ],
};
const sols = { version: 1, sols: [["nor", "Ofotbanen", [[17, 68], [18.1, 68.4]]], ["swe", "Malmbanan", [[18.11, 68.41], [20, 67]]]] };

function fakeFetch(ok = true): typeof fetch {
  return (async (url: string) => {
    if (!ok) return new Response("", { status: 404 });
    if (url.endsWith("index/ops.json")) return Response.json(index);
    if (url.endsWith("index/sols.json")) return Response.json(sols);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
}

describe("network index in the browser", () => {
  it("loads the index, or reports that there is none", async () => {
    const net = (await loadNetwork("/", fakeFetch()))!;
    expect(net.ops).toHaveLength(4);
    expect(net.sols).toHaveLength(2);
    expect(net.byKey.get("swe/EU1")?.routable).toBe(true);
    expect(net.datasets.nor?.imName).toBe("Bane NOR");
    expect(await loadNetwork("/", fakeFetch(false))).toBeUndefined();
  });

  it("filters by dataset and searches across all of them", async () => {
    const net = (await loadNetwork("/", fakeFetch()))!;
    expect(visibleOps(net, "swe").map((o) => o.uopid)).toEqual(["EU1", "SEST"]);
    expect(visibleOps(net, undefined)).toHaveLength(4);
    const all = buildSearchIndex(visibleOps(net, undefined));
    expect(searchOps(all, "riksgr").map((o) => `${o.dataset}/${o.uopid}`)).toEqual(["swe/EU1", "nor/EU1"]); // the routable one first
    expect(searchOps(buildSearchIndex(visibleOps(net, "nor")), "stockholm")).toEqual([]);
  });

  it("picks the filter from the URL, then the configuration, else all", () => {
    const list = [{ id: "nor" }, { id: "swe" }];
    expect(pickFilter(list, "SWE")).toBe("swe");
    expect(pickFilter(list, null, "nor")).toBe("nor");
    expect(pickFilter(list, "all", "nor")).toBeUndefined();
    expect(pickFilter(list, "xxx", "nor")).toBe("nor");
    expect(pickFilter(list, null)).toBeUndefined();
  });

  it("resolves URL codes, with the dataset when a code is in two datasets", async () => {
    const net = (await loadNetwork("/", fakeFetch()))!;
    expect(findByCode(net, "noosl")?.dataset).toBe("nor");
    expect(findByCode(net, "EU1")?.dataset).toBe("swe"); // routable wins
    expect(findByCode(net, "EU1", "nor")?.dataset).toBe("nor");
    expect(findByCode(net, "EU1@nor")?.dataset).toBe("nor");
    expect(findByCode(net, "SEST@nor")?.dataset).toBe("swe"); // wrong dataset in the link: still found
    expect(findByCode(net, "nope")).toBeUndefined();
    expect(codeOf(net, net.byKey.get("nor/EU1")!)).toBe("EU1@nor");
    expect(codeOf(net, net.byKey.get("nor/EU1")!, "nor")).toBe("EU1");
    expect(codeOf(net, net.byKey.get("nor/NOOSL")!)).toBe("NOOSL");
  });

  it("builds the map data and the bounds", async () => {
    const net = (await loadNetwork("/", fakeFetch()))!;
    expect(opsBounds(visibleOps(net, "nor"))).toEqual([[10.75, 59.91], [18.1, 68.4]]);
    expect(opsBounds([])).toBeUndefined();
    const ops = opsGeoJson(net);
    expect(ops.features).toHaveLength(4);
    expect(ops.features[0]!.properties).toEqual({ key: "nor/NOOSL", dataset: "nor", name: "Oslo S", uopid: "NOOSL", station: 1 });
    expect(solsGeoJson(net).features.map((f) => f.properties.dataset)).toEqual(["nor", "swe"]);
  });

  it("stands in for the index with one bundle", () => {
    const snapshot = {
      meta: { endpoint: "e", graph: "g", country: "NOR", name: "Norway", fetchedAt: "t", counts: {} },
      ops: [{ id: "x", uopid: "NOOSL", name: "Oslo S", type: ".../10", lon: 10.75, lat: 59.91, points: [{ ne: "e", offset: 0 }], areas: [] }],
      sols: [],
    } as unknown as Snapshot;
    const net = networkFromBundle("nor", snapshot);
    expect(net.fromBundle).toBe("nor");
    expect(net.datasets).toEqual({ nor: { name: "Norway" } });
    expect(net.ops[0]).toMatchObject({ dataset: "nor", uopid: "NOOSL", routable: true });
  });
});
