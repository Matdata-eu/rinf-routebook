import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_PARTS, toWebBundle } from "./compact.js";
import { imCodeOf, latestPublication } from "./era.js";
import type { GraphProvenance, Snapshot, SnapshotMeta } from "./types.js";

/**
 * A snapshot is stored as one JSON file per part, so that a browser can load
 * only what it needs (e.g. ops.json + sols.json for the overview map).
 */
const PARTS = ["meta", "ops", "lines", "sols", "topology", "tracks", "features", "tunnels", "geometry"] as const;
type Part = (typeof PARTS)[number];

export async function saveSnapshot(dir: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const part of PARTS) {
    await writeFile(join(dir, `${part}.json`), JSON.stringify(snapshot[part]));
  }
}

export async function loadSnapshot(dir: string): Promise<Snapshot> {
  const entries = await Promise.all(
    PARTS.map(async (part) => [part, JSON.parse(await readFile(join(dir, `${part}.json`), "utf8"))] as const),
  );
  return Object.fromEntries(entries) as Record<Part, unknown> as Snapshot;
}

/**
 * Write the compact browser bundle (see compact.ts) as one JSON file per part.
 * `extras` are written as additional parts (`<name>.json`) with the same IRI compaction.
 */
export async function saveWebBundle(dir: string, snapshot: Snapshot, extras: Record<string, unknown> = {}): Promise<void> {
  await mkdir(dir, { recursive: true });
  const parts = toWebBundle(snapshot, { extras });
  for (const part of [...WEB_PARTS, ...Object.keys(extras)]) {
    await writeFile(join(dir, `${part}.json`), JSON.stringify(parts[part]));
  }
}

/** One entry of datasets.json: a web bundle the app can load, or a dataset whose last fetch failed. */
export interface DatasetEntry {
  /** Folder name and `?dataset=` value, lower case. */
  id: string;
  name: string;
  imName?: string;
  /** When the data that is there was fetched; absent when no fetch ever succeeded. */
  fetchedAt?: string;
  ops: number;
  /**
   * loaded: the bundle is there and its last fetch succeeded;
   * failed: the last fetch failed (`error`; the previous bundle, if any, is still served);
   * removed: ERA no longer publishes the dataset, the bundle stays.
   */
  status: DatasetStatus;
  error?: string;
  /** When the dataset was last fetched or checked against ERA. */
  checkedAt?: string;
  /** Latest ERA publication date among the dataset's graphs. */
  publishedAt?: string;
  graphs?: GraphProvenance[];
  counts?: Record<string, number>;
  endpoint?: string;
  ontologyVersion?: string;
}

export type DatasetStatus = "loaded" | "failed" | "removed";

/** datasets.json: the datasets on offer and when the endpoint was last checked. */
export interface DatasetCatalogue {
  version: 2;
  /** When the datasets were last compared with the endpoint (a fetch, fetch-all or sync). */
  checkedAt?: string;
  endpoint?: string;
  datasets: DatasetEntry[];
}

export function datasetEntry(id: string, meta: SnapshotMeta): DatasetEntry {
  const publishedAt = latestPublication(meta.provenance);
  return {
    id,
    name: meta.name ?? meta.country,
    ...(meta.imName ? { imName: meta.imName } : {}),
    fetchedAt: meta.fetchedAt,
    ops: meta.counts?.ops ?? 0,
    status: "loaded",
    ...(meta.checkedAt ? { checkedAt: meta.checkedAt } : {}),
    ...(publishedAt ? { publishedAt } : {}),
    ...(meta.provenance ? { graphs: meta.provenance } : {}),
    ...(meta.counts ? { counts: meta.counts } : {}),
    ...(meta.endpoint ? { endpoint: meta.endpoint } : {}),
    ...(meta.ontologyVersion ? { ontologyVersion: meta.ontologyVersion } : {}),
  };
}

/** A fetch that did not succeed, to record in the catalogue. */
export interface DatasetFailure {
  id: string;
  name?: string;
  imName?: string;
  error: string;
  graphs?: string[];
  at?: string;
}

