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
}

/**
 * Default model: prefer running tracks over sidings. RINF has no "main track"
 * or permitted-direction semantics, so this is the best signal we have.
 */
export function trackPreferenceCostModel(tracks: Track[], opts: TrackPreferenceOptions = {}): CostModel {
  const sidingFactor = opts.sidingFactor ?? 5;
  const unknownFactor = opts.unknownFactor ?? 1.5;
  const kind = new Map<string, "running" | "siding">();
  for (const t of tracks) {
    for (const ne of t.elements) {
      // running wins when an element is shared
      if (t.kind === "running" || !kind.has(ne)) kind.set(ne, t.kind);
    }
  }
  return {
    name: "prefer-running-tracks",
    factor: (ne) => {
      const k = kind.get(ne);
      return k === "running" ? 1 : k === "siding" ? sidingFactor : unknownFactor;
    },
  };
}
