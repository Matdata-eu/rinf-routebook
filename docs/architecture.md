# Architecture

## Overview

```
              ERA knowledge graph (SPARQL, public)
                          │
              packages/rinf-client  ── queries/*.rq ({{graph}} = country graph)
                          │  fetchSnapshot → data/snapshots/<country>/*.json
                          ▼
   ┌──────────── Snapshot (ops, lines, sols, topology, tracks, features, tunnels)
   │                      │
   │           packages/routing          RoutingGraph + CostModel + resolveOp/opEndpoint
   │                      │  Route (ordered steps on micro elements)
   │                      ▼
   │           packages/routebook        RoutebookIndex + buildRoutebook → items + gaps
   │                      │
   │           packages/schematic        switch classification + lane layout along a route
   │                      │
   │           packages/core-extensions  PluginRegistry + extendRoutebook (plugins add items/overlays/cost models)
   │                      │
   └───────► apps/web (MapLibre)   apps/cli (fetch / route / stats)
```

The dependency direction is strictly downwards. `rinf-client` holds the shared snapshot types. `core-extensions` sits on top of the three core packages, so plugins depend on the core and never the other way round.

## Packages

### rinf-client

- `SparqlClient` sends POST requests to the endpoint and substitutes the `{{graph}}` parameter. Country graphs are listed in `countries.ts`; Norway is `http://data.europa.eu/949/graph/0076`.
- The query templates in `packages/rinf-client/queries/` are derived from the step-1 queries in `docs/queries/`. The ones in `docs/` stay as plain, runnable documentation.
- `fetchSnapshot` runs the queries one after another, because the public endpoint is shared. `assembleSnapshot` is a pure function that turns the result rows into the snapshot model and removes the duplicated labels.
- `saveSnapshot` / `loadSnapshot` write and read one JSON file per part. The web app can therefore load only `ops.json` and `sols.json`.
- Snapshots make every consumer work offline. A live mode (query per route) can be added later behind the same types.

### routing

- A state is "at end X of element E". Moving along an element costs `metres × factor(element)`. Only `NetRelation`s with navigability `Both` are followed, so a route never U-turns through a switch.
- Endpoints are lists of intervals on elements. `opEndpoint` uses the OP centre points (`NetPointReference`) when they exist and falls back to the OP area (`NetAreaReference`).
- `CostModel` is an interface. The default is `trackPreferenceCostModel`: running track ×1, siding ×5, unknown ×1.5. `lengthCostModel` uses pure distance.
- The logic is ported from `docs/queries/route_test.py` and gives the same results for Oslo S–Lillestrøm and Oslo S–Drammen.

### routebook

- `buildRoutebook(route)` produces `RoutebookItem`s sorted by distance from the start. Each item has `kind`, `distance`, the line km when known, `label`, `quality` and `source` (the RINF IRI).
- `quality` makes uncertainty explicit:
  - `rinf`: taken directly from RINF.
  - `derived`: computed from RINF data, e.g. a tunnel entry/exit from the area coverage, or an OP area entry.
  - `approximate`: e.g. a gradient change placed by interpolating line km from km posts and signals.
  - `missing`: a placeholder item, e.g. a track without a speed value.
- `gaps` lists the fields RINF can't provide (`RINF_GAPS`): speed profile, derailers, no-stop zones, switch attributes, signal id, distant signals and boards.
- Signal direction filter: we assume `appliesToDirection` "normal" means "valid when travelling in the direction of increasing offset on the element". **This still has to be verified against Bane NOR's own data or ERA documentation.**

### schematic

A schematic track layout of the tracks around a route, derived from the micro topology only.