/** datasets.json as an older version wrote it (a bare list) or as it is now. */
export function parseCatalogue(json: unknown): DatasetCatalogue {
  const entries = (list: unknown): DatasetEntry[] =>
    Array.isArray(list)
      ? list
          .filter((d): d is Record<string, unknown> => !!d && typeof d === "object" && typeof (d as { id?: unknown }).id === "string")
          .map((d) => ({ ...(d as unknown as DatasetEntry), name: String(d.name || d.id), ops: Number(d.ops ?? 0) || 0, status: d.status === "failed" || d.status === "removed" ? d.status : "loaded" }))
      : [];
  if (Array.isArray(json)) return { version: 2, datasets: entries(json) };
  if (json && typeof json === "object") {
    const o = json as Record<string, unknown>;
    return {
      version: 2,
      ...(typeof o.checkedAt === "string" ? { checkedAt: o.checkedAt } : {}),
      ...(typeof o.endpoint === "string" ? { endpoint: o.endpoint } : {}),
      datasets: entries(o.datasets),
    };
  }
  return { version: 2, datasets: [] };
}

/** Read `root/datasets.json`; an absent or broken file is an empty catalogue. */
export async function readCatalogue(root: string): Promise<DatasetCatalogue> {
  try {
    return parseCatalogue(JSON.parse(await readFile(join(root, "datasets.json"), "utf8")));
  } catch {
    return { version: 2, datasets: [] };
  }
}

export interface IndexOptions {
  /** Fetches that failed in this run; recorded on the dataset (its previous bundle stays listed). */
  failures?: DatasetFailure[];
  /** Datasets ERA no longer publishes (ids); marked removed, bundles kept. */
  removed?: string[];
  /** When the endpoint was compared with the data (default: kept from the previous catalogue). */
  checkedAt?: string;
  endpoint?: string;
}

/**
 * List the web bundles in `root` (one folder per dataset with a meta.json), merge the
 * outcome of this run and what the previous catalogue knew (failures without a bundle),
 * and write `root/datasets.json`, which the web app and the server read.
 */
export async function writeDatasetIndex(root: string, opts: IndexOptions = {}): Promise<DatasetEntry[]> {
  const previous = await readCatalogue(root);
  const byId = new Map<string, DatasetEntry>();
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(join(root, d.name, "meta.json"), "utf8")) as SnapshotMeta;
      byId.set(d.name, datasetEntry(d.name, meta));
    } catch {
      /* not a bundle */
    }
  }
  const failedNow = new Set<string>();
  for (const f of opts.failures ?? []) {
    const id = f.id.toLowerCase();
    failedNow.add(id);
    const at = f.at ?? opts.checkedAt ?? new Date().toISOString();
    const had = byId.get(id);
    byId.set(id, {
      ...(had ?? { id, name: f.name ?? f.id, ops: 0, ...(f.imName ? { imName: f.imName } : {}), ...(f.graphs ? { graphs: f.graphs.map((graph) => ({ graph, imCode: imCodeOf(graph) })) } : {}) }),
      status: "failed",
      error: f.error,
      checkedAt: at,
    });
  }
  for (const p of previous.datasets) {
    const had = byId.get(p.id);
    if (!had) {
      // a failure recorded earlier, still without a bundle
      if (p.status === "failed") byId.set(p.id, p);
    } else if (p.status === "failed" && p.error && !failedNow.has(p.id) && had.fetchedAt === p.fetchedAt && had.status === "loaded") {
      // the bundle was not refetched since it failed: the failure still stands
      byId.set(p.id, { ...had, status: "failed", error: p.error, checkedAt: p.checkedAt ?? had.checkedAt });
    }
  }
  for (const id of opts.removed ?? []) {
    const had = byId.get(id.toLowerCase());
    if (had) byId.set(had.id, { ...had, status: "removed" });
  }
  const entries = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name));
  const catalogue: DatasetCatalogue = {
    version: 2,
    ...((opts.checkedAt ?? previous.checkedAt) ? { checkedAt: opts.checkedAt ?? previous.checkedAt } : {}),
    ...((opts.endpoint ?? previous.endpoint ?? entries.find((e) => e.endpoint)?.endpoint) ? { endpoint: opts.endpoint ?? previous.endpoint ?? entries.find((e) => e.endpoint)?.endpoint } : {}),
    datasets: entries,
  };
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "datasets.json"), JSON.stringify(catalogue, null, 2));
  return entries;
}
