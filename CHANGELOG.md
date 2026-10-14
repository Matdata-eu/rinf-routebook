# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@routebook/schematic`:
  - Switch classification from the micro topology: common leg, continuous and deviating branch (Bane NOR rule: same track name, then same track type, then closest curvature) and the side of the deviating branch from the geometry of the first metres of each branch.
  - Lane layout of the tracks around a route: the route straight on lane 0, deviating branches one lane to their side.
  - Lanes are x intervals per side, assigned greedily nearest the route first and reused where a station's tracks end: no tracks drawn on top of each other, with no lane limit by default (`maxLanes` can set one; tracks beyond it are left out with a stub, `Schematic.omitted`).
  - Off-route tracks are placed by their distance along the track from the route, in the direction the topology gives, with at least 40 m per lane changed (`minRun`): no more near-vertical lines.
  - Kinks: tracks next to the route change lane where the topology changes, so they stay close to the route and step out only where another track appears between them (`addKinks`, `SchematicTrack.runs`, on by default, `kinks: false` turns it off). Level model after railplot (MIT).
  - A track that leaves the view is labelled with the next operational point along it (`towards`); an element of a wye is drawn as a stub at each end.
  - Crossings and slip switches (4-end nodes) keep their straight pair through and are listed in `Schematic.crossings`.
  - Solved layout (`layoutRouteSchematicSolved`): railplot's model (MIT) as a mixed-integer program solved by HiGHS (WebAssembly) per window of the route, with the heuristic layout as fallback; far fewer crossings and bends. `layoutMetrics` counts crossings, overlaps and bends of a drawn layout.
- Web app: **Schematic** tab next to the map (`?view=schematic`), with compressed open line, zoom, switch tooltips and selection linked to the routebook strip.
  - Ctrl / Cmd + mouse wheel zooms at the cursor; **Fit** zooms the whole route into the view.
  - Lane changes drawn horizontal, 45° diagonal, horizontal (crossovers and kinks too); labels that would overlap are left out, OP names use up to three rows.
  - Crossings marked with an X; signals drawn on the right of the track for the direction of travel, with their names from zoom 2.
  - The schematic is drawn with the heuristic layout first and replaced by the solved layout, computed in a Web Worker.
  - The OP names stay at the top and a bottom band with the line, speed (km/h), gradient (‰) and the km ruler stays at the bottom while scrolling vertically; tunnels are drawn as a band along the route, level crossings as two bars across it, and signals are coloured by type; main signals (home, intermediate, exit, block) are named at every zoom, the others from zoom 2.
- CLI: `routebook bundle` / `fetch` write `switches.json` (classified on full-resolution geometry); `pnpm bundle:nor`.

## [0.1.0] - 2026-10-13

First preview, Norway (Bane NOR) only.

### Added

- RINF data coverage check for Norway, with reusable SPARQL queries (`docs/`).
- `@routebook/rinf-client`:
  - SPARQL client for the ERA `rinf-plus` endpoint, with the country named graph as a parameter.
  - Offline JSON snapshot, and a compact web bundle with IRI prefix compaction and simplified geometry.
- `@routebook/routing`:
  - Dijkstra on the micro topology (`LinearElement`/`NetRelation`); only `Both` relations are followed, so routes never reverse through a switch.
  - OP endpoints from `NetPointReference`/`NetAreaReference`.
  - Pluggable cost models (the default prefers running tracks).
- `@routebook/routebook`:
  - Ordered routebook items: OPs, line, speed, gradient, tunnels, signals, switches, km posts, level crossings.
  - Quality flags on each item, and a list of RINF gaps.
- `@routebook/core-extensions`: plugin interface for item providers, map overlays and cost models.
- CLI: `routebook fetch | bundle | route | stats`.
- Web app:
  - MapLibre map of OPs and SoLs.
  - Origin and destination from search (with autocomplete) or by clicking the map; swap, clear, and URL state.
  - Routing in the browser and a routebook strip with speed and gradient bands; clicking an item pans the map.
  - Tablet layout and a print/PDF stylesheet.
- `pnpm demo` (offline-capable local demo), `docs/demo.md`, headless screenshots.
