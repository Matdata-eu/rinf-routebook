# Datasets: where the data comes from and how it stays current

Routebook works on copies of the RINF datasets that the infrastructure managers publish through the European Union Agency for Railways (ERA). This page explains what a dataset is here, how the server keeps its copies current, what the catalogue records and how to read the statuses in the app.

## One dataset per infrastructure manager

ERA publishes RINF as one named graph per infrastructure manager (IM) in its knowledge graph (`http://data.europa.eu/949/graph/<IM code>`, for example `0076` for Bane NOR). Routebook groups the graphs into datasets, normally one per country (`routebook datasets` lists what the endpoint has). A dataset's id is its folder name and its `?dataset=` value in the app: `nor`, `bel`, `0088`.

A fetch (`routebook fetch --dataset NOR`) runs the SPARQL queries in `packages/rinf-client/queries/` against the graphs of the dataset, stores the result as a snapshot (`data/snapshots/<id>/`) and writes the compact web bundle the browser loads (`data/web/<id>/`, 3 to 12 MB per country, see [architecture.md](architecture.md#apps)).

## What ERA says about a dataset

Next to the data itself, every fetch records what ERA publishes for each graph, the way [RINF Atlas](https://github.com/Matdata-eu/rinf-atlas) does, so that both apps agree on which version is shown:

| Field | Source |
|---|---|
| infrastructure manager, country, dataset id, file name, publication date | the dataset explorer API (`GET /api/v1/dataset/published?latest=true&groupBy=im`) |
| triple count | the repository (`GET <repository>/size?context=<graph>`) |
| fingerprint | `dataset id \| publication date \| triple count`: it changes whenever ERA publishes new data for the graph |

The explorer belongs to the endpoint (`https://rinf.data.era.europa.eu/api/v1` for the production endpoint); `ROUTEBOOK_DATASETS_API` or `--datasets-api` names another one, `none` skips it. When the explorer or the repository cannot be read, the fetch still succeeds, the fields stay empty and a warning is printed.

## The catalogue: `data/web/datasets.json`

The catalogue is what the Datasets dialog and `GET /healthz` show. It is rewritten by every `fetch`, `fetch-all`, `bundle`, `index` and by each step of a sync, in one file:

```json
{
  "version": 2,
  "checkedAt": "2026-10-17T10:00:00.000Z",
  "endpoint": "https://graph.data.era.europa.eu/repositories/rinf-plus",
  "datasets": [
    {
      "id": "nor", "name": "Norway", "imName": "Bane NOR",
      "fetchedAt": "2026-10-13T12:00:00.000Z", "ops": 734, "status": "loaded",
      "publishedAt": "2026-10-08T14:53:56.953Z",
      "graphs": [{ "graph": "http://data.europa.eu/949/graph/0076", "imCode": "0076", "imName": "Bane NOR",
                   "datasetId": "…", "publishedAt": "2026-10-08T14:53:56.953Z", "triples": 1594395, "fingerprint": "…|…|1594395" }],
      "counts": { "ops": 734, "sols": 912 }
    }
  ]
}
```

`checkedAt` is when the endpoint was last compared with the data. Per dataset:

| Status | Meaning | In the app |
|---|---|---|
| `loaded` | the bundle is there and matches what ERA publishes | Up to date |
| `stale` | ERA has published newer data since the fetch (`latest` holds what it publishes now); the next sync fetches it, the current data stays on offer until then | Newer data published |
| `pending` | ERA publishes the dataset and no fetch has succeeded yet | Fetching |
| `failed` | the last fetch failed (`error`); the previous bundle, if any, stays on offer | Update failed |
| `removed` | ERA no longer publishes the dataset; the bundle stays until it is fetched again or deleted | Removed from ERA |

The Datasets button in the app shows the network's ERA publication date and, with several datasets, how many have data (`27/28 datasets`), in red when a fetch failed and in amber while updates are on their way. The footer and the printed routebook name the publication behind the route.

## Keeping the data current: `routebook sync`

The container keeps its own data current; there is no scheduled rebuild. The server starts `routebook sync` next to itself when `ROUTEBOOK_SYNC_MINUTES` is above zero (the image sets 60) and restarts it should it exit. Each pass:

1. reads the dataset explorer once and the triple count of every graph of the datasets to keep (`ROUTEBOOK_DATASETS`: ids, or `all` for every dataset on the endpoint; without it, the datasets already in the catalogue);
2. compares the fingerprints with the catalogue and records what it found: new datasets become `pending`, changed ones `stale`, and, with `all`, datasets gone from the endpoint `removed`;
3. fetches only the datasets that are new, changed or failed last time, one after the other (the public endpoint is shared), with one retry each;
4. writes each bundle into `data/web/<id>.tmp` and swaps it into place when complete, so the server never serves a half-written bundle; a fetch that fails leaves the previous bundle and records the error;
5. sleeps `ROUTEBOOK_SYNC_MINUTES` and checks again. Graphs whose fingerprint cannot be read (explorer or repository down) count as unchanged, so an outage never triggers a refetch.

Stopping the container (`SIGTERM`) lets the current fetch finish, then stops; a second signal stops at once, and the next pass removes any `.tmp` folder left behind.

One check costs about two small requests per dataset (some 70 for the whole endpoint). A full fetch of every dataset takes a few hours, most of it waiting for the endpoint; the catalogue shows the progress and the app offers each dataset as soon as it is there.

`routebook sync --once` does one pass and exits (0 when everything succeeded, 1 when a fetch failed, 2 when the endpoint could not be checked), for a cron job or a CI workflow. `--force` fetches every dataset whether it changed or not (`ROUTEBOOK_REFRESH=1` does that once on start), `--only` and `--skip` narrow the selection, `--minutes` sets the interval for a loop outside the container.

## Serving the bundles

`saveWebBundle` writes `.gz` and `.br` next to every part of a bundle (brotli at its highest quality, which is slow and therefore done once at fetch time, not per request). The server sends them as they are when the browser accepts the encoding, and compresses on the fly otherwise. Every file carries a weak `ETag` (size and modification time), so a browser that has a bundle only downloads it again after a new fetch. `datasets.json` and the bundles are `no-cache`: always revalidated, never served stale.

`GET /healthz` reports the catalogue for monitoring:

```json
{ "ok": true, "checkedAt": "2026-10-17T10:00:00.000Z", "datasets": 28, "loaded": 27, "failed": 1, "stale": 0, "pending": 0, "removed": 0,
  "sync": { "enabled": true, "minutes": 60, "running": true, "restarts": 0, "startedAt": "2026-10-17T09:00:00.000Z" } }
```

`ok` says that the server runs; a failed dataset does not make the instance unhealthy, since the previous data stays on offer.

## Memory

A fetch holds one dataset in memory at a time; the sync processes them one after the other. Norway fits in Node's default heap. The largest networks (Germany, France) need more: the sync child inherits `NODE_OPTIONS` from the container's environment, so set `NODE_OPTIONS=--max-old-space-size=6144` or more for `ROUTEBOOK_DATASETS=all` (the public instance does, see `deploy/matdata/docker-compose.yml`). The sync log ends each pass with `peak memory N MB`: measure it on the first full run and give the container that much. Idle, the server and the sleeping sync need about 100 MB together.
