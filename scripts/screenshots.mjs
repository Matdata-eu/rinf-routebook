#!/usr/bin/env node
// Headless screenshots of the built web app (pnpm build first).
// Uses an installed Chrome/Edge through playwright-core, so no browser download is needed.
// Usage: node scripts/screenshots.mjs [--channel chrome|msedge] [--only name,name]
// CHROME_PATH=/path/to/chrome uses that browser binary instead of a channel.
import { mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { startServer } from "./serve.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const out = `${root}docs/screenshots`;
const channel = process.argv.includes("--channel") ? process.argv[process.argv.indexOf("--channel") + 1] : "chrome";
const only = process.argv.includes("--only") ? process.argv[process.argv.indexOf("--only") + 1].split(",") : undefined;
const port = 4199;

const shots = [
  { name: "oslo-drammen", query: "from=NOOSL&to=NODRM", viewport: { width: 1440, height: 900 } },
  { name: "oslo-bergen", query: "from=NOOSL&to=NOBRG", viewport: { width: 1440, height: 900 } },
  { name: "oslo-drammen-tablet", query: "from=NOOSL&to=NODRM", viewport: { width: 820, height: 1180 }, select: "Lieråstunnelen" },
  { name: "oslo-drammen-schematic", query: "from=NOOSL&to=NODRM&view=schematic", viewport: { width: 1440, height: 900 }, scrollSchematic: 1300 },
  { name: "oslo-bergen-strip", query: "from=NOOSL&to=NOBRG&view=strip&km=10&dep=08:15", viewport: { width: 1440, height: 900 } },
  { name: "oslo-drammen-print", query: "from=NOOSL&to=NODRM", viewport: { width: 900, height: 1270 }, print: true },
  { name: "drive-chase", query: "from=NOOSL&to=NODRM&view=drive&at=13900", viewport: { width: 1440, height: 900 } },
  { name: "drive-cab", query: "from=NOOSL&to=NODRM&view=drive&at=5200", viewport: { width: 1440, height: 900 }, click: '[data-camera="cab"]' },
  { name: "drive-tablet", query: "from=NOOSL&to=NODRM&view=drive&at=35800", viewport: { width: 820, height: 1180 } },
];

await mkdir(out, { recursive: true });
const server = await startServer(`${root}apps/web/dist`, port);
const browser = await chromium.launch({
  ...(process.env.CHROME_PATH ? { executablePath: process.env.CHROME_PATH } : { channel }),
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
});
try {
  for (const s of shots.filter((x) => !only || only.includes(x.name))) {
    const page = await browser.newPage({ viewport: s.viewport, deviceScaleFactor: 1 });
    const errors = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`http://127.0.0.1:${port}/?${s.query}`);
    await page.waitForSelector('body[data-state="routed"], body[data-state="error"]', { timeout: 60_000 });
    const state = await page.getAttribute("body", "data-state");
    const status = await page.textContent("#status");
    if (s.select) {
      await page.locator(".rb-row.kind-tunnel", { hasText: s.select }).first().click();
    }
    if (s.click) await page.click(s.click);
    if (s.scrollSchematic) await page.evaluate((x) => (document.getElementById("sch-scroll").scrollLeft = x), s.scrollSchematic);
    await page.waitForLoadState("networkidle").catch(() => {});
    await page.waitForTimeout(2500); // let tiles and the map fade-in finish
    if (s.print) await page.emulateMedia({ media: "print" });
    const file = `${out}/${s.name}.png`;
    await page.screenshot({ path: file, fullPage: false });
    console.log(`${s.name}: state=${state} status="${status}" -> ${file}${errors.length ? ` errors: ${errors.join("; ")}` : ""}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.close();
}
