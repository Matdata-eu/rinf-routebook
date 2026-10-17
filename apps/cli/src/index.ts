#!/usr/bin/env node
import { parseArgs } from "node:util";
import { appendFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  DEFAULT_ENDPOINT,
  SparqlClient,
  allDatasets,
  discoverGraphs,
  fetchSnapshot,
  graphsOf,
  knownDataset,
  loadSnapshot,
  resolveDataset,
  saveSnapshot,
  saveWebBundle,
  writeDatasetIndex,
  readCatalogue,
  type CountryGraph,
  type Snapshot,
} from "@routebook/rinf-client";
import { RoutingGraph, lengthCostModel, opEndpoint, resolveOp, trackPreferenceCostModel } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, formatRoutebook } from "@routebook/routebook";
import { classifySwitches, compactSwitches } from "@routebook/schematic";

const HELP = `routebook <command> [options]

Commands:
  datasets                  List the RINF named graphs on the endpoint, with their countries
  fetch                     Fetch a RINF snapshot from the ERA SPARQL endpoint (also writes the web bundle)
  fetch-all                 Fetch every RINF dataset on the endpoint, one per country, one after the other;
                            a dataset that fails is reported and skipped
  bundle                    Rebuild the compact web bundle (<data>/web/<dataset>) from the snapshot,
                            including the switch classification for the schematic view
  index                     Rewrite <data>/web/datasets.json (the datasets the web app offers, with
                            what ERA published for each of them and the outcome of the last fetch)
  route <from> <to>         Route between two OPs (name, uopid or IRI) and print the routebook
  stats                     Topology statistics of the snapshot

Options:
  --dataset <id>            Dataset to fetch or use (default NOR; alias --country). For fetch:
                            an ISO 3166-1 alpha-3 country code (its graphs are looked up on the
                            endpoint), an IM code such as 0076, or a named graph IRI
  --graph <code|IRI>        Fetch exactly these named graphs (repeatable); --dataset is then the id
  --name <text>             Display name of the dataset (fetch)
  --im <text>               Infrastructure manager(s), shown in the data attribution (fetch)
  --only <a,b>              Only these dataset ids (fetch-all)
  --skip <a,b>              Leave these dataset ids out (fetch-all)
  --data <dir>              Data folder (default ./data, or ROUTEBOOK_DATA_DIR)
  --snapshot <dir>          Snapshot directory (default <data>/snapshots/<dataset>)
  --endpoint <url>          SPARQL endpoint (default ${DEFAULT_ENDPOINT}, or ROUTEBOOK_SPARQL_ENDPOINT)
  --datasets-api <url>      ERA dataset explorer API, for the publication date and id of each graph
                            (default: the one of the endpoint, or ROUTEBOOK_DATASETS_API; "none" skips it)
  --limit <n>               Max items to print (route, default all)
  --kinds <a,b>             Only print these item kinds (route)
  --area                    Use OP areas instead of OP centre points as endpoints
  --cost <model>            prefer-running (default) | length
  --json                    Print JSON instead of a table (route)
`;

/** Derived bundle parts, computed on the full-resolution geometry before it is simplified. */
function webExtras(snapshot: Snapshot): Record<string, unknown> {
  return { switches: compactSwitches(classifySwitches(snapshot)) };
}

