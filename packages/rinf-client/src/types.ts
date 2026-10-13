/**
 * Snapshot model: a compact, JSON-serialisable projection of the RINF knowledge
 * graph for one country graph. All ids are the original RINF IRIs.
 * Offsets are metres from the origin of a micro LinearElement; `km` values are
 * line kilometres (LRS) with the offset from the km post already applied.
 */

/** Position on the micro topology. */
export interface TopoPosition {
  ne: string;
  offset: number;
}

/** Linear (km) position. `lrs` is the RINF LinearPositioningSystem / LRS id when known. */
export interface KmPosition {
  km: number;
  lrs?: string;
}

/** Interval on one micro element, e.g. the part of an OP area on that element. */
export interface TopoInterval {
  ne: string;
  start: number;
  end: number;
}

export interface OperationalPoint {
  id: string;
  uopid: string;
  name: string;
  /** SKOS concept IRI of era:opType. */
  type?: string;
  lon?: number;
  lat?: number;
  /** Centre point(s) of the OP, one per track (era:NetPointReference). */
  points: Array<TopoPosition & Partial<KmPosition>>;
  /** OP area on the micro topology (era:NetAreaReference). */
  areas: TopoInterval[];
}

export interface Line {
  id: string;
  /** e.g. "B20-Drammensbanen" */
  label: string;
}

export interface SectionOfLine {
  id: string;
  label?: string;
  opStart: string;
  opEnd: string;
  line?: string;
  /** km */
  length?: number;
  wkt?: string;
}

export interface NetElement {
  id: string;
  length: number;
}

export interface NetRelation {
  a: string;
  b: string;
  /** true when the relation is at the origin (offset 0) of element A. */
  aAtOrigin: boolean;
  bAtOrigin: boolean;
  /** false for navigability None (e.g. switch leg-to-leg). */
  navigable: boolean;
}

export interface Topology {
  netElements: NetElement[];
  netRelations: NetRelation[];
}

export type TrackKind = "running" | "siding";

export interface Track {
  id: string;
  kind: TrackKind;
  label?: string;
  /** era:maximumPermittedSpeed, km/h, one value for the whole track. */
  speed?: number;
  /** Raw era:gradientProfile string, e.g. "-9.0(+110.998), -4.7(+111.045)". */
  gradientProfile?: string;
  elements: string[];
  /** SoL or OP ids (era:isPartOf). */
  partOf: string[];
}

export type FeatureKind = "signal" | "switch" | "kmPost" | "levelCrossing";
/** era:appliesToDirection relative to the element: normal = origin -> end. */
export type Direction = "normal" | "opposite" | "both";

export interface PointFeature extends TopoPosition, Partial<KmPosition> {
  id: string;
  kind: FeatureKind;
  label?: string;
  /** SKOS concept IRI of era:signalType. */
  signalType?: string;
  direction?: Direction;
}

export interface Tunnel {
  id: string;
  ident?: string;
  label?: string;
  /** metres */
  length?: number;
  start: TopoPosition & Partial<KmPosition>;
  end: TopoPosition & Partial<KmPosition>;
  /** Elements covered by the tunnel (all tracks), from its era:NetAreaReference. */
  areas: TopoInterval[];
}

export interface SnapshotMeta {
  endpoint: string;
  graph: string;
  country: string;
  fetchedAt: string;
  counts: Record<string, number>;
}

export interface Snapshot {
  meta: SnapshotMeta;
  ops: OperationalPoint[];
  lines: Line[];
  sols: SectionOfLine[];
  topology: Topology;
  tracks: Track[];
  features: PointFeature[];
  tunnels: Tunnel[];
}
