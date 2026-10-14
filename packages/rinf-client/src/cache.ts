import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_PARTS, toWebBundle } from "./compact.js";
import type { Snapshot, SnapshotMeta } from "./types.js";

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

/** One entry of datasets.json: the web bundles the app can load. */
export interface DatasetEntry {
  /** Folder name and `?dataset=` value, lower case. */
  id: string;
  name: string;
  imName?: string;
  fetchedAt: string;
  ops: number;
}

export function datasetEntry(id: string, meta: SnapshotMeta): DatasetEntry {
  return {
    id,
    name: meta.name ?? meta.country,
    ...(meta.imName ? { imName: meta.imName } : {}),
    fetchedAt: meta.fetchedAt,
    ops: meta.counts?.ops ?? 0,
  };
}

/**
 * List the web bundles in `root` (one folder per dataset with a meta.json) and
 * write them to `root/datasets.json`, which the web app reads to offer a dataset picker.
 */
export async function writeDatasetIndex(root: string): Promise<DatasetEntry[]> {
  const entries: DatasetEntry[] = [];
  for (const d of await readdir(root, { withFileTypes: true }).catch(() => [])) {
    if (!d.isDirectory()) continue;
    try {
      const meta = JSON.parse(await readFile(join(root, d.name, "meta.json"), "utf8")) as SnapshotMeta;
      entries.push(datasetEntry(d.name, meta));
    } catch {
      /* not a bundle */
    }
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "datasets.json"), JSON.stringify(entries, null, 2));
  return entries;
}