const ROOT = fileURLToPath(new URL("../../../", import.meta.url));

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      dataset: { type: "string" },
      country: { type: "string" },
      graph: { type: "string", multiple: true },
      name: { type: "string" },
      im: { type: "string" },
      only: { type: "string" },
      skip: { type: "string" },
      data: { type: "string" },
      snapshot: { type: "string" },
      endpoint: { type: "string" },
      "datasets-api": { type: "string" },
      limit: { type: "string" },
      kinds: { type: "string" },
      area: { type: "boolean", default: false },
      cost: { type: "string", default: "prefer-running" },
      json: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  const [cmd, ...args] = positionals;
  if (values.help || !cmd) {
    console.log(HELP);
    return;
  }
  const id = (values.dataset ?? values.country ?? process.env.ROUTEBOOK_DATASET ?? "NOR").trim();
  const dataRoot = resolve(values.data ?? process.env.ROUTEBOOK_DATA_DIR ?? join(ROOT, "data"));
  const webRoot = join(dataRoot, "web");
  const endpoint = values.endpoint ?? process.env.ROUTEBOOK_SPARQL_ENDPOINT;
  const datasetsApi = (values["datasets-api"] ?? process.env.ROUTEBOOK_DATASETS_API)?.trim();
  const provenance = datasetsApi?.toLowerCase() === "none" ? false : datasetsApi ? { datasetsApi } : true;
  const folder = (code: string) => code.toLowerCase().replace(/[^a-z0-9_-]+/g, "-");
  let dir = values.snapshot ? resolve(values.snapshot) : join(dataRoot, "snapshots", folder(id));
  let webDir = join(webRoot, folder(id));

  if (cmd === "datasets") {
    const client = new SparqlClient({ graph: "", ...(endpoint ? { endpoint } : {}) });
    console.error(`Named graphs with operational points on ${client.endpoint}:`);
    for (const g of await discoverGraphs(client)) {
      console.log(`${g.graph.padEnd(40)} ${String(g.ops).padStart(6)} OPs  ${g.countries.join(", ")}`);
    }
    console.error(`\nFetch one with: routebook fetch --dataset <ISO3 country | IM code | graph IRI>`);
    return;
  }

  if (cmd === "index") {
    const list = await writeDatasetIndex(webRoot);
    console.error(`${join(webRoot, "datasets.json")}: ${list.map((d) => `${d.id}${d.status === "loaded" ? "" : ` (${d.status})`}`).join(", ") || "no datasets"}`);
    return;
  }

  /** Fetch one dataset and write its snapshot, web bundle and the dataset index. */
  const fetchDataset = async (dataset: CountryGraph, snapshotDir = join(dataRoot, "snapshots", folder(dataset.code))) => {
    const out = join(webRoot, folder(dataset.code));
    const graphs = graphsOf(dataset);
    const client = new SparqlClient({ graph: graphs[0]!, graphs, ...(endpoint ? { endpoint } : {}) });
    console.error(`Fetching ${dataset.name} (${graphs.join(", ")}) from ${client.endpoint}`);
    const t0 = Date.now();
    try {
      const snapshot = await fetchSnapshot({
        client,
        country: dataset.code,
        name: dataset.name,
        ...(dataset.imName ? { imName: dataset.imName } : {}),
        onProgress: (step, rows) => console.error(`  ${step.padEnd(16)} ${rows} rows`),
        provenance,
        onWarning: (message) => console.error(`  warning: ${message}`),
      });
      await saveSnapshot(snapshotDir, snapshot);
      await saveWebBundle(out, snapshot, webExtras(snapshot));
      await writeDatasetIndex(webRoot, { checkedAt: new Date().toISOString(), endpoint: client.endpoint });
      const seconds = (Date.now() - t0) / 1000;
      const published = snapshot.meta.provenance?.map((g) => g.publishedAt?.slice(0, 10)).filter(Boolean);
      console.error(`Saved to ${snapshotDir} and ${out} in ${seconds.toFixed(0)} s${published?.length ? ` (ERA publication ${[...new Set(published)].join(", ")})` : ""}`);
      return { snapshot, seconds };
    } catch (e) {
      // the previous bundle, if any, stays; the catalogue records the failure
      const error = e instanceof Error ? e.message : String(e);
      await writeDatasetIndex(webRoot, {
        failures: [{ id: folder(dataset.code), name: dataset.name, ...(dataset.imName ? { imName: dataset.imName } : {}), error, graphs }],
        checkedAt: new Date().toISOString(),
        endpoint: client.endpoint,
      }).catch(() => undefined);
      throw e;
    }
  };

  if (cmd === "fetch") {
    const lookup = new SparqlClient({ graph: "", ...(endpoint ? { endpoint } : {}) });
    const dataset = await resolveDataset(id, lookup, {
      ...(values.graph?.length ? { graphs: values.graph } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values.im ? { imName: values.im } : {}),
    });
    const { snapshot } = await fetchDataset(dataset, values.snapshot ? dir : undefined);
    console.log(JSON.stringify(snapshot.meta.counts));
    return;
  }

  if (cmd === "fetch-all") {
    const lookup = new SparqlClient({ graph: "", ...(endpoint ? { endpoint } : {}) });
    const ids = (list?: string) => new Set((list ?? "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean));
    const only = ids(values.only);
    const skip = ids(values.skip);
    const all = allDatasets(await discoverGraphs(lookup));
    const datasets = all.filter((d) => (!only.size || only.has(d.code)) && !skip.has(d.code));
    if (!datasets.length) throw new Error(`No RINF datasets to fetch on ${lookup.endpoint}${only.size ? ` (--only ${[...only].join(",")})` : ""}`);
    console.error(`${datasets.length} datasets: ${datasets.map((d) => d.code).join(", ")}`);
    const results: Array<{ dataset: CountryGraph; ops?: number; seconds?: number; error?: string }> = [];
    for (const dataset of datasets) {
      // one retry: the endpoint occasionally times out or drops a long query
      for (let attempt = 1; ; attempt++) {
        try {
          const { snapshot, seconds } = await fetchDataset(dataset);
          results.push({ dataset, ops: snapshot.meta.counts.ops, seconds });
          break;
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          console.error(`  ${dataset.code} failed (attempt ${attempt}): ${error}`);
          if (attempt >= 2) {
            results.push({ dataset, error });
            break;
          }
        }
      }
    }
    const ok = results.filter((r) => !r.error);
    // datasets that were fetched earlier but are no longer on the endpoint
    const onEndpoint = new Set(all.map((d) => folder(d.code)));
    const removed = only.size || skip.size ? [] : (await readCatalogue(webRoot)).datasets.map((d) => d.id).filter((i) => !onEndpoint.has(i));
    await writeDatasetIndex(webRoot, { checkedAt: new Date().toISOString(), endpoint: lookup.endpoint, removed });
    const lines = [
      `| Dataset | Graphs | Operational points | Time |`,
      `| --- | --- | ---: | ---: |`,
      ...results.map((r) =>
        `| ${r.dataset.name} (${r.dataset.code}) | ${graphsOf(r.dataset).map((g) => g.slice(g.lastIndexOf("/") + 1)).join(", ")} | ${r.error ? `failed: ${r.error.replace(/[|\n]/g, " ").slice(0, 200)}` : r.ops} | ${r.seconds !== undefined ? `${r.seconds.toFixed(0)} s` : ""} |`,
      ),
    ];
    console.log(`Fetched ${ok.length} of ${results.length} RINF datasets\n\n${lines.join("\n")}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      await appendFile(process.env.GITHUB_STEP_SUMMARY, `### RINF data: ${ok.length} of ${results.length} datasets\n\n${lines.join("\n")}\n`);
    }
    if (!ok.length) process.exit(1);
    return;
  }

  const snapshot = await loadSnapshot(dir).catch((e: unknown) => {
    throw new Error(`Cannot load snapshot from ${dir} (run "routebook fetch" first): ${String(e)}`);
  });
  if (cmd === "bundle") {
    // bundles fetched before datasets had names get them from the table of known datasets
    const known = knownDataset(snapshot.meta.country);
    if (known && !snapshot.meta.name) snapshot.meta.name = known.name;
    if (known?.imName && !snapshot.meta.imName) snapshot.meta.imName = known.imName;
    await saveWebBundle(webDir, snapshot, webExtras(snapshot));
    await writeDatasetIndex(webRoot);
    console.error(`Web bundle written to ${webDir}`);
    return;
  }

  const graph = new RoutingGraph(snapshot.topology);

  if (cmd === "stats") {
    const comps = graph.components();
    console.log(`snapshot fetched ${snapshot.meta.fetchedAt}: ${JSON.stringify(snapshot.meta.counts)}`);
    console.log(`components: ${comps.length}, largest: ${comps.slice(0, 5).map((c) => c.length).join(", ")}`);
    return;
  }

  if (cmd === "route") {
    const [a, b] = args;
    if (!a || !b) throw new Error("route needs <from> <to>");
    const from = resolveOp(snapshot.ops, a);
    const to = resolveOp(snapshot.ops, b);
    const mode = values.area ? "area" : "point";
    const src = opEndpoint(from, mode);
    const dst = opEndpoint(to, mode);
    const costModel = values.cost === "length" ? lengthCostModel : trackPreferenceCostModel(snapshot.tracks);
    const route = graph.route(src.intervals, dst.intervals, { costModel });
    if (!route) throw new Error(`No route between ${from.name} and ${to.name}`);
    const rb = buildRoutebook({
      index: new RoutebookIndex(snapshot),
      route,
      from,
      to,
      endpointModes: { from: src.mode, to: dst.mode },
    });
    if (values.json) {
      console.log(JSON.stringify({ ...rb, route: { ...rb.route, steps: rb.route.steps.length } }, null, 2));
    } else {
      console.log(
        formatRoutebook(rb, {
          ...(values.limit ? { limit: Number(values.limit) } : {}),
          ...(values.kinds ? { kinds: values.kinds.split(",") } : {}),
        }),
      );
    }
    return;
  }
  throw new Error(`Unknown command "${cmd}"\n\n${HELP}`);
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
