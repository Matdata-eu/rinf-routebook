import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { WEB_PARTS, toWebBundle } from "./compact.js";
import type { Snapshot } from "./types.js";

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

/** Write the compact browser bundle (see compact.ts) as one JSON file per part. */
export async function saveWebBundle(dir: string, snapshot: Snapshot): Promise<void> {
  await mkdir(dir, { recursive: true });
  const parts = toWebBundle(snapshot);
  for (const part of WEB_PARTS) {
    await writeFile(join(dir, `${part}.json`), JSON.stringify(parts[part]));
  }
}
