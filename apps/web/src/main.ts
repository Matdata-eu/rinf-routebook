import maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import type { OperationalPoint, SectionOfLine } from "@routebook/rinf-client";

// Skeleton only: shows the OPs and SoLs of a snapshot. The routebook UI is step 3.
const COUNTRY = new URLSearchParams(location.search).get("country")?.toLowerCase() ?? "nor";
const status = document.getElementById("status")!;

const map = new maplibregl.Map({
  container: "map",
  center: [10.75, 59.91],
  zoom: 6,
  style: {
    version: 8,
    sources: {
      osm: {
        type: "raster",
        tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
        tileSize: 256,
        attribution: "© OpenStreetMap contributors · RINF data © ERA",
      },
    },
    layers: [{ id: "osm", type: "raster", source: "osm", paint: { "raster-saturation": -0.8 } }],
  },
});

function solFeatures(sols: SectionOfLine[]) {
  const features = [];
  for (const s of sols) {
    const m = s.wkt?.match(/LINESTRING\s*\(([^)]*)\)/i);
    if (!m) continue;
    const coordinates = m[1]!.split(",").map((p) => p.trim().split(/\s+/).map(Number));
    features.push({ type: "Feature" as const, geometry: { type: "LineString" as const, coordinates }, properties: { label: s.label ?? "" } });
  }
  return { type: "FeatureCollection" as const, features };
}

async function load() {
  const [ops, sols] = await Promise.all([
    fetch(`/snapshots/${COUNTRY}/ops.json`).then((r) => {
      if (!r.ok) throw new Error(`No snapshot for "${COUNTRY}" (run pnpm fetch:nor)`);
      return r.json() as Promise<OperationalPoint[]>;
    }),
    fetch(`/snapshots/${COUNTRY}/sols.json`).then((r) => (r.ok ? (r.json() as Promise<SectionOfLine[]>) : [])),
  ]);
  const opGeojson = {
    type: "FeatureCollection" as const,
    features: ops
      .filter((o) => o.lon !== undefined && o.lat !== undefined)
      .map((o) => ({
        type: "Feature" as const,
        geometry: { type: "Point" as const, coordinates: [o.lon!, o.lat!] },
        properties: { name: o.name, uopid: o.uopid, type: o.type?.split("/").pop() ?? "" },
      })),
  };
  map.addSource("sols", { type: "geojson", data: solFeatures(sols) });
  map.addLayer({ id: "sols", type: "line", source: "sols", paint: { "line-color": "#1f4e79", "line-width": 2 } });
  map.addSource("ops", { type: "geojson", data: opGeojson });
  map.addLayer({
    id: "ops",
    type: "circle",
    source: "ops",
    paint: {
      "circle-radius": ["case", ["==", ["get", "type"], "10"], 5, 3],
      "circle-color": "#c0392b",
      "circle-stroke-color": "#fff",
      "circle-stroke-width": 1,
    },
  });
  map.on("click", "ops", (e) => {
    const f = e.features?.[0];
    if (!f) return;
    new maplibregl.Popup()
      .setLngLat(e.lngLat)
      .setText(`${String(f.properties.name)} (${String(f.properties.uopid)})`)
      .addTo(map);
  });
  status.textContent = `${opGeojson.features.length} operational points, ${sols.length} sections of line (${COUNTRY.toUpperCase()})`;
}

if (import.meta.env.DEV) Object.assign(window, { routebookMap: map });

// "style.load" rather than "load": the data layers should not wait for base-map tiles
map.once("style.load", () => {
  load().catch((e: unknown) => (status.textContent = String(e)));
});
