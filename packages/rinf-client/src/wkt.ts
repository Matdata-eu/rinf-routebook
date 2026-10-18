/**
 * WKT as the infrastructure managers publish it in RINF, read as lon/lat. Browser-safe.
 *
 * GeoSPARQL says WKT without a CRS is CRS84 (lon/lat) and EPSG:4326 is lat/lon, but providers
 * mix the two up, write explicit plus signs ("POINT (+23.1 54.7)"), exponents ("5.47E+1") or a
 * Z value. Like RINF Atlas, the axis order is checked against Europe's extent: latitude is
 * larger than longitude almost everywhere RINF covers.
 */

const CRS = /^\s*<([^>]*)>\s*/;
const NUM = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][-+]?\\d+)?";
const PAIR = new RegExp(`(${NUM})\\s+(${NUM})(?:\\s+${NUM})*`, "g");

/** Does an x/y pair look like lat/lon in Europe (latitude first)? */
function looksLatLon(x: number, y: number): boolean {
  return x >= 34 && x <= 72 && y >= -25 && y <= 45 && x > y;
}

/** The coordinate pairs of a WKT body (the part inside the outer parentheses), as written. */
function pairs(body: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  for (const m of body.matchAll(PAIR)) out.push([Number(m[1]), Number(m[2])]);
  return out;
}

/** Split off the CRS prefix and say whether the coordinates must be swapped to lon/lat. */
function read(wkt: string, kind: "POINT" | "LINESTRING"): Array<[number, number]> | undefined {
  let text = wkt;
  let crs: string | undefined;
  const c = text.match(CRS);
  if (c) {
    crs = c[1];
    text = text.slice(c[0].length);
  }
  const m = text.match(new RegExp(`${kind}\\s*(?:Z|M|ZM)?\\s*\\(([^)]*)\\)`, "i"));
  if (!m) return undefined;
  const coords = pairs(m[1]!);
  if (!coords.length || coords.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return undefined;
  const [x, y] = coords[0]!;
  const latLonCrs = !!crs && crs.includes("4326") && !crs.includes("CRS84");
  const flip = latLonCrs ? looksLatLon(x, y) || !(y >= 34 && y <= 72) : looksLatLon(x, y);
  return flip ? coords.map(([a, b]) => [b, a]) : coords;
}

/** A WKT POINT (optionally with a CRS IRI) as lon/lat. */
export function parseWktPoint(wkt: string | undefined): { lon: number; lat: number } | undefined {
  const c = wkt ? read(wkt, "POINT") : undefined;
  return c?.[0] ? { lon: c[0][0], lat: c[0][1] } : undefined;
}

/** A WKT LINESTRING (optionally with a CRS IRI) as [lon, lat] pairs. */
export function parseWktLineString(wkt: string | undefined): Array<[number, number]> | undefined {
  return wkt ? read(wkt, "LINESTRING") : undefined;
}

/**
 * Where a geometry is, for an operational point: the POINT itself, else the middle of the
 * coordinates of whatever else was published (a LINESTRING or POLYGON on the net reference).
 */
export function wktPosition(wkt: string | undefined): { lon: number; lat: number } | undefined {
  if (!wkt) return undefined;
  const point = parseWktPoint(wkt);
  if (point) return point;
  const body = wkt.replace(CRS, "");
  const coords = pairs(body.slice(body.indexOf("(") + 1));
  if (!coords.length || coords.some(([x, y]) => !Number.isFinite(x) || !Number.isFinite(y))) return undefined;
  const flip = looksLatLon(coords[0]![0], coords[0]![1]);
  const n = coords.length;
  const lon = coords.reduce((s, c) => s + c[flip ? 1 : 0], 0) / n;
  const lat = coords.reduce((s, c) => s + c[flip ? 0 : 1], 0) / n;
  return { lon, lat };
}
