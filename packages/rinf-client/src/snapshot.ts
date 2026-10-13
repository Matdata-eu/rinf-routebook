import { SparqlClient, type Row } from "./sparql.js";
import type {
  Direction,
  FeatureKind,
  KmPosition,
  OperationalPoint,
  PointFeature,
  Snapshot,
  Track,
  Tunnel,
} from "./types.js";

const ERA = "http://data.europa.eu/949/";

const num = (v: string | undefined): number | undefined => {
  if (v === undefined || v === "") return undefined;
  const n = Number(v);
  return Number.isFinite(n) ? n : undefined;
};

/** km post kilometre + offset in metres -> km value. */
const kmOf = (km?: string, offKm?: string, lrs?: string): Partial<KmPosition> => {
  const k = num(km);
  if (k === undefined) return {};
  const pos: Partial<KmPosition> = { km: round(k + (num(offKm) ?? 0) / 1000, 4) };
  if (lrs) pos.lrs = lrs;
  return pos;
};

/** Some labels arrive CSV-escaped, e.g. `"Signal 75A ""Kilometerskilt"""`. */
export function cleanLabel(label: string | undefined): string | undefined {
  if (label === undefined) return undefined;
  let l = label.trim();
  if (l.length >= 2 && l.startsWith('"') && l.endsWith('"')) l = l.slice(1, -1);
  l = l.replace(/""/g, '"').trim();
  return l || undefined;
}

const round = (n: number, d: number) => Math.round(n * 10 ** d) / 10 ** d;

/** Parse a WKT LINESTRING (optionally prefixed with a CRS IRI) into [lon, lat] pairs. */
export function parseWktLineString(wkt: string | undefined): Array<[number, number]> | undefined {
  const m = wkt?.match(/LINESTRING\s*\(([^)]*)\)/i);
  if (!m) return undefined;
  return m[1]!.split(",").map((p) => {
    const [x, y] = p.trim().split(/\s+/).map(Number);
    return [x!, y!] as [number, number];
  });
}

