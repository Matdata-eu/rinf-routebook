/**
 * The network index: every operational point and every section of line of every dataset on
 * offer, in two small files (`index/ops.json`, `index/sols.json`) that the web app loads at
 * start, so that search and the map cover all of RINF while the full bundles load on demand.
 * Browser-safe (no Node imports); see cache.ts for writing it.
 */
import type { NetRelation, OperationalPoint, SectionOfLine, Snapshot, Topology } from "./types.js";
import { simplifyLine } from "./compact.js";
import { parseWktLineString } from "./wkt.js";

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

/**
 * An operational point that may be shared with another dataset: a border point (op type 90, or
 * 140 for a domestic one) or an OP whose UOPID is coded for another country. `[uopid, name,
 * type, lon, lat, ne, side]`: `ne` and `side` name the end of the micro element the OP sits on
 * that faces the other network (a dead end of this dataset's topology when there is one), or
 * null when the OP has no position on the topology.
 */
export type IndexBorderRow = [string, string, string, number | null, number | null, string | null, 0 | 1 | null];

/** The index parts of one dataset (`<bundle>/index.json`), merged into the network index by `writeNetworkIndex`. */
export interface DatasetIndex {
  version: number;
  dataset: { id: string } & IndexDataset;
  ops: IndexOpRow[];
  sols: IndexSolRow[];
  /** Absent in an index written before border links existed; derived from the bundle then. */
  borders?: IndexBorderRow[];
}

/** One end of a border link: an OP of a dataset and the element end the other network continues from. */
export interface BorderEnd {
  dataset: string;
  uopid: string;
  name: string;
  ne: string;
  side: 0 | 1;
  lon?: number;
  lat?: number;
}

/**
 * A link between two datasets' topologies, derived by Routebook (RINF has no net relations
 * between infrastructure managers): the same UOPID declared by both, or two border points
 * within `distance` metres of each other.
 */
export interface BorderLink {
  a: BorderEnd;
  b: BorderEnd;
  method: "uopid" | "distance";
  /** Great-circle distance between the two OPs, metres (0 when unknown). */
  distance: number;
}

export interface UnmatchedBorder {
  dataset: string;
  uopid: string;
  name: string;
  lon?: number;
  lat?: number;
  /** The other dataset's name in the OP name ("Kornsjø stasjon / Mon") does not tell; this is only "no partner found". */
  reason: "no partner" | "no position";
}

export interface BorderDatasetSummary {
  links: number;
  /** Links per other dataset. */
  with: Record<string, number>;
  unmatched: number;
}

/** `index/borders.json`: every border link and every border point without one. */
export interface NetworkBordersIndex {
  version: number;
  /** Distance threshold used for the distance method, metres. */
  threshold: number;
  links: BorderLink[];
  unmatched: UnmatchedBorder[];
  datasets: Record<string, BorderDatasetSummary>;
}

export const BORDER_THRESHOLD_M = 300;

const r4 = (n: number) => Math.round(n * 1e4) / 1e4;

export function opTypeCode(type: string | undefined): string {
  return type ? type.slice(type.lastIndexOf("/") + 1) : "";
}

export function opRow(dataset: string, op: OperationalPoint): IndexOpRow {
  return [dataset, op.uopid, op.name, opTypeCode(op.type), op.lon ?? null, op.lat ?? null, op.points.length || op.areas.length ? 1 : 0];
}

/** The WKT LINESTRING of a section of line as coordinates, simplified (tolerance in degrees, default about 50 m). */
export function solRow(dataset: string, sol: SectionOfLine, tolerance = 5e-4): IndexSolRow | undefined {
  const coords = parseWktLineString(sol.wkt);
  if (!coords || coords.length < 2) return undefined;
  return [dataset, sol.label ?? "", simplifyLine(coords, tolerance).map(([x, y]) => [r4(x), r4(y)])];
}

const BORDER_TYPES = new Set(["90", "140"]);

/** Great-circle distance in metres. */
export function haversine(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const r = Math.PI / 180;
  const dLat = (lat2 - lat1) * r, dLon = (lon2 - lon1) * r;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(a));
}

