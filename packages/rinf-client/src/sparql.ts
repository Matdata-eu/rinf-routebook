import { readFile } from "node:fs/promises";

export const DEFAULT_ENDPOINT = "https://graph.data.era.europa.eu/repositories/rinf-plus";

/** One row of a SPARQL SELECT result, as plain strings (absent bindings are missing). */
export type Row = Record<string, string | undefined>;

interface SparqlJson {
  head: { vars: string[] };
  results: { bindings: Array<Record<string, { type: string; value: string }>> };
}

export interface SparqlClientOptions {
  endpoint?: string;
  /** Named graph IRI substituted for {{graph}} in query templates. */
  graph: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export class SparqlClient {
  readonly endpoint: string;
  readonly graph: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: SparqlClientOptions) {
    this.endpoint = opts.endpoint ?? DEFAULT_ENDPOINT;
    this.graph = opts.graph;
    this.timeoutMs = opts.timeoutMs ?? 300_000;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  /** Substitute template parameters. */
  render(template: string): string {
    return template.replaceAll("{{graph}}", `<${this.graph}>`);
  }

  async select(query: string): Promise<Row[]> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/sparql-results+json",
      },
      body: new URLSearchParams({ query: this.render(query) }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new Error(`SPARQL ${res.status} ${res.statusText}: ${(await res.text()).slice(0, 500)}`);
    }
    const json = (await res.json()) as SparqlJson;
    return json.results.bindings.map((b) => {
      const row: Row = {};
      for (const [k, v] of Object.entries(b)) row[k] = v.value;
      return row;
    });
  }

  /** Run a query template shipped in this package's queries/ folder. */
  async selectNamed(name: string): Promise<Row[]> {
    return this.select(await loadQuery(name));
  }
}

export async function loadQuery(name: string): Promise<string> {
  return readFile(new URL(`../queries/${name}.rq`, import.meta.url), "utf8");
}
