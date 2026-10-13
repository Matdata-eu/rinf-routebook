#!/usr/bin/env node
// Serve the built web app with its bundled RINF snapshot (run via `pnpm demo`, which builds first).
// Everything needed for routing is local; only the OSM background tiles and map label fonts need internet.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { startServer } from "./serve.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const dist = `${root}apps/web/dist`;
const port = Number(process.env.PORT ?? 4173);

if (!existsSync(`${dist}/nor/meta.json`)) {
  console.error('No snapshot in the web build. Run "pnpm fetch:nor" once (needs internet), then "pnpm demo" again.');
  process.exit(1);
}
await startServer(dist, port);
const base = `http://127.0.0.1:${port}/`;
console.log(`
  Routebook demo running at ${base}

  Example routes:
    Oslo S -> Drammen        ${base}?from=NOOSL&to=NODRM
    Oslo S -> Bergen         ${base}?from=NOOSL&to=NOBRG
    Trondheim S -> Bodø      ${base}?from=NOTND&to=NOBO

  Ctrl+C to stop.
`);
