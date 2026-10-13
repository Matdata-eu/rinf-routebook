/**
 * Browser-safe helpers to shrink a snapshot for the web app (no Node imports).
 *
 * - IRIs: frequent namespace prefixes are replaced by short tokens ("~0/", "~1/", ...).
 * - Geometry: vertices are simplified (Douglas-Peucker) and rounded.
 *
 * The web bundle has the same parts as a snapshot plus `prefixes` in `meta`.
 */
import type { Snapshot, SnapshotMeta } from "./types.js";

export const WEB_PARTS = ["meta", "ops", "lines", "sols", "topology", "tracks", "features", "tunnels", "geometry"] as const;
export type WebPart = (typeof WEB_PARTS)[number];

export interface WebBundleMeta extends SnapshotMeta {
  /** token -> IRI prefix */
  prefixes: Record<string, string>;
}

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

function walk(v: Json, fn: (s: string) => string): Json {
  if (typeof v === "string") return fn(v);
  if (Array.isArray(v)) return v.map((x) => walk(x, fn));
  if (v && typeof v === "object") {
    const out: { [k: string]: Json } = {};
    for (const [k, x] of Object.entries(v)) out[fn(k)] = walk(x, fn);
    return out;
  }
  return v;
}

function collectPrefixes(snapshot: Snapshot, max = 8): string[] {
  const counts = new Map<string, number>();
  walk(snapshot as unknown as Json, (s) => {
    if (s.startsWith("http://") || s.startsWith("https://")) {
      const p = s.slice(0, s.lastIndexOf("/") + 1);
      counts.set(p, (counts.get(p) ?? 0) + 1);
    }
    return s;
  });
  return [...counts]
    .filter(([, n]) => n >= 50)
    .sort((a, b) => b[1] * b[0].length - a[1] * a[0].length)
    .slice(0, max)
    .map(([p]) => p)
    .sort((a, b) => b.length - a.length); // longest first when compacting
}

/** Perpendicular-distance Douglas-Peucker on lon/lat (tolerance in degrees). */
export function simplifyLine(coords: Array<[number, number]>, tolerance: number): Array<[number, number]> {
  if (coords.length <= 2) return coords;
  const keep = new Uint8Array(coords.length);
  keep[0] = keep[coords.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, coords.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const [ax, ay] = coords[a]!, [bx, by] = coords[b]!;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let maxD = -1, idx = -1;
    for (let i = a + 1; i < b; i++) {
      const [px, py] = coords[i]!;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
      const d = Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
      if (d > maxD) {
        maxD = d;
        idx = i;
      }
    }
    if (maxD > tolerance) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  return coords.filter((_, i) => keep[i]);
}

const r5 = (n: number) => Math.round(n * 1e5) / 1e5;

/** Snapshot -> web bundle parts (JSON-ready). */
export function toWebBundle(snapshot: Snapshot, opts: { tolerance?: number } = {}): Record<WebPart, unknown> {
  const prefixList = collectPrefixes(snapshot);
  const prefixes: Record<string, string> = {};
  prefixList.forEach((p, i) => (prefixes[`~${i}/`] = p));
  const compact = (s: string) => {
    for (const [token, p] of Object.entries(prefixes)) if (s.startsWith(p)) return token + s.slice(p.length);
    return s;
  };
  const tol = opts.tolerance ?? 1e-5; // ~1 m
  const geometry: Record<string, Array<[number, number]>> = {};
  for (const [id, coords] of Object.entries(snapshot.geometry ?? {})) {
    geometry[id] = simplifyLine(coords, tol).map(([x, y]) => [r5(x), r5(y)]);
  }
  const out = {} as Record<WebPart, unknown>;
  for (const part of WEB_PARTS) {
    const value = part === "geometry" ? geometry : snapshot[part];
    out[part] = walk(value as unknown as Json, compact);
  }
  out.meta = { ...(out.meta as object), prefixes } satisfies Partial<WebBundleMeta>;
  return out;
}

/** Web bundle parts -> snapshot (IRIs restored). */
export function fromWebBundle(parts: Record<WebPart, unknown>): Snapshot {
  const prefixes = (parts.meta as WebBundleMeta).prefixes ?? {};
  const tokens = Object.entries(prefixes);
  const expand = (s: string) => {
    if (s.charCodeAt(0) !== 126 /* ~ */) return s;
    for (const [token, p] of tokens) if (s.startsWith(token)) return p + s.slice(token.length);
    return s;
  };
  const out = {} as Record<WebPart, unknown>;
  for (const part of WEB_PARTS) out[part] = part === "meta" ? parts.meta : walk(parts[part] as Json, expand);
  return out as unknown as Snapshot;
}