export function parseWktPoint(wkt: string | undefined): { lon: number; lat: number } | undefined {
  const m = wkt?.match(/POINT\s*\(\s*(-?[\d.]+)\s+(-?[\d.]+)/i);
  return m ? { lon: Number(m[1]), lat: Number(m[2]) } : undefined;
}

const DIRECTIONS: Record<string, Direction> = {
  [`${ERA}concepts/orientations/00`]: "normal",
  [`${ERA}concepts/orientations/01`]: "opposite",
  [`${ERA}concepts/orientations/02`]: "both",
};

const FEATURE_KINDS: Record<string, FeatureKind> = {
  [`${ERA}Signal`]: "signal",
  [`${ERA}Switch`]: "switch",
  [`${ERA}KilometricPost`]: "kmPost",
  [`${ERA}LevelCrossing`]: "levelCrossing",
};

export interface FetchSnapshotOptions {
  client: SparqlClient;
  country: string;
  onProgress?: (step: string, rows: number) => void;
}

/** Fetch everything the routebook needs for one country graph. */
export async function fetchSnapshot({ client, country, onProgress }: FetchSnapshotOptions): Promise<Snapshot> {
  const run = async (name: string): Promise<Row[]> => {
    const rows = await client.selectNamed(name);
    onProgress?.(name, rows.length);
    return rows;
  };
  // Sequential on purpose: the public endpoint is shared.
  const r = {
    ops: await run("ops"),
    opAreas: await run("op-areas"),
    opPoints: await run("op-points"),
    lines: await run("lines"),
    sols: await run("sols"),
    netelements: await run("netelements"),
    netrelations: await run("netrelations"),
    tracks: await run("tracks"),
    trackElements: await run("track-elements"),
    trackParents: await run("track-parents"),
    features: await run("features"),
    tunnels: await run("tunnels"),
    tunnelAreas: await run("tunnel-areas"),
    geometry: await run("netelement-geometry"),
  };
  return assembleSnapshot(r, { endpoint: client.endpoint, graph: client.graph, country });
}

export type RawResults = Record<
  | "ops" | "opAreas" | "opPoints" | "lines" | "sols" | "netelements" | "netrelations"
  | "tracks" | "trackElements" | "trackParents" | "features" | "tunnels" | "tunnelAreas" | "geometry",
  Row[]
>;

/** Pure transformation of query rows into the snapshot model (deduplicates repeated labels etc.). */
export function assembleSnapshot(
  r: RawResults,
  meta: { endpoint: string; graph: string; country: string },
): Snapshot {
  const ops = new Map<string, OperationalPoint>();
  for (const row of r.ops) {
    if (!row.op || ops.has(row.op)) continue;
    const p = parseWktPoint(row.wkt);
    ops.set(row.op, {
      id: row.op,
      uopid: row.uopid ?? "",
      name: row.name ?? "",
      ...(row.type ? { type: row.type } : {}),
      ...(p ?? {}),
      points: [],
      areas: [],
    });
  }
  const seen = new Set<string>();
  const once = (key: string) => (seen.has(key) ? false : (seen.add(key), true));
  for (const row of r.opAreas) {
    const op = row.op && ops.get(row.op);
    const start = num(row.startOff), end = num(row.endOff);
    if (!op || !row.ne || start === undefined || end === undefined) continue;
    if (!once(`a|${row.op}|${row.ne}|${start}|${end}`)) continue;
    op.areas.push({ ne: row.ne, start: Math.min(start, end), end: Math.max(start, end) });
  }
  for (const row of r.opPoints) {
    const op = row.op && ops.get(row.op);
    const offset = num(row.off);
    if (!op || !row.ne || offset === undefined) continue;
    if (!once(`p|${row.op}|${row.ne}|${offset}`)) continue;
    op.points.push({ ne: row.ne, offset, ...kmOf(row.km, row.offKm, row.lrs) });
  }

  const lines = new Map<string, { id: string; label: string }>();
  for (const row of r.lines) if (row.line) lines.set(row.line, { id: row.line, label: row.label ?? row.line });

  const sols = new Map<string, Snapshot["sols"][number]>();
  for (const row of r.sols) {
    if (!row.sol || sols.has(row.sol) || !row.opStart || !row.opEnd) continue;
    const length = num(row.length);
    sols.set(row.sol, {
      id: row.sol,
      opStart: row.opStart,
      opEnd: row.opEnd,
      ...(row.label ? { label: row.label } : {}),
      ...(row.line ? { line: row.line } : {}),
      ...(length !== undefined ? { length } : {}),
      ...(row.wkt ? { wkt: row.wkt } : {}),
    });
  }

  const netElements = new Map<string, number>();
  for (const row of r.netelements) {
    const len = num(row.len);
    if (row.e && len !== undefined) netElements.set(row.e, len);
  }
  const netRelations = r.netrelations
    .filter((row) => row.a && row.b)
    .map((row) => ({
      a: row.a!,
      b: row.b!,
      aAtOrigin: row.oa === "true",
      bAtOrigin: row.ob === "true",
      navigable: !!row.nav?.endsWith("/Both"),
    }));

  const tracks = new Map<string, Track>();
  for (const row of r.tracks) {
    if (!row.track || tracks.has(row.track)) continue;
    const speed = num(row.speed);
    tracks.set(row.track, {
      id: row.track,
      kind: row.kind === `${ERA}Siding` ? "siding" : "running",
      ...(row.label ? { label: row.label } : {}),
      ...(speed !== undefined ? { speed } : {}),
      ...(row.gradientProfile ? { gradientProfile: row.gradientProfile } : {}),
      elements: [],
      partOf: [],
    });
  }
  for (const row of r.trackElements) {
    const t = row.track && tracks.get(row.track);
    if (t && row.ne && !t.elements.includes(row.ne)) t.elements.push(row.ne);
  }
  for (const row of r.trackParents) {
    const t = row.track && tracks.get(row.track);
    if (t && row.parent && !t.partOf.includes(row.parent)) t.partOf.push(row.parent);
  }

  const features = new Map<string, PointFeature>();
  for (const row of r.features) {
    const kind = row.class ? FEATURE_KINDS[row.class] : undefined;
    const offset = num(row.off);
    if (!row.f || !kind || !row.ne || offset === undefined || features.has(row.f)) continue;
    const direction = row.dir ? DIRECTIONS[row.dir] : undefined;
    features.set(row.f, {
      id: row.f,
      kind,
      ne: row.ne,
      offset,
      ...(cleanLabel(row.label) ? { label: cleanLabel(row.label)! } : {}),
      ...(row.signalType ? { signalType: row.signalType } : {}),
      ...(direction ? { direction } : {}),
      ...kmOf(row.km, row.offKm, row.lrs),
    });
  }

  const tunnels = new Map<string, Tunnel>();
  for (const row of r.tunnels) {
    const offS = num(row.offS), offE = num(row.offE);
    if (!row.t || tunnels.has(row.t) || !row.neS || !row.neE || offS === undefined || offE === undefined) continue;
    const length = num(row.len);
    tunnels.set(row.t, {
      id: row.t,
      ...(row.id ? { ident: row.id } : {}),
      ...(row.label ? { label: row.label } : {}),
      ...(length !== undefined ? { length } : {}),
      start: { ne: row.neS, offset: offS, ...kmOf(row.kmS, row.offKmS) },
      end: { ne: row.neE, offset: offE, ...kmOf(row.kmE, row.offKmE) },
      areas: [],
    });
  }
  for (const row of r.tunnelAreas) {
    const t = row.t && tunnels.get(row.t);
    const start = num(row.startOff), end = num(row.endOff);
    if (!t || !row.ne || start === undefined || end === undefined) continue;
    if (!once(`t|${row.t}|${row.ne}|${start}|${end}`)) continue;
    t.areas.push({ ne: row.ne, start: Math.min(start, end), end: Math.max(start, end) });
  }

  const geometry: Record<string, Array<[number, number]>> = {};
  for (const row of r.geometry ?? []) {
    const coords = parseWktLineString(row.wkt);
    if (row.e && coords && netElements.has(row.e)) geometry[row.e] = coords;
  }

  const snapshot: Snapshot = {
    meta: { ...meta, fetchedAt: new Date().toISOString(), counts: {} },
    ops: [...ops.values()],
    lines: [...lines.values()],
    sols: [...sols.values()],
    topology: {
      netElements: [...netElements].map(([id, length]) => ({ id, length })),
      netRelations,
    },
    tracks: [...tracks.values()],
    features: [...features.values()],
    tunnels: [...tunnels.values()],
    geometry,
  };
  snapshot.meta.counts = {
    ops: snapshot.ops.length,
    lines: snapshot.lines.length,
    sols: snapshot.sols.length,
    netElements: snapshot.topology.netElements.length,
    netRelations: snapshot.topology.netRelations.length,
    tracks: snapshot.tracks.length,
    features: snapshot.features.length,
    tunnels: snapshot.tunnels.length,
    geometries: Object.keys(geometry).length,
  };
  return snapshot;
}
