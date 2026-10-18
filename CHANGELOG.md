# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [Semantic Versioning](https://semver.org/).

## [Unreleased]

### Added

- The data keeps itself current: `routebook sync` compares what ERA publishes (dataset explorer and triple counts, as fingerprints) with the catalogue and fetches only the datasets that are new, changed or failed last time, one at a time, writing each bundle next to the old one and swapping it in when complete. The server runs it as a child process when `ROUTEBOOK_SYNC_MINUTES` is set (60 in the image; the container no longer blocks its start on the first fetch), the catalogue gains the statuses `stale` (newer data published, with what ERA publishes now) and `pending` (not fetched yet), which the Datasets dialog and button show, `GET /healthz` reports the datasets' state and the sync, and `sync --once` / `--force` serve cron jobs and `ROUTEBOOK_REFRESH`. Bundles are written with precompressed `.gz` and `.br` parts, which the server sends as they are, and every file carries an `ETag`. New guide: `docs/datasets.md`.
- Dataset provenance, modelled on RINF Atlas: `routebook fetch` records what ERA published for each named graph (infrastructure manager, dataset id, file name, publication date, triple count, fingerprint) from the dataset explorer API and the repository (`meta.provenance`, `ROUTEBOOK_DATASETS_API` / `--datasets-api`). `datasets.json` becomes a catalogue with a status per dataset (loaded, failed with the error while the previous data stays on offer, removed from ERA) and when the endpoint was last checked; `routebook index` rebuilds it. The web app shows a **Datasets** button (network, ERA publication date, loaded/listed count) that opens a dialog listing every dataset with its publication, fetch time, status and a link into RINF Atlas (`atlasUrl`), and prints the publication behind every routebook in the footer.
- Demo disclaimer in the app: a hazard-striped banner, a notice to acknowledge on the first visit (again when the wording changes) and a stamp on printed routebooks, saying that this is a demo, not for operational use, and that the RINF data is shown as ERA publishes it without warranty. `disclaimer` in the configuration names the publisher, changes the wording or switches it off. A code of conduct for the project.
- A configured imagery background (for example Esri World Imagery through `ESRI_API_KEY`) takes the place of the coarse built-in Satellite layer; `builtinBasemaps: ["map", "satellite"]` keeps it.

- Any RINF country or infrastructure manager, not only Norway:
  - `routebook datasets` lists the named graphs on the endpoint with their countries.
  - `routebook fetch --dataset <id>` takes an ISO 3166-1 alpha-3 country code (its graphs are looked up on the endpoint), an IM code such as `0076` or a graph IRI; `--graph` (repeatable), `--name` and `--im` combine graphs into one dataset. `--country` still works.
  - Datasets of several graphs are queried together (`SparqlClientOptions.graphs`).
  - `datasets.json` lists the fetched datasets; the web app has a **Network** picker (`?dataset=`) and opens on the whole network. The data credit names the infrastructure manager of the dataset.
  - `ROUTEBOOK_DATA_DIR` and `ROUTEBOOK_SPARQL_ENDPOINT` for the CLI.
