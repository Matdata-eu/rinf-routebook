/**
 * Extension points of the routebook core.
 *
 * The core (everything in this repository) is MIT licensed and only uses
 * public RINF data. Additional data sources, e.g. an IM's detailed speed
 * profile or commercial modules, live in separate packages that implement
 * `RoutebookPlugin` and are registered at runtime. They never need to fork or
 * patch the core.
 *
 * Rules for plugins:
 * - Item kinds a plugin adds must be namespaced: `<pluginId>:<kind>`.
 * - A plugin that fills a gap listed in `RINF_GAPS` declares it in `fillsGaps`;
 *   the gap is then removed from the routebook's `gaps` list.
 * - Plugins must not mutate the snapshot, the route or items from other providers.
 */
import type { Snapshot } from "@routebook/rinf-client";
import type { CostModel, Route } from "@routebook/routing";
import { sortItems, type Routebook, type RoutebookItem } from "@routebook/routebook";

/**
 * What a provider gets to look at.
 *
 * In the web app `snapshot` is the expanded web bundle: the same shape as a fetched snapshot, with
 * element geometry simplified to about 1 m. On a route across infrastructure managers it is the
 * bundles of every dataset the route runs through, joined by their border links: `meta.country`
 * is then e.g. "nor+swe" and `datasets` lists them in travel order.
 */
export interface RouteContext {
  snapshot: Snapshot;
  route: Route;
  routebook: Readonly<Routebook>;
  /** Dataset ids the route runs through, in travel order (the web app sets it). */
  datasets?: string[];
}

/** Adds items to a routebook (e.g. speed boards, no-stop zones from another source). */
export interface RoutebookItemProvider {
  id: string;
  /** Gap fields (see RINF_GAPS) this provider supplies. */
  fillsGaps?: string[];
  provideItems(ctx: RouteContext): RoutebookItem[] | Promise<RoutebookItem[]>;
}

/** A map layer, kept independent of the map library: GeoJSON plus a style hint. */
export interface OverlayLayer {
  id: string;
  title: string;
  geojson: GeoJSONFeatureCollection;
  /** Library-specific paint/layout properties, e.g. a MapLibre layer spec fragment. */
  style?: Record<string, unknown>;
}

export interface GeoJSONFeatureCollection {
  type: "FeatureCollection";
  features: Array<{ type: "Feature"; geometry: unknown; properties: Record<string, unknown> | null }>;
}

export interface MapOverlayProvider {
  id: string;
  getLayers(ctx: { snapshot: Snapshot; route?: Route }): OverlayLayer[] | Promise<OverlayLayer[]>;
}

/** Supplies an alternative routing cost model (e.g. timetable-aware). */
export interface CostModelProvider {
  id: string;
  create(snapshot: Snapshot): CostModel;
}

export interface RoutebookPlugin {
  /** Unique, used as item-kind namespace. */
  id: string;
  name: string;
  version: string;
  /** SPDX id; informative only. */
  license?: string;
  itemProviders?: RoutebookItemProvider[];
  overlays?: MapOverlayProvider[];
  costModels?: CostModelProvider[];
}

/**
 * What a plugin module exports (default export, or `plugin` / `plugins`): one plugin, a list of
 * them, or a function that returns either (it may be async).
 */
export type PluginModuleExport = RoutebookPlugin | RoutebookPlugin[] | (() => RoutebookPlugin | RoutebookPlugin[] | Promise<RoutebookPlugin | RoutebookPlugin[]>);

/** The plugins an imported module provides (see PluginModuleExport); throws when it provides none. */
export async function pluginsOf(mod: unknown, name = "plugin module"): Promise<RoutebookPlugin[]> {
  const m = (mod ?? {}) as Record<string, unknown>;
  let value: unknown = m.default ?? m.plugins ?? m.plugin ?? mod;
  if (typeof value === "function") value = await (value as () => unknown)();
  const list = (Array.isArray(value) ? value : [value]).filter(
    (p): p is RoutebookPlugin => !!p && typeof p === "object" && typeof (p as RoutebookPlugin).id === "string" && typeof (p as RoutebookPlugin).name === "string",
  );
  if (!list.length) throw new Error(`${name} exports no RoutebookPlugin (an object with id, name and version)`);
  return list;
}

export class PluginRegistry {
  private readonly plugins = new Map<string, RoutebookPlugin>();

  register(plugin: RoutebookPlugin): this {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(plugin.id)) throw new Error(`Invalid plugin id "${plugin.id}"`);
    if (this.plugins.has(plugin.id)) throw new Error(`Plugin "${plugin.id}" is already registered`);
    this.plugins.set(plugin.id, plugin);
    return this;
  }

  list(): RoutebookPlugin[] {
    return [...this.plugins.values()];
  }

  itemProviders(): Array<{ plugin: RoutebookPlugin; provider: RoutebookItemProvider }> {
    return this.list().flatMap((plugin) => (plugin.itemProviders ?? []).map((provider) => ({ plugin, provider })));
  }

  overlays(): MapOverlayProvider[] {
    return this.list().flatMap((p) => p.overlays ?? []);
  }

  costModel(id: string, snapshot: Snapshot): CostModel | undefined {
    for (const p of this.list()) {
      const c = p.costModels?.find((m) => m.id === id);
      if (c) return c.create(snapshot);
    }
    return undefined;
  }
}

/**
 * Run all registered item providers on a core routebook and return the
 * extended routebook (items merged and re-sorted, filled gaps removed).
 */
export async function extendRoutebook(registry: PluginRegistry, snapshot: Snapshot, routebook: Routebook, opts: { datasets?: string[] } = {}): Promise<Routebook> {
  const ctx: RouteContext = { snapshot, route: routebook.route, routebook, ...(opts.datasets ? { datasets: opts.datasets } : {}) };
  const extra: RoutebookItem[] = [];
  const filled = new Set<string>();
  for (const { plugin, provider } of registry.itemProviders()) {
    const items = await provider.provideItems(ctx);
    for (const item of items) {
      if (!item.kind.startsWith(`${plugin.id}:`)) {
        throw new Error(`Plugin "${plugin.id}" returned item kind "${item.kind}"; plugin kinds must be "${plugin.id}:<kind>"`);
      }
      extra.push(item);
    }
    for (const g of provider.fillsGaps ?? []) filled.add(g);
  }
  return {
    ...routebook,
    items: sortItems([...routebook.items, ...extra]),
    gaps: routebook.gaps.filter((g) => !filled.has(g.field)),
  };
}

/**
 * The map layers of every overlay provider for a snapshot (and the route shown, if any). A provider
 * that throws is skipped and reported through `onError`, so one broken plugin never hides the others.
 */
export async function overlayLayers(
  registry: PluginRegistry,
  ctx: { snapshot: Snapshot; route?: Route },
  onError: (provider: string, error: unknown) => void = () => undefined,
): Promise<OverlayLayer[]> {
  const out: OverlayLayer[] = [];
  for (const p of registry.overlays()) {
    try {
      out.push(...(await p.getLayers(ctx)));
    } catch (e) {
      onError(p.id, e);
    }
  }
  return out;
}
