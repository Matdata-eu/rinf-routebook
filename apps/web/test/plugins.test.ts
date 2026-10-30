import { describe, expect, it } from "vitest";
import { loadPlugins } from "../src/plugins.js";
import plugin from "../../../examples/plugins/km-markers.js";
import { extendRoutebook } from "@routebook/core-extensions";
import type { Snapshot } from "@routebook/rinf-client";
import type { Routebook } from "@routebook/routebook";

describe("web plugins", () => {
  it("imports the modules relative to the app and skips the broken ones", async () => {
    const asked: string[] = [];
    const modules: Record<string, unknown> = {
      "https://rb.test/app/plugins/km.js": { default: plugin },
      "https://rb.test/app/plugins/empty.js": {},
    };
    const { registry, errors } = await loadPlugins(["plugins/km.js", "plugins/empty.js", "plugins/missing.js"], "https://rb.test/app/", async (url) => {
      asked.push(url);
      if (!(url in modules)) throw new Error("404");
      return modules[url];
    });
    expect(asked).toEqual(["https://rb.test/app/plugins/km.js", "https://rb.test/app/plugins/empty.js", "https://rb.test/app/plugins/missing.js"]);
    expect(registry.list().map((p) => p.id)).toEqual(["km-markers"]);
    expect(errors).toHaveLength(2);
    expect(errors[0]).toMatch(/empty\.js: .*exports no RoutebookPlugin/);
    expect(errors[1]).toBe("plugins/missing.js: 404");
    expect((await loadPlugins(undefined, "https://rb.test/")).registry.list()).toEqual([]);
  });

  it("the example plugin adds a marker every 10 km", async () => {
    const { registry } = await loadPlugins(["km.js"], "https://rb.test/", async () => ({ default: plugin }));
    const rb = { length: 25_000, items: [], gaps: [], route: { steps: [] } } as unknown as Routebook;
    const out = await extendRoutebook(registry, {} as Snapshot, rb);
    expect(out.items.map((i) => [i.kind, i.distance])).toEqual([["km-markers:marker", 10_000], ["km-markers:marker", 20_000]]);
  });
});
