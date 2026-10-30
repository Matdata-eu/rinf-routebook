import { SparqlClient, type Row } from "./sparql.js";
import { parseWktLineString, wktPosition } from "./wkt.js";
import { graphProvenance, type EraOptions } from "./era.js";
import type {
  Direction,
  FeatureKind,
  KmPosition,
  NetRelation,
  OperationalPoint,
  PointFeature,
  Separation,
  Snapshot,
  SnapshotMeta,
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
  /** Dataset id written to meta.country, e.g. "NOR". */
  country: string;
  /** Display name and infrastructure manager for meta. */
  name?: string;
  imName?: string;
  onProgress?: (step: string, rows: number) => void;
  /**
   * Ask ERA what it published for the graphs (dataset explorer + graph sizes) and
   * record it in meta.provenance. Default true; false skips the extra requests.
   */
  provenance?: boolean | EraOptions;
  onWarning?: (message: string) => void;
}

/** Fetch everything the routebook needs for one country graph. */
export async function fetchSnapshot({ client, country, name, imName, onProgress, provenance = true, onWarning }: FetchSnapshotOptions): Promise<Snapshot> {
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
    trackParams: await run("track-params"),
    trackStates: await run("track-states"),
    trackSeparations: await run("track-separations"),
    features: await run("features"),
    tunnels: await run("tunnels"),
    tunnelAreas: await run("tunnel-areas"),
    geometry: await run("netelement-geometry"),
  };
  const snapshot = assembleSnapshot(r, {
    endpoint: client.endpoint,
    graph: client.graphs[0] ?? client.graph,
    ...(client.graphs.length > 1 ? { graphs: client.graphs } : {}),
    country,
    ...(name ? { name } : {}),
    ...(imName ? { imName } : {}),
  });
  if (provenance) {
    const opts = { ...(typeof provenance === "object" ? provenance : {}), ...(onWarning ? { onWarning } : {}) };
    snapshot.meta.provenance = await graphProvenance(client.endpoint, client.graphs, opts);
    snapshot.meta.checkedAt = new Date().toISOString();
    onProgress?.("provenance", snapshot.meta.provenance.length);
    // the IMs' names as ERA lists them, when the dataset was not given one
    const ims = snapshot.meta.provenance.map((g) => g.imName).filter((n): n is string => !!n);
    if (!snapshot.meta.imName && ims.length) snapshot.meta.imName = [...new Set(ims)].join(", ");
  }
  return snapshot;
}

export type RawResults = Record<
  | "ops" | "opAreas" | "opPoints" | "lines" | "sols" | "netelements" | "netrelations"
  | "tracks" | "trackElements" | "trackParents" | "features" | "tunnels" | "tunnelAreas" | "geometry",
  Row[]
> &
  // section parameters (FETCH_VERSION 3), absent in results gathered before
  Partial<Record<"trackParams" | "trackStates" | "trackSeparations", Row[]>>;

/** The section parameters Routebook reads per track (track-params.rq), in display order. */
export const TRACK_PARAM_KEYS = [
  "contactLine", "energySupply", "maxTrainCurrent", "raisedPantographs", "pantographHead",
  "protectionLegacy", "otherProtection", "etcsLevel", "etcsBaseline",
  "gsmR", "legacyRadio",
  "gauge", "gauging", "lineCategory",
] as const;
export type TrackParamKey = (typeof TRACK_PARAM_KEYS)[number];

/**
 * The parameter keys an era:notApplicable / era:notYetAvailable statement covers: a statement on an
 * object (no ETCS at all, no contact line system) covers every parameter read from it.
 */
const STATE_KEYS: Record<string, string[]> = {
  maximumPermittedSpeed: ["speed"],
  gradientProfile: ["gradient"],
  contactLineSystem: ["contactLine", "energySupply", "maxTrainCurrent"],
  contactLineSystemType: ["contactLine"],
  energySupplySystem: ["energySupply"],
  maxTrainCurrent: ["maxTrainCurrent"],
  trackRaisedPantographsDistanceAndSpeed: ["raisedPantographs"],
  tsiPantographHead: ["pantographHead"],
  protectionLegacySystem: ["protectionLegacy"],
  otherTrainProtection: ["otherProtection"],
  etcs: ["etcsLevel", "etcsBaseline"],
  etcsLevelType: ["etcsLevel"],
  etcsBaseline: ["etcsBaseline"],
  gsmRVersion: ["gsmR"],
  legacyRadioSystem: ["legacyRadio"],
  wheelSetGauge: ["gauge"],
  gaugingProfile: ["gauging"],
  trackLoadCapability: ["lineCategory"],
  loadCapabilityLineCategory: ["lineCategory"],
  trackPhaseInfo: ["phaseSeparation"],
  trackSystemSeparationInfo: ["systemSeparation"],
};

/** "1 pantograph, up to 40 km/h" / "2 pantographs at least 250 m apart, up to 200 km/h" (RINF 1.1.1.2.2.4). */
export function raisedPantographsText(number?: string, distance?: string, speed?: string): string | undefined {
  const n = num(number), d = num(distance), v = num(speed);
  if (n === undefined && v === undefined) return undefined;
  const parts = [n !== undefined ? `${n} pantograph${n === 1 ? "" : "s"}${d ? ` at least ${d} m apart` : ""}` : undefined, v !== undefined ? `up to ${v} km/h` : undefined];
  return parts.filter(Boolean).join(", ");
}

/**
 * Version of the queries and the parsing; raise it when a change means data fetched before has
 * to be fetched again (the sync does that by itself). 2: OP and SoL geometry also read from the
 * net reference, WKT axis order, signs and exponents normalised. 3: section parameters per track
 * (energy, train protection, radio, gauge), their not-applicable / not-yet-available statements and
 * phase and system separations. 4: net relations navigable one way only (AB, BA), which were
 * dropped before.
 */
