import type { Snapshot, Track } from "@routebook/rinf-client";
import { LocalFrame, along, curvature, norm, signedAngle, sub, type XY } from "./geo.js";
import { TopoNetwork, endKey, parseEndKey, type EndRef } from "./network.js";

/** Which rule decided the continuous branch (Bane NOR rule: ① same name ② same type ③ closest curvature). */
export type ContinuityRule = "name" | "type" | "curvature";
export type BranchSide = "left" | "right";

export interface SwitchInfo {
  /** Topology node of the switch in the TopoNetwork it was computed with. */
  node: number;
  /** Leg that is navigable to both branches. */
  common: EndRef;
  /** Branch that continues the common leg in the schematic (drawn straight). */
  continuous: EndRef;
  /** Branch that turns off (drawn as a diagonal). */
  deviating: EndRef;
  /** Side of the deviating branch relative to the continuous one, looking from the common leg into the switch. */
  deviatingSide: BranchSide;
  rule: ContinuityRule;
  /** Angle between the two branches (degrees) at the distance where the side was decided. */
  spread: number;
  /** era:Switch at this node, when RINF has one. */
  switchId?: string;
  label?: string;
}

export interface ClassifyOptions {
  /** Distances (m) from the switch at which the branches are compared for left/right; the first that separates them wins. */
  sideSamples?: number[];
  /** Length (m) of the section used for the curvature rule. */
  curvatureLength?: number;
  /** Length (m) of the common leg used as reference direction. */
  headingLength?: number;
}

const DEG = 180 / Math.PI;

function trackIndex(tracks: Track[]): Map<string, Track> {
  const m = new Map<string, Track>();
  for (const t of tracks) for (const e of t.elements) if (!m.has(e)) m.set(e, t);
  return m;
}

/**
 * Pick the continuous branch with the Bane NOR rule from the RINF workshop
 * slides (matdata-eu.github.io/slides-railway-topology, "schematic layouts
 * from topology"):
 *  1. the branch whose track has the same name as the common leg's track,
 *  2. else the branch whose track has the same type (running / siding),
 *  3. else the branch whose curvature is closest to the common leg's.
 * Returns the index (0 or 1) of the continuous branch.
 */
export function continuousBranch(
  common: { name?: string; kind?: string; curvature: number },
  branches: [{ name?: string; kind?: string; curvature: number }, { name?: string; kind?: string; curvature: number }],
): { index: 0 | 1; rule: ContinuityRule } {
  const [x, y] = branches;
  const sameName = (b: { name?: string }) => b.name !== undefined && b.name === common.name;
  if (sameName(x) !== sameName(y)) return { index: sameName(x) ? 0 : 1, rule: "name" };
  if (x.kind !== y.kind && common.kind !== undefined && (x.kind === common.kind || y.kind === common.kind)) {
    return { index: x.kind === common.kind ? 0 : 1, rule: "type" };
  }
  const dx = Math.abs(x.curvature - common.curvature);
  const dy = Math.abs(y.curvature - common.curvature);
  return { index: dx <= dy ? 0 : 1, rule: "curvature" };
}

/** Curvature (1/m) of the first `len` metres of a line, in its own direction of travel. */
function sectionCurvature(line: XY[], len: number): number {
  if (line.length < 2) return 0;
  const l = Math.min(len, polyLen(line));
  if (l < 2) return 0;
  return curvature(along(line, 0), along(line, l / 2), along(line, l));
}

