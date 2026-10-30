/**
 * Plugins in the browser: the modules named in config.json (`plugins`) are imported at start-up
 * and registered in one PluginRegistry. Their item providers extend every routebook, their
 * overlays are drawn on the map and their cost models can be picked with `costModel`.
 *
 * Plugin modules are plain ES modules served by the deployment itself (the server's `plugins/`
 * folder, see docs/plugins.md): the Content-Security-Policy only allows scripts from the app's
 * own origin. A module that fails to load is reported and skipped; the core app keeps working.
 */
import type { GeoJSONSource, LayerSpecification, Map as MapLibreMap } from "maplibre-gl";
import { PluginRegistry, pluginsOf, type OverlayLayer } from "@routebook/core-extensions";

export interface LoadedPlugins {
  registry: PluginRegistry;
  /** One line per module that failed to load or register. */
  errors: string[];
}

/** Import and register the plugin modules (URLs relative to the app). */
export async function loadPlugins(urls: readonly string[] | undefined, base: string, importer: (url: string) => Promise<unknown> = (u) => import(/* @vite-ignore */ u)): Promise<LoadedPlugins> {
  const registry = new PluginRegistry();
  const errors: string[] = [];
  const list = Array.isArray(urls) ? urls.filter((u): u is string => typeof u === "string" && u.length > 0) : [];
  const mods = await Promise.all(list.map((u) => importer(new URL(u, base).href).then((m) => ({ u, m }), (e: unknown) => ({ u, e }))));
  for (const r of mods) {
    try {
      if ("e" in r) throw r.e;
      for (const p of await pluginsOf(r.m, r.u)) registry.register(p);
    } catch (e) {
      errors.push(`${r.u}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { registry, errors };
}

/** The MapLibre layer for an overlay: its `style` (a layer spec fragment) or a default by geometry. */
function layerFor(o: OverlayLayer, color: string): LayerSpecification {
  const id = `plugin-${o.id}`;
  const style = (o.style ?? {}) as Partial<LayerSpecification>;
  if (style.type) return { ...style, id, source: id } as LayerSpecification;
  const point = o.geojson.features.some((f) => (f.geometry as { type?: string } | null)?.type?.endsWith("Point"));
  return point
    ? { id, type: "circle", source: id, paint: { "circle-radius": 5, "circle-color": color, "circle-stroke-color": "#fff", "circle-stroke-width": 1.5 } }
    : { id, type: "line", source: id, paint: { "line-color": color, "line-width": 3 } };
}

/**
 * Show the overlays on the map: new ones get a GeoJSON source and a layer under `before`, known
 * ones get their data replaced, and those no longer provided are emptied.
 */
export function showOverlays(map: MapLibreMap, layers: OverlayLayer[], shown: Set<string>, opts: { before?: string; color: string }): void {
  const ids = new Set(layers.map((o) => `plugin-${o.id}`));
  for (const o of layers) {
    const id = `plugin-${o.id}`;
    const source = map.getSource(id) as GeoJSONSource | undefined;
    if (source) source.setData(o.geojson as never);
    else {
      map.addSource(id, { type: "geojson", data: o.geojson as never });
      map.addLayer(layerFor(o, opts.color), opts.before && map.getLayer(opts.before) ? opts.before : undefined);
    }
  }
  for (const id of shown) if (!ids.has(id)) (map.getSource(id) as GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
  for (const id of ids) shown.add(id);
}