export const FETCH_VERSION = 4;

/** A relation's era:navigability (…/Both, …/AB, …/BA, …/None): navigable, and in which direction only. */
export function navigability(nav: string | undefined): Pick<NetRelation, "navigable" | "direction"> {
  const v = nav?.slice(nav.lastIndexOf("/") + 1);
  if (v === "Both") return { navigable: true };
  if (v === "AB" || v === "BA") return { navigable: true, direction: v };
  return { navigable: false };
}

/**
 * What decides whether Routebook can work on a dataset (see the web app's Datasets dialog):
 * OPs with a position on the micro topology (a route needs one at each end), signals, and the
 * length of track in kilometres to judge the number of signals by.
 */
export function readinessCounts(snapshot: Pick<Snapshot, "ops" | "features" | "topology">): { routableOps: number; signals: number; trackKm: number } {
  return {
    routableOps: snapshot.ops.filter((op) => op.points.length || op.areas.length).length,
    signals: snapshot.features.filter((f) => f.kind === "signal").length,
    trackKm: Math.round(snapshot.topology.netElements.reduce((s, e) => s + e.length, 0) / 1000),
  };
}

/** Pure transformation of query rows into the snapshot model (deduplicates repeated labels etc.). */
export function assembleSnapshot(
  r: RawResults,
  meta: Omit<SnapshotMeta, "fetchedAt" | "counts" | "fetchVersion">,
): Snapshot {
  const ops = new Map<string, OperationalPoint>();
  for (const row of r.ops) {
    if (!row.op) continue;
    // the geometry may come on the OP or on its net reference(s): the first that gives a position wins
    const p = wktPosition(row.wkt);
    const had = ops.get(row.op);
    if (had) {
      if (had.lon === undefined && p) Object.assign(had, p);
      continue;
    }
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
    if (!row.sol || !row.opStart || !row.opEnd) continue;
    const had = sols.get(row.sol);
    if (had) {
      // a later row with the line geometry (on the SoL or its net reference) the first one lacked
      if (!parseWktLineString(had.wkt) && parseWktLineString(row.wkt)) had.wkt = row.wkt!;
      continue;
    }
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
      ...navigability(row.nav),
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

  assembleTrackParams(tracks, r);

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
    meta: { ...meta, fetchedAt: new Date().toISOString(), fetchVersion: FETCH_VERSION, counts: {} },
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
    ...readinessCounts(snapshot),
  };
  return snapshot;
}

const bool = (v: string | undefined): boolean | undefined => (v === "true" || v === "1" ? true : v === "false" || v === "0" ? false : undefined);

/** Section parameters, their declared states and the separations onto the tracks (in place). */
function assembleTrackParams(tracks: Map<string, Track>, r: RawResults): void {
  const values = new Map<string, Map<string, Set<string>>>();
  const pantos = new Map<string, Record<string, string>>();
  for (const row of r.trackParams ?? []) {
    if (!row.track || !row.key || row.v === undefined || !tracks.has(row.track)) continue;
    if (row.key.startsWith("raisedPantographs.")) {
      const p = pantos.get(row.track) ?? {};
      p[row.key.slice("raisedPantographs.".length)] = row.v;
      pantos.set(row.track, p);
      continue;
    }
    const text = cleanLabel(row.label) ?? (row.v.startsWith("http") ? row.v.split("/").pop()! : row.v);
    const perTrack = values.get(row.track) ?? new Map<string, Set<string>>();
    const set = perTrack.get(row.key) ?? new Set<string>();
    set.add(text);
    perTrack.set(row.key, set);
    values.set(row.track, perTrack);
  }
  for (const [id, perTrack] of values) {
    const t = tracks.get(id)!;
    const params: Record<string, string> = {};
    for (const key of TRACK_PARAM_KEYS) {
      const set = perTrack.get(key);
      if (set) params[key] = [...set].sort().join(", ");
    }
    if (Object.keys(params).length) t.params = params;
  }
  for (const [id, p] of pantos) {
    const text = raisedPantographsText(p.number, p.distance, p.speed);
    if (!text) continue;
    const t = tracks.get(id)!;
    t.params = { ...(t.params ?? {}), raisedPantographs: text };
  }
  for (const row of r.trackStates ?? []) {
    const t = row.track && tracks.get(row.track);
    const prop = row.prop?.startsWith(ERA) ? row.prop.slice(ERA.length) : undefined;
    const keys = prop ? STATE_KEYS[prop] : undefined;
    if (!t || !keys) continue;
    const field = row.state === `${ERA}notApplicable` ? "notApplicable" : row.state === `${ERA}notYetAvailable` ? "notYetAvailable" : undefined;
    if (!field) continue;
    // a value wins over a statement about it
    const list = (t[field] ??= []);
    for (const k of keys) if (!t.params?.[k] && !list.includes(k)) list.push(k);
  }
  for (const row of r.trackSeparations ?? []) {
    const t = row.track && tracks.get(row.track);
    if (!t || !row.sep || (row.kind !== "phase" && row.kind !== "system")) continue;
    if (t.separations?.some((s) => s.id === row.sep)) continue;
    const km = num(row.km), length = num(row.length);
    const flags = { pantographLowered: bool(row.pantographLowered), switchOffBreaker: bool(row.switchOffBreaker), changeSupplySystem: bool(row.changeSupply) };
    const sep: Separation = {
      id: row.sep,
      kind: row.kind,
      ...(km !== undefined ? { km } : {}),
      ...(length !== undefined ? { length } : {}),
      ...Object.fromEntries(Object.entries(flags).filter(([, v]) => v !== undefined)),
    };
    (t.separations ??= []).push(sep);
  }
}
