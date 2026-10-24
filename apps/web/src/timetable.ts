import type { Routebook } from "@routebook/routebook";
import { DEFAULT_TRAIN, TrainSim, speedProfile, type LimitSpan, type TrainParams } from "./drive.js";

/**
 * A rough timetable for a routebook: leave the origin at a given time, stop at the chosen
 * operational points for a dwell time, and run in between like the Drive view's train (accelerate
 * to the RINF maximum speed, brake ahead of lower ones and of every stop). Not a running-time
 * calculation: no train mass, gradient resistance or timetable margins. Pure (no DOM).
 */

export interface TimetableOptions {
  /** departure from the origin, epoch ms */
  departure: number;
  /** UOPIDs of the operational points the train stops at (origin and destination always count) */
  stops: ReadonlySet<string>;
  /** seconds at each intermediate stop */
  dwell?: number;
  train?: TrainParams;
}

export interface TimetableEntry {
  /** index of the routebook item (origin, op or destination) */
  index: number;
  uopid?: string;
  name?: string;
  distance: number;
  /** epoch ms; arrival and departure at a stop, pass otherwise */
  arrival?: number;
  departure?: number;
  pass?: number;
  stop: boolean;
}

/** The speed profile between `a` and `b`, shifted to start at 0. */
function clip(profile: LimitSpan[], a: number, b: number): LimitSpan[] {
  return profile
    .filter((s) => s.end > a && s.start < b)
    .map((s) => ({ start: Math.max(0, s.start - a), end: Math.min(b, s.end) - a, ...(s.speed !== undefined ? { speed: s.speed } : {}) }));
}

/** Seconds to run from standstill to standstill over `length` metres of `profile`, with (d, t) samples. */
export function runSegment(profile: LimitSpan[], length: number, train: TrainParams = DEFAULT_TRAIN): { seconds: number; samples: Array<[number, number]> } {
  if (length <= 0.5) return { seconds: 0, samples: [[0, 0]] };
  const sim = new TrainSim(profile.length ? profile : [{ start: 0, end: length }], length, train);
  const samples: Array<[number, number]> = [[0, 0]];
  let t = 0;
  // 2 s steps (in 0.1 s sub-steps inside); a stuck train ends after a day of simulated time
  while (!sim.finished && t < 86_400) {
    sim.step(2);
    t += 2;
    samples.push([sim.d, t]);
  }
  return { seconds: t, samples };
}

/** Time (s) at distance `d` from (d, t) samples, interpolated. */
function timeAt(samples: Array<[number, number]>, d: number): number {
  let lo = 0, hi = samples.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (samples[mid]![0] < d) lo = mid + 1;
    else hi = mid;
  }
  const b = samples[lo]!, a = samples[Math.max(0, lo - 1)]!;
  if (b[0] === a[0]) return b[1];
  return a[1] + ((d - a[0]) / (b[0] - a[0])) * (b[1] - a[1]);
}

export function timetable(rb: Pick<Routebook, "items" | "length">, opts: TimetableOptions): TimetableEntry[] {
  const train = opts.train ?? DEFAULT_TRAIN;
  const dwell = (opts.dwell ?? 60) * 1000;
  const profile = speedProfile(rb as Routebook);
  const points = rb.items
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => item.kind === "origin" || item.kind === "op" || item.kind === "destination");
  const isStop = (p: (typeof points)[number]) => p.item.kind !== "op" || opts.stops.has(String(p.item.data?.uopid ?? ""));
  const out: TimetableEntry[] = [];
  let clock = opts.departure;
  let from = 0;
  let pending: typeof points = [];
  const flush = (to: number, stop: (typeof points)[number] | undefined) => {
    const run = runSegment(clip(profile, from, to), to - from, train);
    for (const p of pending) out.push(entry(p, { pass: clock + timeAt(run.samples, p.item.distance - from) * 1000 }, false));
    pending = [];
    clock += run.seconds * 1000;
    if (stop) {
      const last = stop.item.kind === "destination";
      out.push(entry(stop, { arrival: clock, ...(last ? {} : { departure: clock + dwell }) }, true));
      if (!last) clock += dwell;
    }
    from = to;
  };
  const entry = (p: (typeof points)[number], times: Pick<TimetableEntry, "arrival" | "departure" | "pass">, stop: boolean): TimetableEntry => ({
    index: p.index,
    ...(typeof p.item.data?.uopid === "string" ? { uopid: p.item.data.uopid } : {}),
    ...(p.item.label ? { name: p.item.label } : {}),
    distance: p.item.distance,
    ...times,
    stop,
  });
  for (const p of points) {
    if (p.item.kind === "origin") {
      out.push(entry(p, { departure: clock }, true));
      continue;
    }
    if (isStop(p)) flush(p.item.distance, p);
    else pending.push(p);
  }
  if (pending.length) flush(rb.length, undefined);
  return out;
}

/** "08:15" in local time. */
export function clockText(ms: number | undefined): string {
  if (ms === undefined) return "";
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A running time from the start: "+0:00", "+1:23" (hours:minutes), from ms since departure. */
export function elapsedText(ms: number | undefined): string {
  if (ms === undefined) return "";
  const min = Math.round(ms / 60_000);
  return `+${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`;
}

/** "08:15" -> epoch ms today (local time); undefined when it is not a time. */
export function parseClock(text: string | null | undefined, today = new Date()): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text?.trim() ?? "");
  if (!m) return undefined;
  const h = Number(m[1]), min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;
  const d = new Date(today);
  d.setHours(h, min, 0, 0);
  return d.getTime();
}
