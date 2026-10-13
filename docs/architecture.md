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

### core-extensions (the open-core boundary)

A `RoutebookPlugin` can contribute:

- `itemProviders`: extra routebook items. Their kinds are namespaced as `<pluginId>:<kind>`. A provider can declare `fillsGaps`, which removes those gaps from the routebook.
- `overlays`: library-neutral map layers (GeoJSON plus style hints).
- `costModels`: alternative routing cost models.

`extendRoutebook(registry, snapshot, routebook)` merges and re-sorts the items without changing the inputs.

**Licensing model:** everything in this repository is MIT and uses only public RINF data. Paid or proprietary modules live in **separate repositories** and plug in through `core-extensions`; examples are IM-specific speed profiles, timetable-aware routing, PDF export and fleet features. The core never imports them. This keeps the open-source app fully usable while leaving room for commercial add-ons that don't fork the core.

## Apps

- `apps/cli` provides `routebook fetch | route <from> <to> | stats`. It proves that the packages work end to end.
- `apps/web` is a Vite + MapLibre skeleton that draws OPs and SoLs from the snapshot on an OSM raster base map. The real UI (OP picking, the routebook panel) is step 3.

## Known limitations

- Only Norway has been checked.
- OP areas are large. Oslo S and Lillestrøm have no centre point, so routes from or to them start at the area edge.
- Line km values can jump inside a span (e.g. in the Oslo tunnel). Fitted km values are therefore approximate.
- There is no validity-date filtering yet (`era:validity` is ignored).
