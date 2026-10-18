import { describe, expect, it } from "vitest";
import type { Snapshot } from "@routebook/rinf-client";
import type { BorderLink } from "@routebook/rinf-client/network-index";
import { RouteEngine, mergeBundles } from "../src/engine.js";

/** One element of 1000 m from (lon0, 60) eastwards, with a station at its origin and a border point at its end. */
function snapshot(country: string, imName: string, ne: string, lon0: number, station: string, border: string): Snapshot {
  return {
    meta: { endpoint: "e", graph: `g-${country}`, country, name: country, imName, fetchedAt: "t", counts: { ops: 2 }, provenance: [{ graph: `g-${country}`, imCode: country, datasetId: `d-${country}` }] },
    ops: [
      { id: `${country}:${station}`, uopid: station, name: station, type: "http://data.europa.eu/949/concepts/op-types/10", lon: lon0, lat: 60, points: [{ ne, offset: 0 }], areas: [] },
      { id: `${country}:${border}`, uopid: border, name: `Border ${country}`, type: "http://data.europa.eu/949/concepts/op-types/90", lon: lon0 + 0.018, lat: 60, points: [{ ne, offset: 1000 }], areas: [] },
    ],
    lines: [{ id: `L-${country}`, label: `Line ${country}` }],
    sols: [{ id: `S-${country}`, opStart: station, opEnd: border, line: `L-${country}` }],
    topology: { netElements: [{ id: ne, length: 1000 }], netRelations: [] },
    tracks: [{ id: `T-${country}`, kind: "running", elements: [ne], partOf: [`S-${country}`], speed: country === "NOR" ? 130 : 160 }],
    features: [{ id: `sig-${country}`, kind: "signal", ne, offset: 500, label: `S${country}` }],
    tunnels: [],
    geometry: { [ne]: [[lon0, 60], [lon0 + 0.018, 60]] },
  };
}

describe("routing across datasets", () => {
  // Sweden's element is laid out westwards: its border end is its origin
  const nor = snapshot("NOR", "Bane NOR", "ne-nor", 10, "NOOSL", "EU1");
  const swe = { ...snapshot("SWE", "Trafikverket", "ne-swe", 10.018, "SEST", "EU1"), geometry: { "ne-swe": [[10.036, 60], [10.018, 60]] as Array<[number, number]> } };
  swe.ops[0]!.points = [{ ne: "ne-swe", offset: 0 }];
  swe.ops[0]!.lon = 10.036;
  swe.ops[1]!.points = [{ ne: "ne-swe", offset: 1000 }];
  const links: BorderLink[] = [{ a: { dataset: "nor", uopid: "EU1", name: "Border NOR", ne: "ne-nor", side: 1 }, b: { dataset: "swe", uopid: "EU1", name: "Border SWE", ne: "ne-swe", side: 1 }, method: "uopid", distance: 0 }];

  it("merges the bundles and routes over the border link", () => {
    const { bundle, networks } = mergeBundles([{ id: "nor", bundle: { snapshot: nor } }, { id: "swe", bundle: { snapshot: swe }, label: "Sweden" }], links);
    expect(bundle.snapshot.meta).toMatchObject({ country: "nor+swe", name: "NOR + SWE", imName: "Bane NOR, Trafikverket", counts: { ops: 4 } });
    expect(bundle.snapshot.meta.provenance).toHaveLength(2);
    expect(bundle.snapshot.topology.netRelations).toEqual([{ a: "ne-nor", b: "ne-swe", aAtOrigin: false, bAtOrigin: false, navigable: true }]);
    expect(networks.datasetOf("ne-swe")).toBe("swe");
    expect(networks.labelOf("nor")).toBe("Bane NOR");
    expect(networks.labelOf("swe")).toBe("Sweden");

    const engine = new RouteEngine(bundle.snapshot, { networks });
    const result = engine.route(nor.ops[0]!, swe.ops[0]!);
    expect(result.routebook.length).toBe(2000);
    const kinds = result.routebook.items.map((i) => `${i.kind}@${i.distance}${i.dataset ? `:${i.dataset}` : ""}`);
    expect(kinds).toContain("border@1000:swe");
    expect(kinds).toContain("signal@500:nor");
    expect(kinds).toContain("signal@1500:swe");
    expect(kinds).toContain("destination@2000:swe");
    expect(result.routebook.items.filter((i) => i.kind === "op")).toHaveLength(1); // the border point once, not twice
    expect(result.routebook.items.filter((i) => i.kind === "speed").map((i) => i.data?.speed)).toEqual([130, 160]);
    expect(result.geometry.coordinates).toEqual([[10, 60], [10.018, 60], [10.036, 60]]);
  });

  it("cannot route across without the border link", () => {
    const { bundle, networks } = mergeBundles([{ id: "nor", bundle: { snapshot: nor } }, { id: "swe", bundle: { snapshot: swe } }], []);
    expect(() => new RouteEngine(bundle.snapshot, { networks }).route(nor.ops[0]!, swe.ops[0]!)).toThrow(/No route/);
  });
});
