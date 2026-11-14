import { readFileSync } from "node:fs";
import type { Snapshot, Track } from "@routebook/rinf-client";
import type { Route } from "@routebook/routing";
import { TopoNetwork, expandSwitches, type CompactSwitch, type LayoutInput } from "@routebook/schematic";

/**
 * A station area cut out of real RINF data by `node scripts/schematic-lab.mjs fixture`: the route and
 * every track within 3.5 km of it, with the element ids shortened.
 */
interface FixtureFile {
  source: string;
  route: Route;
  elements: Array<[id: string, length: number]>;
  relations: Array<[a: string, b: string, aAtOrigin: number, bAtOrigin: number, navigable: number]>;
  tracks: Array<[kind: Track["kind"], label: string, elements: string[]]>;
  switches: Array<[common: string, continuous: string, deviating: string, side: string, rule: string, label: string]>;
  ops: Array<[name: string, elements: string[]]>;
  geometry: NonNullable<Snapshot["geometry"]>;
}

export const FIXTURES = ["hamar", "skoyen", "drammen", "trondheim", "dalane", "radviliskis"] as const;

export interface StationFixture {
  route: Route;
  input: LayoutInput;
  lengthOf: (ne: string) => number | undefined;
}

export function loadFixture(name: (typeof FIXTURES)[number]): StationFixture {
  const f = JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8")) as FixtureFile;
  const network = new TopoNetwork({
    topology: {
      netElements: f.elements.map(([id, length]) => ({ id, length })),
      netRelations: f.relations.map(([a, b, ao, bo, nav]) => ({ a, b, aAtOrigin: !!ao, bAtOrigin: !!bo, navigable: !!nav })),
    },
    geometry: f.geometry,
  });
  const rows = f.switches.map(([c, k, d, side, rule, label]) => [c, k, d, side, rule, "", label] as unknown as CompactSwitch);
  return {
    route: f.route,
    input: {
      network,
      switches: expandSwitches(rows, network),
      tracks: f.tracks.map(([kind, label, elements], i) => ({ id: `t${i}`, kind, ...(label ? { label } : {}), elements, partOf: [] })),
      ops: f.ops.map(([name, elements]) => ({ name, areas: elements.map((ne) => ({ ne })) })),
    },
    lengthOf: (ne) => network.lengths.get(ne),
  };
}
