import type { Routebook, RoutebookItem } from "@routebook/routebook";

/**
 * Turns routebook items into strip rows: the speed and gradient in force are
 * carried forward so each row can show the bands, like a printed routebook.
 * Pure (no DOM) so it can be unit tested.
 */
export interface StripRow {
  item: RoutebookItem;
  index: number;
  speed?: number;
  speedMissing: boolean;
  speedChanged: boolean;
  gradient?: number;
  gradientChanged: boolean;
  line?: string;
}

export function stripRows(rb: Routebook): StripRow[] {
  let speed: number | undefined;
  let speedMissing = false;
  let gradient: number | undefined;
  let line: string | undefined;
  return rb.items.map((item, index) => {
    let speedChanged = false, gradientChanged = false;
    if (item.kind === "speed") {
      speed = item.data?.speed as number;
      speedMissing = false;
      speedChanged = true;
    } else if (item.kind === "missing" && item.data?.field === "speed") {
      speed = undefined;
      speedMissing = true;
      speedChanged = true;
    } else if (item.kind === "gradient") {
      gradient = item.data?.gradient as number;
      gradientChanged = true;
    } else if (item.kind === "line") {
      line = item.label;
    }
    return {
      item,
      index,
      ...(speed !== undefined ? { speed } : {}),
      speedMissing,
      speedChanged,
      ...(gradient !== undefined ? { gradient } : {}),
      gradientChanged,
      ...(line !== undefined ? { line } : {}),
    };
  });
}

/** Band colour for a speed (km/h): darker = faster. */
export function speedColor(v: number | undefined): string {
  if (v === undefined) return "transparent";
  const t = Math.max(0, Math.min(1, (v - 20) / 190));
  return `hsl(212 70% ${88 - t * 50}%)`;
}

/** Band colour for a gradient (‰): red uphill, blue downhill. */
export function gradientColor(g: number | undefined): string {
  if (g === undefined) return "transparent";
  const t = Math.min(1, Math.abs(g) / 25);
  if (Math.abs(g) < 0.5) return "hsl(0 0% 90%)";
  return g > 0 ? `hsl(8 75% ${92 - t * 40}%)` : `hsl(200 70% ${92 - t * 40}%)`;
}

export const KIND_LABELS: Record<string, string> = {
  origin: "Origin",
  destination: "Destination",
  op: "Operational point",
  line: "Line",
  speed: "Speed",
  gradient: "Gradient",
  tunnel: "Tunnel",
  signal: "Signal",
  switch: "Switch",
  kmPost: "Km post",
  levelCrossing: "Level crossing",
  missing: "Missing data",
};

export const QUALITY_LABELS: Record<RoutebookItem["quality"], { short: string; title: string }> = {
  rinf: { short: "R", title: "From RINF" },
  derived: { short: "D", title: "Derived from RINF data" },
  approximate: { short: "≈", title: "Approximate position or value" },
  missing: { short: "!", title: "Not available in RINF" },
};