function polyLen(line: XY[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += norm(sub(line[i]!, line[i - 1]!));
  return s;
}

/**
 * Classify every switch of the topology: which branch is continuous and on
 * which side the deviating branch lies.
 *
 * Left/right is decided spatially on a short piece of track next to the
 * switch. Each element's geometry runs from its origin to its end, so the
 * walk starts at whichever end touches the switch (reversing the geometry
 * when that is the element end) and continues into the next element when the
 * branch element is very short. The reference direction is the common leg,
 * pointing into the switch.
 */
export function classifySwitches(
  snapshot: Pick<Snapshot, "topology" | "geometry" | "tracks" | "features">,
  opts: ClassifyOptions & { network?: TopoNetwork } = {},
): SwitchInfo[] {
  const net = opts.network ?? new TopoNetwork(snapshot);
  const samples = opts.sideSamples ?? [20, 50, 100];
  const curvLen = opts.curvatureLength ?? 30;
  const headLen = opts.headingLength ?? 30;
  const tracks = trackIndex(snapshot.tracks);

  // era:Switch point features sit on an element end at the switch
  const switchAt = new Map<string, { id: string; label?: string }>();
  for (const f of snapshot.features) {
    if (f.kind !== "switch") continue;
    const len = net.lengths.get(f.ne);
    if (len === undefined) continue;
    const end = f.offset <= len - f.offset ? 0 : 1;
    switchAt.set(endKey({ ne: f.ne, end }), { id: f.id, ...(f.label ? { label: f.label } : {}) });
  }

  const out: SwitchInfo[] = [];
  net.nodes.forEach((ends, node) => {
    if (ends.length !== 3) return;
    const common = ends.find((e) => ends.filter((o) => o !== e && net.isNavigable(e, o)).length === 2);
    if (!common) return;
    const branches = ends.filter((e) => e !== common) as [EndRef, EndRef];
    if (net.isNavigable(branches[0], branches[1])) return;
    if (!net.hasGeometry(common.ne) || !branches.every((b) => net.hasGeometry(b.ne))) return;

    const origin = net.endPoint(common)!;
    const frame = new LocalFrame(origin[1]);
    const p0 = frame.xy(origin);
    // common leg walked away from the switch, then reversed: travel direction towards the switch
    const back = net.walk(common, Math.max(headLen, curvLen), frame);
    const ref = back.length >= 2 ? along(back, Math.min(headLen, polyLen(back))) : undefined;
    if (!ref) return;
    const heading = sub(p0, ref);
    if (norm(heading) === 0) return;

    const lines = branches.map((b) => net.walk(b, Math.max(...samples, curvLen), frame)) as [XY[], XY[]];
    if (lines.some((l) => l.length < 2)) return;

    // left/right: signed angle of each branch seen from the switch, first sample distance that separates them
    let angles: [number, number] = [0, 0];
    for (const s of samples) {
      angles = lines.map((l) => signedAngle(heading, sub(along(l, s), p0))) as [number, number];
      if (Math.abs(angles[0] - angles[1]) * DEG > 0.25) break;
    }

    const commonTrack = tracks.get(common.ne);
    // walked away from the switch, so flip the sign to get it in the direction of travel into the switch
    const commonCurv = -sectionCurvature(back, curvLen);
    const info = branches.map((b, i) => {
      const t = tracks.get(b.ne);
      return { name: t?.label, kind: t?.kind, curvature: sectionCurvature(lines[i as 0 | 1], curvLen) };
    }) as [{ name?: string; kind?: string; curvature: number }, { name?: string; kind?: string; curvature: number }];
    const { index, rule } = continuousBranch({ name: commonTrack?.label, kind: commonTrack?.kind, curvature: commonCurv }, info);
    const dev = (1 - index) as 0 | 1;
    const sw = switchAt.get(endKey(common)) ?? branches.map((b) => switchAt.get(endKey(b))).find(Boolean);
    out.push({
      node,
      common,
      continuous: branches[index],
      deviating: branches[dev],
      deviatingSide: angles[dev] > angles[index] ? "left" : "right",
      rule,
      spread: Math.abs(angles[0] - angles[1]) * DEG,
      ...(sw ? { switchId: sw.id, ...(sw.label ? { label: sw.label } : {}) } : {}),
    });
  });
  return out;
}

/** Compact JSON form for the web bundle: [commonKey, continuousKey, deviatingKey, "L"|"R", rule, switchId?, label?]. */
export type CompactSwitch = [string, string, string, "L" | "R", ContinuityRule, string?, string?];

export function compactSwitches(list: SwitchInfo[]): CompactSwitch[] {
  return list.map((s) => {
    const row: CompactSwitch = [endKey(s.common), endKey(s.continuous), endKey(s.deviating), s.deviatingSide === "left" ? "L" : "R", s.rule];
    if (s.switchId) row.push(s.switchId, s.label);
    return row;
  });
}

/** Inverse of compactSwitches, resolving the nodes in `net`. Rows whose elements are unknown are dropped. */
export function expandSwitches(rows: CompactSwitch[], net: TopoNetwork): SwitchInfo[] {
  const out: SwitchInfo[] = [];
  for (const [c, k, d, side, rule, switchId, label] of rows) {
    const common = parseEndKey(c);
    if (!net.lengths.has(common.ne)) continue;
    out.push({
      node: net.nodeOf(common),
      common,
      continuous: parseEndKey(k),
      deviating: parseEndKey(d),
      deviatingSide: side === "L" ? "left" : "right",
      rule,
      spread: NaN,
      ...(switchId ? { switchId } : {}),
      ...(label ? { label } : {}),
    });
  }
  return out;
}
