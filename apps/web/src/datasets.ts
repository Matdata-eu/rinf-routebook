import type { SnapshotMeta } from "@routebook/rinf-client";

/** One named graph of a dataset as ERA publishes it (meta.provenance / datasets.json `graphs`). */
export interface GraphInfo {
  graph: string;
  imCode: string;
  imName?: string;
  country?: string;
  datasetId?: string;
  fileName?: string;
  publishedAt?: string;
  triples?: number;
  fingerprint?: string;
}

export type DatasetStatus = "loaded" | "stale" | "pending" | "failed" | "removed";

/** One entry of datasets.json (written by `routebook fetch` / `routebook index`, or listed by the server). */
export interface DatasetInfo {
  id: string;
  name: string;
  imName?: string;
  /** When the data on offer was fetched; absent when no fetch ever succeeded. */
  fetchedAt?: string;
  ops?: number;
  /**
   * loaded (default), stale (ERA published newer data, `latest`; the sync fetches it), pending (on ERA,
   * not fetched yet), failed (last fetch failed, `error`; older data may still be there) or removed (no longer on ERA).
   */
  status?: DatasetStatus;
  /** What ERA publishes now, when it is not what was fetched (stale, pending). */
  latest?: GraphInfo[];
  error?: string;
  /** When ERA was last asked about this dataset. */
  checkedAt?: string;
  /** Latest ERA publication date among its graphs. */
  publishedAt?: string;
  graphs?: GraphInfo[];
  counts?: Record<string, number>;
  endpoint?: string;
}

/** datasets.json: the datasets on offer and when the endpoint was last checked. */
export interface DatasetCatalogue {
  checkedAt?: string;
  endpoint?: string;
  datasets: DatasetInfo[];
}

/** datasets.json as an older build wrote it (a bare list) or as it is now (an object with `datasets`). */
export function parseCatalogue(json: unknown): DatasetCatalogue {
  const entries = (list: unknown): DatasetInfo[] =>
    Array.isArray(list) ? list.filter((d): d is DatasetInfo => !!d && typeof d === "object" && typeof (d as DatasetInfo).id === "string").map((d) => ({ ...d, name: d.name || d.id })) : [];
  if (Array.isArray(json)) return { datasets: entries(json) };
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    return {
      ...(typeof o.checkedAt === "string" ? { checkedAt: o.checkedAt } : {}),
      ...(typeof o.endpoint === "string" ? { endpoint: o.endpoint } : {}),
      datasets: entries(o.datasets),
    };
  }
  return { datasets: [] };
}

/** Load datasets.json; an absent file means a single default dataset. */
export async function loadCatalogue(url: string, fetchImpl: typeof fetch = fetch): Promise<DatasetCatalogue> {
  try {
    const res = await fetchImpl(url, { cache: "no-cache" });
    if (!res.ok) return { datasets: [] };
    return parseCatalogue((await res.json()) as unknown);
  } catch {
    return { datasets: [] };
  }
}

/** The datasets of datasets.json alone. */
export async function loadDatasets(url: string, fetchImpl: typeof fetch = fetch): Promise<DatasetInfo[]> {
  return (await loadCatalogue(url, fetchImpl)).datasets;
}

/** Datasets the app can open: those with data (a failed fetch keeps its previous data on offer). */
export function loadable(list: DatasetInfo[]): DatasetInfo[] {
  return list.filter((d) => d.fetchedAt || !d.status || d.status === "loaded" || d.status === "stale");
}

/** "6 Oct 2026" for an ISO date, or "–". */
export function fmtDate(iso: string | undefined, time = false): string {
  if (!iso) return "–";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, time ? { dateStyle: "medium", timeStyle: "short" } : { dateStyle: "medium" });
}

/**
 * "27/28 datasets" (with data, of those listed; removed ones left out) for the Datasets button,
 * with the number of problems (failed) and of updates on their way (stale, pending); "" when there is nothing to say.
 */
export function datasetsSummary(list: DatasetInfo[]): { label: string; problems: number; updating: number } {
  const listed = list.filter((d) => d.status !== "removed");
  if (!listed.length) return { label: "", problems: 0, updating: 0 };
  const problems = listed.filter((d) => d.status === "failed").length;
  const updating = listed.filter((d) => d.status === "stale" || d.status === "pending").length;
  const n = listed.length;
  const withData = loadable(listed).length;
  const one = listed[0]!;
  const label = n === 1 ? (one.status === "failed" ? "1 dataset, failed" : one.status === "pending" ? "1 dataset, fetching" : one.status === "stale" ? "1 dataset, updating" : "1 dataset") : `${withData}/${n} datasets`;
  return { label, problems, updating };
}

/** The latest publication date among graphs, or undefined. */
export function latestOf(graphs: GraphInfo[] | undefined): string | undefined {
  return graphs?.map((g) => g.publishedAt).filter((d): d is string => !!d).sort().at(-1);
}

/** The IMs of a dataset as ERA names them, else the configured name, else the IM codes. */
export function imNames(d: Pick<DatasetInfo, "imName" | "graphs">): string {
  const names = [...new Set((d.graphs ?? []).map((g) => g.imName).filter((n): n is string => !!n))];
  if (names.length) return names.join(", ");
  if (d.imName) return d.imName;
  return (d.graphs ?? []).map((g) => g.imCode).join(", ");
}