/**
 * The OPs of a dataset that may be shared with a neighbour: border points, and OPs coded for
 * another country than most of the dataset's (Bane NOR declares its border points as EU00237,
 * Trafikverket the same). Each with the end of its element that faces out of this network: the
 * element end without a navigable relation, or the end nearer the OP when both continue.
 */
export function borderCandidates(ops: OperationalPoint[], topology: Topology): IndexBorderRow[] {
  const prefixes = new Map<string, number>();
  for (const op of ops) prefixes.set(op.uopid.slice(0, 2), (prefixes.get(op.uopid.slice(0, 2)) ?? 0) + 1);
  const home = [...prefixes.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const degree = new Map<string, number>();
  for (const r of topology.netRelations) {
    if (!r.navigable) continue;
    for (const k of [`${r.a}|${r.aAtOrigin ? 0 : 1}`, `${r.b}|${r.bAtOrigin ? 0 : 1}`]) degree.set(k, (degree.get(k) ?? 0) + 1);
  }
  const length = new Map(topology.netElements.map((e) => [e.id, e.length]));
  const rows: IndexBorderRow[] = [];
  const seen = new Set<string>();
  for (const op of ops) {
    const type = opTypeCode(op.type);
    if (!BORDER_TYPES.has(type) && (op.uopid.slice(0, 2) === home || op.uopid.length < 2)) continue;
    const pos = op.points[0] ?? (op.areas[0] ? { ne: op.areas[0].ne, offset: (op.areas[0].start + op.areas[0].end) / 2 } : undefined);
    let ne: string | null = null, side: 0 | 1 | null = null;
    if (pos && length.has(pos.ne)) {
      const d0 = degree.get(`${pos.ne}|0`) ?? 0, d1 = degree.get(`${pos.ne}|1`) ?? 0;
      ne = pos.ne;
      side = d0 === 0 && d1 > 0 ? 0 : d1 === 0 && d0 > 0 ? 1 : pos.offset * 2 < length.get(pos.ne)! ? 0 : 1;
    }
    // one row per uopid: the one with a position wins
    const key = op.uopid;
    if (seen.has(key)) {
      const i = rows.findIndex((r) => r[0] === key);
      if (i >= 0 && rows[i]![5] === null && ne) rows[i] = [op.uopid, op.name, type, op.lon ?? null, op.lat ?? null, ne, side];
      continue;
    }
    seen.add(key);
    rows.push([op.uopid, op.name, type, op.lon ?? null, op.lat ?? null, ne, side]);
  }
  return rows;
}

/** The index of one dataset, from its snapshot (or its expanded web bundle); border candidates when the topology is given. */
export function datasetIndex(id: string, snapshot: Pick<Snapshot, "meta" | "ops" | "sols"> & Partial<Pick<Snapshot, "topology">>): DatasetIndex {
  return {
    version: NETWORK_INDEX_VERSION,
    dataset: { id, name: snapshot.meta.name ?? snapshot.meta.country, ...(snapshot.meta.imName ? { imName: snapshot.meta.imName } : {}) },
    ops: snapshot.ops.map((op) => opRow(id, op)),
    sols: snapshot.sols.flatMap((s) => {
      const row = solRow(id, s);
      return row ? [row] : [];
    }),
    ...(snapshot.topology ? { borders: borderCandidates(snapshot.ops, snapshot.topology) } : {}),
  };
}

function borderEnd(dataset: string, r: IndexBorderRow): BorderEnd | undefined {
  if (r[5] === null || r[6] === null) return undefined;
  return { dataset, uopid: r[0], name: r[1], ne: r[5], side: r[6], ...(r[3] !== null && r[4] !== null ? { lon: r[3], lat: r[4] } : {}) };
}

/**
 * Match the datasets' border candidates into links: first the same UOPID in two datasets, then
 * the remaining border points within `threshold` metres of one in another dataset, nearest
 * first. Candidates without a position on the topology cannot be linked and are listed.
 */
export function matchBorders(parts: Array<Pick<DatasetIndex, "dataset" | "borders">>, threshold = BORDER_THRESHOLD_M): NetworkBordersIndex {
  type Cand = { dataset: string; row: IndexBorderRow; end: BorderEnd | undefined; linked: boolean };
  const cands: Cand[] = parts.flatMap((p) => (p.borders ?? []).map((row) => ({ dataset: p.dataset.id, row, end: borderEnd(p.dataset.id, row), linked: false })));
  const links: BorderLink[] = [];
  const dist = (a: Cand, b: Cand) => (a.row[3] !== null && a.row[4] !== null && b.row[3] !== null && b.row[4] !== null ? haversine(a.row[3], a.row[4], b.row[3], b.row[4]) : 0);
  const byUopid = new Map<string, Cand[]>();
  for (const c of cands) byUopid.set(c.row[0], [...(byUopid.get(c.row[0]) ?? []), c]);
  for (const group of byUopid.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i]!, b = group[j]!;
        if (a.dataset === b.dataset || !a.end || !b.end) continue;
        links.push({ a: a.end, b: b.end, method: "uopid", distance: Math.round(dist(a, b)) });
        a.linked = b.linked = true;
      }
    }
  }
  const pairs: Array<{ a: Cand; b: Cand; d: number }> = [];
  const open = cands.filter((c) => !c.linked && c.end && BORDER_TYPES.has(c.row[2]) && c.row[3] !== null && c.row[4] !== null);
  for (let i = 0; i < open.length; i++) {
    for (let j = i + 1; j < open.length; j++) {
      const a = open[i]!, b = open[j]!;
      if (a.dataset === b.dataset) continue;
      const d = dist(a, b);
      if (d <= threshold) pairs.push({ a, b, d });
    }
  }
  pairs.sort((x, y) => x.d - y.d);
  for (const { a, b, d } of pairs) {
    if (a.linked || b.linked) continue;
    links.push({ a: a.end!, b: b.end!, method: "distance", distance: Math.round(d) });
    a.linked = b.linked = true;
  }
  const unmatched: UnmatchedBorder[] = cands
    .filter((c) => !c.linked && BORDER_TYPES.has(c.row[2]))
    .map((c) => ({ dataset: c.dataset, uopid: c.row[0], name: c.row[1], ...(c.row[3] !== null && c.row[4] !== null ? { lon: c.row[3], lat: c.row[4] } : {}), reason: c.end ? "no partner" : "no position" }));
  const datasets: Record<string, BorderDatasetSummary> = {};
  for (const p of parts) datasets[p.dataset.id] = { links: 0, with: {}, unmatched: 0 };
  for (const l of links) {
    for (const [me, other] of [[l.a, l.b], [l.b, l.a]] as const) {
      const d = (datasets[me.dataset] ??= { links: 0, with: {}, unmatched: 0 });
      d.links++;
      d.with[other.dataset] = (d.with[other.dataset] ?? 0) + 1;
    }
  }
  for (const u of unmatched) (datasets[u.dataset] ??= { links: 0, with: {}, unmatched: 0 }).unmatched++;
  return { version: NETWORK_INDEX_VERSION, threshold, links, unmatched, datasets };
}

