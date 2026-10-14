import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { expandIris, fromWebBundle, WEB_PARTS, type WebBundleMeta, type WebPart } from "@routebook/rinf-client/compact";
import { RoutingGraph, opEndpoint, trackPreferenceCostModel, type CostModel } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, type Routebook } from "@routebook/routebook";
import {
  TopoNetwork,
  classifySwitches,
  expandSwitches,
  layoutRouteSchematic,
  prepareSolvedLayout,
  type CompactSwitch,
  type LpSolver,
  type Schematic,
  type SwitchInfo,
} from "@routebook/schematic";
import { buildRouteGeometry, type RouteGeometry } from "./geometry.js";

export interface Bundle {
  snapshot: Snapshot;
  /** Switch classification computed by `routebook bundle` on the full-resolution geometry (switches.json), when present. */
  switches?: CompactSwitch[];
}

/** Load a web bundle (data/web/<country>/*.json) produced by `routebook fetch`. */
export async function loadBundle(baseUrl: string, fetchImpl: typeof fetch = fetch): Promise<Bundle> {
  const parts = await Promise.all(
    WEB_PARTS.map(async (part) => {
      const res = await fetchImpl(`${baseUrl}/${part}.json`);
      if (!res.ok) throw new Error(`Cannot load ${baseUrl}/${part}.json (${res.status}). No RINF data here yet: fetch it with "routebook fetch --dataset <id>" (see the README).`);
      return [part, await res.json()] as const;
    }),
  );
  const switches = await fetchImpl(`${baseUrl}/switches.json`)
    .then((r) => (r.ok ? (r.json() as Promise<CompactSwitch[]>) : undefined))
    .catch(() => undefined);
  const snapshot = fromWebBundle(Object.fromEntries(parts) as Record<WebPart, unknown>);
  // switches.json uses the same IRI prefix tokens as the other parts
  const prefixes = (snapshot.meta as WebBundleMeta).prefixes ?? {};
  return { snapshot, ...(switches ? { switches: expandIris(switches, prefixes) } : {}) };
}

export interface RouteResult {
  routebook: Routebook;
  geometry: RouteGeometry;
}

export interface EngineOptions {
  switches?: CompactSwitch[];
}

/** Everything needed to route and build routebooks in the browser, built once per snapshot. */
export class RouteEngine {
  readonly graph: RoutingGraph;
  readonly index: RoutebookIndex;
  readonly costModel: CostModel;
  private readonly switchRows: CompactSwitch[] | undefined;
  private schematicData: { network: TopoNetwork; switches: SwitchInfo[] } | undefined;

  constructor(readonly snapshot: Snapshot, opts: EngineOptions = {}) {
    this.graph = new RoutingGraph(snapshot.topology);
    this.index = new RoutebookIndex(snapshot);
    this.costModel = trackPreferenceCostModel(snapshot.tracks);
    this.switchRows = opts.switches;
  }

  /**
   * Topology nodes and switch classification, built on first use. Uses the
   * precomputed switches.json when the bundle has it; otherwise classifies
   * on the simplified browser geometry (less precise for left/right).
   */
  private schematicInput(): { network: TopoNetwork; switches: SwitchInfo[] } {
    if (!this.schematicData) {
      const network = new TopoNetwork(this.snapshot);
      const switches = this.switchRows ? expandSwitches(this.switchRows, network) : classifySwitches(this.snapshot, { network });
      this.schematicData = { network, switches };
    }
    return this.schematicData;
  }

  /** Schematic track layout around a computed route (the fast heuristic layout). */
  schematic(result: RouteResult): Schematic {
    return layoutRouteSchematic(result.routebook.route, { ...this.schematicInput(), tracks: this.snapshot.tracks, ops: this.snapshot.ops });
  }

  /**
   * Both schematic layouts: the heuristic one at once, and a promise of the
   * solver layout (its window models solved by `solver`, e.g. HiGHS in a Web
   * Worker). The promise falls back to the heuristic layout when solving fails.
   */
  schematics(result: RouteResult, solver: LpSolver): { heuristic: Schematic; solved: Promise<Schematic> } {
    const prep = prepareSolvedLayout(result.routebook.route, { ...this.schematicInput(), tracks: this.snapshot.tracks, ops: this.snapshot.ops });
    const solved = prep.problems.length
      ? solver(prep.problems).then(prep.finish, () => prep.heuristic)
      : Promise.resolve(prep.heuristic);
    return { heuristic: prep.heuristic, solved };
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
