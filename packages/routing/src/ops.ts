import type { OperationalPoint, TopoInterval } from "@routebook/rinf-client";

export type EndpointMode = "point" | "area";

/**
 * Where a route starts or ends inside an OP. RINF OP areas are large (station
 * limits), so the centre point (era:NetPointReference) is preferred and the
 * area is the fallback.
 */
export function opEndpoint(op: OperationalPoint, mode: EndpointMode = "point"): { mode: EndpointMode; intervals: TopoInterval[] } {
  if (mode === "point" && op.points.length > 0) {
    return { mode: "point", intervals: op.points.map((p) => ({ ne: p.ne, start: p.offset, end: p.offset })) };
  }
  return { mode: "area", intervals: op.areas };
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().trim();

/** Resolve an OP by RINF id, uopid (e.g. "NOOSL") or exact/unique-prefix name (e.g. "Oslo S"). */
export function resolveOp(ops: OperationalPoint[], query: string): OperationalPoint {
  const q = norm(query);
  const exact = ops.filter((o) => o.id === query || norm(o.uopid) === q || norm(o.name) === q);
  if (exact.length === 1) return exact[0]!;
  // several OPs can share a name (e.g. a station and a technical change point); prefer one with a net reference
  if (exact.length > 1) return exact.find((o) => o.areas.length > 0 || o.points.length > 0) ?? exact[0]!;
  const prefix = ops.filter((o) => norm(o.name).startsWith(q));
  if (prefix.length === 1) return prefix[0]!;
  if (prefix.length > 1) {
    throw new Error(`"${query}" is ambiguous: ${prefix.slice(0, 8).map((o) => `${o.name} (${o.uopid})`).join(", ")}`);
  }
  throw new Error(`No operational point matches "${query}"`);
}
