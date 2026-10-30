import { describe, expect, it, afterAll } from "vitest";
import { mkdtemp, mkdir, utimes, writeFile } from "node:fs/promises";
import { brotliCompressSync, gzipSync } from "node:zlib";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { esriLayer, inBounds, loadConfig, pmtilesLayer, loadPrivacy, parseTilePath, privacyPage, publicConfig, substituteEnv, tileBbox3857, upstreamUrl } from "../runtime-config.mjs";
import { byteRange, contentSecurityPolicy, createRateLimiter, createTileCache, health, inlineScriptHashes, startServer, startSync } from "../serve.mjs";
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

  it("adds a self-hosted PMTiles basemap from ROUTEBOOK_BASEMAP_PMTILES", () => {
    const config = loadConfig({ env: { ROUTEBOOK_BASEMAP_PMTILES: "europe 2026.pmtiles" }, cwd: tmpdir(), log: quiet });
    expect(config.basemaps[0]).toEqual(pmtilesLayer("europe 2026.pmtiles"));
    expect(config.basemaps[0].url).toBe("basemap/europe%202026.pmtiles");
    const own = loadConfig({ env: { ROUTEBOOK_CONFIG: JSON.stringify({ basemaps: [{ id: "v", type: "pmtiles", url: "basemap/a.pmtiles" }, { id: "bad", type: "pmtiles" }] }) }, cwd: tmpdir(), log: quiet });
    expect(own.basemaps.map((b: { id: string }) => b.id)).toEqual(["v"]);
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
    // a plain text is never HTML, even when it looks a bit like it
    expect(loadPrivacy({ text: "We <3 privacy & a < b > c" })).toEqual({ label: "Privacy", html: "<p>We &lt;3 privacy &amp; a &lt; b &gt; c</p>" });
    expect(loadPrivacy({ html: "<p>Own <b>HTML</b></p>" })).toEqual({ label: "Privacy", html: "<p>Own <b>HTML</b></p>" });
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
    expect(await (await get("/datasets.json")).json()).toEqual({ version: 2, datasets: [{ id: "nor", name: "Norway", imName: "Bane NOR", fetchedAt: "t", ops: 1, status: "loaded", counts: { ops: 1 } }] });
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

  it("serves a self-hosted basemap with range requests", async () => {
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    await mkdir(join(data, "basemap", "fonts", "Noto Sans Regular"), { recursive: true });
    await writeFile(join(data, "basemap", "europe.pmtiles"), "0123456789abcdef");
    await writeFile(join(data, "basemap", "fonts", "Noto Sans Regular", "0-255.pbf"), "glyphs");
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: {} });
    servers.push(server);
    const url = `${base(server)}/basemap/europe.pmtiles`;
    const part = await fetch(url, { headers: { Range: "bytes=2-5" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-5/16");
    expect(await part.text()).toBe("2345");
    const tail = await fetch(url, { headers: { Range: "bytes=-3" } });
    expect(await tail.text()).toBe("def");
    expect((await fetch(url, { headers: { Range: "bytes=40-50" } })).status).toBe(416);
    const whole = await fetch(url);
    expect(whole.status).toBe(200);
    expect(whole.headers.get("accept-ranges")).toBe("bytes");
    expect(await (await fetch(`${base(server)}/basemap/fonts/Noto%20Sans%20Regular/0-255.pbf`)).text()).toBe("glyphs");
    expect((await fetch(`${base(server)}/basemap/../web/x`)).status).toBe(404);
    expect((await fetch(`${base(server)}/basemap/missing.pmtiles`)).status).toBe(404);
  });

  it("survives malformed URLs and answers them", async () => {
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: {} });
    servers.push(server);
    for (const p of ["/%", "/%e0", "/basemap/%zz", "/nor/%00.json"]) expect((await fetch(`${base(server)}${p}`)).status).toBeGreaterThanOrEqual(400);
    // still up
    expect((await fetch(`${base(server)}/healthz`)).status).toBe(200);
  });

  it("sends a Content-Security-Policy with the hashes of the page's inline scripts", async () => {
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    const html = `<!doctype html><script>var t = 1;</script><script type="module" src="./a.js"></script>`;
    await writeFile(join(dist, "index.html"), html);
    const [hash] = inlineScriptHashes(html);
    expect(inlineScriptHashes(html)).toHaveLength(1);
    expect(hash).toMatch(/^sha256-/);
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: {} });
    servers.push(server);
    const csp = (await fetch(`${base(server)}/`)).headers.get("content-security-policy")!;
    expect(csp).toBe(contentSecurityPolicy([hash!]));
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain(`'${hash}'`);
    expect((await fetch(`${base(server)}/healthz`)).headers.get("content-security-policy")).toBeNull();
    const off = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: { contentSecurityPolicy: false } });
    servers.push(off);
    expect((await fetch(`${base(off)}/`)).headers.get("content-security-policy")).toBeNull();
  });

  it("keeps the tile proxy for its own app: no other sites, a rate limit and a shared cache", async () => {
    let hits = 0;
    const upstream = createServer((req, res) => {
      hits++;
      res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": req.url?.includes("/9/") ? "no-store" : "max-age=600" }).end(`tile ${req.url}`);
    });
    await new Promise<void>((ok) => upstream.listen(0, "127.0.0.1", ok));
    servers.push(upstream);
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    const config = { basemaps: [{ id: "k", tiles: [`${base(upstream)}/{z}/{x}/{y}`], proxy: true }], overlays: [] };
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config, tileRate: 4, tileCacheMb: 1 });
    servers.push(server);
    const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base(server)}${p}`, { headers });
    expect((await get("/tiles/k/3/4/5", { "Sec-Fetch-Site": "cross-site" })).status).toBe(403);
    expect(hits).toBe(0);
    expect(await (await get("/tiles/k/3/4/5", { "Sec-Fetch-Site": "same-origin" })).text()).toBe("tile /3/4/5");
    expect(await (await get("/tiles/k/3/4/5")).text()).toBe("tile /3/4/5");
    expect(hits).toBe(1); // the second came from the cache
    await get("/tiles/k/9/4/5");
    await get("/tiles/k/9/4/5");
    expect(hits).toBe(3); // no-store is never cached
    expect((await get("/tiles/k/3/4/6")).status).toBe(429);
  });

  it("serves plugin modules from the plugins folder, also under a sub-path", async () => {
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    await mkdir(join(data, "plugins"));
    await writeFile(join(data, "plugins", "acme.js"), "export default { id: 'acme', name: 'Acme', version: '1' };");
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: { basemaps: [], overlays: [] } });
    servers.push(server);
    const res = await fetch(`${base(server)}/app/plugins/acme.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/javascript");
    expect(await res.text()).toContain("acme");
    expect((await fetch(`${base(server)}/plugins/../plugins/acme.js`)).status).toBe(200); // normalised by the URL parser
    expect((await fetch(`${base(server)}/plugins/%2e%2e%2fsecret.js`)).status).toBe(404);
  });

  it("limits requests per client with a refilling bucket", () => {
    let t = 0;
    const allow = createRateLimiter(60, () => t);
    for (let i = 0; i < 60; i++) expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(allow("b")).toBe(true);
    t += 1000; // one more token a second
    expect(allow("a")).toBe(true);
    expect(allow("a")).toBe(false);
    expect(createRateLimiter(0)("a")).toBe(true);
  });

  it("caches tiles within a memory budget, least recently used out first", () => {
    let t = 0;
    const cache = createTileCache(30, () => t);
    cache.set("a", "image/png", "max-age=60", Buffer.alloc(3));
    cache.set("b", "image/png", "max-age=60", Buffer.alloc(3));
    cache.set("p", "image/png", "private, max-age=60", Buffer.alloc(3));
    expect(cache.get("p")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    for (const k of ["c", "d", "e", "f", "g", "h", "i", "j", "k"]) cache.set(k, "image/png", undefined, Buffer.alloc(3));
    expect(cache.get("a")).toBeDefined(); // used recently
    expect(cache.get("b")).toBeUndefined(); // the oldest went
    t += 61_000;
    expect(cache.get("a")).toBeUndefined(); // expired
  });

  it("reads byte ranges", () => {
    expect(byteRange(undefined, 10)).toBeUndefined();
    expect(byteRange("bytes=0-3", 10)).toEqual({ start: 0, end: 3 });
    expect(byteRange("bytes=5-", 10)).toEqual({ start: 5, end: 9 });
    expect(byteRange("bytes=8-100", 10)).toEqual({ start: 8, end: 9 });
    expect(byteRange("bytes=-4", 10)).toEqual({ start: 6, end: 9 });
    expect(byteRange("bytes=0-1,4-5", 10)).toBeUndefined();
    expect(byteRange("bytes=10-12", 10)).toBeNull();
  });

  it("sends precompressed bundle parts, validates ETags and reports the catalogue on /healthz", async () => {
    const dist = await mkdtemp(join(tmpdir(), "rbdist-"));
    const data = await mkdtemp(join(tmpdir(), "rbdata-"));
    await writeFile(join(dist, "index.html"), "<!doctype html>");
    const nor = join(data, "web", "nor");
    await mkdir(nor, { recursive: true });
    const ops = JSON.stringify(Array.from({ length: 200 }, (_, i) => ({ i, name: `Station ${i}` })));
    await writeFile(join(nor, "ops.json"), ops);
    await writeFile(join(nor, "ops.json.gz"), gzipSync(ops));
    await writeFile(join(nor, "ops.json.br"), brotliCompressSync(ops));
    // a stale .br from an older bundle is ignored
    await writeFile(join(nor, "lines.json"), "[1,2,3]");
    await writeFile(join(nor, "lines.json.br"), brotliCompressSync("old"));
    await utimes(join(nor, "lines.json.br"), new Date(2020, 0, 1), new Date(2020, 0, 1));
    await writeFile(
      join(data, "web", "datasets.json"),
      JSON.stringify({ version: 2, checkedAt: "2026-10-17T10:00:00Z", datasets: [
        { id: "nor", name: "Norway", fetchedAt: "t", ops: 1, status: "stale" },
        { id: "bel", name: "Belgium", ops: 0, status: "failed", error: "timeout" },
        { id: "fra", name: "France", ops: 0, status: "pending" },
        { id: "old", name: "Old", fetchedAt: "t", ops: 1, status: "removed" },
      ] }),
    );
    const server = await startServer(dist, 0, "127.0.0.1", { dataDir: data, config: { basemaps: [], overlays: [] } });
    servers.push(server);
    const get = (p: string, headers: Record<string, string> = {}) => fetch(`${base(server)}${p}`, { headers, redirect: "manual" });

    // node's fetch decompresses: check the headers and the bytes it got
    const br = await get("/nor/ops.json", { "Accept-Encoding": "br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(await br.text()).toBe(ops);
    const gz = await get("/nor/ops.json", { "Accept-Encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(Number(gz.headers.get("content-length"))).toBe(gzipSync(ops).length);
    expect(await gz.text()).toBe(ops);
    const plain = await get("/nor/ops.json", { "Accept-Encoding": "identity" });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(await plain.text()).toBe(ops);
    const stale = await get("/nor/lines.json", { "Accept-Encoding": "br, gzip" });
    expect(stale.headers.get("content-encoding")).toBe("gzip"); // on the fly, not the stale .br
    expect(await stale.text()).toBe("[1,2,3]");

    const etag = plain.headers.get("etag")!;
    expect(etag).toMatch(/^W\/"/);
    const cached = await get("/nor/ops.json", { "If-None-Match": etag });
    expect(cached.status).toBe(304);
    expect((await get("/nor/ops.json", { "If-None-Match": 'W/"nope"' })).status).toBe(200);

    expect(await (await get("/healthz")).json()).toEqual({ ok: true, checkedAt: "2026-10-17T10:00:00Z", datasets: 4, loaded: 1, failed: 1, stale: 1, pending: 1, removed: 1 });
    expect(health([join(data, "web")], { state: () => ({ enabled: true, running: true }) }).sync).toEqual({ enabled: true, running: true });
  });

  it("runs the sync only when asked and says when the CLI is missing", () => {
    expect(startSync({ minutes: 0 }).state()).toEqual({ enabled: false });
    const messages: string[] = [];
    expect(startSync({ minutes: 60, cli: "/nowhere/index.js", log: (m: string) => messages.push(m) }).state()).toMatchObject({ enabled: true, running: false });
    expect(messages[0]).toContain("/nowhere/index.js");
  });
});

describe("static build", () => {
  it("writes config.json without proxied layers, privacy.html and datasets.json", async () => {
    const repo = await mkdtemp(join(tmpdir(), "rbstatic-"));
    await writeFile(join(repo, "privacy.html"), "<h1>Privacy statement</h1><p>Published and hosted by Example.</p>");
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
    expect(page).toContain("hosted by Example");
    expect(JSON.parse(await readFile(join(dist, "datasets.json"), "utf8"))).toEqual({ version: 2, datasets: [{ id: "bel", name: "Belgium", ops: 7, status: "loaded", counts: { ops: 7 } }] });
  });

  it("ships the configuration of the public instance with the Matdata privacy statement", () => {
    const cfg = loadConfig({ cwd: join(__dirname, "..", ".."), log: quiet, env: { ROUTEBOOK_CONFIG_FILE: "deploy/matdata/config.json", ESRI_API_KEY: "k" } });
    expect(cfg.privacy.html).toMatch(/Matdata/);
    expect(cfg.privacy.html).toMatch(/routebook\.matdata\.eu/);
    // the street map opens first; the aerial view is one click away in Map layers
    expect(cfg.defaultBasemap).toBeUndefined();
    expect(cfg.basemaps.map((b: { id: string }) => b.id)).toEqual(["aerial"]);
    expect((cfg as { disclaimer?: unknown }).disclaimer).toEqual({ publisher: "Matdata" });
  });
});
