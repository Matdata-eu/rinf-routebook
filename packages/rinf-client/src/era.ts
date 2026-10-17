/**
 * What ERA publishes about a RINF dataset, next to the data itself.
 *
 * Each infrastructure manager (IM) uploads its RINF data to ERA, which
 * publishes it as one named graph per IM in the SPARQL repository and lists
 * the upload in its dataset explorer. This module asks both, so a fetched
 * dataset can say which publication it comes from:
 *
 * - the dataset explorer API: `GET {api}/dataset/published?latest=true&groupBy=im`
 *   (the call the explorer web page makes) gives the latest dataset per IM
 *   with its id, file name, publication date, IM name and country;
 * - the repository's RDF4J REST API: `GET {endpoint}/size?context=<graph>`
 *   gives the triple count of a graph.
 *
 * `dataset id | publication date | triple count` is the fingerprint of a
 * graph: it changes when ERA publishes something new. RINF Atlas uses the
 * same definition, so both apps agree on what "changed" means.
 *
 * Everything here is best effort: when the explorer or the repository does
 * not answer, the fields stay undefined and the fetch goes on.
 */
import { DEFAULT_ENDPOINT } from "./sparql.js";
import type { GraphProvenance } from "./types.js";

export const DEFAULT_DATASETS_API = "https://rinf.data.era.europa.eu/api/v1";

/** The dataset explorer API that belongs to a SPARQL endpoint, when known (PROD and UAT). */
export function datasetsApiFor(endpoint: string): string | undefined {
  if (endpoint.startsWith(DEFAULT_ENDPOINT) || endpoint.startsWith("https://graph.data.era.europa.eu/")) return DEFAULT_DATASETS_API;
  if (endpoint.startsWith("https://graph.uat.data.test-era.europa.eu/")) return "https://rinf.uat.data.test-era.europa.eu/api/v1";
  return undefined;
}

/** One entry of the dataset explorer: the latest dataset of one IM. */
export interface PublishedDataset {
  datasetId: string;
  /** IM organisation code, the last part of its graph IRI (0076 for Bane NOR). */
  imCode: string;
  imName?: string;
  /** Country code as the explorer reports it. */
  country?: string;
  fileName?: string;
  /** ISO 8601 publication date (`datePublished`, else `dateCreated`). */
  publishedAt?: string;
  type?: string;
  status?: string;
}

/** The JSON of the dataset explorer -> one entry per IM code (unknown shapes are skipped). */
export function parsePublished(json: unknown): PublishedDataset[] {
  const list = Array.isArray(json) ? json : json && typeof json === "object" && Array.isArray((json as { content?: unknown }).content) ? (json as { content: unknown[] }).content : [];
  const out: PublishedDataset[] = [];
  for (const d of list) {
    if (!d || typeof d !== "object") continue;
    const rec = d as Record<string, unknown>;
    const acc = (rec.account && typeof rec.account === "object" ? rec.account : {}) as Record<string, unknown>;
    const code = typeof acc.code === "string" ? acc.code.trim() : "";
    if (!code) continue;
    const ts = rec.datePublished ?? rec.dateCreated;
    const when = typeof ts === "number" ? new Date(ts) : typeof ts === "string" ? new Date(ts) : undefined;
    const country = acc.country && typeof acc.country === "object" ? (acc.country as Record<string, unknown>).code : acc.country;
    out.push({
      datasetId: String(rec.id ?? ""),
      imCode: code,
      ...(typeof acc.name === "string" && acc.name.trim() ? { imName: acc.name.trim() } : {}),
      ...(typeof country === "string" && country ? { country } : {}),
      ...(typeof rec.fileName === "string" && rec.fileName ? { fileName: rec.fileName } : {}),
      ...(when && !Number.isNaN(when.getTime()) ? { publishedAt: when.toISOString() } : {}),
      ...(typeof rec.type === "string" ? { type: rec.type } : {}),
      ...(typeof rec.status === "string" ? { status: rec.status } : {}),
    });
  }
  return out;
}

