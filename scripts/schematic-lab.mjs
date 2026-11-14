// Developer tool for the schematic layouter: measures the heuristic and the solver layout of routes on
// a web bundle (data/web/<dataset>, as written by `routebook fetch` or copied from a running instance),
// and writes small test fixtures out of it.
//
//   node scripts/schematic-lab.mjs measure <dataset> <FROM:TO> [<FROM:TO> ...]
//   node scripts/schematic-lab.mjs dump <dataset> <FROM:TO> [<from m> <to m>]  the solver layout, a line per track
//   node scripts/schematic-lab.mjs ops <dataset> <FROM:TO>            operational points along a route
//   node scripts/schematic-lab.mjs fixture <dataset> <FROM:TO> <name> writes packages/schematic/test/fixtures/<name>.json
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const root = new URL("../", import.meta.url);
// the workspace packages resolve from the schematic package (the repository root does not depend on them)
const require = createRequire(new URL("packages/schematic/package.json", root));
const load = (name) => import(pathToFileURL(require.resolve(name)).href);
const { fromWebBundle, expandIris } = await load("@routebook/rinf-client/compact");
const { RoutingGraph, opEndpoint, resolveOp, trackPreferenceCostModel } = await load("@routebook/routing");
const S = await load("@routebook/schematic");

// LAB_OPTS: solver layout options as JSON, e.g. LAB_OPTS='{"stretch":false}'
const OPTS = JSON.parse(process.env.LAB_OPTS ?? "{}");
const [cmd, ds, ...rest] = process.argv.slice(2);
if (!cmd || !ds) {
  console.error("usage: schematic-lab.mjs measure|ops|fixture <dataset> <FROM:TO> ...");
  process.exit(2);
}
const dir = new URL(`data/web/${ds}/`, root);
const part = (p) => JSON.parse(readFileSync(new URL(`${p}.json`, dir), "utf8"));
const PARTS = ["meta", "ops", "lines", "sols", "topology", "tracks", "features", "tunnels", "geometry"];
const parts = Object.fromEntries(PARTS.map((p) => [p, part(p)]));
const snap = fromWebBundle(parts);
const prefixes = snap.meta.prefixes ?? {};
const network = new S.TopoNetwork(snap);
const switchRows = part("switches");
const switches = S.expandSwitches(expandIris(switchRows, prefixes), network);
const graph = new RoutingGraph(snap.topology);
const cost = trackPreferenceCostModel(snap.tracks);
const input = { network, switches, tracks: snap.tracks, ops: snap.ops };
const routeOf = (pair) => {
  const [a, b] = pair.split(":");
  const r = graph.route(opEndpoint(resolveOp(snap.ops, a)).intervals, opEndpoint(resolveOp(snap.ops, b)).intervals, { costModel: cost });
  if (!r) throw new Error(`no route ${pair}`);
  return r;
};
const lengthOf = (ne) => network.lengths.get(ne);
const fmt = (q) =>
  `lanes ${q.minLane}..${q.maxLane} (excess ${q.excessLanes}), crossings ${q.crossings}, bends ${q.bends}, overlaps ${q.overlaps}, squeezed ${q.squeezed}, stretched ${q.stretched}, steep ${q.steep}, split ${q.split}`;

