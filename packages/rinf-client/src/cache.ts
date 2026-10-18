import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { constants as zlib, brotliCompressSync, gzipSync } from "node:zlib";
import { basename, join } from "node:path";
import { WEB_PARTS, expandIris, toWebBundle, type WebBundleMeta } from "./compact.js";
import { datasetIndex, mergeIndexes, type DatasetIndex } from "./network-index.js";
import { fingerprintsDiffer, imCodeOf, latestPublication } from "./era.js";
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

/** The folder name and `?dataset=` id of a dataset code (`NOR` -> `nor`). */
export function datasetFolder(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
}

export interface SaveBundleOptions {
  /**
   * Write `.gz` and `.br` next to every part, so the server can send them as they are
   * (default true). Brotli at its highest quality is slow, so this is done once here, not per request.
   */
  compress?: boolean;
  /**
   * Write into `<dir>.tmp` and swap it into place when complete (default true), so a server
   * reading `dir` never sees a half-written bundle; the previous bundle is kept until then.
   */
  atomic?: boolean;
}

/** gzip and brotli versions of a bundle part, for the server to send precompressed. */
export function compressPart(json: string): { gz: Buffer; br: Buffer } {
  const buf = Buffer.from(json, "utf8");
  return {
    gz: gzipSync(buf, { level: 9 }),
    br: brotliCompressSync(buf, {
      params: { [zlib.BROTLI_PARAM_MODE]: zlib.BROTLI_MODE_TEXT, [zlib.BROTLI_PARAM_QUALITY]: 11, [zlib.BROTLI_PARAM_SIZE_HINT]: buf.length },
    }),
  };
}

/**
 * Write the compact browser bundle (see compact.ts) as one JSON file per part.
 * `extras` are written as additional parts (`<name>.json`) with the same IRI compaction.
 */
export async function saveWebBundle(dir: string, snapshot: Snapshot, extras: Record<string, unknown> = {}, opts: SaveBundleOptions = {}): Promise<void> {
  const { compress = true, atomic = true } = opts;
  const target = atomic ? `${dir}.tmp` : dir;
  if (atomic) await rm(target, { recursive: true, force: true });
  await mkdir(target, { recursive: true });
  const parts = toWebBundle(snapshot, { extras });
  // the dataset's part of the network index (index/ops.json, index/sols.json), merged by writeDatasetIndex
  const index = datasetIndex(basename(dir), snapshot);
  for (const part of [...WEB_PARTS, ...Object.keys(extras), "index"]) {
    const json = JSON.stringify(part === "index" ? index : parts[part]);
    const file = join(target, `${part}.json`);
    await writeFile(file, json);
    if (compress) {
      const { gz, br } = compressPart(json);
      // written after the plain file, so their mtime is never older than it (the server checks that)
      await writeFile(`${file}.gz`, gz);
      await writeFile(`${file}.br`, br);
    } else {
      await rm(`${file}.gz`, { force: true });
      await rm(`${file}.br`, { force: true });
    }
  }
  if (atomic) await swapDirectory(target, dir);
}

/**
 * The index part of a bundle: `index.json` as saveWebBundle writes it, or, for a bundle written
 * before there was one, derived from its ops.json and sols.json.
 */
export async function readDatasetIndex(root: string, id: string): Promise<DatasetIndex | undefined> {
  const dir = join(root, id);
  try {
    const parsed = JSON.parse(await readFile(join(dir, "index.json"), "utf8")) as DatasetIndex;
    if (parsed && Array.isArray(parsed.ops) && Array.isArray(parsed.sols) && parsed.dataset?.id) return parsed;
  } catch {
    /* no index.json: derive it */
  }
  try {
    const meta = JSON.parse(await readFile(join(dir, "meta.json"), "utf8")) as WebBundleMeta;
    const prefixes = meta.prefixes ?? {};
    const ops = expandIris(JSON.parse(await readFile(join(dir, "ops.json"), "utf8")), prefixes) as Snapshot["ops"];
    const sols = expandIris(JSON.parse(await readFile(join(dir, "sols.json"), "utf8")), prefixes) as Snapshot["sols"];
    return datasetIndex(id, { meta, ops, sols });
  } catch {
    return undefined;
  }
}

/**
 * Write `root/index/ops.json` and `root/index/sols.json` (with .gz/.br) from the index parts of the
 * datasets that have data, swapped into place when complete. Returns the number of OPs indexed.
 */
