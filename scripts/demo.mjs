#!/usr/bin/env node
// Serve the built web app with the RINF data in data/web (run via `pnpm demo`, which builds first).
// Everything needed for routing is local; only the map background tiles and label fonts need internet.
import { fileURLToPath } from "node:url";
import { listDatasets, startServer } from "./serve.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = `${root}apps/web/dist`;
const dataDir = process.env.ROUTEBOOK_DATA_DIR ?? `${root}data`;
const port = Number(process.env.PORT ?? 4173);

const datasets = listDatasets([`${dataDir}/web`, dist]);
if (!datasets.length) {
  console.error('No RINF data yet. Fetch a dataset once (needs internet), e.g. "pnpm fetch:nor" or "pnpm routebook fetch --dataset BEL", then run "pnpm demo" again.');
  process.exit(1);
}
await startServer(dist, port, process.env.HOST ?? "127.0.0.1", { dataDir });
const base = `http://127.0.0.1:${port}/`;
const nor = datasets.some((d) => d.id === "nor");
console.log(`
  Routebook demo running at ${base}

  Datasets: ${datasets.map((d) => `${d.name} (${d.id})`).join(", ")}
${nor ? `
  Example routes (Norway):
    Oslo S -> Drammen        ${base}?dataset=nor&from=NOOSL&to=NODRM
    Oslo S -> Bergen         ${base}?dataset=nor&from=NOOSL&to=NOBRG
    Trondheim S -> Bodø      ${base}?dataset=nor&from=NOTND&to=NOBO
` : ""}
  Ctrl+C to stop.
`);
