#!/usr/bin/env node
// Static deployment (e.g. GitHub Pages): writes the runtime configuration that the server
// (scripts/serve.mjs) would otherwise serve into the built app, as plain files:
//   <dist>/config.json    the configuration as the browser gets it
//   <dist>/privacy.html   the privacy statement, when it is a text or a file
//   <dist>/datasets.json  the datasets found in <dist> (the web bundles copied in by the build)
//
// Usage: node scripts/build-static.mjs [dist=apps/web/dist]
// The configuration is read as the server reads it (ROUTEBOOK_CONFIG_FILE, ROUTEBOOK_CONFIG, the
// shorthands; see scripts/runtime-config.mjs). A static site has no tile proxy, so layers with
// "proxy": true are left out: everything in config.json is public.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, privacyPage, publicConfig } from "./runtime-config.mjs";
import { listDatasets } from "./serve.mjs";

/** Write config.json, privacy.html and datasets.json into `dist`; returns what was written. */
export function buildStatic(dist, { config = loadConfig(), log = console.warn } = {}) {
  const dropped = [];
  const keep = (l) => {
    if (l.proxy) dropped.push(l.id);
    return !l.proxy;
  };
  const staticConfig = { ...config, basemaps: (config.basemaps ?? []).filter(keep), overlays: (config.overlays ?? []).filter(keep) };
  if (dropped.length) log(`Static build: layer(s) ${dropped.join(", ")} need the server's tile proxy and are left out.`);
  const written = ["config.json"];
  if (staticConfig.privacy?.html) {
    writeFileSync(resolve(dist, "privacy.html"), privacyPage(staticConfig.privacy, staticConfig.title));
    written.push("privacy.html");
  }
  writeFileSync(resolve(dist, "config.json"), JSON.stringify(publicConfig(staticConfig), null, 2));
  const catalogue = listDatasets([dist]);
  writeFileSync(resolve(dist, "datasets.json"), JSON.stringify(catalogue, null, 2));
  written.push("datasets.json");
  return { written, dropped, datasets: catalogue.datasets };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dist = resolve(process.argv[2] ?? "apps/web/dist");
  const { written, datasets } = buildStatic(dist);
  console.error(`${dist}: ${written.join(", ")}; datasets: ${datasets.map((d) => d.id).join(", ") || "none"}`);
}
