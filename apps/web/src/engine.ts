import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { fromWebBundle, WEB_PARTS, type WebPart } from "@routebook/rinf-client/compact";
import { RoutingGraph, opEndpoint, trackPreferenceCostModel, type CostModel } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, type Routebook } from "@routebook/routebook";
import { buildRouteGeometry, type RouteGeometry } from "./geometry.js";

/** Load a web bundle (data/web/<country>/*.json) produced by `routebook fetch`. */
export async function loadBundle(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Snapshot> {
  const parts = await Promise.all(
    WEB_PARTS.map(async (part) => {
      const res = await fetchImpl(`${baseUrl}/${part}.json`);
      if (!res.ok) throw new Error(`Cannot load ${baseUrl}/${part}.json (${res.status}). Run "pnpm fetch:nor" first.`);
      return [part, await res.json()] as const;
    }),
  );
  return fromWebBundle(Object.fromEntries(parts) as Record<WebPart, unknown>);
}

export interface RouteResult {
  routebook: Routebook;
  geometry: RouteGeometry;
}

/** Everything needed to route and build routebooks in the browser, built once per snapshot. */
export class RouteEngine {
  readonly graph: RoutingGraph;
  readonly index: RoutebookIndex;
  readonly costModel: CostModel;

  constructor(readonly snapshot: Snapshot) {
    this.graph = new RoutingGraph(snapshot.topology);
    this.index = new RoutebookIndex(snapshot);
    this.costModel = trackPreferenceCostModel(snapshot.tracks);
  }

  route(from: OperationalPoint, to: OperationalPoint): RouteResult {
    if (from.id === to.id) throw new Error("Origin and destination are the same");
    const src = opEndpoint(from), dst = opEndpoint(to);
    if (src.intervals.length === 0) throw new Error(`${from.name} has no position on the track network in RINF`);
    if (dst.intervals.length === 0) throw new Error(`${to.name} has no position on the track network in RINF`);
    const route = this.graph.route(src.intervals, dst.intervals, { costModel: this.costModel });
    if (!route) throw new Error(`No route between ${from.name} and ${to.name} (not connected in the RINF topology)`);
    const routebook = buildRoutebook({ index: this.index, route, from, to, endpointModes: { from: src.mode, to: dst.mode } });
    const geometry = buildRouteGeometry(route, this.snapshot.geometry ?? {}, this.graph.lengths);
    return { routebook, geometry };
  }
}