export function parseBordersIndex(json: unknown): NetworkBordersIndex {
  const o = (json ?? {}) as Partial<NetworkBordersIndex>;
  const end = (e: unknown): BorderEnd | undefined => {
    const x = e as Partial<BorderEnd> | undefined;
    if (!x || typeof x.dataset !== "string" || typeof x.uopid !== "string" || typeof x.ne !== "string" || (x.side !== 0 && x.side !== 1)) return undefined;
    return { dataset: x.dataset, uopid: x.uopid, name: typeof x.name === "string" ? x.name : x.uopid, ne: x.ne, side: x.side, ...(typeof x.lon === "number" && typeof x.lat === "number" ? { lon: x.lon, lat: x.lat } : {}) };
  };
  const links: BorderLink[] = [];
  for (const l of Array.isArray(o.links) ? o.links : []) {
    const a = end(l?.a), b = end(l?.b);
    if (a && b) links.push({ a, b, method: l.method === "distance" ? "distance" : "uopid", distance: typeof l.distance === "number" ? l.distance : 0 });
  }
  const unmatched = (Array.isArray(o.unmatched) ? o.unmatched : []).filter((u): u is UnmatchedBorder => !!u && typeof u.dataset === "string" && typeof u.uopid === "string");
  return { version: typeof o.version === "number" ? o.version : NETWORK_INDEX_VERSION, threshold: typeof o.threshold === "number" ? o.threshold : BORDER_THRESHOLD_M, links, unmatched, datasets: o.datasets && typeof o.datasets === "object" ? o.datasets : {} };
}

