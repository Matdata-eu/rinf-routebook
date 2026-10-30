import { describe, expect, it } from "vitest";
import type { Snapshot } from "@routebook/rinf-client";
import type { Routebook } from "@routebook/routebook";
import { PluginRegistry, extendRoutebook, overlayLayers, pluginsOf, type RoutebookPlugin } from "@routebook/core-extensions";

const routebook = {
  from: { id: "a", uopid: "A", name: "A", points: [], areas: [] },
  to: { id: "b", uopid: "B", name: "B", points: [], areas: [] },
  endpointModes: { from: "area", to: "area" },
  route: { steps: [], length: 1000, cost: 1000, costModel: "length" },
  length: 1000,
  items: [
    { kind: "origin", distance: 0, quality: "rinf" },
    { kind: "destination", distance: 1000, quality: "rinf" },
  ],
  gaps: [{ field: "speedProfile", reason: "x" }, { field: "derailers", reason: "y" }],
} as Routebook;

const speedBoards: RoutebookPlugin = {
  id: "acme",
  name: "ACME speed boards",
  version: "1.0.0",
  license: "LicenseRef-Proprietary",
  itemProviders: [
    {
      id: "speed-boards",
      fillsGaps: ["speedProfile"],
      provideItems: () => [{ kind: "acme:speedBoard", distance: 400, quality: "rinf", label: "70" }],
    },
  ],
};

describe("core-extensions", () => {
  it("merges plugin items in route order and removes filled gaps", async () => {
    const reg = new PluginRegistry().register(speedBoards);
    const out = await extendRoutebook(reg, {} as Snapshot, routebook);
    expect(out.items.map((i) => i.kind)).toEqual(["origin", "acme:speedBoard", "destination"]);
    expect(out.gaps.map((g) => g.field)).toEqual(["derailers"]);
    expect(routebook.items).toHaveLength(2); // input not mutated
  });

  it("rejects item kinds outside the plugin namespace", async () => {
    const bad: RoutebookPlugin = {
      ...speedBoards,
      id: "bad",
      itemProviders: [{ id: "x", provideItems: () => [{ kind: "signal", distance: 1, quality: "rinf" }] }],
    };
    await expect(extendRoutebook(new PluginRegistry().register(bad), {} as Snapshot, routebook)).rejects.toThrow(/bad:<kind>/);
  });

  it("rejects duplicate plugin ids", () => {
    expect(() => new PluginRegistry().register(speedBoards).register(speedBoards)).toThrow(/already registered/);
  });

  it("reads plugins from a module: a default export, a list or a factory", async () => {
    expect((await pluginsOf({ default: speedBoards })).map((p) => p.id)).toEqual(["acme"]);
    expect((await pluginsOf({ plugins: [speedBoards, { ...speedBoards, id: "two" }] })).map((p) => p.id)).toEqual(["acme", "two"]);
    expect((await pluginsOf({ default: async () => speedBoards })).map((p) => p.id)).toEqual(["acme"]);
    await expect(pluginsOf({ default: 42 }, "x.js")).rejects.toThrow(/x\.js exports no RoutebookPlugin/);
  });

  it("passes the datasets of the route to providers and collects overlays, skipping broken ones", async () => {
    let seen: string[] | undefined;
    const reg = new PluginRegistry().register({
      id: "geo",
      name: "Geo",
      version: "1",
      itemProviders: [{ id: "p", provideItems: (ctx) => ((seen = ctx.datasets), []) }],
      overlays: [
        { id: "ok", getLayers: () => [{ id: "pts", title: "Points", geojson: { type: "FeatureCollection", features: [] } }] },
        { id: "broken", getLayers: () => { throw new Error("no"); } },
      ],
    });
    await extendRoutebook(reg, {} as Snapshot, routebook, { datasets: ["nor", "swe"] });
    expect(seen).toEqual(["nor", "swe"]);
    const errors: string[] = [];
    const layers = await overlayLayers(reg, { snapshot: {} as Snapshot }, (id) => errors.push(id));
    expect(layers.map((l) => l.id)).toEqual(["pts"]);
    expect(errors).toEqual(["broken"]);
  });
});
