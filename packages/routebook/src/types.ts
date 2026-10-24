import type { OperationalPoint } from "@routebook/rinf-client";
import type { EndpointMode, Route } from "@routebook/routing";

export type ItemKind =
  | "origin"
  | "destination"
  | "op"
  /** change of infrastructure manager at a border link between two RINF datasets (derived by Routebook) */
  | "border"
  | "line"
  /** a section parameter changes: energy, class B, ETCS, radio or gauge (derived from the tracks' parameters) */
  | "change"
  | "speed"
  | "gradient"
  | "tunnel"
  /** phase or system separation (era:PhaseInfo / era:SystemSeparationInfo), placed by line km */
  | "separation"
  | "signal"
  | "switch"
  | "kmPost"
  | "levelCrossing"
  | "missing"
  /** items contributed by plugins (core-extensions) use their own namespaced kind, e.g. "acme:speedBoard" */
  | `${string}:${string}`;

/**
 * How trustworthy an item is:
 * - rinf: taken directly from RINF
 * - derived: computed from RINF data (e.g. tunnel enter/exit from travel direction)
 * - approximate: position or value estimated (e.g. gradient placed by km interpolation)
 * - missing: placeholder where RINF has no data for something a routebook needs
 */
export type Quality = "rinf" | "derived" | "approximate" | "missing";

export interface RoutebookItem {
  kind: ItemKind;
  /** metres from the start of the route */
  distance: number;
  /** line km (LRS) when known */
  km?: number;
  label?: string;
  quality: Quality;
  /** RINF IRI the item comes from */
  source?: string;
  /** kind-specific values, e.g. { speed: 130 } or { gradient: -9 } */
  data?: Record<string, unknown>;
  /** The RINF dataset the item comes from, on routes across networks. */
  dataset?: string;
  note?: string;
}

/** Something a routebook needs that RINF cannot provide for this route. */
export interface Gap {
  field: string;
  reason: string;
}

/**
 * A part of the route on one RINF track (or a run of tracks with the same parameters): what is in
 * force there. The line strip draws its bands from these, the section card lists them.
 */
export interface Stretch {
  /** metres from the start of the route */
  start: number;
  end: number;
  /** the RINF track (running track, else a siding) the route runs on; absent where the element belongs to none */
  track?: string;
  trackLabel?: string;
  /** line id (era:nationalLine) and its label */
  line?: string;
  lineLabel?: string;
  /** era:maximumPermittedSpeed of the running track, km/h */
  speed?: number;
  params?: Record<string, string>;
  notApplicable?: string[];
  notYetAvailable?: string[];
  /** line km at the start and the end, when km anchors allow an estimate */
  kmStart?: number;
  kmEnd?: number;
  /** the RINF dataset, on routes across networks */
  dataset?: string;
}

export interface Routebook {
  from: OperationalPoint;
  to: OperationalPoint;
  endpointModes: { from: EndpointMode; to: EndpointMode };
  route: Route;
  /** metres */
  length: number;
  items: RoutebookItem[];
  /** What is in force along the route, stretch by stretch, from start to end. */
  stretches?: Stretch[];
  gaps: Gap[];
}
