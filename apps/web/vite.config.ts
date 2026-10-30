import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const src = (pkg: string, file = "index.ts") => fileURLToPath(new URL(`../../packages/${pkg}/src/${file}`, import.meta.url));

type Handler = (req: IncomingMessage, res: ServerResponse, next?: () => void) => void;

/**
 * Dev server: the same config.json, datasets.json and tile proxy as the production
 * server (scripts/serve.mjs), with the configuration from config.json at the repo root.
 */
function routebookServer(): Plugin {
  return {
    name: "routebook-server",
    async configureServer(server) {
      // import() needs a file:// URL, not a path: on Windows "C:\\..." reads as a URL scheme
      const repo = fileURLToPath(new URL("../../", import.meta.url));
      const { createHandler } = (await import(new URL("../../scripts/serve.mjs", import.meta.url).href)) as { createHandler: (dir: string, opts?: { dataDir?: string }) => Handler };
      const { loadConfig } = (await import(new URL("../../scripts/runtime-config.mjs", import.meta.url).href)) as {
        loadConfig: (o: { cwd: string }) => object;
      };
      const handler = createHandler(`${repo}apps/web/dist`, { dataDir: process.env.ROUTEBOOK_DATA_DIR ?? `${repo}data`, config: loadConfig({ cwd: repo }) } as never);
      server.middlewares.use((req, res, next) => handler(req, res, next));
    },
  };
}

/**
 * The offline app: the web app manifest, its icons and the service worker (pwa/sw.js) with the
 * list of this build's files to cache when it installs. The RINF data is cached as it is used.
 */
function pwa(): Plugin {
  const dir = new URL("./pwa/", import.meta.url);
  return {
    name: "routebook-pwa",
    apply: "build",
    generateBundle(_options, bundle) {
      for (const name of ["icon-192.png", "icon-512.png", "icon.svg"]) this.emitFile({ type: "asset", fileName: `pwa/${name}`, source: readFileSync(new URL(name, dir)) });
      const manifest = {
        name: "RouteBook",
        short_name: "RouteBook",
        description: "Open-source railway routebook built on ERA RINF data",
        start_url: "./",
        scope: "./",
        display: "standalone",
        background_color: "#f5f7fa",
        theme_color: "#0563bb",
        icons: [
          { src: "pwa/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any maskable" },
          { src: "pwa/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any maskable" },
          { src: "pwa/icon.svg", sizes: "any", type: "image/svg+xml" },
        ],
      };
      this.emitFile({ type: "asset", fileName: "manifest.webmanifest", source: JSON.stringify(manifest, null, 2) });
      // .woff fonts are the fallback for browsers without woff2: fetched when needed, not cached up front
      // (the bundle already holds the files emitted above; Cache.addAll refuses duplicates)
      const files = [...new Set(["./", ...Object.keys(bundle).filter((f) => !f.endsWith(".map") && !f.endsWith(".woff")).sort(), "manifest.webmanifest", "pwa/icon-192.png"])];
      const version = createHash("sha256").update(files.join("\n")).digest("hex").slice(0, 12);
      const sw = readFileSync(new URL("sw.js", dir), "utf8").replace("__VERSION__", version).replace("__PRECACHE__", JSON.stringify(files));
      this.emitFile({ type: "asset", fileName: "sw.js", source: sw });
    },
  };
}

// Web bundles written by `routebook fetch` (data/web/<country>/*.json) are served
// from /<country>/ and copied into the build, so the built app works offline.
export default defineConfig({
  base: "./",
  plugins: [routebookServer(), pwa()],
  publicDir: fileURLToPath(new URL("../../data/web", import.meta.url)),
  resolve: {
    alias: [
      { find: "@routebook/rinf-client/compact", replacement: src("rinf-client", "compact.ts") },
      { find: "@routebook/rinf-client/network-index", replacement: src("rinf-client", "network-index.ts") },
      { find: /^@routebook\/(routing|routebook|schematic|core-extensions)$/, replacement: fileURLToPath(new URL("../../packages/$1/src/index.ts", import.meta.url)) },
    ],
  },
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
  // es2022: main.ts awaits the runtime config at the top level
  build: { chunkSizeWarningLimit: 1500, target: "es2022" },
  // the HiGHS worker (schematic solver) is an ES module: highs.mjs loads its WebAssembly with import.meta.url
  worker: { format: "es" },
});
