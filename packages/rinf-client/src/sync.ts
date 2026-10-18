/**
 * Keeping the data current: compare what ERA publishes with the catalogue, fetch only what
 * changed, is new or failed last time. `routebook sync` runs this in a loop next to the server.
 */
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { datasetFolder, readCatalogue, writeDatasetIndex, type DatasetCatalogue, type DatasetEntry } from "./cache.js";
import { graphsOf, type CountryGraph } from "./countries.js";
import { datasetsApiFor, fingerprintsDiffer, graphProvenance, publishedDatasets, type EraOptions, type PublishedDataset } from "./era.js";
import { FETCH_VERSION } from "./snapshot.js";
import type { GraphProvenance } from "./types.js";

/** Why a dataset is fetched; outdated: fetched by an older version of the queries (FETCH_VERSION). */
export type SyncReason = "new" | "changed" | "failed" | "outdated" | "forced";

export interface SyncItem {
  dataset: CountryGraph;
  /** Folder name and catalogue id. */
  id: string;
  reason: SyncReason;
  /** What ERA publishes now for the dataset's graphs. */
  latest: GraphProvenance[];
}

export interface SyncPlan {
  /** Datasets to fetch, in catalogue order. */
  fetch: SyncItem[];
  /** Datasets whose bundle matches what ERA publishes. */
  current: string[];
  /** Datasets in the catalogue that are no longer on the endpoint (only when the whole endpoint is synced). */
  removed: string[];
  /** What ERA publishes now, by dataset id, for the catalogue. */
  available: Record<string, GraphProvenance[]>;
  warnings: string[];
}

export interface PlanOptions extends EraOptions {
  endpoint: string;
  /** The datasets to keep current (every one on the endpoint when `all` is set). */
  datasets: CountryGraph[];
  /** `datasets` is the whole endpoint: datasets missing from it are marked removed. */
  all?: boolean;
  catalogue: DatasetCatalogue;
  /** Fetch every dataset whatever its state. */
  force?: boolean;
  onWarning?: (message: string) => void;
}

