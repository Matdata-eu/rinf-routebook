import type { OperationalPoint } from "@routebook/rinf-client";
import type { EndpointMode, Route } from "@routebook/routing";

export type ItemKind =
  | "origin"
  | "destination"
  | "op"
  | "line"
  | "speed"
  | "gradient"
  | "tunnel"
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
  note?: string;
}

/** Something a routebook needs that RINF cannot provide for this route. */
export interface Gap {
  field: string;
  reason: string;
}

export interface Routebook {
  from: OperationalPoint;
  to: OperationalPoint;
  endpointModes: { from: EndpointMode; to: EndpointMode };
  route: Route;
  /** metres */
  length: number;
  items: RoutebookItem[];
  gaps: Gap[];
}
