import type { SnapshotMeta } from "@routebook/rinf-client";

/** One entry of datasets.json (written by `routebook fetch` / `routebook index`, or listed by the server). */
export interface DatasetInfo {
  id: string;
  name: string;
  imName?: string;
  fetchedAt?: string;
}

/** Load datasets.json; an absent file means a single default dataset. */
export async function loadDatasets(url: string, fetchImpl: typeof fetch = fetch): Promise<DatasetInfo[]> {
  try {
    const res = await fetchImpl(url, { cache: "no-cache" });
    if (!res.ok) return [];
    const list = (await res.json()) as unknown;
    return Array.isArray(list) ? list.filter((d): d is DatasetInfo => !!d && typeof d.id === "string").map((d) => ({ ...d, name: d.name || d.id })) : [];
  } catch {
    return [];
  }
}

/** The dataset to open: the URL's, the configured default, then the first one on offer ("nor" when nothing is listed). */
export function pickDataset(list: DatasetInfo[], requested: string | null | undefined, fallback?: string): string {
  const ids = list.map((d) => d.id.toLowerCase());
  for (const want of [requested, fallback]) {
    const w = want?.trim().toLowerCase();
    if (w && (ids.length === 0 || ids.includes(w))) return w;
  }
  return ids[0] ?? "nor";
}

/** "RINF © ERA, data: Bane NOR" style credit for the data of a snapshot. */
export function rinfAttribution(meta: Pick<SnapshotMeta, "imName" | "name" | "country">, opts: { html?: boolean } = {}): string {
  const era = opts.html === false ? "European Union Agency for Railways" : `<a href="https://graph.data.era.europa.eu/">European Union Agency for Railways</a>`;
  return `RINF data © ${era}${meta.imName ? `, provided by ${meta.imName}` : ""}`;
}

/** Example routes that are known to work, per dataset. Deployments add their own in config.json (`examples`). */
export const BUILTIN_EXAMPLES: Record<string, Array<{ from: string; to: string; label: string }>> = {
  nor: [
    { from: "NOOSL", to: "NODRM", label: "Oslo S → Drammen" },
    { from: "NOOSL", to: "NOBRG", label: "Oslo S → Bergen" },
    { from: "NOTND", to: "NOBO", label: "Trondheim S → Bodø" },
  ],
};

export function examplesFor(dataset: string, configured?: Record<string, Array<{ from: string; to: string; label?: string }>>): Array<{ from: string; to: string; label?: string }> {
  return configured?.[dataset] ?? BUILTIN_EXAMPLES[dataset] ?? [];
}