/** Compare ERA with the catalogue and say what to fetch. Never throws: what cannot be read counts as unchanged. */
export async function planSync(opts: PlanOptions): Promise<SyncPlan> {
  const warnings: string[] = [];
  const warn = (m: string) => {
    warnings.push(m);
    opts.onWarning?.(m);
  };
  const api = opts.datasetsApi ?? datasetsApiFor(opts.endpoint);
  let published = new Map<string, PublishedDataset>();
  if (api) {
    try {
      published = await publishedDatasets(api, opts);
    } catch (e) {
      warn(`Could not read the ERA dataset explorer (${api}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const byId = new Map(opts.catalogue.datasets.map((d) => [d.id, d]));
  const plan: SyncPlan = { fetch: [], current: [], removed: [], available: {}, warnings };
  for (const dataset of opts.datasets) {
    const id = datasetFolder(dataset.code);
    const latest = await graphProvenance(opts.endpoint, graphsOf(dataset), { ...opts, published, onWarning: warn });
    plan.available[id] = latest;
    const reason = reasonFor(byId.get(id), latest, opts.force);
    if (reason) plan.fetch.push({ dataset, id, reason, latest });
    else plan.current.push(id);
  }
  if (opts.all) {
    const onEndpoint = new Set(opts.datasets.map((d) => datasetFolder(d.code)));
    plan.removed = opts.catalogue.datasets.filter((d) => !onEndpoint.has(d.id) && d.status !== "removed").map((d) => d.id);
  }
  return plan;
}

function reasonFor(entry: DatasetEntry | undefined, latest: GraphProvenance[], force?: boolean): SyncReason | undefined {
  if (force) return "forced";
  if (entry?.status === "failed") return "failed";
  if (!entry || !entry.fetchedAt || entry.status === "pending") return "new";
  if (fingerprintsDiffer(entry.graphs, latest)) return "changed";
  if ((entry.fetchVersion ?? 1) < FETCH_VERSION) return "outdated";
  return undefined;
}

export interface SyncResult {
  checkedAt: string;
  plan: SyncPlan;
  fetched: Array<{ id: string; reason: SyncReason; seconds: number; ops?: number }>;
  failed: Array<{ id: string; reason: SyncReason; error: string }>;
  /** Peak resident memory of this process over the pass, in MB. */
  peakMemoryMb: number;
}

export interface RunSyncOptions extends Omit<PlanOptions, "catalogue"> {
  /** The web data folder (`<data>/web`), holding the bundles and `datasets.json`. */
  webRoot: string;
  /**
   * Fetch one dataset and write its bundle into `webRoot/<id>` (atomically, see saveWebBundle).
   * Throws on failure; the previous bundle then stays.
   */
  fetchDataset: (item: SyncItem) => Promise<{ ops?: number }>;
  /** How often to try a dataset in one pass (default 2: the endpoint occasionally drops a long query). */
  attempts?: number;
  /** Stop before the next dataset when this returns true (a shutdown). */
  stopped?: () => boolean;
  log?: (message: string) => void;
}

/**
 * One sync pass: plan, record what ERA publishes (pending, stale, removed), fetch what the plan
 * says one dataset at a time, and record every outcome in the catalogue as it happens, so the
 * web app and `/healthz` always see the current state.
 */
export async function runSync(opts: RunSyncOptions): Promise<SyncResult> {
  const log = opts.log ?? (() => undefined);
  const { webRoot, fetchDataset, attempts = 2, stopped = () => false } = opts;
  await removeLeftovers(webRoot);
  const checkedAt = new Date().toISOString();
  const catalogue = await readCatalogue(webRoot);
  const plan = await planSync({ ...opts, catalogue });
  const pending = plan.fetch.filter((i) => i.reason === "new").map((i) => ({ id: i.id, name: i.dataset.name, ...(i.dataset.imName ? { imName: i.dataset.imName } : {}), graphs: graphsOf(i.dataset) }));
  await writeDatasetIndex(webRoot, { checkedAt, endpoint: opts.endpoint, pending, available: plan.available, removed: plan.removed });
  const summary = (items: SyncItem[], reason: SyncReason) => items.filter((i) => i.reason === reason).map((i) => i.id);
  log(
    `${checkedAt}: ${opts.datasets.length} datasets on ${opts.endpoint}; ${plan.current.length} current, ${plan.fetch.length} to fetch` +
      (plan.fetch.length ? ` (new: ${summary(plan.fetch, "new").join(", ") || "-"}; changed: ${summary(plan.fetch, "changed").join(", ") || "-"}; failed before: ${summary(plan.fetch, "failed").join(", ") || "-"}; outdated: ${summary(plan.fetch, "outdated").length}${opts.force ? `; forced: ${summary(plan.fetch, "forced").length}` : ""})` : "") +
      (plan.removed.length ? `; no longer on ERA: ${plan.removed.join(", ")}` : ""),
  );
  const result: SyncResult = { checkedAt, plan, fetched: [], failed: [], peakMemoryMb: 0 };
  const sample = () => (result.peakMemoryMb = Math.max(result.peakMemoryMb, Math.round(process.memoryUsage().rss / 1048576)));
  for (const item of plan.fetch) {
    if (stopped()) {
      log(`Stopping before ${item.id}`);
      break;
    }
    const t0 = Date.now();
    let error = "";
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const { ops } = await fetchDataset(item);
        sample();
        const seconds = (Date.now() - t0) / 1000;
        result.fetched.push({ id: item.id, reason: item.reason, seconds, ...(ops !== undefined ? { ops } : {}) });
        log(`  ${item.id}: fetched in ${seconds.toFixed(0)} s (${item.reason}; ${ops ?? "?"} OPs, ${result.peakMemoryMb} MB peak)`);
        error = "";
        break;
      } catch (e) {
        error = e instanceof Error ? e.message : String(e);
        sample();
        log(`  ${item.id}: attempt ${attempt} failed: ${error}`);
      }
    }
    if (error) {
      result.failed.push({ id: item.id, reason: item.reason, error });
      await writeDatasetIndex(webRoot, {
        failures: [{ id: item.id, name: item.dataset.name, ...(item.dataset.imName ? { imName: item.dataset.imName } : {}), error, graphs: graphsOf(item.dataset), at: new Date().toISOString() }],
      }).catch(() => undefined);
    } else {
      await writeDatasetIndex(webRoot, { available: { [item.id]: item.latest } });
    }
  }
  sample();
  log(`Done: ${result.fetched.length} fetched, ${result.failed.length} failed, ${plan.current.length} unchanged; peak memory ${result.peakMemoryMb} MB`);
  return result;
}

/** Remove `<id>.tmp` / `<id>.old` folders left by an interrupted fetch. */
export async function removeLeftovers(webRoot: string): Promise<string[]> {
  const gone: string[] = [];
  for (const d of await readdir(webRoot, { withFileTypes: true }).catch(() => [])) {
    if (d.isDirectory() && /\.(tmp|old)$/.test(d.name)) {
      await rm(join(webRoot, d.name), { recursive: true, force: true });
      gone.push(d.name);
    }
  }
  return gone;
}
