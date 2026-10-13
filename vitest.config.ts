import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@routebook/rinf-client/compact": fileURLToPath(new URL("./packages/rinf-client/src/compact.ts", import.meta.url)),
      "@routebook/rinf-client": pkg("rinf-client"),
      "@routebook/routing": pkg("routing"),
      "@routebook/routebook": pkg("routebook"),
      "@routebook/core-extensions": pkg("core-extensions"),
      "@routebook/schematic": pkg("schematic"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts", "apps/*/test/**/*.test.ts"] },
});
