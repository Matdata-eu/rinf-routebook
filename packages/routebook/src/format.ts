import type { Routebook, RoutebookItem } from "./types.js";

const QUALITY_MARK: Record<RoutebookItem["quality"], string> = { rinf: " ", derived: "~", approximate: "≈", missing: "!" };

/** Plain-text table, for the CLI and quick inspection. */
export function formatRoutebook(rb: Routebook, opts: { limit?: number; kinds?: string[] } = {}): string {
  const rows = rb.items.filter((i) => !opts.kinds || opts.kinds.includes(i.kind));
  const shown = opts.limit ? rows.slice(0, opts.limit) : rows;
  const out = [
    `${rb.from.name} (${rb.from.uopid}) -> ${rb.to.name} (${rb.to.uopid}): ${(rb.length / 1000).toFixed(2)} km, ${rb.items.length} items` +
      ` [endpoints: ${rb.endpointModes.from}/${rb.endpointModes.to}, cost model: ${rb.route.costModel}]`,
    "     dist(km)    line km  q  kind           item",
  ];
  for (const i of shown) {
    const extra = i.data && "signalType" in i.data ? ` (${String(i.data.signalType)})` : i.data && "boundary" in i.data ? ` (${String(i.data.boundary)})` : "";
    out.push(
      `${(i.distance / 1000).toFixed(3).padStart(13)}  ${i.km !== undefined ? i.km.toFixed(3).padStart(9) : "        -"}  ${QUALITY_MARK[i.quality]}  ${i.kind.padEnd(13)}  ${i.label ?? ""}${extra}`,
    );
  }
  if (shown.length < rows.length) out.push(`  ... ${rows.length - shown.length} more`);
  out.push("", "Not available in RINF (placeholders):", ...rb.gaps.map((g) => `  ! ${g.field}: ${g.reason}`));
  out.push("", "q: ' ' RINF, '~' derived, '≈' approximate, '!' missing");
  return out.join("\n");
}