- Runtime configuration (`config.json`, `ROUTEBOOK_CONFIG`, environment variables) read by the server instead of build-time variables, so one build serves any deployment: title, default dataset, extra background maps and overlays (XYZ, TMS, quadkey, WMS `{bbox-epsg-3857}`), request headers, example routes. `${NAME}` placeholders are filled from the environment.
- Privacy statement set by the deployer (`privacy` in the configuration: a URL, a text or an HTML file served as `privacy.html`; `ROUTEBOOK_PRIVACY_URL` / `ROUTEBOOK_PRIVACY_FILE`), linked in the footer.
- Tile proxy: layers with `"proxy": true` are fetched by the server with their keys and headers, which never reach the browser. `ESRI_API_KEY` adds Esri World Imagery this way.
- Docker image (`ghcr.io/matdata-eu/rinf-routebook`), Docker Compose file, `.env.example` and `config.example.json`; the container fetches the datasets in `ROUTEBOOK_DATASETS` on its first start.
- All of RINF: `routebook fetch-all` (`pnpm fetch:all`) fetches every dataset on the endpoint, one per country, with a retry and a summary; a country that fails is skipped. `ROUTEBOOK_DATASETS=all` does the same in Docker. Country datasets get English names.
- The public demo moves to https://routebook.matdata.eu, run by Matdata from the Docker image with every RINF dataset kept current by the sync and Esri World Imagery as the background; its configuration and privacy statement are in `deploy/matdata/`. The GitHub Pages workflow and `deploy/github-pages/` are gone (a static site cannot keep itself current); `scripts/build-static.mjs` stays for static hosts.
- GitHub workflows: CI (build, typecheck, test) and a multi-platform Docker image published on pushes to `main` and version tags.
- Deployment guide (`docs/deployment.md`), credits, support and security policy, issue and pull request templates.

### Changed

- The optional aerial background is configured at runtime (`config.json` or `ESRI_API_KEY`) instead of `VITE_*` variables in `apps/web/.env.local`.
- The server (`scripts/serve.mjs`) also serves `config.json`, `datasets.json`, the data bundles from the data folder and `/healthz`, sends cache and security headers, and listens on `HOST` / `PORT`.

### Added (schematic, drive view, background maps)

- `@routebook/schematic`:
  - Switch classification from the micro topology: common leg, continuous and deviating branch (Bane NOR rule: same track name, then same track type, then closest curvature) and the side of the deviating branch from the geometry of the first metres of each branch.
  - Lane layout of the tracks around a route: the route straight on lane 0, deviating branches one lane to their side.
  - Lanes are x intervals per side, assigned greedily nearest the route first and reused where a station's tracks end: no tracks drawn on top of each other, with no lane limit by default (`maxLanes` can set one; tracks beyond it are left out with a stub, `Schematic.omitted`).
  - Off-route tracks are placed by their distance along the track from the route, in the direction the topology gives, with at least 40 m per lane changed (`minRun`): no more near-vertical lines.
  - Kinks: tracks next to the route change lane where the topology changes, so they stay close to the route and step out only where another track appears between them (`addKinks`, `SchematicTrack.runs`, on by default, `kinks: false` turns it off). Level model after railplot (MIT).
  - A track that leaves the view is labelled with the next operational point along it (`towards`); an element of a wye is drawn as a stub at each end.
  - Crossings and slip switches (4-end nodes) keep their straight pair through and are listed in `Schematic.crossings`.
  - Solved layout (`layoutRouteSchematicSolved`): railplot's model (MIT) as a mixed-integer program solved by HiGHS (WebAssembly) per window of the route, with the heuristic layout as fallback; far fewer crossings and bends. `layoutMetrics` counts crossings, overlaps and bends of a drawn layout.
- Web app: background map switch on the map (`?base=`): **Streets** (OSM) and **Satellite** (Sentinel-2 cloudless 2016 by EOX, CC BY 4.0, no key), plus an optional high-resolution **Aerial** background (Esri World Imagery with an API key, or any XYZ tile template such as Norge i bilder) configured in `apps/web/.env.local`.
- Web app: **Drive** tab (`?view=drive`, `&at=<metres>` for a position, `&play=1` to start running): a satnav-style, heading-up camera follows a little 3D train along the route.
  - The routebook is read out as cues ahead, like turn instructions: next signal, speed change, tunnel, level crossing and operational point with the distance to go; speed signs, signals and OP names stand along the line.
  - Speed cluster with the simulated speed, the speed in force, gradient and line; "In tunnel" banner; next stop with a rough time at line speed.
  - Simulated run: accelerates to the RINF maximum speed, brakes ahead of lower speeds and at the destination (no train length, gradient or stops); play/pause (space), 1×–60×, scrub bar, Chase / Cab / Top cameras, mouse wheel zoom. The routebook strip follows the train, and clicking a row moves the train there.
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
