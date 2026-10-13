# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- `@routebook/schematic`:
  - Switch classification from the micro topology: common leg, continuous and deviating branch (Bane NOR rule: same track name, then same track type, then closest curvature) and the side of the deviating branch from the geometry of the first metres of each branch.
  - Lane layout of the tracks around a route: the route straight on lane 0, deviating branches one lane to their side, lateral offsets to resolve crowded lanes.
- Web app: **Schematic** tab next to the map (`?view=schematic`), with compressed open line, zoom, switch tooltips and selection linked to the routebook strip.
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
