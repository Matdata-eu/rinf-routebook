import { describe, expect, it } from "vitest";
import { basemaps, pickBasemap } from "../src/basemaps.js";

describe("basemaps", () => {
  it("offers the key-free map and Sentinel-2 by default", () => {
    const list = basemaps({});
    expect(list.map((b) => b.id)).toEqual(["map", "satellite"]);
    // only the CC BY 2016 mosaic may be used commercially; the yearly layers are non-commercial
    expect(list[1]!.source.tiles![0]).toContain("/s2cloudless_3857/");
    expect(list[1]!.source.attribution).toContain("EOX");
  });

  it("adds Esri World Imagery when an API key is set", () => {
    const list = basemaps({ VITE_ESRI_API_KEY: " k&y " });
    expect(list.map((b) => b.id)).toEqual(["map", "satellite", "aerial"]);
    expect(list[2]!.source.tiles![0]).toMatch(/World_Imagery\/MapServer\/tile\/\{z\}\/\{y\}\/\{x\}\?token=k%26y$/);
    expect(list[2]!.source.attribution).toContain("Esri");
  });

  it("prefers a custom tile template over Esri", () => {
    const list = basemaps({ VITE_ESRI_API_KEY: "k", VITE_AERIAL_TILES: "https://x.test/{z}/{x}/{y}.jpg", VITE_AERIAL_LABEL: "Norge i bilder", VITE_AERIAL_MAXZOOM: "20", VITE_AERIAL_ATTRIBUTION: "© Geovekst" });
    const aerial = list[2]!;
    expect(aerial.label).toBe("Norge i bilder");
    expect(aerial.source.tiles).toEqual(["https://x.test/{z}/{x}/{y}.jpg"]);
    expect(aerial.source.maxzoom).toBe(20);
    expect(aerial.source.attribution).toMatch(/^© Geovekst · RINF/);
  });

  it("picks by id and falls back sensibly", () => {
    const plain = basemaps({});
    expect(pickBasemap(plain, null).id).toBe("map");
    expect(pickBasemap(plain, "nonsense").id).toBe("map");
    expect(pickBasemap(plain, "aerial").id).toBe("satellite");
    expect(pickBasemap(basemaps({ VITE_ESRI_API_KEY: "k" }), "aerial").id).toBe("aerial");
  });
});
