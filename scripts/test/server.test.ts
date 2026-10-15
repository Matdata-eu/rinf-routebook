import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { esriLayer, inBounds, loadConfig, loadPrivacy, parseTilePath, privacyPage, publicConfig, substituteEnv, tileBbox3857, upstreamUrl } from "../runtime-config.mjs";
import { startServer } from "../serve.mjs";
import { buildStatic } from "../build-static.mjs";
import { readFile } from "node:fs/promises";

const quiet = () => {};

describe("runtime configuration", () => {
  it("substitutes environment variables and reports missing ones", () => {
    const missing = new Set<string>();
    expect(substituteEnv({ a: ["x${KEY}y", "${NOPE:-dflt}", "${GONE}"], n: 3 }, { KEY: "k" }, missing)).toEqual({ a: ["xky", "dflt", ""], n: 3 });
    expect([...missing]).toEqual(["GONE"]);
  });

  it("reads the file, the JSON variable and the shorthands", async () => {
    const dir = await mkdtemp(join(tmpdir(), "rbcfg-"));
    await writeFile(
      join(dir, "config.json"),
      JSON.stringify({ title: "From file", basemaps: [{ id: "ortho", tiles: ["https://o.test/{z}/{x}/{y}?key=${ORTHO_KEY}"], proxy: true }, { id: "bad id", tiles: ["x"] }] }),
    );
    const cfg = loadConfig({ cwd: dir, log: quiet, env: { ORTHO_KEY: "s3cret", ROUTEBOOK_CONFIG: '{"defaultDataset":"nor"}', ROUTEBOOK_TITLE: "Title", ESRI_API_KEY: "e&k" } });
    expect(cfg.title).toBe("Title");
    expect(cfg.defaultDataset).toBe("nor");
    expect(cfg.basemaps.map((b: { id: string }) => b.id)).toEqual(["ortho", "aerial"]);
    expect(cfg.basemaps[0].tiles[0]).toBe("https://o.test/{z}/{x}/{y}?key=s3cret");
    expect(cfg.basemaps[1].tiles[0]).toContain("token=e%26k");
    expect(loadConfig({ cwd: join(dir, "none"), log: quiet, env: {} })).toEqual({ basemaps: [], overlays: [] });
  });

  it("never sends the keys of proxied layers to the browser", () => {
    const cfg = { basemaps: [esriLayer("SECRET"), { id: "open", tiles: ["https://x.test/{z}/{x}/{y}"], headers: { "X-Key": "visible" } }], overlays: [{ id: "o", tiles: ["https://y.test/?k=SECRET&b={bbox-epsg-3857}"], headers: { Authorization: "SECRET" }, proxy: true }] };
    const pub = publicConfig(cfg);
    expect(JSON.stringify(pub)).not.toContain("SECRET");
    expect(pub.basemaps[0].tiles).toEqual(["tiles/aerial/{z}/{x}/{y}"]);
    expect(pub.basemaps[0].proxy).toBeUndefined();
    expect(pub.basemaps[1].headers).toEqual({ "X-Key": "visible" });
    expect(pub.overlays[0].tiles).toEqual(["tiles/o/{z}/{x}/{y}"]);
  });

  it("takes the privacy statement as a link, a text or a file", async () => {
    expect(loadPrivacy("https://example.org/privacy")).toEqual({ label: "Privacy", url: "https://example.org/privacy" });
    expect(loadPrivacy({ text: "We log nothing & set no cookies.\n\nContact: dpo@example.org", label: "Privacy notice" })).toEqual({ label: "Privacy notice", html: "<p>We log nothing &amp; set no cookies.</p>\n<p>Contact: dpo@example.org</p>" });
    const dir = await mkdtemp(join(tmpdir(), "rbpriv-"));
    await writeFile(join(dir, "privacy.html"), "<h1>Privacy</h1><p>Hi</p>");
    expect(loadPrivacy({ file: "privacy.html" }, dir)).toEqual({ label: "Privacy", html: "<h1>Privacy</h1><p>Hi</p>" });
    expect(loadPrivacy({ file: "missing.html" }, dir, quiet)).toBeUndefined();
    expect(loadPrivacy({ text: "  " })).toBeUndefined();
    const page = privacyPage({ label: "Privacy", html: "<p>Hi</p>" }, "Rail & Co");
    expect(page).toContain("<title>Privacy · Rail &amp; Co</title>");
    expect(page).toContain("<h1>Privacy</h1>");
    expect(privacyPage({ label: "P", html: "<html><body>x</body></html>" })).toBe("<html><body>x</body></html>");
    // the browser gets only the link
    expect(publicConfig({ privacy: { label: "Privacy", html: "<p>x</p>" } }).privacy).toEqual({ label: "Privacy", url: "privacy.html" });
    expect(loadConfig({ cwd: dir, log: quiet, env: { ROUTEBOOK_PRIVACY_URL: "https://x.test/p" } }).privacy).toEqual({ label: "Privacy", url: "https://x.test/p" });
    expect(loadConfig({ cwd: dir, log: quiet, env: { ROUTEBOOK_PRIVACY_FILE: "privacy.html" } }).privacy?.html).toContain("Hi");
  });

  it("builds upstream URLs for XYZ, TMS, quadkey and WMS templates", () => {
    expect(upstreamUrl({ tiles: ["https://x.test/{z}/{y}/{x}.jpg"] }, 3, 4, 5)).toBe("https://x.test/3/5/4.jpg");
    expect(upstreamUrl({ tiles: ["https://x.test/{quadkey}"] }, 3, 3, 5)).toBe("https://x.test/213");
    expect(upstreamUrl({ tiles: ["https://x.test/{quadkey}"], scheme: "tms" }, 3, 3, 2)).toBe("https://x.test/213");
    const bbox = upstreamUrl({ tiles: ["https://x.test/wms?BBOX={bbox-epsg-3857}"] }, 0, 0, 0);
    const half = 20037508.342789244;
    expect(bbox).toBe(`https://x.test/wms?BBOX=${[-half, -half, half, half].join(",")}`);
    expect(tileBbox3857(1, 1, 0)).toEqual([0, 0, half, half]);
  });

  it("only accepts real tile paths and skips tiles outside a layer's bounds", () => {
    expect(parseTilePath("/sub/tiles/aerial/3/4/5")).toEqual({ id: "aerial", z: 3, x: 4, y: 5 });
    expect(parseTilePath("/tiles/aerial/3/8/5")).toBeUndefined();
    expect(parseTilePath("/tiles/../3/4/5")).toBeUndefined();
    const norway = { bounds: [4, 57, 32, 72] };
    expect(inBounds(norway, 6, 33, 17)).toBe(true); // around Oslo
    expect(inBounds(norway, 6, 10, 40)).toBe(false); // the Americas
  });
});