export interface EraOptions {
  /** Dataset explorer API base; default: the one that belongs to the endpoint, or none. */
  datasetsApi?: string;
  /** The explorer's answer, when already read (a sync reads it once for every dataset). */
  published?: Map<string, PublishedDataset>;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** Latest published dataset per IM code, from the dataset explorer. Throws when it cannot be read. */
export async function publishedDatasets(api: string, opts: EraOptions = {}): Promise<Map<string, PublishedDataset>> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${api.replace(/\/$/, "")}/dataset/published?latest=true&groupBy=im`;
  const res = await fetchImpl(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
  if (!res.ok) throw new Error(`Dataset explorer ${res.status} ${res.statusText} for ${url}`);
  return new Map(parsePublished(await res.json()).map((p) => [p.imCode, p]));
}

/** Triple count of a named graph (RDF4J `GET {repo}/size?context=<graph>`). Throws when the endpoint does not answer. */
export async function graphSize(endpoint: string, graph: string, opts: EraOptions = {}): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${endpoint.replace(/\/$/, "")}/size?context=${encodeURIComponent(`<${graph}>`)}`;
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(opts.timeoutMs ?? 60_000) });
  if (!res.ok) throw new Error(`Repository size ${res.status} ${res.statusText} for ${url}`);
  const n = Number((await res.text()).trim());
  if (!Number.isFinite(n)) throw new Error(`Repository size for ${graph} is not a number`);
  return n;
}

/** `dataset id | publication date | triple count`: changes when ERA publishes new data for the graph. */
export function fingerprint(pub: Pick<PublishedDataset, "datasetId" | "publishedAt"> | undefined, triples: number | undefined): string {
  return `${pub?.datasetId ?? ""}|${pub?.publishedAt ?? ""}|${triples ?? ""}`;
}

/** The IM code of a provider graph IRI (`.../graph/0076` -> `0076`). */
export function imCodeOf(graph: string): string {
  return graph.replace(/\/$/, "").slice(graph.replace(/\/$/, "").lastIndexOf("/") + 1);
}

/**
 * What ERA says about each graph of a dataset: publication, IM, triple count,
 * fingerprint. Never throws: a source that fails leaves its fields undefined
 * and is reported through `onWarning`.
 */
export async function graphProvenance(
  endpoint: string,
  graphs: string[],
  opts: EraOptions & { onWarning?: (message: string) => void } = {},
): Promise<GraphProvenance[]> {
  const api = opts.datasetsApi ?? datasetsApiFor(endpoint);
  let published = opts.published ?? new Map<string, PublishedDataset>();
  if (api && !opts.published) {
    try {
      published = await publishedDatasets(api, opts);
    } catch (e) {
      opts.onWarning?.(`Could not read the ERA dataset explorer (${api}): ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const out: GraphProvenance[] = [];
  for (const graph of graphs) {
    const imCode = imCodeOf(graph);
    const pub = published.get(imCode);
    let triples: number | undefined;
    try {
      triples = await graphSize(endpoint, graph, opts);
    } catch (e) {
      opts.onWarning?.(`Could not read the size of ${graph}: ${e instanceof Error ? e.message : String(e)}`);
    }
    out.push({
      graph,
      imCode,
      ...(pub?.imName ? { imName: pub.imName } : {}),
      ...(pub?.country ? { country: pub.country } : {}),
      ...(pub?.datasetId ? { datasetId: pub.datasetId } : {}),
      ...(pub?.fileName ? { fileName: pub.fileName } : {}),
      ...(pub?.publishedAt ? { publishedAt: pub.publishedAt } : {}),
      ...(triples !== undefined ? { triples } : {}),
      ...(pub || triples !== undefined ? { fingerprint: fingerprint(pub, triples) } : {}),
    });
  }
  return out;
}

/**
 * Whether ERA publishes something else than what was fetched: a graph whose fingerprint differs,
 * or a graph added or dropped. Graphs without a fingerprint on either side cannot be compared and
 * count as unchanged, so an unreachable explorer never triggers a refetch.
 */
export function fingerprintsDiffer(fetched: GraphProvenance[] | undefined, latest: GraphProvenance[]): boolean {
  const had = new Map((fetched ?? []).map((g) => [g.graph, g.fingerprint]));
  if (fetched && new Set(latest.map((g) => g.graph)).size !== had.size) return true;
  for (const g of latest) {
    if (fetched && !had.has(g.graph)) return true;
    const before = had.get(g.graph);
    if (before && g.fingerprint && before !== g.fingerprint) return true;
  }
  return false;
}

/** The latest publication date among the graphs of a dataset, or undefined. */
export function latestPublication(graphs: GraphProvenance[] | undefined): string | undefined {
  return graphs?.map((g) => g.publishedAt).filter((d): d is string => !!d).sort().at(-1);
}
