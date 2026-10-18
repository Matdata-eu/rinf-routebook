/**
 * The network index: every operational point and every section of line of every dataset on
 * offer, in two small files (`index/ops.json`, `index/sols.json`) that the web app loads at
 * start, so that search and the map cover all of RINF while the full bundles load on demand.
 * Browser-safe (no Node imports); see cache.ts for writing it.
 */
import type { OperationalPoint, SectionOfLine, Snapshot } from "./types.js";
import { simplifyLine } from "./compact.js";

export const NETWORK_INDEX_VERSION = 1;

/** One operational point in the index. */
export interface IndexOp {
  /** Dataset id (folder name, `?dataset=` value). */
  dataset: string;
  uopid: string;
  name: string;
  /** The last part of the era:opType concept IRI ("10" = station), or "". */
  type: string;
  lon?: number;
  lat?: number;
  /** Has a position on the micro topology, so it can be the end of a route. */
  routable: boolean;
}

/** `[dataset, uopid, name, type, lon, lat, routable]`; lon/lat are null when unknown. */
export type IndexOpRow = [string, string, string, string, number | null, number | null, 0 | 1];
/** `[dataset, label, [[lon, lat], ...]]`, simplified to about 50 m. */
export type IndexSolRow = [string, string, Array<[number, number]>];

export interface IndexDataset {
  name: string;
  imName?: string;
}

export interface NetworkOpsIndex {
  version: number;
  datasets: Record<string, IndexDataset>;
  ops: IndexOpRow[];
}

export interface NetworkSolsIndex {
  version: number;
  sols: IndexSolRow[];
}

/** The index parts of one dataset (`<bundle>/index.json`), merged into the network index by `writeNetworkIndex`. */
export interface DatasetIndex {
  version: number;
  dataset: { id: string } & IndexDataset;
  ops: IndexOpRow[];
  sols: IndexSolRow[];
}

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function opTypeCode(type: string | undefined): string {
  return type ? type.slice(type.lastIndexOf("/") + 1) : "";
}

export function opRow(dataset: string, op: OperationalPoint): IndexOpRow {
  return [dataset, op.uopid, op.name, opTypeCode(op.type), op.lon ?? null, op.lat ?? null, op.points.length || op.areas.length ? 1 : 0];
}

/** The WKT LINESTRING of a section of line as coordinates, simplified (tolerance in degrees, default about 50 m). */
export function solRow(dataset: string, sol: SectionOfLine, tolerance = 5e-4): IndexSolRow | undefined {
  const m = sol.wkt?.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!m) return undefined;
  const coords = m[1]!.split(",").map((p) => p.trim().split(/\s+/).map(Number) as [number, number]);
  if (coords.length < 2 || coords.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return undefined;
  return [dataset, sol.label ?? "", simplifyLine(coords, tolerance).map(([x, y]) => [r4(x), r4(y)])];
}

/** The index of one dataset, from its snapshot (or its expanded web bundle). */
export function datasetIndex(id: string, snapshot: Pick<Snapshot, "meta" | "ops" | "sols">): DatasetIndex {
  return {
    version: NETWORK_INDEX_VERSION,
    dataset: { id, name: snapshot.meta.name ?? snapshot.meta.country, ...(snapshot.meta.imName ? { imName: snapshot.meta.imName } : {}) },
    ops: snapshot.ops.map((op) => opRow(id, op)),
    sols: snapshot.sols.flatMap((s) => {
      const row = solRow(id, s);
      return row ? [row] : [];
    }),
  };
}

/** Merge the datasets' index parts into the two files the web app loads. */
export function mergeIndexes(parts: DatasetIndex[]): { ops: NetworkOpsIndex; sols: NetworkSolsIndex } {
  const datasets: Record<string, IndexDataset> = {};
  for (const p of parts) datasets[p.dataset.id] = { name: p.dataset.name, ...(p.dataset.imName ? { imName: p.dataset.imName } : {}) };
  return {
    ops: { version: NETWORK_INDEX_VERSION, datasets, ops: parts.flatMap((p) => p.ops) },
    sols: { version: NETWORK_INDEX_VERSION, sols: parts.flatMap((p) => p.sols) },
  };
}

/** Rows -> objects, tolerant of a broken file (bad rows are skipped). */
export function parseOpsIndex(json: unknown): { datasets: Record<string, IndexDataset>; ops: IndexOp[] } {
  const o = (json ?? {}) as Partial<NetworkOpsIndex>;
  const datasets: Record<string, IndexDataset> = {};
  for (const [id, d] of Object.entries(o.datasets ?? {})) if (d && typeof d === "object" && typeof d.name === "string") datasets[id] = { name: d.name, ...(d.imName ? { imName: d.imName } : {}) };
  const ops: IndexOp[] = [];
  for (const r of Array.isArray(o.ops) ? o.ops : []) {
    if (!Array.isArray(r) || typeof r[0] !== "string" || typeof r[1] !== "string" || typeof r[2] !== "string") continue;
    ops.push({
      dataset: r[0],
      uopid: r[1],
      name: r[2],
      type: typeof r[3] === "string" ? r[3] : "",
      ...(typeof r[4] === "number" && typeof r[5] === "number" ? { lon: r[4], lat: r[5] } : {}),
      routable: r[6] === 1,
    });
  }
  return { datasets, ops };
}

export function parseSolsIndex(json: unknown): IndexSolRow[] {
  const o = (json ?? {}) as Partial<NetworkSolsIndex>;
  return (Array.isArray(o.sols) ? o.sols : []).filter((r): r is IndexSolRow => Array.isArray(r) && typeof r[0] === "string" && Array.isArray(r[2]) && r[2].length >= 2);
}

/** Key of an index OP: its dataset and uopid (a uopid can appear in two datasets, at a border). */
export function opKey(op: Pick<IndexOp, "dataset" | "uopid">): string {
  return `${op.dataset}/${op.uopid}`;
}