describe("server", () => {
  const servers: Server[] = [];
  afterAll(() => servers.forEach((s) => s.close()));
  const base = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  it("serves config.json, datasets.json, data bundles and proxied tiles", async () => {
    const upstream = createServer((req, res) => {
      if (req.headers.authorization !== "Bearer SECRET") return void res.writeHead(401).end();
      res.writeHead(200, { "Content-Type": "image/png" }).end(`tile ${req.url}`);
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    servers.push(upstream);

    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    await mkdir(join(data, "web", "nor"), { recursive: true });
    await writeFile(join(data, "web", "nor", "meta.json"), JSON.stringify({ country: "NOR", name: "Norway", imName: "Bane NOR", fetchedAt: "t", counts: { ops: 1 } }));
    const config = {
      basemaps: [{ id: "ortho", tiles: [`${base(upstream)}/{z}/{x}/{y}.png`], headers: { Authorization: "Bearer SECRET" }, proxy: true }],
      overlays: [],
      privacy: { label: "Privacy", html: "<p>No tracking.</p>" },
    };
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config });
    servers.push(server);
    const get = (p: string) => fetch(`${base(server)}${p}`);

    const cfg = await (await get("/config.json")).text();
    expect(cfg).not.toContain("SECRET");
    expect(JSON.parse(cfg).basemaps[0].tiles).toEqual(["tiles/ortho/{z}/{x}/{y}"]);
    expect(await (await get("/datasets.json")).json()).toEqual([{ id: "nor", name: "Norway", imName: "Bane NOR", fetchedAt: "t", ops: 1 }]);
    expect((await get("/nor/meta.json")).status).toBe(200);
    expect((await get("/")).status).toBe(200);
    expect(JSON.parse(cfg).privacy).toEqual({ label: "Privacy", url: "privacy.html" });
    expect(await (await get("/privacy.html")).text()).toContain("<p>No tracking.</p>");
    expect((await get("/../etc/passwd")).status).toBe(404);

    const tile = await get("/tiles/ortho/3/4/5");
    expect(tile.status).toBe(200);
    expect(await tile.text()).toBe("tile /3/4/5.png");
    expect((await get("/tiles/other/3/4/5")).status).toBe(404);
    expect((await fetch(`${base(server)}/config.json`, { method: "POST" })).status).toBe(405);
  });
});

describe("static build (GitHub Pages)", () => {
  it("writes config.json without proxied layers, privacy.html and datasets.json", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rbstatic-"));
    await writeFile(join(repo, "privacy.html"), "<h1>Privacy statement</h1><p>Published by Matdata, hosted on GitHub Pages.</p>");
    await writeFile(
      join(repo, "config.json"),
      JSON.stringify({
        title: "Demo",
        privacy: { file: "privacy.html" },
        basemaps: [{ id: "keyed", tiles: ["https://k.test/{z}/{x}/{y}?key=${KEY}"], proxy: true }, { id: "open", tiles: ["https://o.test/{z}/{x}/{y}"] }],
      }),
    );
    const dist = join(repo, "dist");
    await mkdir(join(dist, "bel"), { recursive: true });
    await writeFile(join(dist, "bel", "meta.json"), JSON.stringify({ country: "BEL", name: "Belgium", counts: { ops: 7 } }));
    const config = loadConfig({ cwd: repo, log: quiet, env: { ROUTEBOOK_CONFIG_FILE: "config.json", KEY: "s3cret" } });
    const out = buildStatic(dist, { config, log: quiet });
    expect(out.dropped).toEqual(["keyed"]);
    const written = await readFile(join(dist, "config.json"), "utf8");
    expect(written).not.toContain("s3cret");
    expect(JSON.parse(written)).toMatchObject({ title: "Demo", privacy: { label: "Privacy", url: "privacy.html" }, basemaps: [{ id: "open" }] });
    const page = await readFile(join(dist, "privacy.html"), "utf8");
    expect(page).toContain("<!doctype html>");
    expect(page).toContain("hosted on GitHub Pages");
    expect(JSON.parse(await readFile(join(dist, "datasets.json"), "utf8"))).toEqual([{ id: "bel", name: "Belgium", ops: 7 }]);
  });

  it("ships the Matdata privacy statement for the public demo", () => {
    const cfg = loadConfig({ cwd: join(__dirname, "..", ".."), log: quiet, env: { ROUTEBOOK_CONFIG_FILE: "deploy/github-pages/config.json" } });
    expect(cfg.privacy.html).toMatch(/Matdata/);
    expect(cfg.privacy.html).toMatch(/GitHub Pages/);
  });
});
