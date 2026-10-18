import { describe, expect, it } from "vitest";
import { brandParts } from "../src/brand.js";
import { MAP_COLORS, themedRasterPaint } from "../src/theme.js";

describe("brand", () => {
  it("splits a camel-case name for the wordmark", () => {
    expect(brandParts("RouteBook")).toEqual(["Route", "Book"]);
    expect(brandParts("MatData")).toEqual(["Mat", "Data"]);
  });

  it("keeps any other title as it is", () => {
    expect(brandParts("Routebook")).toBeUndefined();
    expect(brandParts("RINF Routebook by Matdata")).toBeUndefined();
    expect(brandParts("Internal test")).toBeUndefined();
  });
});

describe("theme", () => {
  it("keeps the configured raster paint in the light theme", () => {
    const paint = themedRasterPaint({ "raster-saturation": -0.85, "raster-opacity": 0.75 }, false, "light");
    expect(paint).toMatchObject({ "raster-saturation": -0.85, "raster-opacity": 0.75, "raster-brightness-min": 0, "raster-brightness-max": 1 });
  });

  it("dims a street map as RINF Atlas does, and only dims imagery", () => {
    const streets = themedRasterPaint({ "raster-saturation": -0.35 }, false, "dark");
    expect(streets).toMatchObject({ "raster-brightness-max": 0.72, "raster-saturation": -0.5, "raster-contrast": 0.1 });
    const aerial = themedRasterPaint({ "raster-brightness-max": 0.85 }, true, "dark");
    expect(aerial).toMatchObject({ "raster-brightness-min": 0, "raster-contrast": 0 });
    expect(aerial["raster-brightness-max"]).toBeLessThan(0.85);
  });

  it("has the same map colour roles in both themes", () => {
    expect(Object.keys(MAP_COLORS.dark).sort()).toEqual(Object.keys(MAP_COLORS.light).sort());
  });
});
