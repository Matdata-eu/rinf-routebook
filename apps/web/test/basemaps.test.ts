import { describe, expect, it } from "vitest";
import { absoluteTemplate, basemaps, headerTransform, loadRuntimeConfig, overlays, pickBasemap } from "../src/basemaps.js";

const BASE = "https://rail.example/routebook/?dataset=nor";

describe("basemaps", () => {
  it("offers the key-free map and Sentinel-2 by default", () => {
    const list = basemaps({});
    expect(list.map((b) => b.id)).toEqual(["map", "satellite"]);
    // only the CC BY 2016 mosaic may be used commercially; the yearly layers are non-commercial
    expect(list[1]!.source.tiles![0]).toContain("/s2cloudless_3857/");
    expect(list[1]!.source.attribution).toContain("EOX");
  });

  it("adds configured layers after the built-ins, and can hide the built-ins", () => {
    const ortho = { id: "ortho", label: "Orthophoto", tiles: ["https://x.test/{z}/{x}/{y}.jpg"], maxzoom: 21, attribution: "© Ortho" };
    const list = basemaps({ basemaps: [ortho] }, BASE);
    expect(list.map((b) => b.id)).toEqual(["map", "satellite", "ortho"]);
    expect(list[2]).toMatchObject({ label: "Orthophoto", aerial: true, source: { tiles: ["https://x.test/{z}/{x}/{y}.jpg"], maxzoom: 21, attribution: "© Ortho" } });
    expect(basemaps({ basemaps: [ortho], builtinBasemaps: false }).map((b) => b.id)).toEqual(["ortho"]);
    expect(basemaps({ basemaps: [ortho], builtinBasemaps: ["map"] }).map((b) => b.id)).toEqual(["map", "ortho"]);
    // a configured id replaces the built-in one
    expect(basemaps({ basemaps: [{ ...ortho, id: "map" }] }).map((b) => b.label)).toEqual(["Satellite", "Orthophoto"]);
    // never an empty switch
    expect(basemaps({ builtinBasemaps: false }).map((b) => b.id)).toEqual(["map"]);
  });

  it("skips layers without tiles and resolves relative (proxied) templates", () => {
    const list = basemaps({ basemaps: [{ id: "bad", tiles: [] }, { id: "aerial", tiles: ["tiles/aerial/{z}/{x}/{y}"], tileSize: 512, scheme: "tms" }] }, BASE);
    expect(list.map((b) => b.id)).toEqual(["map", "satellite", "aerial"]);
    expect(list[2]!.source).toMatchObject({ tiles: ["https://rail.example/routebook/tiles/aerial/{z}/{x}/{y}"], tileSize: 512, scheme: "tms" });
    expect(absoluteTemplate("/t/{z}/{x}/{y}", BASE)).toBe("https://rail.example/t/{z}/{x}/{y}");
    expect(absoluteTemplate("//cdn.test/{z}", BASE)).toBe("https://cdn.test/{z}");
  });

  it("builds overlays, hidden unless marked visible", () => {
    const list = overlays({ overlays: [{ id: "lines", tiles: ["https://x.test/wms?bbox={bbox-epsg-3857}"], opacity: 0.6, visible: true }, { id: "parcels", tiles: ["https://y.test/{z}/{x}/{y}.png"] }] });
    expect(list.map((o) => [o.id, o.visible, o.aerial])).toEqual([["lines", true, false], ["parcels", false, false]]);
    expect(list[0]!.paint).toEqual({ "raster-opacity": 0.6 });
  });

  it("picks by id, then the configured default, and falls back sensibly", () => {
    const plain = basemaps({});
    expect(pickBasemap(plain, null).id).toBe("map");
    expect(pickBasemap(plain, "nonsense").id).toBe("map");
    expect(pickBasemap(plain, null, "satellite").id).toBe("satellite");
    expect(pickBasemap(plain, "aerial").id).toBe("satellite");
    const withOrtho = basemaps({ basemaps: [{ id: "ortho", tiles: ["https://x.test/{z}/{x}/{y}"] }] });
    expect(pickBasemap(withOrtho, "aerial").id).toBe("ortho");
  });

  it("adds configured headers to the matching tile requests only", () => {
    const t = headerTransform([{ id: "a", tiles: ["https://x.test/tiles/{z}/{x}/{y}"], headers: { Authorization: "Bearer k" } }, { id: "b", tiles: ["https://y.test/{z}"] }])!;
    expect(t("https://x.test/tiles/3/4/5")).toEqual({ url: "https://x.test/tiles/3/4/5", headers: { Authorization: "Bearer k" } });
    expect(t("https://y.test/3")).toBeUndefined();
    expect(headerTransform([{ id: "b", tiles: ["https://y.test/{z}"] }])).toBeUndefined();
  });

  it("loads config.json, with defaults when it is missing or broken", async () => {
    const ok = (body: unknown) => (async () => new Response(JSON.stringify(body))) as unknown as typeof fetch;
    expect(await loadRuntimeConfig("config.json", ok({ title: "X" }))).toEqual({ title: "X" });
    expect(await loadRuntimeConfig("config.json", ok([1]))).toEqual({});
    expect(await loadRuntimeConfig("config.json", (async () => new Response("", { status: 404 })) as unknown as typeof fetch)).toEqual({});
    expect(await loadRuntimeConfig("config.json", (async () => new Response("{oops")) as unknown as typeof fetch)).toEqual({});
  });
});
