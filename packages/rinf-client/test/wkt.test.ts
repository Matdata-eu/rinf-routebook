import { describe, expect, it } from "vitest";
import { assembleSnapshot, parseWktLineString, parseWktPoint, wktPosition, FETCH_VERSION, type RawResults } from "@routebook/rinf-client";

describe("WKT as RINF publishes it", () => {
  it("reads lon/lat points, with or without a CRS, signs, exponents and a Z value", () => {
    expect(parseWktPoint("POINT(4.33 50.83)")).toEqual({ lon: 4.33, lat: 50.83 });
    expect(parseWktPoint("POINT Z (10.75 59.91 12)")).toEqual({ lon: 10.75, lat: 59.91 });
    expect(parseWktPoint("POINT (+23.135931 54.710154)")).toEqual({ lon: 23.135931, lat: 54.710154 });
    expect(parseWktPoint("POINT (2.3135931E+1 5.4710154E+1)")).toEqual({ lon: 23.135931, lat: 54.710154 });
    expect(parseWktPoint("<http://www.opengis.net/def/crs/OGC/1.3/CRS84> POINT(16.37 48.2)")).toEqual({ lon: 16.37, lat: 48.2 });
    expect(parseWktPoint("LINESTRING (1 2, 3 4)")).toBeUndefined();
    expect(parseWktPoint(undefined)).toBeUndefined();
  });

  it("swaps lat/lon written the other way round, as EPSG:4326 says or by mistake", () => {
    expect(parseWktPoint("<http://www.opengis.net/def/crs/EPSG/0/4326> POINT(50.83 4.33)")).toEqual({ lon: 4.33, lat: 50.83 });
    expect(parseWktPoint("POINT(50.83 4.33)")).toEqual({ lon: 4.33, lat: 50.83 });
    expect(parseWktLineString("LINESTRING (50.1 4.1, 50.2 4.2)")).toEqual([[4.1, 50.1], [4.2, 50.2]]);
    // northern Norway: longitude 30, latitude 70 stays as it is
    expect(parseWktPoint("POINT(30.04 69.72)")).toEqual({ lon: 30.04, lat: 69.72 });
  });

  it("places an OP published with a line or area geometry at its middle", () => {
    expect(wktPosition("LINESTRING (4 50, 6 52)")).toEqual({ lon: 5, lat: 51 });
    expect(wktPosition("POLYGON ((4 50, 6 50, 6 52, 4 52, 4 50))")?.lon).toBeCloseTo(4.8);
    expect(wktPosition("POINT EMPTY")).toBeUndefined();
  });
});

describe("snapshot geometry", () => {
  const empty = (): RawResults => ({ ops: [], opAreas: [], opPoints: [], lines: [], sols: [], netelements: [], netrelations: [], tracks: [], trackElements: [], trackParents: [], features: [], tunnels: [], tunnelAreas: [], geometry: [] });
  const meta = { endpoint: "e", graph: "g", country: "BEL" };

  it("takes an OP's position from the first row that has one (OP or net reference)", () => {
    const r = empty();
    r.ops = [
      { op: "op1", uopid: "BE1", name: "A", wkt: "LINESTRING EMPTY" },
      { op: "op1", uopid: "BE1", name: "A", wkt: "POINT (4.35 50.85)" },
      { op: "op2", uopid: "BE2", name: "B" },
    ];
    r.sols = [
      { sol: "s1", opStart: "op1", opEnd: "op2" },
      { sol: "s1", opStart: "op1", opEnd: "op2", wkt: "LINESTRING (4.35 50.85, 4.4 50.9)" },
    ];
    const s = assembleSnapshot(r, meta);
    expect(s.ops.map((o) => [o.uopid, o.lon, o.lat])).toEqual([["BE1", 4.35, 50.85], ["BE2", undefined, undefined]]);
    expect(s.sols[0]?.wkt).toBe("LINESTRING (4.35 50.85, 4.4 50.9)");
    expect(s.meta.fetchVersion).toBe(FETCH_VERSION);
    expect(s.meta.counts).toMatchObject({ ops: 2, routableOps: 0, signals: 0, trackKm: 0 });
  });
});
