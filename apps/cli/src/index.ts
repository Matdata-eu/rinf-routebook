#!/usr/bin/env node
import { parseArgs } from "node:util";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";
import { SparqlClient, countryGraph, fetchSnapshot, loadSnapshot, saveSnapshot, saveWebBundle, type Snapshot } from "@routebook/rinf-client";
import { RoutingGraph, lengthCostModel, opEndpoint, resolveOp, trackPreferenceCostModel } from "@routebook/routing";
import { RoutebookIndex, buildRoutebook, formatRoutebook } from "@routebook/routebook";
import { classifySwitches, compactSwitches } from "@routebook/schematic";

const HELP = `routebook <command> [options]

Commands:
  fetch                     Fetch a RINF snapshot from the ERA SPARQL endpoint (also writes the web bundle)
  bundle                    Rebuild the compact web bundle (data/web/<country>) from the snapshot,
                            including the switch classification for the schematic view
  route <from> <to>         Route between two OPs (name, uopid or IRI) and print the routebook
  stats                     Topology statistics of the snapshot

Options:
  --country <ISO3>          Country graph (default NOR)
  --snapshot <dir>          Snapshot directory (default data/snapshots/<country>)
  --endpoint <url>          SPARQL endpoint (fetch only)
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
      country: { type: "string", default: "NOR" },
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
  const country = countryGraph(values.country!);
  const dir = values.snapshot ? resolve(values.snapshot) : join(ROOT, "data", "snapshots", country.code.toLowerCase());
  const webDir = join(ROOT, "data", "web", country.code.toLowerCase());

  if (cmd === "fetch") {
    const client = new SparqlClient({ graph: country.graph, ...(values.endpoint ? { endpoint: values.endpoint } : {}) });
    console.error(`Fetching ${country.name} (${country.graph}) from ${client.endpoint}`);
    const t0 = Date.now();
    const snapshot = await fetchSnapshot({
      client,
      country: country.code,
      onProgress: (step, rows) => console.error(`  ${step.padEnd(16)} ${rows} rows`),
    });
    await saveSnapshot(dir, snapshot);
    await saveWebBundle(webDir, snapshot, webExtras(snapshot));
    console.error(`Saved to ${dir} and ${webDir} in ${((Date.now() - t0) / 1000).toFixed(0)} s`);
    console.log(JSON.stringify(snapshot.meta.counts));
    return;
  }

  const snapshot = await loadSnapshot(dir).catch((e: unknown) => {
    throw new Error(`Cannot load snapshot from ${dir} (run "routebook fetch" first): ${String(e)}`);
  });
  if (cmd === "bundle") {
    await saveWebBundle(webDir, snapshot, webExtras(snapshot));
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
