import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

// Snapshots fetched with `pnpm fetch:nor` are served from /snapshots/<country>/*.json.
// They are copied into the build too; a real deployment would host them separately.
export default defineConfig({
  publicDir: fileURLToPath(new URL("../../data", import.meta.url)),
  server: { port: 5173 },
});
