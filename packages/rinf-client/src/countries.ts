import type { SparqlClient } from "./sparql.js";

/**
 * RINF datasets. The ERA knowledge graph holds one named graph per
 * infrastructure manager (IM) code, e.g. <http://data.europa.eu/949/graph/0076>
 * for Bane NOR. A dataset is one or more of those graphs, fetched together and
 * shown as one network in the app (a country with several IMs, or a region).
 *
 * Any graph on the endpoint can be fetched: by country code (the graphs are
 * looked up on the endpoint), by IM code or by graph IRI. The table below only
 * adds friendly names for the datasets that have been checked; see
 * docs/data-coverage-norway.md for what that check covers.
 */
export interface CountryGraph {
  /** Dataset id, used for the data folder and the `?dataset=` URL parameter (lower case in both). */
  code: string;
  name: string;
  /** Primary graph (the first of `graphs`). */
  graph: string;
  /** All named graphs of the dataset; defaults to [graph]. */
  graphs?: string[];
  /** Infrastructure manager(s), for the data attribution. */
  imName?: string;
  /** ISO 3166-1 alpha-3 country, when the dataset is one country. */
  country?: string;
}

export const GRAPH_BASE = "http://data.europa.eu/949/graph/";
export const COUNTRY_BASE = "http://publications.europa.eu/resource/authority/country/";

/** Datasets that have been checked against the endpoint. */
export const COUNTRIES: Record<string, CountryGraph> = {
  NOR: {
    code: "NOR",
    name: "Norway",
    graph: `${GRAPH_BASE}0076`,
    imName: "Bane NOR",
    country: "NOR",
  },
};

export function graphsOf(c: CountryGraph): string[] {
  return c.graphs?.length ? c.graphs : [c.graph];
}

/** A known dataset by id, or undefined. */
export function knownDataset(code: string): CountryGraph | undefined {
  return COUNTRIES[code.toUpperCase()];
}

/** A known dataset by id; throws for anything else (use resolveDataset to look graphs up on the endpoint). */
export function countryGraph(code: string): CountryGraph {
  const c = knownDataset(code);
  if (!c) throw new Error(`Unknown dataset ${code}; known: ${Object.keys(COUNTRIES).join(", ")}. Use resolveDataset to look it up on the endpoint.`);
  return c;
}

/** "0076", "graph/0076" or a full IRI -> the graph IRI. */
export function graphIri(spec: string): string {
  const s = spec.trim();
  if (/^https?:\/\//.test(s)) return s;
  return GRAPH_BASE + s.replace(/^graph\//, "");
}

/** One named graph on the endpoint with what it contains. */
export interface GraphInfo {
  graph: string;
  /** ISO 3166-1 alpha-3 codes of the operational points in it, most operational points first (border points can sit in a neighbour country). */
  countries: string[];
  ops: number;
}

const DISCOVER = `PREFIX era: <http://data.europa.eu/949/>
SELECT ?g ?country (COUNT(DISTINCT ?op) AS ?ops) WHERE {
  GRAPH ?g { ?op a era:OperationalPoint . OPTIONAL { ?op era:inCountry ?country } }
} GROUP BY ?g ?country ORDER BY ?g`;

/** Named graphs on the endpoint that hold operational points, with their countries. */
export async function discoverGraphs(client: SparqlClient): Promise<GraphInfo[]> {
  const rows = await client.select(DISCOVER);
  const byGraph = new Map<string, { ops: number; countries: Map<string, number> }>();
  for (const r of rows) {
    if (!r.g) continue;
    const info = byGraph.get(r.g) ?? { ops: 0, countries: new Map<string, number>() };
    const n = Number(r.ops ?? 0) || 0;
    info.ops += n;
    const c = r.country?.startsWith(COUNTRY_BASE) ? r.country.slice(COUNTRY_BASE.length) : r.country;
    if (c) info.countries.set(c, (info.countries.get(c) ?? 0) + n);
    byGraph.set(r.g, info);
  }
  return [...byGraph]
    .map(([graph, i]) => ({ graph, ops: i.ops, countries: [...i.countries].sort((a, b) => b[1] - a[1]).map(([c]) => c) }))
    .sort((a, b) => b.ops - a.ops);
}

export interface ResolveOptions {
  /** Explicit graphs (IM codes or IRIs); with these, `spec` is only the dataset id. */
  graphs?: string[];
  name?: string;
  imName?: string;
}

/**
 * The dataset for a CLI argument:
 * - a known dataset id (NOR),
 * - explicit graphs (`--graph 0076 --graph 0084`), with `spec` as the id,
 * - a 4-digit IM code or a graph IRI, or
 * - any other ISO 3166-1 alpha-3 country code: its graphs are looked up on the endpoint.
 */
export async function resolveDataset(spec: string, client: SparqlClient, opts: ResolveOptions = {}): Promise<CountryGraph> {
  const extra = { ...(opts.imName ? { imName: opts.imName } : {}) };
  if (opts.graphs?.length) {
    const graphs = opts.graphs.map(graphIri);
    const known = knownDataset(spec);
    return { ...known, code: spec.toUpperCase(), name: opts.name ?? known?.name ?? spec, graph: graphs[0]!, graphs, ...extra };
  }
  const known = knownDataset(spec);
  if (known) return { ...known, ...(opts.name ? { name: opts.name } : {}), ...extra };
  if (/^\d{4}$/.test(spec) || /^https?:\/\//.test(spec) || spec.startsWith("graph/")) {
    const graph = graphIri(spec);
    const code = graph.slice(graph.lastIndexOf("/") + 1).toUpperCase();
    return { code, name: opts.name ?? `RINF graph ${code}`, graph, ...extra };
  }
  if (!/^[A-Za-z]{3}$/.test(spec)) throw new Error(`"${spec}" is not a country code (ISO 3166-1 alpha-3), IM code or graph IRI`);
  const country = spec.toUpperCase();
  // a graph belongs to the country most of its operational points are in (not to the neighbours of its border points)
  const found = (await discoverGraphs(client)).filter((g) => g.countries[0] === country);
  if (!found.length) throw new Error(`No RINF graph on ${client.endpoint} has operational points in ${country}. Run "routebook datasets" to list them.`);
  const graphs = found.map((g) => g.graph);
  return { code: country, name: opts.name ?? country, graph: graphs[0]!, graphs, country, ...extra };
}
