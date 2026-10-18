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

Each dataset also says whether Routebook can work on it. `counts` holds, besides the sizes, `routableOps` (operational points with a net reference to a linear element: a route needs one at each end), `signals` and `trackKm` (length of all linear elements). The Datasets dialog turns them into a **Routing** column:

| Routing | When |
|---|---|
| Ready (green) | linear elements and net relations, operational points on them, and at least 0.5 signals per km of track (Norway has about one) |
| Few signals / No signals (amber) | routes work, but the routebook will miss most signals |
| ⚠ No track network, Tracks not connected, OPs not on the track network (red) | no route is possible; the dialog says which |
| Signals not counted | data fetched before the counts existed; the next fetch adds them |

Operational points without a position on the track network are drawn grey on the map and cannot be picked. In October 2026, for example, Belgium (Infrabel) and Austria (ÖBB) publish operational points and sections of line with coordinates, but no linear elements or net relations, so Routebook shows them but cannot route there.

The Datasets button in the app shows the network's ERA publication date and, with several datasets, how many have data (`27/28 datasets`), in red when a fetch failed and in amber while updates are on their way. The footer and the printed routebook name the publication behind the route.

## Keeping the data current: `routebook sync`

The container keeps its own data current; there is no scheduled rebuild. The server starts `routebook sync` next to itself when `ROUTEBOOK_SYNC_MINUTES` is above zero (the image sets 60) and restarts it should it exit. Each pass:

1. reads the dataset explorer once and the triple count of every graph of the datasets to keep (`ROUTEBOOK_DATASETS`: ids, or `all` for every dataset on the endpoint; without it, the datasets already in the catalogue);
2. compares the fingerprints with the catalogue and records what it found: new datasets become `pending`, changed ones `stale`, and, with `all`, datasets gone from the endpoint `removed`;
3. fetches only the datasets that are new, changed, failed last time or fetched by an older version of Routebook's queries (`outdated`: the bundle records the `fetchVersion` it was made with, and a release that reads more from RINF raises it, so every dataset is fetched again once), one after the other (the public endpoint is shared), with one retry each;
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

## The network index: `data/web/index/`

The app no longer needs a bundle to show a network. Every bundle carries an `index.json` (its operational points with position, type and whether they are on the routable topology, and its sections of line simplified to about 50 m), and whenever the catalogue is written (`fetch`, `fetch-all`, `sync`, `index`) the parts of every loaded dataset are merged into `index/ops.json` and `index/sols.json`, written atomically and precompressed like the bundles. A bundle fetched before this index existed is indexed from its `ops.json` and `sols.json`. The index weighs tens of KB per country, so the app opens on all of RINF at once; a dataset's bundle (a few MB) is only fetched when a route needs it. `routebook index` rebuilds the catalogue and the index from the bundles on disk.

## Border links: `data/web/index/borders.json`

RINF publishes one graph per infrastructure manager and no net relations between them: Bane NOR's topology ends at Kornsjø, Trafikverket's at Mon, and nothing in the data says they meet. So that a route can run from Oslo to Stockholm, the catalogue writer derives **border links** between the datasets and writes them with the index, whenever the catalogue is written and on `routebook link`:

1. each bundle's `index.json` lists its *border candidates*: border points (op types 90 and 140) and OPs whose UOPID is coded for another country than most of the dataset's, each with the end of its micro element that faces out of the network (the end without a navigable relation, else the end nearer the OP);
2. two candidates of different datasets with the **same UOPID** are linked (both IMs usually declare the shared border point, EU00237 for Bjørnfjell / Vassijaure);
3. the remaining border points are linked to the nearest border point of another dataset within **300 m** (`routebook link --threshold <m>` changes it);
4. everything else is listed as *unmatched*: a border point with no partner, or without a position on the track network. The Datasets dialog shows the links per dataset and the unmatched list, which is worth reporting to the infrastructure managers.

Every link is derived by Routebook, not read from RINF, and the routebook says so: the strip gets an **Infrastructure manager change** item (quality *derived*) where the route passes the link, and the two networks' topologies are joined at that point at zero length. The app loads the bundles of every dataset the route runs through (up to six, chosen on a meso graph of the border links) and lists each dataset's publication in the footer and the print.

## Memory

A fetch holds one dataset in memory at a time; the sync processes them one after the other. Norway fits in Node's default heap. The largest networks (Germany, France) need more: the sync child inherits `NODE_OPTIONS` from the container's environment, so set `NODE_OPTIONS=--max-old-space-size=6144` or more for `ROUTEBOOK_DATASETS=all` (the public instance does, see `deploy/matdata/docker-compose.yml`). The sync log ends each pass with `peak memory N MB`: measure it on the first full run and give the container that much. Idle, the server and the sleeping sync need about 100 MB together.
