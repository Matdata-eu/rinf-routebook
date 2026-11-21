import type { Track } from "@routebook/rinf-client";

/**
 * A cost model turns physical distance on an element into routing cost.
 * The cost of travelling `metres` on element `ne` is `metres * factor(ne)`.
 * Factors must be >= 1 when the shortest physical route should win ties,
 * and must never be negative (Dijkstra).
 */
export interface CostModel {
  readonly name: string;
  factor(ne: string): number;
}

/** Pure physical distance. */
export const lengthCostModel: CostModel = { name: "length", factor: () => 1 };

export interface TrackPreferenceOptions {
  /** Factor for elements that only belong to sidings. Default 5. */
  sidingFactor?: number;
  /** Factor for elements not referenced by any track. Default 1.5. */
  unknownFactor?: number;
  /**
   * Running tracks slower than this (km/h, era:maximumPermittedSpeed) cost `slowSpeed / speed` per
   * metre, so a route keeps to the through track of a station rather than a slow loop or platform
   * track of about the same length. Tracks at or above it, and tracks without a speed, cost 1.
   * The factor never exceeds `sidingFactor`: a running track is never worse than a siding.
   * Default 80; 0 turns it off.
   */
  slowSpeed?: number;
}

/**
 * Default model: prefer running tracks over sidings, and fast running tracks over slow ones.
 * RINF has no "main track" semantics; the track kind and its maximum speed are the best signals
 * we have. Without the speed, a passing loop that is a few metres shorter than the through track
 * (Blaker on Kongsvingerbanen: track 2, 40 km/h, not electrified) wins and the routebook reports
 * that loop's parameters as if the train ran over it.
 */
export function trackPreferenceCostModel(tracks: Track[], opts: TrackPreferenceOptions = {}): CostModel {
  const sidingFactor = opts.sidingFactor ?? 5;
  const unknownFactor = opts.unknownFactor ?? 1.5;
  const slowSpeed = opts.slowSpeed ?? 80;
  const kind = new Map<string, "running" | "siding">();
  /** the lowest running-track factor of each element (the fastest running track over it) */
  const running = new Map<string, number>();
  for (const t of tracks) {
    for (const ne of t.elements) {
      // running wins when an element is shared
      if (t.kind === "running" || !kind.has(ne)) kind.set(ne, t.kind);
      if (t.kind !== "running") continue;
      const slow = t.speed !== undefined && t.speed > 0 && t.speed < slowSpeed;
      const f = slow ? Math.min(slowSpeed / t.speed!, Math.max(sidingFactor, 1)) : 1;
      running.set(ne, Math.min(f, running.get(ne) ?? Infinity));
    }
  }
  return {
    name: "prefer-running-tracks",
    factor: (ne) => {
      const k = kind.get(ne);
      return k === "running" ? running.get(ne) ?? 1 : k === "siding" ? sidingFactor : unknownFactor;
    },
  };
}
