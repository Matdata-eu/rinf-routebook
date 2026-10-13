# Routebook

An open-source (MIT) routebook built on public **ERA RINF** data. You pick two operational points, the app routes between them on the RINF micro topology and lists what a driver meets along the way: km positions, line numbers, signals, switches, tunnels, speed and gradient. Where RINF has no data, the routebook says so explicitly.

Status: early skeleton. Norway (Bane NOR) is the only country checked so far; see [docs/data-coverage-norway.md](docs/data-coverage-norway.md).

## Requirements

- Node.js ≥ 22
- pnpm 10

## Quick start

```bash
pnpm install
pnpm build
pnpm fetch:nor                      # download the Norway snapshot into data/snapshots/nor (~25 s, ~14 MB)
pnpm route "Oslo S" Drammen --limit 40
pnpm test
pnpm dev:web                        # map of OPs and SoLs at http://localhost:5173
```

CLI options: `--area` (route between OP areas instead of centre points), `--cost length|prefer-running`, `--kinds signal,switch`, `--json`. Run `node apps/cli/dist/index.js --help` for the full list.

## Layout

| Path | What |
|---|---|
| `packages/rinf-client` | SPARQL client for `https://graph.data.era.europa.eu/repositories/rinf-plus`, query templates and the offline JSON snapshot |
| `packages/routing` | Graph of micro `LinearElement`/`NetRelation`, Dijkstra with pluggable cost models |
| `packages/routebook` | Routebook model: ordered items along a route plus gap markers |
| `packages/core-extensions` | Plugin interface (item providers, map overlays, cost models) |
| `apps/cli` | Fetch snapshots and print routebooks |
| `apps/web` | Vite + MapLibre skeleton |
| `docs/` | Data coverage report, architecture, reusable SPARQL queries |

See [docs/architecture.md](docs/architecture.md).

## Data

RINF data © European Union Agency for Railways, fetched from the public ERA knowledge graph. Snapshots are not committed; regenerate them with `pnpm fetch:nor`.

## License

[MIT](LICENSE)
