#!/usr/bin/env node
// Browser smoke test of the built web app (pnpm build first): a small synthetic dataset and the
// example plugin, served by scripts/serve.mjs with its Content-Security-Policy, routed in headless
// Chromium through all four views. Fails on a page error, a CSP violation, a console error from
// the app's own origin, or a route that is not found.
// Usage: node scripts/smoke.mjs [--channel chrome|msedge]   (CHROME_PATH=/path/to/chrome uses that binary)
import { copyFile, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { saveWebBundle, writeDatasetIndex } from "../packages/rinf-client/dist/index.js";
import { startServer } from "./serve.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const arg = (name) => (process.argv.includes(name) ? process.argv[process.argv.indexOf(name) + 1] : undefined);
const OP = "http://data.europa.eu/949/concepts/op-types/";

// two stations 25 km apart on one element, with a signal and a speed: enough for every view
const L = 25_000;
const snapshot = {
  meta: { endpoint: "https://sparql.test", graph: "g-smk", country: "SMK", name: "Smoke", imName: "Smoke IM", fetchedAt: "2026-10-30T00:00:00.000Z", counts: { ops: 2 } },
  ops: [
    { id: "op-a", uopid: "SMKA", name: "Alpha", type: `${OP}10`, lon: 10, lat: 60, points: [{ ne: "ne-1", offset: 0 }], areas: [] },
    { id: "op-b", uopid: "SMKB", name: "Bravo", type: `${OP}10`, lon: 10.45, lat: 60, points: [{ ne: "ne-1", offset: L }], areas: [] },
  ],
  lines: [{ id: "line-1", label: "Smoke line" }],
  sols: [{ id: "sol-1", opStart: "op-a", opEnd: "op-b", line: "line-1" }],
  topology: { netElements: [{ id: "ne-1", length: L }], netRelations: [] },
  tracks: [{ id: "t-1", kind: "running", elements: ["ne-1"], partOf: ["sol-1"], speed: 120 }],
  features: [{ id: "sig-1", kind: "signal", ne: "ne-1", offset: 12_000, label: "S1" }],
  tunnels: [],
  geometry: { "ne-1": [[10, 60], [10.225, 60], [10.45, 60]] },
};

const data = await mkdtemp(join(tmpdir(), "rbsmoke-"));
const web = join(data, "web");
// switches.json as `routebook fetch` writes it (optional for the app, but a 404 would be logged)
await saveWebBundle(join(web, "smk"), snapshot, { switches: [] });
await writeDatasetIndex(web);
await mkdir(join(data, "plugins"));
await copyFile(join(root, "examples/plugins/km-markers.js"), join(data, "plugins/km-markers.js"));
const config = { basemaps: [], overlays: [], builtinBasemaps: false, builtinOverlays: false, disclaimer: false, offline: false, plugins: ["plugins/km-markers.js"] };
const server = await startServer(join(root, "apps/web/dist"), 0, "127.0.0.1", { dataDir: data, config });
const base = `http://127.0.0.1:${server.address().port}/`;

const channel = arg("--channel") ?? "chrome";
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel }),
  args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"],
});
const problems = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on("pageerror", (e) => problems.push(`page error: ${e.message}`));
  page.on("response", (r) => {
    if (r.status() >= 400 && r.url().startsWith(base)) console.log(`  ${r.status()} ${r.url().slice(base.length)}`);
  });
  page.on("console", (m) => {
    if (m.type() !== "error") return;
    const from = m.location().url ?? "";
    // map tiles and fonts of third parties may fail offline; the app's own errors may not
    if (!from || from.startsWith(base)) problems.push(`console error: ${m.text()}`);
  });
  await page.addInitScript(() => {
    window.__csp = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__csp.push(`${e.violatedDirective} ${e.blockedURI}`));
  });
  const res = await page.goto(`${base}?from=SMKA&to=SMKB`);
  if (!res?.headers()["content-security-policy"]) problems.push("no Content-Security-Policy header on the page");
  await page.waitForFunction(() => ["routed", "error"].includes(document.body.dataset.state ?? ""), null, { timeout: 30_000 });
  const state = await page.evaluate(() => [document.body.dataset.state, document.getElementById("status")?.textContent]);
  if (state[0] !== "routed") problems.push(`not routed: ${state[1]}`);
  console.log(`map: ${state[1]}`);
  const panel = await page.textContent("#routebook");
  if (!panel?.includes("10 km from the start")) problems.push("the example plugin's items are not in the routebook");
  for (const view of ["schematic", "strip", "drive", "map"]) {
    await page.click(`#tab-${view}`);
    await page.waitForTimeout(view === "schematic" ? 2500 : 1000);
    const selected = await page.getAttribute(`#tab-${view}`, "aria-selected");
    if (selected !== "true") problems.push(`${view} tab not selected`);
    console.log(`${view}: ok`);
  }
  const csp = await page.evaluate(() => window.__csp);
  for (const v of csp) problems.push(`CSP violation: ${v}`);
} finally {
  await browser.close();
  server.close();
  await rm(data, { recursive: true, force: true });
}
if (problems.length) {
  console.error(`Smoke test failed:\n- ${[...new Set(problems)].join("\n- ")}`);
  process.exit(1);
}
console.log("Smoke test passed");
