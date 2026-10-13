/** Small planar helpers. Coordinates are [lon, lat]; work is done in local metres. */

export type LngLat = [number, number];
export type XY = [number, number];

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320;

/** Equirectangular projection to metres around a reference latitude (good to well under 1 % over a few km). */
export class LocalFrame {
  private readonly kx: number;
  constructor(readonly lat0: number) {
    this.kx = M_PER_DEG_LON * Math.cos((lat0 * Math.PI) / 180);
  }
  xy([lon, lat]: LngLat): XY {
    return [lon * this.kx, (lat - this.lat0) * M_PER_DEG_LAT];
  }
}

export const sub = (a: XY, b: XY): XY => [a[0] - b[0], a[1] - b[1]];
export const dot = (a: XY, b: XY): number => a[0] * b[0] + a[1] * b[1];
export const cross = (a: XY, b: XY): number => a[0] * b[1] - a[1] * b[0];
export const norm = (a: XY): number => Math.hypot(a[0], a[1]);

/** Signed angle (radians, counter-clockwise positive) from direction `h` to vector `v`. */
export function signedAngle(h: XY, v: XY): number {
  return Math.atan2(cross(h, v), dot(h, v));
}

/**
 * Signed curvature (1/m, positive = turning left) of the circle through three
 * points, in the order of travel a -> b -> c. 0 for collinear points.
 */
export function curvature(a: XY, b: XY, c: XY): number {
  const ab = norm(sub(b, a)), bc = norm(sub(c, b)), ac = norm(sub(c, a));
  if (ab === 0 || bc === 0 || ac === 0) return 0;
  return (2 * cross(sub(b, a), sub(c, a))) / (ab * bc * ac);
}

/** Point `d` metres along a polyline (clamped to its ends). */
export function along(line: XY[], d: number): XY {
  if (line.length === 0) throw new Error("empty line");
  let rest = Math.max(0, d);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1]!, b = line[i]!;
    const seg = norm(sub(b, a));
    if (rest <= seg) {
      const t = seg === 0 ? 0 : rest / seg;
      return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    }
    rest -= seg;
  }
  return line.at(-1)!;
}

export function polylineLength(line: XY[]): number {
  let s = 0;
  for (let i = 1; i < line.length; i++) s += norm(sub(line[i]!, line[i - 1]!));
  return s;
}
