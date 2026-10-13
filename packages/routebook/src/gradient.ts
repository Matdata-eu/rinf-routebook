/** One breakpoint of an era:gradientProfile: from `km` onwards (increasing km) the gradient is `permille`. */
export interface GradientBreak {
  km: number;
  permille: number;
}

/**
 * Parse the Bane NOR gradientProfile string, e.g. "-9.0(+110.998), -4.7(+111.045)".
 * Unparseable parts are skipped. Result is sorted by km.
 */
export function parseGradientProfile(profile: string): GradientBreak[] {
  const out: GradientBreak[] = [];
  for (const m of profile.matchAll(/([+-]?\d+(?:\.\d+)?)\s*\(\s*([+-]?\d+(?:\.\d+)?)\s*\)/g)) {
    out.push({ permille: Number(m[1]), km: Number(m[2]) });
  }
  return out.sort((a, b) => a.km - b.km);
}

/** Least-squares km = a + b * distance. Returns undefined with < 2 distinct anchors. */
export function fitKm(anchors: Array<{ distance: number; km: number }>): ((d: number) => number) & { slope: number } | undefined {
  if (anchors.length < 2) return undefined;
  const n = anchors.length;
  const md = anchors.reduce((s, a) => s + a.distance, 0) / n;
  const mk = anchors.reduce((s, a) => s + a.km, 0) / n;
  let sxx = 0, sxy = 0;
  for (const a of anchors) {
    sxx += (a.distance - md) ** 2;
    sxy += (a.distance - md) * (a.km - mk);
  }
  if (sxx === 0) return undefined;
  const slope = sxy / sxx;
  const f = ((d: number) => mk + slope * (d - md)) as ((d: number) => number) & { slope: number };
  f.slope = slope;
  return f;
}