if (cmd === "ops") {
  const r = routeOf(rest[0]);
  const at = new Map();
  for (const st of r.steps) for (const op of snap.ops) if ([...(op.areas ?? []), ...(op.points ?? [])].some((x) => x.ne === st.ne) && !at.has(op.uopid)) at.set(op.uopid, [st.startDistance, op.name]);
  for (const [id, [d, name]] of at) console.log((d / 1000).toFixed(1).padStart(7), id, name);
} else if (cmd === "measure") {
  const highs = await S.loadHighs();
  for (const pair of rest) {
    const r = routeOf(pair);
    let t = performance.now();
    const h = S.layoutRouteSchematic(r, input);
    const th = performance.now() - t;
    const prep = S.prepareSolvedLayout(r, input, OPTS);
    t = performance.now();
    const sols = prep.problems.map((p) => {
      const s = S.solveWithHighs(highs, p);
      return s;
    });
    const ts = performance.now() - t;
    const s = prep.finish(sols);
    const status = {};
    for (const w of prep.reports) status[w.status] = (status[w.status] ?? 0) + 1;
    console.log(`${pair} ${(r.length / 1000).toFixed(0)} km, ${s.tracks.length} tracks; heuristic ${th.toFixed(0)} ms, solve ${ts.toFixed(0)} ms, windows ${JSON.stringify(status)}`);
    console.log(`  heuristic ${fmt(S.layoutQuality(h, lengthOf))}`);
    console.log(`  solver    ${fmt(S.layoutQuality(s, lengthOf))}`);
  }
} else if (cmd === "dump") {
  // the solver layout between two distances (m): one line per track
  const [pair, d0 = "0", d1 = "Infinity"] = rest;
  const r = routeOf(pair);
  const highs = await S.loadHighs();
  const prep = S.prepareSolvedLayout(r, input, OPTS);
  const s = prep.finish(prep.problems.map((p) => S.solveWithHighs(highs, p)));
  const [x0, x1] = [S.schematicX(s, +d0), S.schematicX(s, +d1)];
  console.log(`x ${x0.toFixed(0)}..${x1.toFixed(0)}; scale ${JSON.stringify((s.scale ?? []).filter(([d]) => d >= +d0 - 500 && d <= +d1 + 500))}`);
  for (const w of s.windows ?? []) if (w.to >= +d0 && w.from <= +d1) console.log("window", JSON.stringify(w));
  for (const t of s.tracks) {
    if (Math.max(t.from.x, t.to.x) < x0 || Math.min(t.from.x, t.to.x) > x1) continue;
    const runs = t.runs ? " runs " + t.runs.map((q) => `${q.from.toFixed(0)}..${q.to.toFixed(0)}@${q.y}`).join(" ") : "";
    console.log(`${t.onRoute ? "R" : t.baseline ? "B" : t.stub ? "s" : " "} ${(t.track ?? "").padEnd(8).slice(0, 8)} len ${String(Math.round(lengthOf(t.ne) ?? 0)).padStart(5)}  (${t.from.x.toFixed(0)},${t.from.y}) -> (${t.to.x.toFixed(0)},${t.to.y}) lane ${t.lane}${runs}  ${t.ne.slice(-12)}`);
  }
} else if (cmd === "fixture") {
  const [pair, name] = rest;
  const r = routeOf(pair);
  // every element within 3.5 km of track from the route
  const keep = new Map(r.steps.map((st) => [st.ne, 0]));
  const queue = [...keep.keys()];
  for (let ne = queue.shift(); ne; ne = queue.shift()) {
    const d = keep.get(ne) + (keep.get(ne) === 0 && r.steps.some((s) => s.ne === ne) ? 0 : (network.lengths.get(ne) ?? 0));
    if (d > 3500) continue;
    for (const end of [0, 1]) for (const o of network.nodes[network.nodeOf({ ne, end })] ?? []) if (!keep.has(o.ne)) {
      keep.set(o.ne, d);
      queue.push(o.ne);
    }
  }
  // short ids: the fixture only has to be consistent with itself
  const ids = new Map([...keep.keys()].map((ne, i) => [ne, `e${i}`]));
  const id = (ne) => ids.get(ne);
  const has = (ne) => ids.has(ne);
  const endId = (k) => {
    const [ne, end] = k.split("|");
    return `${id(ne)}|${end}`;
  };
  const r3 = (v) => Math.round(v * 1000) / 1000;
  const out = {
    source: `RINF data of ${snap.meta.imName ?? snap.meta.name ?? ds}, published by the European Union Agency for Railways (ERA), fetched ${String(snap.meta.fetchedAt ?? "").slice(0, 10)}: the tracks within 3.5 km of ${pair.replace(":", " to ")}. Element ids are shortened.`,
    route: { ...r, length: r3(r.length), cost: r3(r.cost), steps: r.steps.map((st) => ({ ...st, ne: id(st.ne), from: r3(st.from), to: r3(st.to), startDistance: r3(st.startDistance) })) },
    // [id, length]
    elements: snap.topology.netElements.filter((e) => has(e.id)).map((e) => [id(e.id), r3(e.length)]),
    // [a, b, a at origin, b at origin, navigable]
    relations: snap.topology.netRelations.filter((x) => has(x.a) && has(x.b)).map((x) => [id(x.a), id(x.b), +x.aAtOrigin, +x.bAtOrigin, +x.navigable]),
    // [kind, label, elements]
    tracks: snap.tracks.filter((t) => t.elements.some(has)).map((t) => [t.kind, t.label ?? "", t.elements.filter(has).map(id)]),
    // [common, continuous, deviating, side, rule, label]: the classification of `routebook bundle`
    switches: expandIris(switchRows, prefixes).filter((row) => has(row[0].split("|")[0])).map((row) => [endId(row[0]), endId(row[1]), endId(row[2]), row[3], row[4], row[6] ?? ""]),
    // [name, elements]
    ops: snap.ops
      .map((o) => [o.name, [...new Set([...(o.areas ?? []), ...(o.points ?? [])].map((x) => x.ne).filter(has).map(id))]])
      .filter((o) => o[1].length),
    geometry: Object.fromEntries(Object.entries(snap.geometry ?? {}).filter(([ne]) => has(ne)).map(([ne, g]) => [id(ne), g])),
  };
  const file = new URL(`packages/schematic/test/fixtures/${name}.json`, root);
  mkdirSync(new URL("./", file), { recursive: true });
  const text = JSON.stringify(out);
  writeFileSync(file, text + "\n");
  console.log(`${name}: ${out.elements.length} elements, ${(text.length / 1024).toFixed(0)} kB`);
}
