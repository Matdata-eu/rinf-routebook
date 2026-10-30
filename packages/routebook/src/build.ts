import type { OperationalPoint, PointFeature, Snapshot, Track, Tunnel } from "@routebook/rinf-client";
import type { EndpointMode, Route, RouteStep } from "@routebook/routing";
import { RINF_GAPS } from "./gaps.js";
import { fitKm, parseGradientProfile } from "./gradient.js";
import { CHANGE_PARAMS } from "./params.js";
import type { ItemKind, Routebook, RoutebookItem, Stretch } from "./types.js";

export type RoutebookData = Pick<Snapshot, "ops" | "lines" | "sols" | "tracks" | "features" | "tunnels">;

const SIGNAL_TYPES: Record<string, string> = {
  "01": "home",
  "02": "intermediate",
  "03": "distant",
  "04": "exit",
  "06": "block",
  "12": "shunting",
};

/** Lower sorts first when items share a distance. */
const KIND_ORDER: Record<string, number> = {
  origin: 0,
  op: 1,
  border: 2,
  line: 3,
  change: 3.5,
  speed: 4,
  gradient: 5,
  tunnel: 6,
  separation: 6.5,
  signal: 7,
  switch: 8,
  levelCrossing: 9,
  kmPost: 10,
  missing: 11,
  destination: 99,
};

/** Stable order along the route: distance, then kind priority, then label. */
export function sortItems(items: RoutebookItem[]): RoutebookItem[] {
  return items
    .map((item, i) => ({ item, i }))
    .sort(
      (a, b) =>
        a.item.distance - b.item.distance ||
        (KIND_ORDER[a.item.kind] ?? 50) - (KIND_ORDER[b.item.kind] ?? 50) ||
        a.i - b.i,
    )
    .map((x) => x.item);
}