/** The net relations that join the given datasets' topologies, for a merged routing graph. */
export function borderRelations(links: BorderLink[], datasets: ReadonlySet<string>): NetRelation[] {
  return links
    .filter((l) => datasets.has(l.a.dataset) && datasets.has(l.b.dataset))
    .map((l) => ({ a: l.a.ne, b: l.b.ne, aAtOrigin: l.a.side === 0, bAtOrigin: l.b.side === 0, navigable: true }));
}

export interface Located {
  dataset: string;
  lon?: number;
  lat?: number;
}

/**
 * The datasets a route from `from` to `to` passes through, in order, on a meso graph whose nodes
 * are the two OPs and the border ends, joined inside a dataset by great-circle distance and across
 * a border link at no cost. Undefined when no chain of border links joins the two datasets.
 */
export function transitDatasets(links: BorderLink[], from: Located, to: Located): string[] | undefined {
  if (from.dataset === to.dataset) return [from.dataset];
  type Node = { id: number; dataset: string; lon?: number; lat?: number; link?: number };
  const nodes: Node[] = [{ id: 0, ...from }, { id: 1, ...to }];
  const ends = new Map<string, number>(); // `${dataset}/${uopid}` -> node
  const across = new Map<number, number>();
  for (const l of links) {
    const ids = [l.a, l.b].map((e) => {
      const k = `${e.dataset}/${e.uopid}`;
      let id = ends.get(k);
      if (id === undefined) {
        id = nodes.length;
        nodes.push({ id, dataset: e.dataset, ...(e.lon !== undefined && e.lat !== undefined ? { lon: e.lon, lat: e.lat } : {}) });
        ends.set(k, id);
      }
      return id;
    }) as [number, number];
    across.set(ids[0], ids[1]);
    across.set(ids[1], ids[0]);
  }
  const byDataset = new Map<string, Node[]>();
  for (const n of nodes) byDataset.set(n.dataset, [...(byDataset.get(n.dataset) ?? []), n]);
  const cost = (a: Node, b: Node) => (a.lon !== undefined && a.lat !== undefined && b.lon !== undefined && b.lat !== undefined ? haversine(a.lon, a.lat, b.lon, b.lat) : 1e6);
  const best = new Map<number, number>([[0, 0]]);
  const prev = new Map<number, number>();
  const done = new Set<number>();
  for (;;) {
    let u: number | undefined, uc = Infinity;
    for (const [n, c] of best) if (!done.has(n) && c < uc) { u = n; uc = c; }
    if (u === undefined) return undefined;
    if (u === 1) break;
    done.add(u);
    const node = nodes[u]!;
    const relax = (v: number, c: number) => {
      if (c < (best.get(v) ?? Infinity)) { best.set(v, c); prev.set(v, u!); }
    };
    for (const v of byDataset.get(node.dataset) ?? []) if (v.id !== u) relax(v.id, uc + cost(node, v));
    const o = across.get(u);
    if (o !== undefined) relax(o, uc);
  }
  const chain: string[] = [];
  for (let n: number | undefined = 1; n !== undefined; n = prev.get(n)) {
    const ds = nodes[n]!.dataset;
    if (chain[0] !== ds) chain.unshift(ds);
  }
  return chain;
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
