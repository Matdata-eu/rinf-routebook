import { PARAMS, PARAM_STATE_LABELS, energyOf, etcsOf, paramOf as trackParam, type ParamState, type Routebook, type RoutebookItem, type Stretch } from "@routebook/routebook";

/**
 * The line strip: the route as vertical bands, one per topic, like a paper route book. This module
 * turns a routebook into band segments and marks; line-strip.ts draws them. Pure (no DOM) so it can
 * be unit tested. Distances are route distances in metres.
 */

export interface BandSegment {
  start: number;
  end: number;
  state: ParamState;
  /** the value as RINF gives it (title, section card) */
  value?: string;
  /** what fits in the band */
  short?: string;
}

export interface BandDef {
  id: string;
  label: string;
  /** what a segment of the band is, per stretch */
  read: (s: Stretch) => { state: ParamState; value?: string };
  short?: (value: string) => string;
  /** px */
  width: number;
}

/** "AC 15kV-16.7Hz" -> "15 kV ~", "DC 3kV" -> "3 kV =", "Not electrified" -> "none". */
export function shortEnergy(v: string): string {
  if (/not electrified/i.test(v)) return "none";
  const m = /(AC|DC)\s*([\d.,]+)\s*kV/i.exec(v);
  if (m) return `${m[2]!.replace(",", ".")} kV ${m[1]!.toUpperCase() === "AC" ? "~" : "="}`;
  const v600 = /(AC|DC)\s*(\d+)\s*V/i.exec(v);
  if (v600) return `${v600[2]} V ${v600[1]!.toUpperCase() === "AC" ? "~" : "="}`;
  return v.length > 8 ? `${v.slice(0, 7)}…` : v;
}

/** A parameter of a stretch; where the route runs on no RINF track there is nothing to say. */
const paramOf = (s: Stretch, key: string): { state: ParamState; value?: string } => (s.track ? trackParam(s, key) : { state: "noTrack" });

const stateOfKeys = (s: Stretch, keys: string[]): { state: ParamState; value?: string } => {
  // the first key with a value, else the most telling state of them
  const all = keys.map((k) => paramOf(s, k));
  const withValue = all.find((p) => p.state === "value");
  if (withValue) return withValue;
  for (const st of ["notApplicable", "notYetAvailable", "notPublished", "noTrack"] as const) if (all.some((p) => p.state === st)) return { state: st };
  return { state: "notPublished" };
};

export const BANDS: BandDef[] = [
  {
    id: "speed",
    label: "km/h",
    width: 52,
    read: (s) => (s.speed !== undefined ? { state: "value", value: String(s.speed) } : s.track ? paramOf(s, "speed") : { state: "noTrack" }),
  },
  {
    id: "energy",
    label: "Energy",
    width: 60,
    read: (s) => {
      const v = energyOf(s);
      return v ? { state: "value", value: v } : stateOfKeys(s, ["energySupply", "contactLine"]);
    },
    short: shortEnergy,
  },
  {
    id: "classB",
    label: "Class B",
    width: 56,
    read: (s) => paramOf(s, "protectionLegacy"),
    short: (v) => (v.length > 7 ? `${v.slice(0, 6)}…` : v),
  },
  {
    id: "etcs",
    label: "ETCS",
    width: 46,
    read: (s) => {
      const v = etcsOf(s);
      if (v === "No ETCS") return { state: "notApplicable" };
      return v ? { state: "value", value: v } : paramOf(s, "etcsLevel");
    },
    short: (v) => v.replace(/^ETCS level /, "L"),
  },
  {
    id: "radio",
    label: "GSM-R",
    width: 50,
    read: (s) => paramOf(s, "gsmR"),
    short: (v) => v.replace(/^Baseline\s*/i, "B"),
  },
];

/** A band's segments along the route: neighbouring stretches with the same state and value joined. */
export function bandSegments(rb: Pick<Routebook, "stretches" | "length">, band: Pick<BandDef, "read" | "short">): BandSegment[] {
  const out: BandSegment[] = [];
  for (const s of rb.stretches ?? []) {
    const { state, value } = band.read(s);
    const last = out.at(-1);
    if (last && last.state === state && last.value === value && Math.abs(last.end - s.start) < 1) {
      last.end = s.end;
      continue;
    }
    out.push({ start: s.start, end: s.end, state, ...(value !== undefined ? { value, short: band.short ? band.short(value) : value } : {}) });
  }
  return out;
}

/** Gradient spans from the gradient items (‰ in the direction of travel). */
export function gradientSegments(rb: Pick<Routebook, "items" | "length">): Array<{ start: number; end: number; gradient: number }> {
  const items = rb.items.filter((i) => i.kind === "gradient");
  return items.map((i, n) => ({ start: i.distance, end: items[n + 1]?.distance ?? rb.length, gradient: i.data?.gradient as number })).filter((s) => s.end > s.start);
}