/**
 * One line saying which RINF publication the data comes from, for the footer and the printed
 * routebook (the data credit next to it names ERA and the infrastructure manager).
 */
export function provenanceText(d: Pick<DatasetInfo, "name" | "graphs" | "publishedAt" | "fetchedAt" | "status" | "latest">): string {
  const ids = [...new Set((d.graphs ?? []).map((g) => g.datasetId).filter((x): x is string => !!x))];
  const parts = [
    `${d.name}: RINF dataset${ids.length ? ` ${ids.join(", ")}` : ""}`,
    d.publishedAt ? `published by ERA on ${fmtDate(d.publishedAt)}` : "ERA publication date unknown",
    d.fetchedAt ? `fetched ${fmtDate(d.fetchedAt)}` : "not fetched yet",
  ];
  if (d.status === "failed") parts.push("the last update failed");
  if (d.status === "stale") parts.push(`newer data published by ERA${d.latest ? ` on ${fmtDate(latestOf(d.latest))}` : ""}, update on its way`);
  if (d.status === "pending") parts.push("the first fetch is on its way");
  if (d.status === "removed") parts.push("no longer published by ERA");
  return parts.join(", ");
}

/**
 * Signals per kilometre of track a dataset needs before it counts as ready: Norway, which
 * publishes every main signal, has about one per km; half of that still gives a useful routebook.
 */
export const MIN_SIGNALS_PER_KM = 0.5;

export type ReadinessLevel = "ready" | "limited" | "unusable" | "unknown";

/** Whether Routebook can work on a dataset, and why not. */
export interface Readiness {
  level: ReadinessLevel;
  /** One short label for the dialog. */
  label: string;
  /** What is missing in RINF, in a sentence. */
  detail?: string;
}

/**
 * Can Routebook route on a dataset, judged from what it published: a micro topology (linear
 * elements and the net relations joining them), operational points placed on it (a route needs
 * one at each end) and signals (a routebook without them says little). `routableOps` comes from
 * the network index when the catalogue does not have it (data fetched by an older version).
 */
export function readiness(d: Pick<DatasetInfo, "counts" | "fetchedAt" | "status">, routableOps?: number): Readiness {
  const c = d.counts ?? {};
  if (!d.fetchedAt && !c.ops) return { level: "unknown", label: "Not fetched yet" };
  if (c.netElements === 0) return { level: "unusable", label: "No track network", detail: "RINF has no micro topology (linear elements) for this dataset, so there is nothing to route on." };
  if (c.netRelations === 0) return { level: "unusable", label: "Tracks not connected", detail: "RINF has no net relations between the linear elements, so a route cannot pass from one piece of track to the next." };
  const placed = c.routableOps ?? routableOps;
  if (placed === 0) return { level: "unusable", label: "OPs not on the track network", detail: "No operational point has a position on the track network (a net reference to a linear element), so no route can start or end in this dataset." };
  const signals = c.signals;
  const km = c.trackKm;
  if (signals === undefined || !km) return { level: "unknown", label: "Signals not counted", detail: "Fetched by an older version of Routebook; the next update counts the signals." };
  const perKm = signals / km;
  const density = `${signals.toLocaleString()} signals on ${km.toLocaleString()} km of track`;
  if (perKm < MIN_SIGNALS_PER_KM) return { level: "limited", label: signals ? "Few signals" : "No signals", detail: `Routes work, but ${density}: the routebook will miss most signals (ready from ${MIN_SIGNALS_PER_KM} per km).` };
  return { level: "ready", label: "Ready", detail: `${density}${placed !== undefined ? `, ${placed.toLocaleString()} operational points on the track network` : ""}.` };
}

/** The default public RINF Atlas instance (open source, by Matdata); set `atlasUrl` to false to drop the links. */
export const DEFAULT_ATLAS_URL = "https://rinf-atlas.matdata.eu";

/** Link to the dataset's graphs in RINF Atlas (`?ds=` takes provider graph IRIs; `era:` shortens the ERA namespace). */
export function atlasLink(base: string | false | undefined, graphs: Array<Pick<GraphInfo, "graph">> | undefined): string | undefined {
  if (base === false || !graphs?.length) return undefined;
  const root = (base || DEFAULT_ATLAS_URL).replace(/\/$/, "");
  const ds = graphs.map((g) => g.graph.replace(/^http:\/\/data\.europa\.eu\/949\//, "era:")).join(",");
  // keep the link readable: `:`, `/` and `,` are fine in a query value
  return `${root}/?ds=${encodeURIComponent(ds).replace(/%3A/g, ":").replace(/%2F/g, "/").replace(/%2C/g, ",")}`;
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

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

/**
 * "RINF © ERA, data: Bane NOR" style credit for the data of a snapshot. As HTML (the map's
 * attribution) the infrastructure manager's name is escaped: it comes from the data, not from us.
 */
export function rinfAttribution(meta: Pick<SnapshotMeta, "imName" | "name" | "country">, opts: { html?: boolean } = {}): string {
  const html = opts.html !== false;
  const era = html ? `<a href="https://graph.data.era.europa.eu/">European Union Agency for Railways</a>` : "European Union Agency for Railways";
  const im = meta.imName ? (html ? escapeHtml(meta.imName) : meta.imName) : "";
  return `RINF data © ${era}${im ? `, provided by ${im}` : ""}`;
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
