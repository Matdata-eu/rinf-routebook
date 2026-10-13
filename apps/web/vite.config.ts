import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

const src = (pkg: string, file = "index.ts") => fileURLToPath(new URL(`../../packages/${pkg}/src/${file}`, import.meta.url));

// Web bundles written by `routebook fetch` (data/web/<country>/*.json) are served
// from /<country>/ and copied into the build, so the built app works offline.
export default defineConfig({
  base: "./",
  publicDir: fileURLToPath(new URL("../../data/web", import.meta.url)),
  resolve: {
    alias: [
      { find: "@routebook/rinf-client/compact", replacement: src("rinf-client", "compact.ts") },
      { find: /^@routebook\/(routing|routebook|schematic)$/, replacement: fileURLToPath(new URL("../../packages/$1/src/index.ts", import.meta.url)) },
    ],
  },
  server: { port: 5173, host: "127.0.0.1" },
  preview: { port: 4173, host: "127.0.0.1" },
  build: { chunkSizeWarningLimit: 1500 },
  // the HiGHS worker (schematic solver) is an ES module: highs.mjs loads its WebAssembly with import.meta.url
  worker: { format: "es" },
});