/** Tunnels as intervals along the route, from their enter / exit items. */
export function tunnelSpans(rb: Pick<Routebook, "items" | "length">): Array<{ start: number; end: number; label?: string; length?: number }> {
  const open = new Map<string, RoutebookItem>();
  const out: Array<{ start: number; end: number; label?: string; length?: number }> = [];
  const push = (a: RoutebookItem, end: number) =>
    out.push({ start: a.distance, end, ...(a.label ? { label: a.label } : {}), ...(typeof a.data?.length === "number" ? { length: a.data.length as number } : {}) });
  for (const i of rb.items) {
    if (i.kind !== "tunnel" || !i.source) continue;
    const b = i.data?.boundary;
    if (b === "enter" || b === "inside at start") open.set(i.source, i);
    else if (b === "exit" || b === "inside at end") {
      const a = open.get(i.source);
      if (a) push(a, i.distance);
      else push({ ...i, distance: 0 }, i.distance);
      open.delete(i.source);
    }
  }
  for (const a of open.values()) push(a, rb.length);
  return out.sort((a, b) => a.start - b.start);
}

/** The stretch in force at `d`. */
export function stretchAt(rb: Pick<Routebook, "stretches">, d: number): Stretch | undefined {
  const st = rb.stretches ?? [];
  let lo = 0, hi = st.length - 1;
  if (hi < 0) return undefined;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (st[mid]!.start <= d) lo = mid;
    else hi = mid - 1;
  }
  return st[lo];
}

export interface ParamRow {
  key: string;
  label: string;
  state: ParamState;
  value?: string;
  rinf?: string;
}

/** Everything the section card lists for a stretch: speed, then the section parameters, with their states. */
export function sectionRows(s: Stretch): ParamRow[] {
  const speed: ParamRow = s.speed !== undefined
    ? { key: "speed", label: "Maximum speed (track)", state: "value", value: `${s.speed} km/h`, rinf: "1.1.1.1.2.5" }
    : { key: "speed", label: "Maximum speed (track)", ...paramOf(s, "speed"), rinf: "1.1.1.1.2.5" };
  return [
    speed,
    ...PARAMS.map((p) => {
      const v = paramOf(s, p.key);
      return { key: p.key, label: p.label, state: v.state, ...(v.value !== undefined ? { value: p.unit && /^\d+$/.test(v.value) ? `${v.value} ${p.unit}` : v.value } : {}), rinf: p.rinf };
    }),
  ];
}

export interface Coverage {
  key: string;
  label: string;
  /** share of the route length (0..1) per state */
  shares: Record<ParamState, number>;
}

/** For each parameter: how much of the route has a value, is not applicable, not yet available or not published. */
export function routeCoverage(rb: Pick<Routebook, "stretches" | "length">): Coverage[] {
  const total = rb.length || 1;
  const rows: Array<{ key: string; label: string; read: (s: Stretch) => ParamState }> = [
    { key: "speed", label: "Maximum speed", read: (s) => (s.speed !== undefined ? "value" : s.track ? paramOf(s, "speed").state : "noTrack") },
    ...PARAMS.map((p) => ({ key: p.key, label: p.label, read: (s: Stretch) => paramOf(s, p.key).state })),
  ];
  return rows.map(({ key, label, read }) => {
    const shares = { value: 0, notApplicable: 0, notYetAvailable: 0, notPublished: 0, noTrack: 0 } as Record<ParamState, number>;
    for (const s of rb.stretches ?? []) shares[read(s)] += (s.end - s.start) / total;
    return { key, label, shares };
  });
}

export const STATE_LABELS = PARAM_STATE_LABELS;

/** Strip zoom levels: route km shown per screen height. */
export const STRIP_ZOOMS = [2, 5, 10, 30, 60] as const;

/** Route distance <-> y (px) in the strip; ahead up draws the start at the bottom. */
export function stripScale(length: number, metresPerPx: number, aheadUp: boolean, pad = 24) {
  const height = Math.ceil(length / metresPerPx) + 2 * pad;
  return {
    height,
    y: (d: number) => (aheadUp ? height - pad - d / metresPerPx : pad + d / metresPerPx),
    d: (y: number) => Math.max(0, Math.min(length, aheadUp ? (height - pad - y) * metresPerPx : (y - pad) * metresPerPx)),
  };
}

/**
 * Labels that fit: `marks` in priority order are kept when they are at least `minGap` px from
 * every label kept before (y from `y`). Returns the kept marks in their original order.
 */
export function thinLabels<T>(marks: T[], y: (m: T) => number, priority: (m: T) => number, minGap: number): T[] {
  const order = marks.map((m, i) => ({ m, i, p: priority(m), y: y(m) })).sort((a, b) => b.p - a.p || a.i - b.i);
  const kept: Array<{ m: T; i: number; y: number }> = [];
  const ys: number[] = [];
  for (const o of order) {
    // binary search the nearest kept y
    let lo = 0, hi = ys.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ys[mid]! < o.y) lo = mid + 1;
      else hi = mid;
    }
    const near = Math.min(lo < ys.length ? Math.abs(ys[lo]! - o.y) : Infinity, lo > 0 ? Math.abs(ys[lo - 1]! - o.y) : Infinity);
    if (near < minGap) continue;
    ys.splice(lo, 0, o.y);
    kept.push(o);
  }
  return kept.sort((a, b) => a.i - b.i).map((k) => k.m);
}