- **Nodes.** `TopoNetwork` groups element ends that share NetRelations into nodes. A node with 3 ends where one end is navigable to the other two, and those two are not navigable to each other, is a switch: that end is the *common* leg, the other two are the branches. Norway has 3 447 such switches; nodes with 4 ends are crossings and slips.
- **Continuous or deviating branch.** RINF does not say which branch of a switch is the through route, so `classifySwitches` uses Bane NOR's rule (RINF workshop slides, "schematic layouts from topology"): ① the branch whose track has the same name as the common leg's track, ② else the branch whose track has the same type (running/siding), ③ else the branch whose curvature is closest to the common leg's. For Norway, rule ① decides 88 % of the switches, ② 1 % and ③ 11 %.
- **Left or right.** Decided spatially on a short piece of track next to the switch. The reference direction is the last 30 m of the common leg, pointing into the switch. Each branch is followed for 20 m (50 m or 100 m if the two branches are still less than 0.25° apart) and the branch with the larger counter-clockwise angle is the left one. Element geometry runs from origin to end, so the walk starts at the end that touches the switch and reverses the geometry when that is the element's end; when a branch element is shorter than the sample distance the walk continues into the next element.
- **Precomputed.** The browser geometry is simplified to about 1 m, which changes the answer for about 5 % of the switches, so `routebook bundle` classifies on the full-resolution snapshot geometry and writes `switches.json` next to the other bundle parts. Without that file the web app classifies on the simplified geometry.
- **Layout** (`layoutRouteSchematic`). The route is a straight line on lane 0, with x = distance along the route (the routebook scale). The tracks around it are added nearest first, up to 3 km along the track and 600 m away from the route; nodes off the route are projected onto it for their x. At a switch the continuous branch keeps the lane of the common leg and the deviating branch moves one lane to its side, mapped to the direction of travel: up is left of travel. When the route itself takes the deviating branch, the continuous branch moves to the other side. When a lane is already taken, the real lateral offset from the route decides whether the new track goes beyond the occupant or between the two; lanes are renumbered to integers per station group at the end. On Oslo S–Bergen and Trondheim–Bodø 99 % or more of the off-route tracks end up on the same side of the route as in the geometry; Oslo S–Drammen is at 95 %, with the rest in the crossovers of the busiest stations.

The web app shows it under the **Schematic** tab (`?view=schematic`): open line is compressed and stations keep 0.5 px/m, with zoom buttons. Clicking in the schematic selects the nearest routebook item, and selecting a routebook item marks it in the schematic.

### core-extensions (the open-core boundary)

A `RoutebookPlugin` can contribute:

- `itemProviders`: extra routebook items. Their kinds are namespaced as `<pluginId>:<kind>`. A provider can declare `fillsGaps`, which removes those gaps from the routebook.
- `overlays`: library-neutral map layers (GeoJSON plus style hints).
- `costModels`: alternative routing cost models.

`extendRoutebook(registry, snapshot, routebook)` merges and re-sorts the items without changing the inputs.

**Licensing model:** everything in this repository is MIT and uses only public RINF data. Paid or proprietary modules live in **separate repositories** and plug in through `core-extensions`; examples are IM-specific speed profiles, timetable-aware routing, PDF export and fleet features. The core never imports them. This keeps the open-source app fully usable while leaving room for commercial add-ons that don't fork the core.

## Apps

- `apps/cli` provides `routebook fetch | route <from> <to> | stats`. It proves that the packages work end to end.
- `apps/web` is a Vite + MapLibre app written in plain TypeScript, with no UI framework:
  - **Data:** `routebook fetch` writes a compact *web bundle* to `data/web/<country>/`, using `toWebBundle` from `@routebook/rinf-client/compact`. IRI prefixes are replaced by short tokens and element geometry is simplified to about 1 m. That gives about 12 MB raw, or about 3 MB gzipped. Vite serves the bundle from `/<country>/` and copies it into the build, so the built app routes offline.
  - **Engine** (`engine.ts`): it loads the bundle, expands it with `fromWebBundle` and builds `RoutingGraph`, `RoutebookIndex` and the default cost model once. Each route then takes tens of milliseconds.
  - **UI:** a search box with autocomplete (`search.ts`, diacritic-insensitive), map popups to set the origin and destination, swap and clear buttons, and the route held in the URL (`?from=NOOSL&to=NODRM`). The route line is drawn from the element geometry sliced at the step offsets (`geometry.ts`).
  - **Routebook strip** (`strip.ts` for the pure row model, `view.ts` for the DOM): columns for distance, speed band, gradient band, line km, a symbol, the label and a quality flag. Clicking a row pans the map to that position along the route. There is a responsive tablet layout and a print stylesheet.
- `scripts/serve.mjs` is a dependency-free static server with gzip. `scripts/demo.mjs` backs `pnpm demo`, and `scripts/screenshots.mjs` takes headless screenshots by driving the installed Chrome or Edge through `playwright-core`.

## Known limitations

- Only Norway has been checked.
- OP areas are large. Oslo S and Lillestrøm have no centre point, so routes from or to them start at the area edge.
- Line km values can jump inside a span (e.g. in the Oslo tunnel). Fitted km values are therefore approximate.
- There is no validity-date filtering yet (`era:validity` is ignored).
- Routes are the shortest along the infrastructure, with no "usual passenger route" preference and no via points yet. For example, Oslo S → Bergen goes via Gjøvikbanen and Roa–Hønefoss.
- The base map (OSM raster tiles) and the map label fonts need internet; everything else works offline.