export async function writeNetworkIndex(root: string, entries: DatasetEntry[]): Promise<{ datasets: number; ops: number; sols: number }> {
  const parts: DatasetIndex[] = [];
  for (const e of entries) {
    if (!e.fetchedAt) continue;
    const part = await readDatasetIndex(root, e.id);
    if (part) parts.push(part);
  }
  const { ops, sols } = mergeIndexes(parts);
  const dir = join(root, "index");
  const tmp = `${dir}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const [name, value] of [["ops", ops], ["sols", sols]] as const) {
    const json = JSON.stringify(value);
    const file = join(tmp, `${name}.json`);
    await writeFile(file, json);
    const { gz, br } = compressPart(json);
    await writeFile(`${file}.gz`, gz);
    await writeFile(`${file}.br`, br);
  }
  await swapDirectory(tmp, dir);
  return { datasets: parts.length, ops: ops.ops.length, sols: sols.sols.length };
}

/**
 * Replace the directory `dir` with `tmp`: the old one is moved aside and removed once the new
 * one is in place. A reader is without the folder only between the two renames (microseconds);
 * files it already opened stay readable. A leftover `<dir>.old` from an interrupted swap is removed first.
 */
export async function swapDirectory(tmp: string, dir: string): Promise<void> {
  const old = `${dir}.old`;
  await rm(old, { recursive: true, force: true });
  let hadOld = false;
  try {
    await rename(dir, old);
    hadOld = true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  try {
    await rename(tmp, dir);
  } catch (e) {
    if (hadOld) await rename(old, dir).catch(() => undefined);
    throw e;
  }
  if (hadOld) await rm(old, { recursive: true, force: true });
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
   * stale: the bundle is there, but ERA has published newer data since (`latest`), to be fetched by the next sync;
   * pending: ERA publishes the dataset and no fetch has succeeded yet (the sync is on it);
   * failed: the last fetch failed (`error`; the previous bundle, if any, is still served);
   * removed: ERA no longer publishes the dataset, the bundle stays.
   */
  status: DatasetStatus;
  /** What ERA publishes now, per graph, when it differs from the fetched data (stale) or nothing was fetched (pending). */
  latest?: GraphProvenance[];
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

export type DatasetStatus = "loaded" | "stale" | "pending" | "failed" | "removed";
const STATUSES = new Set<string>(["loaded", "stale", "pending", "failed", "removed"]);

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
          .map((d) => ({ ...(d as unknown as DatasetEntry), name: String(d.name || d.id), ops: Number(d.ops ?? 0) || 0, status: typeof d.status === "string" && STATUSES.has(d.status) ? (d.status as DatasetStatus) : "loaded" }))
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

/** A dataset ERA publishes that has no bundle yet (a sync will fetch it). */
export interface PendingDataset {
  id: string;
  name?: string;
  imName?: string;
  graphs?: string[];
}

export interface IndexOptions {
  /** Fetches that failed in this run; recorded on the dataset (its previous bundle stays listed). */
  failures?: DatasetFailure[];
  /** Datasets ERA no longer publishes (ids); marked removed, bundles kept. */
  removed?: string[];
  /** Datasets on ERA without a bundle yet (pending). */
  pending?: PendingDataset[];
  /**
   * What ERA publishes now, by dataset id, from the last check. A dataset whose bundle does not
   * carry the same fingerprints is marked stale (`latest`); one that does is up to date again.
   * Datasets not named keep what the previous catalogue knew.
   */
  available?: Record<string, GraphProvenance[]>;
  /** When the endpoint was compared with the data (default: kept from the previous catalogue). */
  checkedAt?: string;
  endpoint?: string;
  /** Also rewrite the network index (`index/ops.json`, `index/sols.json`); default true. */
  networkIndex?: boolean;
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
    if (!d.isDirectory() || d.name === "index") continue;
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
  for (const p of opts.pending ?? []) {
    const id = p.id.toLowerCase();
    if (byId.has(id)) continue;
    const graphs = p.graphs?.map((graph) => ({ graph, imCode: imCodeOf(graph) }));
    byId.set(id, { id, name: p.name ?? p.id, ...(p.imName ? { imName: p.imName } : {}), ops: 0, status: "pending", ...(graphs ? { graphs } : {}), checkedAt: opts.checkedAt ?? new Date().toISOString() });
  }
  for (const p of previous.datasets) {
    const had = byId.get(p.id);
    if (!had) {
      // a failure or a pending dataset recorded earlier, still without a bundle
      if (p.status === "failed" || p.status === "pending") byId.set(p.id, p);
    } else if (p.status === "failed" && p.error && !failedNow.has(p.id) && had.fetchedAt === p.fetchedAt && had.status === "loaded") {
      // the bundle was not refetched since it failed: the failure still stands
      byId.set(p.id, { ...had, status: "failed", error: p.error, checkedAt: p.checkedAt ?? had.checkedAt });
    } else if (p.status === "removed" && had.fetchedAt === p.fetchedAt && had.status === "loaded") {
      // still the bundle from before ERA dropped the dataset
      byId.set(p.id, { ...had, status: "removed", checkedAt: p.checkedAt ?? had.checkedAt });
    }
  }
  // what ERA publishes now, against what the bundles carry
  for (const entry of byId.values()) {
    const previousEntry = previous.datasets.find((p) => p.id === entry.id);
    const latest = opts.available?.[entry.id] ?? previousEntry?.latest;
    // nothing known about what ERA publishes (explorer and repository unreachable): nothing to compare
    if (!latest?.some((g) => g.fingerprint)) continue;
    const { latest: _drop, ...rest } = entry;
    if (entry.status === "pending" || !entry.fetchedAt) {
      byId.set(entry.id, { ...entry, latest, publishedAt: latestPublication(latest) ?? entry.publishedAt });
    } else if (fingerprintsDiffer(entry.graphs, latest)) {
      byId.set(entry.id, { ...rest, ...(entry.status === "loaded" ? { status: "stale" } : {}), latest });
    } else {
      byId.set(entry.id, rest as DatasetEntry);
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
  if (opts.networkIndex !== false) await writeNetworkIndex(root, entries);
  return entries;
}
