import { describe, expect, it } from "vitest";
import type { Snapshot } from "@routebook/rinf-client";
import type { Routebook } from "@routebook/routebook";
import { PluginRegistry, extendRoutebook, type RoutebookPlugin } from "@routebook/core-extensions";

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
});
