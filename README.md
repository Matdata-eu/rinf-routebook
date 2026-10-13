# Routebook

**An open-source railway routebook built on public ERA RINF data.** Pick two stations. Routebook computes the route on the track-level (micro) topology of the RINF knowledge graph. It then shows what a driver meets along the way, in order: line changes, speed, gradient, tunnels, signals, switches, km posts and stations. Wherever RINF has no data for something a routebook needs, the routebook says so explicitly instead of guessing.

![Oslo S → Drammen](docs/screenshots/oslo-drammen.png)

<sub>Oslo S → Drammen: route on the map (left) and the routebook strip (right) with distance, speed band, gradient band, line km and a quality flag per item. More: [Oslo S → Bergen](docs/screenshots/oslo-bergen.png), [tablet](docs/screenshots/oslo-drammen-tablet.png), [print view](docs/screenshots/oslo-drammen-print.png).</sub>

## Scope

- **Open core (this repository, MIT):** the RINF client, routing, the routebook model, the plugin interface, the web app and the CLI. It only uses public RINF data, and it is useful on its own.
- **Commercial modules (later, separate repositories):** for example, detailed speed profiles from an infrastructure manager, timetable-aware routing, branded PDF export, or fleet features. They plug into [`packages/core-extensions`](packages/core-extensions/src/index.ts) and never require changes to, or a fork of, the core. See [docs/architecture.md](docs/architecture.md#core-extensions-the-open-core-boundary).

Status: **0.1.0, early preview.** Norway (Bane NOR) is the only country checked so far.

## Quick start

Requirements: Node.js ≥ 22 and pnpm 10.

```bash
pnpm install
pnpm build
pnpm fetch:nor     # one-off: download the Norway snapshot from the ERA endpoint (~25 s)
pnpm dev:web       # http://127.0.0.1:5173
```

Other commands:

| Command | What it does |
|---|---|
| `pnpm demo` | Builds everything and serves the web app with the snapshot bundled, at http://127.0.0.1:4173. Routing works offline; only the map background tiles need internet. See [docs/demo.md](docs/demo.md). |
| `pnpm route "Oslo S" Drammen --limit 40` | Prints a routebook in the terminal (`--json`, `--kinds signal,switch`, `--area`, `--cost length`) |
| `pnpm test` / `pnpm typecheck` | Vitest suite / TypeScript checks |
| `pnpm screenshots` | Headless screenshots into `docs/screenshots` (uses your installed Chrome, `--channel msedge` for Edge) |

## How routing works

1. **Snapshot:** `routebook fetch` runs a fixed set of SPARQL queries ([packages/rinf-client/queries](packages/rinf-client/queries)) against the country's named graph. The results are stored as JSON: a full snapshot for the CLI, plus a compact web bundle for the browser.
2. **Graph:** each micro `era:LinearElement` is an edge with its length. `era:NetRelation`s with navigability `Both` connect element ends. Relations with navigability `None` (switch leg to leg) are skipped, so a route never reverses through a switch.
3. **Endpoints:** an OP is placed on the topology through its `NetPointReference` (centre point). If it has none, the `NetAreaReference` (station area) is used.
4. **Shortest path:** Dijkstra with a pluggable cost model. The default prefers running tracks over sidings.
5. **Routebook:** features referenced on the traversed elements are placed by distance along the route. Signals are filtered by direction of travel. Tunnels are placed from their area coverage. Speed and gradient come from the running track. Each item is flagged as `rinf`, `derived`, `approximate` or `missing`.

Routing runs in the browser in tens of milliseconds, for example 73 ms for Oslo S → Bergen (455 km, 3 800 items).

## Data

- Source: the [ERA knowledge graph](https://graph.data.era.europa.eu/) (`rinf-plus` SPARQL endpoint), ERA ontology v3.3.x.
- RINF data © European Union Agency for Railways. The Norwegian data is provided by **Bane NOR** as infrastructure manager.
- Map background © OpenStreetMap contributors.

### Known data gaps

RINF does not contain everything a professional routebook needs. The app lists these gaps on every routebook:

- **Speed:** only one maximum speed per track. There are no speed sections and no speed-board positions.
- **Not in the ERA ontology at all:** derailers and catch points, and no-stop zones.
- **Switches:** position only. No type, orientation or diverging speed.
- **Signals:** there is no `signalId` (the name is in the label), and no distant signals or lineside boards.
- **Gradient:** a text profile per track, keyed to line km. Positions are interpolated, so they are approximate.

Details and fill rates: [docs/data-coverage-norway.md](docs/data-coverage-norway.md).

## Repository layout

| Path | What |
|---|---|
| `packages/rinf-client` | SPARQL client, query templates, snapshot and web bundle |
| `packages/routing` | Routing graph, cost models, OP endpoints |
| `packages/routebook` | Routebook model, ordering, gradient parsing, gap list |
| `packages/core-extensions` | Plugin interface (item providers, overlays, cost models) |
| `apps/web` | Vite + MapLibre web app |
| `apps/cli` | `routebook fetch / bundle / route / stats` |
| `scripts/` | Demo server, screenshot script |
| `docs/` | Architecture, data coverage, demo script, reusable SPARQL queries |

## Roadmap

- **Speed profiles:** a plugin interface for IM speed-section data (the first candidate for a commercial module). Better use of RINF speed data where it exists.
- **Other countries:** add country graphs to `countries.ts`, then run the coverage check and tune the queries per IM.
- **Offline PWA:** a service worker and a cached snapshot, so the app works fully offline on a tablet, including vector base map tiles.
- Validity-date filtering (`era:validity`), via points, and confirming the signal direction semantics with the data owner.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

## License

[MIT](LICENSE) © Mathias Vanden Auweele / matdata
