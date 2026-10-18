# Architecture

## Overview

```
              ERA knowledge graph (SPARQL, public)
                          │
              packages/rinf-client  ── queries/*.rq ({{graph}} = the dataset's named graph(s))
                          │  fetchSnapshot → data/snapshots/<dataset>/*.json
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
- **Layout** (`layoutRouteSchematic`). The route is a straight line on lane 0, with x = distance along the route (the routebook scale); up is left of the direction of travel. The tracks around it are added nearest first, up to 3 km along the track and 600 m away from the route (a track that leaves this corridor is drawn as a short stub).
  - *Direction and x.* Ends of a node that a train can pass between lie on opposite sides of it, so the direction in which an element leaves a node along x follows from the topology (geometry only breaks the tie at nodes without navigability). An off-route node is placed by its distance along the track from the route nodes behind and ahead of it, scaled to fit between them, so a chain of tracks keeps x monotone until it reconnects to the route. An element that changes lanes gets at least 40 m of x per lane (less when it is shorter); the projection onto the route is only used for the corridor test and for the lateral offset of each element.
  - *Runs.* Elements that continue each other (a plain joint, the common leg and continuous branch of a switch, the straightest pair through a crossing) form a run that shares one lane. At a switch the deviating branch lies one lane further to its side than the continuous branch; when the route takes the deviating branch, the continuous branch goes to the other side. A crossover (deviating at both ends, towards each other) is drawn as one diagonal and asks for adjacent lanes. A run is cut inside open line (at elements of 400 m or more), so the other track of a double line can move out around a station and back; the pieces prefer each other's lane.
  - *Lanes.* Runs get a side from the switches that connect them to the route, then lanes per side greedily, nearest the route first (interval scheduling): a run goes on the lowest lane that is free over its x range (15 m gap) and lies outside the runs the switches say it is outside of; between tracks on the same side the switches don't order, the lateral offset from the route (where the track comes closest to it) does. A lane is free again where the last track on it ends, so a large yard does not widen the rest of the route. A station with more tracks on one side than `maxLanes` (no limit by default; the view scrolls vertically) can keep only the nearest; the rest are then left out with a short stub where they branch off (`omitted` counts them). Lanes are then known, and x is placed a second time with the real number of lanes each element changes.
  - *Crossings and slips* (4-end nodes): the straightest pair runs straight through, the other two ends branch off it to the side they lie on, like deviating branches; the renderer marks the node with an X.
  - *Kinks* (`addKinks`, `packages/schematic/src/kinks.ts`): a second pass cuts x at every node into slabs and gives each off-route element a lane per slab, keeping the vertical order of the first pass in every slab, the straight pair through a node on one lane and a branch at least one lane to its side. The lanes are the least fixpoint of those constraints from the route outwards, so a track sits as close to the route as the tracks between them allow and steps out only where something appears between it and the route; a dip too short for its 45° diagonals (40 m per lane) is raised again. The model follows railplot's level formulation (Bjørnar Luteberget, github.com/luteberget/railplot, MIT licence) without its SAT solver. The x placement is unchanged, so busy station throats (Hamar, Drammen) still have long diagonals crossing other tracks.
  - *Quality* (`packages/schematic/test/eval.test.ts`, on the Norway snapshot): no same-lane overlaps and lanes within −6.5..6.5 on Oslo S–Drammen, Oslo S–Bergen and Hamar–Trondheim; the lane of 98 % (Oslo S–Drammen), 100 % (Oslo S–Bergen) and 96 % (Hamar–Trondheim) of the off-route tracks 2–60 m from the route is on the same side as in the geometry. Without a lane limit, busy stations take more lanes (Stavanger–Oslo S reaches −35 lanes) and every track within the corridor is drawn.
  - *Junctions.* A track that leaves the corridor (600 m from the route, 3 km along the track) ends in a stub labelled with the next operational point along it (`SchematicTrack.towards`, e.g. "← Kristiansand" at Dalane). An element whose two ends leave their nodes in the same x direction (a wye, as between Suldal, Dalane and Kristiansand) cannot be drawn as one line and is drawn as a stub at each end.
- **Solved layout** (`layoutRouteSchematicSolved`, `packages/schematic/src/solver.ts`). A port of railplot's model (Bjørnar Luteberget, github.com/luteberget/railplot, MIT licence) to a mixed-integer program solved by HiGHS (npm `highs`, WebAssembly). It reuses the exploration of the heuristic layout (`exploreRoute`) and keeps the heuristic as fallback. Route nodes stay at their route distance on lane 0; every other node gets an x (kept in the heuristic order, at least `minRun` per lane changed, soft) and an integer level, every edge one level with its diagonals at the ends. Port shapes follow the Bane NOR rule (continuous branch straight, deviating branch to its side), and railplot's edge order (switch legs by screen side, propagated through the edges a node lies inside, ties broken by the lateral offset in the geometry) keeps edges apart; a node inside an edge's span stays clear of its end diagonals. The objective weighs height, then bends, then lanes changed, then x away from the heuristic. The route is cut into windows at open line (≥ 1 km without nodes) and each window is one model (0.5 s limit); a window without a solution keeps the heuristic. In the eval it removes most crossings (Hamar–Trondheim 34 → 2, Oslo S–Drammen 10 → 2) and about a third of the bends, at the cost of more lanes in busy stations (up to 14 at Trondheim) and some long steep diagonals (Skøyen, Drammen). The model and the solve are split (`prepareSolvedLayout` returns LP text per window and a `finish`) so that the app solves in a Web Worker.

The web app shows it under the **Schematic** tab (`?view=schematic`). The OP names stay at the top and a band with the line, speed, gradient and km ruler stays at the bottom while scrolling vertically; tunnels are drawn as a band along the route and level crossings as two bars across it. open line is compressed and stations keep 0.5 px/m. Zoom with the + and − buttons, Ctrl / Cmd + mouse wheel (anchored at the cursor) or **Fit** (the whole route in the visible width). An element that changes lanes is drawn horizontal, 45° diagonal, horizontal. Switch numbers, track names and OP names (up to three rows) are left out where they would overlap another label. Signals on the route are drawn on the right of the track for the direction of travel (both sides for signals valid in both directions), with their names from zoom 2. Clicking in the schematic selects the nearest routebook item, and selecting a routebook item marks it in the schematic. The heuristic layout is drawn at once; the solved layout replaces it when the worker (`apps/web/src/solver-worker.ts`, HiGHS loaded on first use: 102 kB JavaScript + 3.5 MB wasm, 1.2 MB gzipped) is done, typically 1–2 s later, keeping the scroll position.

### core-extensions (the open-core boundary)

A `RoutebookPlugin` can contribute:

- `itemProviders`: extra routebook items. Their kinds are namespaced as `<pluginId>:<kind>`. A provider can declare `fillsGaps`, which removes those gaps from the routebook.
- `overlays`: library-neutral map layers (GeoJSON plus style hints).
- `costModels`: alternative routing cost models.

`extendRoutebook(registry, snapshot, routebook)` merges and re-sorts the items without changing the inputs.

**Licensing model:** everything in this repository is MIT and uses only public RINF data. Paid or proprietary modules live in **separate repositories** and plug in through `core-extensions`; examples are IM-specific speed profiles, timetable-aware routing, PDF export and fleet features. The core never imports them. This keeps the open-source app fully usable while leaving room for commercial add-ons that don't fork the core.

## Apps

- `apps/cli` provides `routebook datasets | fetch | fetch-all | sync | bundle | index | route <from> <to> | stats`. It proves that the packages work end to end. `sync` is the loop that keeps a deployment's data current (`packages/rinf-client/src/sync.ts`: compare ERA's fingerprints with the catalogue, fetch what changed, swap bundles in atomically); see [datasets.md](datasets.md).
- `apps/web` is a Vite + MapLibre app written in plain TypeScript, with no UI framework:
  - **Data:** `routebook fetch` writes a compact *web bundle* to `data/web/<dataset>/` (and lists it in `data/web/datasets.json`, the dataset catalogue: status, what ERA published for each graph as read from the dataset explorer and the repository in `packages/rinf-client/src/era.ts`, when the endpoint was last checked), using `toWebBundle` from `@routebook/rinf-client/compact`. IRI prefixes are replaced by short tokens and element geometry is simplified to about 1 m. That gives about 12 MB raw, or about 3 MB gzipped. The server (and Vite in development) serves the bundle from `/<dataset>/`; `pnpm build` also copies `data/web` into the build, so the built app routes offline.
  - **Network index** (`packages/rinf-client/src/network-index.ts`, browser-safe): every bundle also carries an `index.json` with its operational points (dataset, UOPID, name, type, position, whether it is on the routable topology) and its sections of line simplified to about 50 m. Whenever the catalogue is written, the parts are merged into `data/web/index/ops.json` and `sols.json` (tens of KB per country, compressed). The app starts from that index alone: the map and the search cover every dataset without loading a single bundle.
  - **Engines on demand** (`main.ts`, `loadEngine`): a bundle is loaded, and its engine built, the first time a route needs it; up to six stay in memory, the route's own always. The **Network** picker and `?dataset=` are a filter on the index, not a reload, and `?dataset=all` shows everything.
  - **Routes across networks** (`network-index.ts`, `engine.ts`): RINF has no net relations between infrastructure managers' graphs, so the catalogue writer derives *border links* (`index/borders.json`): the same UOPID declared by two datasets (Bane NOR and Trafikverket both publish EU00237), else two border points (op type 90 or 140) within 300 m. Each link names the element end that faces out of its network (the dead end of the border point's element). For a route between two datasets, `transitDatasets` runs a small Dijkstra over a meso graph (the two OPs and all border ends, joined inside a dataset by great-circle distance, across a link at no cost) to find the chain of datasets to load, at most six. `mergeBundles` then lays the loaded bundles' topologies, features and geometry side by side, adds one navigable relation per border link, and a normal `RouteEngine` routes, builds the routebook, the schematic and the drive on that merged bundle; `addBorderItems` (routebook package) tags each item with its dataset and inserts an **Infrastructure manager change** item (quality *derived*) where the route passes a link. The footer and the print list every dataset the route runs through.
  - **Engine** (`engine.ts`): it loads a bundle, expands it with `fromWebBundle` and builds `RoutingGraph`, `RoutebookIndex` and the default cost model once per dataset. Each route then takes tens of milliseconds.
  - **UI:** a search box with autocomplete (`search.ts`, diacritic-insensitive, over the index of every dataset or of the filtered one; `network.ts` holds the index, the filter and the URL codes, `NOOSL@nor` when a UOPID exists in several datasets), clicks on the map to set the origin and then the destination (a click with a route shown starts a new one; OPs without a net reference are grey and refused), swap and clear buttons, and the route held in the URL (`?from=NOOSL&to=NODRM`). The route line is drawn from the element geometry sliced at the step offsets (`geometry.ts`).
  - **Routebook strip** (`strip.ts` for the pure row model, `view.ts` for the DOM): columns for distance, speed band, gradient band, line km, a symbol, the label and a quality flag. Clicking a row pans the map to that position along the route. There is a responsive tablet layout and a print stylesheet.
- `scripts/serve.mjs` is the dependency-free server used in Docker and by `pnpm demo`: static files with ETags and precompressed (`.br`/`.gz`, written at fetch time) or on-the-fly gzip, the data bundles from `ROUTEBOOK_DATA_DIR`, `datasets.json`, `healthz`, the runtime configuration (`config.json`, built by `scripts/runtime-config.mjs`), the tile proxy for layers with keys, and the `routebook sync` child process when `ROUTEBOOK_SYNC_MINUTES` is set. See [deployment.md](deployment.md). `scripts/demo.mjs` backs `pnpm demo`, and `scripts/screenshots.mjs` takes headless screenshots by driving the installed Chrome or Edge through `playwright-core`.

## Known limitations

- Only Norway has been checked in detail. Other countries can be fetched, but their micro topology may be incomplete.
- OP areas are large. Oslo S and Lillestrøm have no centre point, so routes from or to them start at the area edge.
- Line km values can jump inside a span (e.g. in the Oslo tunnel). Fitted km values are therefore approximate.
- There is no validity-date filtering yet (`era:validity` is ignored).
- Routes are the shortest along the infrastructure, with no "usual passenger route" preference and no via points yet. For example, Oslo S → Bergen goes via Gjøvikbanen and Roa–Hønefoss.
- The map layers (OSM raster tiles, the OpenRailwayMap overlay, configured layers, see `apps/web/src/basemaps.ts`) and the map label fonts need internet; everything else works offline.
