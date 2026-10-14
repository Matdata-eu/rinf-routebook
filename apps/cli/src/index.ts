#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import {
  DEFAULT_ENDPOINT,
  SparqlClient,
  discoverGraphs,
  fetchSnapshot,
  graphsOf,
  knownDataset,
  loadSnapshot,
  resolveDataset,
  saveSnapshot,
  saveWebBundle,
  writeDatasetIndex,
  type Snapshot,
} from "@routebook/rinf-client";
import { RoutingGraph, lengthCostModel, opEndpoint, resolveOp, trackPreferenceCostModel } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, formatRoutebook } from "@routebook/routebook";
import { classifySwitches, compactSwitches } from "@routebook/schematic";

const HELP = `routebook <command> [options]

Commands:
  datasets                  List the RINF named graphs on the endpoint, with their countries
  fetch                     Fetch a RINF snapshot from the ERA SPARQL endpoint (also writes the web bundle)
  bundle                    Rebuild the compact web bundle (<data>/web/<dataset>) from the snapshot,
                            including the switch classification for the schematic view
  index                     Rewrite <data>/web/datasets.json (the datasets the web app offers)
  route <from> <to>         Route between two OPs (name, uopid or IRI) and print the routebook
  stats                     Topology statistics of the snapshot

Options:
  --dataset <id>            Dataset to fetch or use (default NOR; alias --country). For fetch:
                            an ISO 3166-1 alpha-3 country code (its graphs are looked up on the
                            endpoint), an IM code such as 0076, or a named graph IRI
  --graph <code|IRI>        Fetch exactly these named graphs (repeatable); --dataset is then the id
  --name <text>             Display name of the dataset (fetch)
  --im <text>               Infrastructure manager(s), shown in the data attribution (fetch)
  --data <dir>              Data folder (default ./data, or ROUTEBOOK_DATA_DIR)
  --snapshot <dir>          Snapshot directory (default <data>/snapshots/<dataset>)
  --endpoint <url>          SPARQL endpoint (default ${DEFAULT_ENDPOINT}, or ROUTEBOOK_SPARQL_ENDPOINT)
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
      data: { type: "string" },
      snapshot: { type: "string" },
      endpoint: { type: "string" },
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
    console.error(`${join(webRoot, "datasets.json")}: ${list.map((d) => d.id).join(", ") || "no datasets"}`);
    return;
  }

  if (cmd === "fetch") {
    const lookup = new SparqlClient({ graph: "", ...(endpoint ? { endpoint } : {}) });
    const dataset = await resolveDataset(id, lookup, {
      ...(values.graph?.length ? { graphs: values.graph } : {}),
      ...(values.name ? { name: values.name } : {}),
      ...(values.im ? { imName: values.im } : {}),
    });
    if (!values.snapshot) dir = join(dataRoot, "snapshots", folder(dataset.code));
    webDir = join(webRoot, folder(dataset.code));
    const graphs = graphsOf(dataset);
    const client = new SparqlClient({ graph: graphs[0]!, graphs, ...(endpoint ? { endpoint } : {}) });
    console.error(`Fetching ${dataset.name} (${graphs.join(", ")}) from ${client.endpoint}`);
    const t0 = Date.now();
    const snapshot = await fetchSnapshot({
      client,
      country: dataset.code,
      name: dataset.name,
      ...(dataset.imName ? { imName: dataset.imName } : {}),
      onProgress: (step, rows) => console.error(`  ${step.padEnd(16)} ${rows} rows`),
    });
    await saveSnapshot(dir, snapshot);
    await saveWebBundle(webDir, snapshot, webExtras(snapshot));
    await writeDatasetIndex(webRoot);
    console.error(`Saved to ${dir} and ${webDir} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(JSON.stringify(snapshot.meta.counts));
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