function groupBy<T>(xs: Iterable<T>, k: (x: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>();
  for (const x of xs) {
    const key = k(x);
    const l = m.get(key);
    if (l) l.push(x);
    else m.set(key, [x]);
  }
  return m;
}

/** Lookup tables over the snapshot, built once and reused for many routes. */
export class RoutebookIndex {
  readonly featuresByNe: Map<string, PointFeature[]>;
  readonly tunnelEnds: Map<string, Array<{ tunnel: Tunnel; end: "start" | "end" }>>;
  readonly tunnelAreasByNe = new Map<string, Array<{ tunnel: Tunnel; start: number; end: number }>>();
  readonly runningTracksByNe: Map<string, Track[]>;
  /** Sidings by element: where the route runs over a siding, its section parameters still apply. */
  readonly sidingsByNe = new Map<string, Track[]>();
  readonly lineOfTrack = new Map<string, string>();
  readonly lineLabel: Map<string, string>;
  readonly opsByNe = new Map<string, Array<{ op: OperationalPoint; start: number; end: number; km?: number; isPoint: boolean }>>();

  constructor(readonly data: RoutebookData) {
    this.featuresByNe = groupBy(data.features, (f) => f.ne);
    this.tunnelEnds = new Map();
    for (const t of data.tunnels) {
      for (const a of t.areas ?? []) {
        const l = this.tunnelAreasByNe.get(a.ne) ?? [];
        l.push({ tunnel: t, start: a.start, end: a.end });
        this.tunnelAreasByNe.set(a.ne, l);
      }
      if (t.areas?.length) continue; // area reference covers all tracks; start/end points only one
      for (const end of ["start", "end"] as const) {
        const ne = t[end].ne;
        const l = this.tunnelEnds.get(ne) ?? [];
        l.push({ tunnel: t, end });
        this.tunnelEnds.set(ne, l);
      }
    }
    this.runningTracksByNe = new Map();
    for (const t of data.tracks) {
      const byNe = t.kind === "running" ? this.runningTracksByNe : this.sidingsByNe;
      for (const ne of t.elements) {
        const l = byNe.get(ne) ?? [];
        l.push(t);
        byNe.set(ne, l);
      }
    }
    const solLine = new Map(data.sols.filter((s) => s.line).map((s) => [s.id, s.line!]));
    for (const t of data.tracks) {
      const line = t.partOf.map((p) => solLine.get(p)).find((l) => l);
      if (line) this.lineOfTrack.set(t.id, line);
    }
    this.lineLabel = new Map(data.lines.map((l) => [l.id, l.label]));
    for (const op of data.ops) {
      const refs = op.points.length > 0
        ? op.points.map((p) => ({ ne: p.ne, start: p.offset, end: p.offset, ...(p.km !== undefined ? { km: p.km } : {}), isPoint: true }))
        : op.areas.map((a) => ({ ...a, isPoint: false }));
      for (const r of refs) {
        const l = this.opsByNe.get(r.ne) ?? [];
        l.push({ op, ...r });
        this.opsByNe.set(r.ne, l);
      }
    }
  }
}

const lo = (s: RouteStep) => Math.min(s.from, s.to);
const hi = (s: RouteStep) => Math.max(s.from, s.to);
/** distance along the route of an offset on a step */
const at = (s: RouteStep, offset: number) => s.startDistance + Math.abs(offset - s.from);
const inStep = (s: RouteStep, offset: number) => offset >= lo(s) - 1e-6 && offset <= hi(s) + 1e-6;

export interface BuildRoutebookInput {
  index: RoutebookIndex;
  route: Route;
  from: OperationalPoint;
  to: OperationalPoint;
  endpointModes?: { from: EndpointMode; to: EndpointMode };
}

export function buildRoutebook({ index, route, from, to, endpointModes }: BuildRoutebookInput): Routebook {
  const items: RoutebookItem[] = [];
  const seen = new Set<string>();
  const push = (dedupeKey: string | undefined, item: RoutebookItem) => {
    if (dedupeKey) {
      if (seen.has(dedupeKey)) return;
      seen.add(dedupeKey);
    }
    items.push(item);
  };

  push(undefined, { kind: "origin", distance: 0, label: from.name, quality: "rinf", source: from.id, data: { uopid: from.uopid } });

  const tunnelCover = new Map<string, { tunnel: Tunnel; min: number; max: number }>();

  // --- point features, tunnels and intermediate OPs, per step
  for (const step of route.steps) {
    for (const f of index.featuresByNe.get(step.ne) ?? []) {
      if (!inStep(step, f.offset)) continue;
      if (f.kind === "signal" && f.direction && f.direction !== "both") {
        // assumption: "normal" = valid when travelling in increasing offset direction of the element
        if ((f.direction === "normal") !== step.forward) continue;
      }
      const code = f.signalType?.split("/").pop();
      push(f.id, {
        kind: f.kind,
        distance: at(step, f.offset),
        ...(f.km !== undefined ? { km: f.km } : {}),
        ...(f.label ? { label: f.label } : {}),
        quality: "rinf",
        source: f.id,
        ...(f.kind === "signal" ? { data: { signalType: (code && SIGNAL_TYPES[code]) ?? code, direction: f.direction } } : {}),
      });
    }
    for (const { tunnel, end } of index.tunnelEnds.get(step.ne) ?? []) {
      const pos = tunnel[end];
      if (!inStep(step, pos.offset)) continue;
      push(`${tunnel.id}|${end}`, {
        kind: "tunnel",
        distance: at(step, pos.offset),
        ...(pos.km !== undefined ? { km: pos.km } : {}),
        label: tunnel.label ?? tunnel.ident ?? "tunnel",
        quality: "derived",
        source: tunnel.id,
        data: { ident: tunnel.ident, length: tunnel.length, rinfEnd: end },
      });
    }
    for (const ref of index.tunnelAreasByNe.get(step.ne) ?? []) {
      const a = Math.max(ref.start, lo(step)), b = Math.min(ref.end, hi(step));
      if (b < a - 1e-6) continue;
      const d1 = at(step, a), d2 = at(step, b);
      const c = tunnelCover.get(ref.tunnel.id) ?? { tunnel: ref.tunnel, min: Infinity, max: -Infinity };
      c.min = Math.min(c.min, d1, d2);
      c.max = Math.max(c.max, d1, d2);
      tunnelCover.set(ref.tunnel.id, c);
    }
    for (const ref of index.opsByNe.get(step.ne) ?? []) {
      if (ref.op.id === from.id || ref.op.id === to.id) continue;
      if (hi(step) < ref.start - 1e-6 || lo(step) > ref.end + 1e-6) continue;
      // first point of the OP reference reached in travel direction
      const entry = step.forward ? Math.max(ref.start, lo(step)) : Math.min(ref.end, hi(step));
      const distance = at(step, entry);
      const existing = items.find((i) => i.kind === "op" && i.source === ref.op.id);
      if (existing) {
        if (distance < existing.distance) existing.distance = distance;
        continue;
      }
      push(undefined, {
        kind: "op",
        distance,
        ...(ref.km !== undefined ? { km: ref.km } : {}),
        label: ref.op.name,
        quality: ref.isPoint ? "rinf" : "derived",
        source: ref.op.id,
        data: { uopid: ref.op.uopid, type: ref.op.type?.split("/").pop(), reference: ref.isPoint ? "centre" : "area-entry" },
      });
    }
  }

  for (const { tunnel, min, max } of tunnelCover.values()) {
    const base = { kind: "tunnel" as const, label: tunnel.label ?? tunnel.ident ?? "tunnel", quality: "derived" as const, source: tunnel.id };
    const data = { ident: tunnel.ident, length: tunnel.length };
    // a boundary at the very start/end of the route means the route starts/ends inside the tunnel
    if (min > 1) push(undefined, { ...base, distance: min, data: { ...data, boundary: "enter" } });
    if (max < route.length - 1) push(undefined, { ...base, distance: max, data: { ...data, boundary: "exit" } });
    if (min <= 1 || max >= route.length - 1) {
      push(undefined, { ...base, distance: min, data: { ...data, boundary: min <= 1 ? "inside at start" : "inside at end" } });
    }
  }

  // tunnel boundaries from start/end points: the first one met is the entry
  for (const [, group] of groupBy(items.filter((i) => i.kind === "tunnel" && !tunnelCover.has(i.source!)), (i) => i.source!)) {
    group.sort((a, b) => a.distance - b.distance);
    group.forEach((g, n) => (g.data = { ...g.data, boundary: group.length === 1 ? "boundary" : n === 0 ? "enter" : "exit" }));
  }

  // km anchors along the route (used to place line-level attributes)
  const anchors = items
    .filter((i) => i.km !== undefined && (i.kind === "kmPost" || i.kind === "signal" || i.kind === "switch"))
    .map((i) => ({ distance: i.distance, km: i.km! }));

  // --- track spans: line, speed, gradient
  const spans: Array<{ track: Track | undefined; start: number; end: number; siding?: Track }> = [];
  for (const step of route.steps) {
    const tracks = index.runningTracksByNe.get(step.ne) ?? [];
    const prev = spans.at(-1);
    const track = tracks.find((t) => t.id === prev?.track?.id) ?? tracks[0];
    const siding = track ? undefined : (index.sidingsByNe.get(step.ne) ?? []).find((t) => t.id === prev?.siding?.id) ?? index.sidingsByNe.get(step.ne)?.[0];
    const end = step.startDistance + Math.abs(step.to - step.from);
    if (prev && prev.track?.id === track?.id && prev.siding?.id === siding?.id) prev.end = end;
    else spans.push({ track, start: step.startDistance, end, ...(siding ? { siding } : {}) });
  }
  const stretches: Stretch[] = [];

  let lastLine: string | undefined;
  let lastSpeed: number | undefined | null = null;
  for (const span of spans) {
    if (span.end - span.start < 1 && spans.length > 1) continue;
    const t = span.track;
    const spanAnchors = anchors.filter((a) => a.distance >= span.start && a.distance <= span.end);
    // km chainages can jump inside a span (e.g. different km references in the Oslo tunnel):
    // fit once, drop anchors more than 200 m off the line, fit again
    const first = fitKm(spanAnchors);
    const fit = first ? fitKm(spanAnchors.filter((a) => Math.abs(first(a.distance) - a.km) < 0.2)) ?? first : undefined;
    const kmAt = (d: number) => (fit ? { km: Math.round(fit(d) * 1000) / 1000 } : {});

    const line = t && index.lineOfTrack.get(t.id);
    if (line && line !== lastLine) {
      lastLine = line;
      push(undefined, { kind: "line", distance: span.start, ...kmAt(span.start), label: index.lineLabel.get(line) ?? line, quality: "rinf", source: line });
    }
    // what is in force here: the running track, else the siding the route runs over
    const pt = t ?? span.siding;
    const shownLine = line ?? (pt && index.lineOfTrack.get(pt.id)) ?? lastLine;
    const k0 = kmAt(span.start).km, k1 = kmAt(span.end).km;
    stretches.push({
      start: span.start,
      end: span.end,
      ...(pt ? { track: pt.id } : {}),
      ...(pt?.label ? { trackLabel: pt.label } : {}),
      ...(shownLine ? { line: shownLine, lineLabel: index.lineLabel.get(shownLine) ?? shownLine } : {}),
      ...(t?.speed !== undefined ? { speed: t.speed } : {}),
      ...(pt?.params ? { params: pt.params } : {}),
      ...(pt?.notApplicable?.length ? { notApplicable: pt.notApplicable } : {}),
      ...(pt?.notYetAvailable?.length ? { notYetAvailable: pt.notYetAvailable } : {}),
      ...(k0 !== undefined ? { kmStart: k0 } : {}),
      ...(k1 !== undefined ? { kmEnd: k1 } : {}),
    });
    // phase and system separations, placed by their line km on this part of the route
    for (const sep of pt?.separations ?? []) {
      if (sep.km === undefined || !fit || fit.slope === 0) continue;
      const d = span.start + (sep.km - fit(span.start)) / fit.slope;
      if (d < span.start - 1 || d > span.end + 1) continue;
      push(sep.id, {
        kind: "separation",
        distance: Math.max(span.start, Math.min(span.end, d)),
        km: sep.km,
        label: sep.kind === "phase" ? "Phase separation" : "System separation",
        quality: "approximate",
        source: sep.id,
        data: {
          separation: sep.kind,
          ...(sep.length !== undefined ? { length: sep.length } : {}),
          ...(sep.pantographLowered !== undefined ? { pantographLowered: sep.pantographLowered } : {}),
          ...(sep.switchOffBreaker !== undefined ? { switchOffBreaker: sep.switchOffBreaker } : {}),
          ...(sep.changeSupplySystem !== undefined ? { changeSupplySystem: sep.changeSupplySystem } : {}),
        },
        note: "position interpolated from km anchors (era:phaseInfoKm / era:systemSeparationInfoKm)",
      });
    }
    if (!t) continue;

    const speed = t.speed;
    if (speed !== lastSpeed) {
      lastSpeed = speed;
      push(undefined, speed !== undefined
        ? { kind: "speed", distance: span.start, ...kmAt(span.start), label: `${speed} km/h`, quality: "rinf", source: t.id, data: { speed }, note: "track-level era:maximumPermittedSpeed, not a speed profile" }
        : { kind: "missing", distance: span.start, label: "speed", quality: "missing", source: t.id, data: { field: "speed", state: t.notYetAvailable?.includes("speed") ? "notYetAvailable" : t.notApplicable?.includes("speed") ? "notApplicable" : "notPublished" }, note: t.notYetAvailable?.includes("speed") ? "the IM declares era:maximumPermittedSpeed not yet available for this track" : "track has no era:maximumPermittedSpeed" });
    }

    if (!t.gradientProfile) continue;
    const breaks = parseGradientProfile(t.gradientProfile);
    if (breaks.length === 0) continue;
    if (!fit || fit.slope === 0) {
      push(undefined, { kind: "missing", distance: span.start, label: "gradient position", quality: "missing", source: t.id, data: { field: "gradient", profile: t.gradientProfile }, note: "gradient profile present but no km anchors on this part of the route" });
      continue;
    }
    const increasing = fit.slope > 0;
    const distAt = (km: number) => span.start + (km - fit(span.start)) / fit.slope;
    const kmStart = fit(span.start), kmEnd = fit(span.end);
    const kLo = Math.min(kmStart, kmEnd), kHi = Math.max(kmStart, kmEnd);
    let lastG: number | undefined;
    const segments = breaks.map((b, i) => ({ from: b.km, to: breaks[i + 1]?.km ?? Infinity, g: b.permille }));
    const placed = segments
      .map((s) => {
        // gradient as seen by the train; entry km of the segment in travel direction
        const g = increasing ? s.g : -s.g;
        const entryKm = increasing ? s.from : s.to;
        const covers = kmStart >= s.from && kmStart < s.to;
        if (covers) return { distance: span.start, g, km: kmStart };
        if (entryKm > kLo && entryKm < kHi) return { distance: distAt(entryKm), g, km: entryKm };
        return undefined;
      })
      .filter((x): x is { distance: number; g: number; km: number } => !!x)
      .sort((a, b) => a.distance - b.distance);
    for (const p of placed) {
      if (p.g === lastG) continue;
      lastG = p.g;
      push(undefined, {
        kind: "gradient",
        distance: p.distance,
        km: Math.round(p.km * 1000) / 1000,
        label: `${p.g > 0 ? "+" : ""}${p.g.toFixed(1)} ‰`,
        quality: "approximate",
        source: t.id,
        data: { gradient: p.g },
        note: "position interpolated from km anchors; sign relative to travel direction",
      });
    }
  }

  for (const c of changeItems(mergeStretches(stretches))) push(undefined, c);

  push(undefined, { kind: "destination", distance: route.length, label: to.name, quality: "rinf", source: to.id, data: { uopid: to.uopid } });

  return {
    from,
    to,
    endpointModes: endpointModes ?? { from: "area", to: "area" },
    route,
    length: route.length,
    items: sortItems(items),
    stretches: mergeStretches(stretches),
    gaps: [...RINF_GAPS],
  };
}

const sameList = (a: string[] | undefined, b: string[] | undefined) => (a ?? []).join("|") === (b ?? []).join("|");
const sameParams = (a: Record<string, string> | undefined, b: Record<string, string> | undefined) => JSON.stringify(a ?? {}) === JSON.stringify(b ?? {});

/** Join neighbouring stretches with the same line, speed and parameters (one track after another). */
export function mergeStretches(stretches: Stretch[]): Stretch[] {
  const out: Stretch[] = [];
  for (const s of stretches) {
    const prev = out.at(-1);
    if (
      prev && prev.line === s.line && prev.speed === s.speed && prev.dataset === s.dataset &&
      sameParams(prev.params, s.params) && sameList(prev.notApplicable, s.notApplicable) && sameList(prev.notYetAvailable, s.notYetAvailable) &&
      (prev.track === undefined) === (s.track === undefined)
    ) {
      out[out.length - 1] = { ...prev, end: s.end, ...(s.kmEnd !== undefined ? { kmEnd: s.kmEnd } : {}), ...(prev.track !== s.track ? { trackLabel: undefined } : {}) };
      if (out.at(-1)!.trackLabel === undefined) delete out.at(-1)!.trackLabel;
    } else out.push({ ...s });
  }
  return out;
}

/** Stretches shorter than this do not start a new value: a short station track or a crossover is not a change. */
export const MIN_CHANGE_STRETCH = 100;

/**
 * "change" items where a section parameter (energy, class B, ETCS, radio, gauge) takes another value
 * along the route. Only known values are compared: a stretch where RINF says nothing neither starts
 * nor ends a value.
 */
export function changeItems(stretches: Stretch[]): RoutebookItem[] {
  const out: RoutebookItem[] = [];
  for (const { param, label, read } of CHANGE_PARAMS) {
    let last: string | undefined;
    for (const s of stretches) {
      if (s.end - s.start < MIN_CHANGE_STRETCH && stretches.length > 1) continue;
      const v = read(s);
      if (v === undefined) continue;
      if (last !== undefined && v !== last) {
        out.push({
          kind: "change",
          distance: s.start,
          ...(s.kmStart !== undefined ? { km: s.kmStart } : {}),
          label: `${label}: ${last} → ${v}`,
          quality: "derived",
          ...(s.track ? { source: s.track } : {}),
          data: { param, from: last, to: v },
          note: "where the track parameters change; the exact position is at the track boundary",
        });
      }
      last = v;
    }
  }
  return out;
}

export const ITEM_KINDS: ItemKind[] = Object.keys(KIND_ORDER) as ItemKind[];

export interface NetworkLabels {
  /** The dataset a micro element belongs to. */
  datasetOf: (ne: string) => string | undefined;
  /** Display name of a dataset (its infrastructure manager, or its name). */
  labelOf: (dataset: string) => string;
}

/**
 * On a route across RINF datasets: tag every item with its dataset, add a "border" item where the
 * route passes a border link (a change of infrastructure manager), and drop the second copy of a
 * border point that both datasets declare (same UOPID within 2 km of the first).
 */
export function addBorderItems(rb: Routebook, networks: NetworkLabels): Routebook {
  const steps = rb.route.steps;
  // the last step starting at or before `distance` (steps are in route order): a binary search,
  // as a long route across networks has thousands of steps and items
  const datasetAt = (distance: number): string | undefined => {
    if (!steps.length) return undefined;
    let lo = 0, hi = steps.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (steps[mid]!.startDistance <= distance + 1e-6) lo = mid;
      else hi = mid - 1;
    }
    return networks.datasetOf(steps[lo]!.ne);
  };
  const items: RoutebookItem[] = [];
  const borderUopids = new Map<string, number>();
  for (const item of rb.items) {
    const dataset = datasetAt(item.distance);
    const tagged = dataset ? { ...item, dataset } : item;
    if (item.kind === "op" && typeof item.data?.uopid === "string") {
      const seenAt = borderUopids.get(item.data.uopid);
      if (seenAt !== undefined && Math.abs(seenAt - item.distance) < 2000) continue;
      borderUopids.set(item.data.uopid, item.distance);
    }
    items.push(tagged);
  }
  let last = steps[0] ? networks.datasetOf(steps[0].ne) : undefined;
  for (const s of steps) {
    const ds = networks.datasetOf(s.ne);
    if (ds === last || ds === undefined) continue;
    items.push({
      kind: "border",
      distance: s.startDistance,
      label: `${networks.labelOf(last ?? "")} → ${networks.labelOf(ds)}`,
      quality: "derived",
      data: { from: last, to: ds },
      dataset: ds,
      note: "RINF has no connection between infrastructure managers' networks; this link was derived by Routebook from the border points",
    });
    last = ds;
  }
  const stretches = rb.stretches?.map((st) => {
    const dataset = datasetAt(Math.min(st.end, st.start + 0.5));
    return dataset ? { ...st, dataset } : st;
  });
  return { ...rb, items: sortItems(items), ...(stretches ? { stretches } : {}) };
}
