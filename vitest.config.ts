import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const pkg = (name: string) => fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      "@routebook/rinf-client": pkg("rinf-client"),
      "@routebook/routing": pkg("routing"),
      "@routebook/routebook": pkg("routebook"),
      "@routebook/core-extensions": pkg("core-extensions"),
    },
  },
  test: { include: ["packages/*/test/**/*.test.ts"] },
});
