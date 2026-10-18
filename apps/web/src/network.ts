/**
 * The whole network in the browser: the index of every operational point and section of line of
 * every dataset on offer (`index/ops.json`, `index/sols.json`, written by `routebook index` and the
 * sync), so that search and the map cover all of RINF before any bundle is loaded.
 */
import type { Snapshot } from "@routebook/rinf-client";
import { datasetIndex, opKey, parseOpsIndex, parseSolsIndex, type IndexDataset, type IndexOp, type IndexSolRow } from "@routebook/rinf-client/network-index";
import type { DatasetInfo } from "./datasets.js";

export interface Network {
  /** The datasets in the index: id -> name (and infrastructure manager). */
  datasets: Record<string, IndexDataset>;
  ops: IndexOp[];
  sols: IndexSolRow[];
  /** `${dataset}/${uopid}` -> op */
  byKey: Map<string, IndexOp>;
  /** Built from one bundle because the data folder has no index (written before the index existed). */
  fromBundle?: string;
}

function build(datasets: Record<string, IndexDataset>, ops: IndexOp[], sols: IndexSolRow[], fromBundle?: string): Network {
  return { datasets, ops, sols, byKey: new Map(ops.map((op) => [opKey(op), op])), ...(fromBundle ? { fromBundle } : {}) };
}

/** Load the network index; undefined when the data folder has none. */
export async function loadNetwork(base: string, fetchImpl: typeof fetch = fetch): Promise<Network | undefined> {
  try {
    const [opsRes, solsRes] = await Promise.all([fetchImpl(`${base}index/ops.json`, { cache: "no-cache" }), fetchImpl(`${base}index/sols.json`, { cache: "no-cache" })]);
    if (!opsRes.ok) return undefined;
    const { datasets, ops } = parseOpsIndex(await opsRes.json());
    const sols = solsRes.ok ? parseSolsIndex(await solsRes.json()) : [];
    return build(datasets, ops, sols);
  } catch {
    return undefined;
  }
}

/** A network of one dataset, from its bundle, for data folders without an index. */
export function networkFromBundle(id: string, snapshot: Snapshot): Network {
  const part = datasetIndex(id, snapshot);
  const { datasets, ops } = parseOpsIndex({ version: part.version, datasets: { [id]: { name: part.dataset.name, ...(part.dataset.imName ? { imName: part.dataset.imName } : {}) } }, ops: part.ops });
  return build(datasets, ops, part.sols, id);
}

/**
 * The dataset the map and the search are limited to: the URL's (`all` for everything), else the
 * configured default, else everything; undefined means all datasets. Unknown ids fall back the same way.
 */
export function pickFilter(available: Pick<DatasetInfo, "id">[], requested: string | null | undefined, fallback?: string): string | undefined {
  const ids = new Set(available.map((d) => d.id.toLowerCase()));
  for (const want of [requested, fallback]) {
    const w = want?.trim().toLowerCase();
    if (!w) continue;
    if (w === "all") return undefined;
    if (ids.has(w)) return w;
  }
  return undefined;
}

/** The index OPs the filter shows. */
export function visibleOps(network: Network, filter: string | undefined): IndexOp[] {
  return filter ? network.ops.filter((op) => op.dataset === filter) : network.ops;
}

/**
 * The OP a `?from=` / `?to=` code means: `NODRM@tst` names the dataset; a bare code is looked up in
 * the filtered dataset when there is one, else in any, and a border point declared by two IMs
 * resolves to the routable one, then the first.
 */
export function findByCode(network: Network, code: string | null | undefined, filter?: string): IndexOp | undefined {
  const raw = code?.trim().toLowerCase();
  if (!raw) return undefined;
  const at = raw.indexOf("@");
  const c = at >= 0 ? raw.slice(0, at) : raw;
  const ds = at >= 0 ? raw.slice(at + 1) : filter;
  let hits = network.ops.filter((op) => op.uopid.toLowerCase() === c && (!ds || op.dataset === ds));
  if (!hits.length && at >= 0) hits = network.ops.filter((op) => op.uopid.toLowerCase() === c);
  return hits.find((op) => op.routable) ?? hits[0];
}

/** The `?from=` / `?to=` value of an OP: its code, with `@dataset` when the code is in more than one dataset and no filter settles it. */
export function codeOf(network: Network, op: IndexOp, filter?: string): string {
  if (filter === op.dataset) return op.uopid;
  const twice = network.ops.some((o) => o.uopid === op.uopid && o.dataset !== op.dataset);
  return twice ? `${op.uopid}@${op.dataset}` : op.uopid;
}

/** Bounding box of the OPs with a position, or undefined. */
export function opsBounds(ops: IndexOp[]): [[number, number], [number, number]] | undefined {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const op of ops) {
    if (op.lon === undefined || op.lat === undefined) continue;
    if (op.lon < minX) minX = op.lon;
    if (op.lon > maxX) maxX = op.lon;
    if (op.lat < minY) minY = op.lat;
    if (op.lat > maxY) maxY = op.lat;
  }
  return Number.isFinite(minX) ? [[minX, minY], [maxX, maxY]] : undefined;
}

/** GeoJSON for the map: every indexed section of line, with its dataset for the filter. */
export function solsGeoJson(network: Network) {
  return {
    type: "FeatureCollection" as const,
    features: network.sols.map(([dataset, label, coordinates]) => ({ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates }, properties: { dataset, label } })),
  };
}

/** GeoJSON for the map: every indexed OP with a position, with its dataset for the filter. */
export function opsGeoJson(network: Network) {
  return {
    type: "FeatureCollection" as const,
    features: network.ops
      .filter((o) => o.lon !== undefined && o.lat !== undefined)
      .map((o) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [o.lon!, o.lat!] },
        properties: { key: opKey(o), dataset: o.dataset, name: o.name, uopid: o.uopid, station: o.type === "10" ? 1 : 0 },
      })),
  };
}
