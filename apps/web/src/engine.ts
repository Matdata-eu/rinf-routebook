import type { OperationalPoint, Snapshot } from "@routebook/rinf-client";
import { expandIris, fromWebBundle, WEB_PARTS, type WebBundleMeta, type WebPart } from "@routebook/rinf-client/compact";
import { borderRelations, type BorderLink } from "@routebook/rinf-client/network-index";
import { RoutingGraph, opEndpoint, trackPreferenceCostModel, type CostModel } from "@routebook/routing";
import { RoutebookIndex, addBorderItems, buildRoutebook, type NetworkLabels, type Routebook } from "@routebook/routebook";
import {
  TopoNetwork,
  classifySwitches,
  expandSwitches,
  layoutRouteSchematic,
  prepareSolvedLayout,
  type CompactSwitch,
  type LpSolution,
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
  /** On a merged bundle: which dataset each element belongs to, for the border items of the routebook. */
  networks?: NetworkLabels;
  /** A routing cost model for this snapshot (e.g. a plugin's); undefined: the built-in track preference model. */
  costModel?: (snapshot: Snapshot) => CostModel | undefined;
}

/**
 * One bundle out of several datasets' bundles, joined by their border links: the topologies,
 * features and geometry side by side, plus one navigable relation per border link, so that the
 * routing graph, the routebook index and the schematic work unchanged across networks. The
 * objects are shared with the parts (nothing is copied but the arrays).
 */
export function mergeBundles(parts: Array<{ id: string; bundle: Bundle; label?: string }>, links: BorderLink[]): { bundle: Bundle; networks: NetworkLabels } {
  const ids = new Set(parts.map((p) => p.id));
  const datasetOfNe = new Map<string, string>();
  for (const p of parts) for (const ne of p.bundle.snapshot.topology.netElements) datasetOfNe.set(ne.id, p.id);
  const labels = new Map(parts.map((p) => [p.id, p.label ?? p.bundle.snapshot.meta.imName ?? p.bundle.snapshot.meta.name ?? p.id]));
  const snapshots = parts.map((p) => p.bundle.snapshot);
  const first = snapshots[0]!;
  const counts: Record<string, number> = {};
  for (const s of snapshots) for (const [k, v] of Object.entries(s.meta.counts)) counts[k] = (counts[k] ?? 0) + v;
  const snapshot: Snapshot = {
    meta: {
      ...first.meta,
      graph: first.meta.graph,
      graphs: snapshots.flatMap((s) => s.meta.graphs ?? [s.meta.graph]),
      country: parts.map((p) => p.id).join("+"),
      name: snapshots.map((s) => s.meta.name ?? s.meta.country).join(" + "),
      imName: [...new Set(snapshots.map((s) => s.meta.imName).filter((n): n is string => !!n))].join(", "),
      counts,
      provenance: snapshots.flatMap((s) => s.meta.provenance ?? []),
    },
    ops: snapshots.flatMap((s) => s.ops),
    lines: snapshots.flatMap((s) => s.lines),
    sols: snapshots.flatMap((s) => s.sols),
    topology: {
      netElements: snapshots.flatMap((s) => s.topology.netElements),
      netRelations: [...snapshots.flatMap((s) => s.topology.netRelations), ...borderRelations(links, ids)],
    },
    tracks: snapshots.flatMap((s) => s.tracks),
    features: snapshots.flatMap((s) => s.features),
    tunnels: snapshots.flatMap((s) => s.tunnels),
    geometry: Object.assign({}, ...snapshots.map((s) => s.geometry ?? {})) as Snapshot["geometry"],
  };
  const switches = parts.flatMap((p) => p.bundle.switches ?? []);
  const everyPartHasSwitches = parts.every((p) => p.bundle.switches);
  return {
    bundle: { snapshot, ...(everyPartHasSwitches && switches.length ? { switches } : {}) },
    networks: { datasetOf: (ne) => datasetOfNe.get(ne), labelOf: (id) => labels.get(id) ?? id },
  };
}

/** Everything needed to route and build routebooks in the browser, built once per snapshot. */
export class RouteEngine {
  readonly graph: RoutingGraph;
  readonly index: RoutebookIndex;
  readonly costModel: CostModel;
  private readonly switchRows: CompactSwitch[] | undefined;
  private readonly networks: NetworkLabels | undefined;
  private schematicData: { network: TopoNetwork; switches: SwitchInfo[] } | undefined;

  constructor(readonly snapshot: Snapshot, opts: EngineOptions = {}) {
    this.graph = new RoutingGraph(snapshot.topology);
    this.index = new RoutebookIndex(snapshot);
    this.costModel = opts.costModel?.(snapshot) ?? trackPreferenceCostModel(snapshot.tracks);
    this.switchRows = opts.switches;
    this.networks = opts.networks;
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
   * Worker). `onUpdate` is called each time one more window is solved, with a
   * function that builds the layout from the windows solved so far; a window
   * without a solution keeps the heuristic layout (`Schematic.windows` says which).
   */
  schematics(result: RouteResult, solver: LpSolver, onUpdate?: (partial: () => Schematic, done: number, total: number) => void): { heuristic: Schematic; solved: Promise<Schematic> } {
    const prep = prepareSolvedLayout(result.routebook.route, { ...this.schematicInput(), tracks: this.snapshot.tracks, ops: this.snapshot.ops });
    if (!prep.problems.length) return { heuristic: prep.heuristic, solved: Promise.resolve(prep.heuristic) };
    const sofar: Array<LpSolution | null> = prep.problems.map(() => null);
    const solved = solver(prep.problems, (index, solution) => {
      sofar[index] = solution;
      const left = sofar.filter((x) => x === null).length;
      if (onUpdate && left) onUpdate(() => prep.finish(sofar), sofar.length - left, sofar.length);
    }).then(
      (solutions) => prep.finish(solutions),
      () => prep.finish(prep.problems.map(() => undefined)),
    );
    return { heuristic: prep.heuristic, solved };
  }

  route(from: OperationalPoint, to: OperationalPoint): RouteResult {
    if (from.id === to.id) throw new Error("Origin and destination are the same");
    const src = opEndpoint(from), dst = opEndpoint(to);
    if (src.intervals.length === 0) throw new Error(`${from.name} has no position on the track network in RINF`);
    if (dst.intervals.length === 0) throw new Error(`${to.name} has no position on the track network in RINF`);
    const route = this.graph.route(src.intervals, dst.intervals, { costModel: this.costModel });
    if (!route) throw new Error(`No route between ${from.name} and ${to.name} (not connected in the RINF topology)`);
    // the routebook only reports what lies on the tracks the train runs over, so the route must be one movement
    if (this.graph.breaks(route).length) throw new Error(`The route between ${from.name} and ${to.name} is not continuous`);
    const built = buildRoutebook({ index: this.index, route, from, to, endpointModes: { from: src.mode, to: dst.mode } });
    const routebook = this.networks ? addBorderItems(built, this.networks) : built;
    const geometry = buildRouteGeometry(route, this.snapshot.geometry ?? {}, this.graph.lengths);
    return { routebook, geometry };
  }
}
