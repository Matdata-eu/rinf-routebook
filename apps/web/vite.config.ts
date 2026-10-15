import { defineConfig, type Plugin } from "vite";
import type { IncomingMessage, ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";

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

// Web bundles written by `routebook fetch` (data/web/<country>/*.json) are served
// from /<country>/ and copied into the build, so the built app works offline.
export default defineConfig({
  base: "./",
  plugins: [routebookServer()],
  publicDir: fileURLToPath(new URL("../../data/web", import.meta.url)),
  resolve: {
    alias: [
      { find: "@routebook/rinf-client/compact", replacement: src("rinf-client", "compact.ts") },
      { find: /^@routebook\/(routing|routebook|schematic)$/, replacement: fileURLToPath(new URL("../../packages/$1/src/index.ts", import.meta.url)) },
    ],
  },
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
  // es2022: main.ts awaits the runtime config at the top level
  build: { chunkSizeWarningLimit: 1500, target: "es2022" },
  // the HiGHS worker (schematic solver) is an ES module: highs.mjs loads its WebAssembly with import.meta.url
  worker: { format: "es" },
});
