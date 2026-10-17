# Deploying Routebook

Routebook is one small Node.js server. It serves the web app, the RINF data bundles, a runtime configuration and, optionally, a tile proxy for map layers that need a key. The easiest way to run it is the Docker image.

- [Docker Compose](#docker-compose)
- [Docker without Compose](#docker-without-compose)
- [Choosing the RINF data](#choosing-the-rinf-data)
- [Map layers](#map-layers) (your own satellite imagery, orthophotos, WMS overlays)
- [Privacy statement](#privacy-statement)
- [All settings](#all-settings)
- [Without Docker](#without-docker)
- [Behind a reverse proxy](#behind-a-reverse-proxy)
- [GitHub Pages (static)](#github-pages-static)

## Docker Compose

```bash
git clone https://github.com/Matdata-eu/rinf-routebook.git
cd rinf-routebook
cp .env.example .env                      # optional: datasets, port, keys
mkdir -p config && cp config.example.json config/config.json   # optional: your own map layers
docker compose up -d
```

Open <http://localhost:8080>. On the first start the container fetches the datasets in `ROUTEBOOK_DATASETS` (Norway by default) from the public ERA SPARQL endpoint into the `routebook-data` volume. That takes a minute or two per country; the logs show the progress (`docker compose logs -f`). Later starts reuse the data.

The image is published as `ghcr.io/matdata-eu/rinf-routebook` (tags: `latest` and `x.y.z` for releases, `edge` for the main branch). `docker compose build` builds it from the source instead.

Update the data, for example monthly:

```bash
docker compose run --rm routebook routebook fetch --dataset NOR
```

or set `ROUTEBOOK_REFRESH=1` for one restart. The server picks up new data without a restart; browsers load it on their next visit.

## Docker without Compose

```bash
docker run -d --name routebook -p 8080:8080 \
  -e ROUTEBOOK_DATASETS=NOR \
  -v routebook-data:/data \
  -v "$PWD/config:/config:ro" \
  ghcr.io/matdata-eu/rinf-routebook:latest
```

The container runs as the unprivileged `node` user (uid 1000): a host folder mounted on `/data` instead of a volume must be writable for it (`chown 1000 <folder>`). `/data` holds the RINF data, `/config/config.json` the optional configuration. `GET /healthz` answers `{"ok":true}` for health checks.

## Choosing the RINF data

The ERA knowledge graph holds one named graph per infrastructure manager (IM). A *dataset* in Routebook is one or more of those graphs, shown as one network. Each dataset gets its own entry in the **Network** picker of the app.

| `ROUTEBOOK_DATASETS` / `--dataset` | Fetches |
|---|---|
| `NOR` (any ISO 3166-1 alpha-3 code) | the graphs whose operational points are mainly in that country, looked up on the endpoint |
| `0076` (an IM code) | that one graph |
| `http://data.europa.eu/949/graph/0076` | that one graph |
| `all` | every dataset on the endpoint, one per country (`routebook fetch-all`) |

List what the endpoint has:

```bash
docker compose run --rm routebook routebook datasets
```

Combine graphs into one dataset with your own id, name and data credit:

```bash
docker compose run --rm routebook routebook fetch --dataset benelux --graph 0088 --graph 0084 --name Benelux --im "Infrabel, ProRail"
```

### Which dataset the app is working on

Every fetch records what ERA published for each named graph of the dataset: the infrastructure manager, the ERA dataset id and file name, the publication date and the triple count, read from the [RINF dataset explorer](https://rinf.data.era.europa.eu) API and the repository (the same calls [RINF Atlas](https://github.com/Matdata-eu/rinf-atlas) makes). The app shows it:

- the **Datasets** button at the top right names the network shown and its ERA publication date, with a `loaded/listed` count when there are several datasets; it opens a dialog with every dataset, its infrastructure manager, publication date, dataset id, fetch time, status (up to date, update failed with the error, removed from ERA) and a link into RINF Atlas;
- the footer, printed with every routebook, says which dataset and publication the routebook is based on.

The list is `datasets.json` in the data folder, written by `routebook fetch`, `fetch-all` and `index`. A dataset whose fetch failed keeps its previous bundle on offer and is marked failed until a fetch succeeds; a dataset no longer on the endpoint is marked removed. `ROUTEBOOK_DATASETS_API` (or `--datasets-api`) points at another dataset explorer, `none` skips it; `atlasUrl` in the configuration points the links at your own RINF Atlas, `false` removes them.

Data quality differs a lot per country: Routebook needs the micro topology (`era:LinearElement` and `era:NetRelation`) to route. Norway has been checked in detail, see [data-coverage-norway.md](data-coverage-norway.md); for other countries, run the queries in [`docs/queries`](queries) and tell us what you find in an issue.

## Map layers

Out of the box the app offers two backgrounds that need no key and allow commercial use: **Streets** (OpenStreetMap, fine for testing, but see the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) for production) and **Satellite** (Sentinel-2 cloudless 2016 by EOX, 10 m pixels, CC BY 4.0).

Many organisations have sharper imagery of their own, usually behind an API key. A configured imagery background takes the place of the built-in Satellite layer (which only stays when `builtinBasemaps` names it), so the map offers one aerial button, the sharp one. Add it in `config/config.json` (see [`config.example.json`](../config.example.json)):

```json
{
  "defaultBasemap": "ortho",
  "basemaps": [
    {
      "id": "ortho",
      "label": "Orthophoto",
      "tiles": ["https://tiles.example.org/ortho/{z}/{x}/{y}.jpg?apikey=${ORTHO_API_KEY}"],
      "maxzoom": 20,
      "attribution": "© Example orthophoto provider",
      "proxy": true
    }
  ],
  "overlays": [
    {
      "id": "catenary",
      "label": "Catenary",
      "tiles": ["https://wms.example.org/wms?SERVICE=WMS&REQUEST=GetMap&VERSION=1.3.0&LAYERS=catenary&STYLES=&CRS=EPSG:3857&BBOX={bbox-epsg-3857}&WIDTH=256&HEIGHT=256&FORMAT=image/png&TRANSPARENT=true",
      "opacity": 0.8
    }
  ]
}
```

and put the key in `.env`:

```bash
ORTHO_API_KEY=your-key
```

**Keys stay on the server.** `${NAME}` (or `${NAME:-default}`) in any string of the configuration is replaced by the environment variable `NAME` when the server starts, so the configuration file can be shared without the key. With `"proxy": true` the browser asks the Routebook server for `tiles/<id>/{z}/{x}/{y}` and the server fetches the tile from the provider with the key and the headers; the key never reaches the browser. Without `proxy`, the URL and headers are sent to the browser as they are: use that only for services without a key, or with a key that is restricted to your domain.

The proxy only fetches the layers in the configuration, and with `bounds` only the tiles inside them, but anyone who can open your Routebook can use it to view those tiles. Put Routebook behind your organisation's sign-in if the provider's terms require that, and check that the terms allow a server to fetch tiles on behalf of your users.

**Esri World Imagery** has a shortcut: set `ESRI_API_KEY` (an [ArcGIS Location Platform](https://location.arcgis.com) API key with the Basemaps privilege) and an **Aerial** background appears, proxied.

### Layer fields

`basemaps` appear as buttons next to the built-in backgrounds; one is shown at a time. `overlays` are toggled on and off on top of the background, under the railway lines.

| Field | Meaning |
|---|---|
| `id` | Letters, digits, `-` and `_`. Used in the URL (`?base=ortho`, `?layers=catenary`). A basemap with the id `map` or `satellite` replaces that built-in. |
| `label` | Button text (default: the id). |
| `tiles` | One or more URL templates (several are used in turn). Placeholders: `{z}`, `{x}`, `{y}`, `{quadkey}` (Bing style) and `{bbox-epsg-3857}` (WMS `GetMap` in Web Mercator). WMTS works through its REST/KVP template, e.g. `.../{z}/{y}/{x}.png`. |
| `tileSize` | `256` (default) or `512`. |
| `minzoom`, `maxzoom` | Zoom range of the service (default maxzoom 19); the map zooms further by scaling the last level. |
| `scheme` | `xyz` (default) or `tms` (y counted from the bottom). |
| `bounds` | `[west, south, east, north]` in degrees: no tile requests outside it. |
| `attribution` | Credit shown on the map (HTML allowed). Most providers require one. |
| `imagery` | `true` draws the railway lines light, for dark aerial imagery. Default `true` for basemaps, `false` for overlays. |
| `opacity` | 0–1. |
| `paint` | Extra [MapLibre raster paint](https://maplibre.org/maplibre-style-spec/layers/#raster) properties, e.g. `{"raster-saturation": -0.5}`. |
| `headers` | HTTP headers for the tile requests, e.g. `{"Authorization": "Bearer ${TOKEN}"}`. Sent by the server with `proxy`, by the browser without. |
| `proxy` | `true`: the server fetches the tiles (see above). |
| `visible` | Overlays only: switched on when the app opens. |

Other top-level fields:

| Field | Meaning |
|---|---|
| `title` | App title in the header and the browser tab. |
| `defaultDataset` | Dataset opened when the URL has none, e.g. `"nor"`. |
| `defaultBasemap` | Background opened when the URL has none, e.g. `"ortho"`. |
| `builtinBasemaps` | `true` (default), `false` to hide Streets and Satellite, or a list such as `["map"]`. |
| `glyphs` | Font URL template for the station labels (MapLibre `glyphs`); the default is the MapLibre demo server. Self-host it for production or offline use. |
| `privacy` | Privacy statement, see [Privacy statement](#privacy-statement). |
| `examples` | Example routes on the start panel per dataset: `{"bel": [{"from": "BEBRU", "to": "BEANT", "label": "Brussels → Antwerp"}]}`. |
| `disclaimer` | Demo disclaimer, see [Disclaimer](#disclaimer): `{ "publisher": "..." }`, custom wording, or `false`. |
| `atlasUrl` | RINF Atlas instance the Datasets dialog links to (default `https://rinf-atlas.matdata.eu`); `false` for no links. |

## Disclaimer

The app ships with a demo disclaimer: a hazard-striped banner at the top ("Demo environment: not for operational use ..."), a notice the user acknowledges once per wording, and a stamp on every printed routebook. It says that the RINF data is shown as ERA publishes it, without warranty, and that the publisher of the site is not responsible for it. Name yourself as the publisher, or change the wording, in `config/config.json`:

```json
{ "disclaimer": { "publisher": "Matdata" } }
{ "disclaimer": { "banner": "Test instance of Example Rail", "title": "Internal test", "text": ["First paragraph.", "Second paragraph."], "print": "TEST INSTANCE" } }
{ "disclaimer": false }
```

Switching it off makes the disclaimer yours to give. Changing the wording asks every user to acknowledge the notice again.

## Privacy statement

When you run Routebook for others, you are responsible for its privacy statement. Set one and a **Privacy** link appears in the footer of the app. In `config/config.json`, one of:

```json
{ "privacy": { "url": "https://example.org/privacy" } }
{ "privacy": { "file": "privacy.html" } }
{ "privacy": { "text": "Routebook does not use cookies. ...", "label": "Privacy notice" } }
```

- `url` links to a page you host elsewhere.
- `file` (relative to the configuration file, so `config/privacy.html` next to `config/config.json`) and `text` are served by Routebook as `privacy.html`. HTML is used as it is (a fragment gets a simple page around it, a full document is served unchanged); plain text becomes paragraphs.
- `label` changes the link text (default `Privacy`).

The shortcuts `ROUTEBOOK_PRIVACY_URL` and `ROUTEBOOK_PRIVACY_FILE` do the same from the environment.

What the software itself does, as input for your statement (check it against your own deployment, proxy and hosting):

- No accounts, no cookies, no analytics or tracking. The routebook filter choices are kept in the browser's local storage.
- The Routebook server keeps no logs of its own beyond start-up messages and tile proxy errors; your reverse proxy or hosting may log requests.
- The browser loads map tiles and label fonts directly from their providers (by default OpenStreetMap, EOX and the MapLibre demo font server), which see the user's IP address and the map area viewed. Layers with `"proxy": true` are fetched by your server instead, so the provider sees the server, not the user.
- The RINF data is fetched by the server from the ERA endpoint; the browser does not contact ERA.

## All settings

Environment variables of the server and the container:

| Variable | Default | Meaning |
|---|---|---|
| `ROUTEBOOK_DATASETS` | `NOR` in Compose, none in the image | Datasets to fetch on start when they are not there yet (comma or space separated). |
| `ROUTEBOOK_REFRESH` | `0` | `1` fetches them again on start. |
| `ROUTEBOOK_DEFAULT_DATASET` | first dataset | Same as `defaultDataset`. |
| `ROUTEBOOK_TITLE` | `Routebook` | Same as `title`. |
| `ROUTEBOOK_DEFAULT_BASEMAP` | first background | Same as `defaultBasemap`. |
| `ESRI_API_KEY` | none | Adds the proxied Esri World Imagery background. |
| `ROUTEBOOK_PRIVACY_URL`, `ROUTEBOOK_PRIVACY_FILE` | none | Privacy statement link or file, see [above](#privacy-statement). |
| `ROUTEBOOK_CONFIG_FILE` | `/config/config.json` in the image, `./config.json` otherwise | The configuration file. |
| `ROUTEBOOK_CONFIG` | none | The configuration as JSON in one variable; its keys replace those of the file. |
| `ROUTEBOOK_DATA_DIR` | `/data` in the image, `./data` otherwise | RINF snapshots (`snapshots/<id>`) and web bundles (`web/<id>`). |
| `ROUTEBOOK_SPARQL_ENDPOINT` | `https://graph.data.era.europa.eu/repositories/rinf-plus` | SPARQL endpoint for `fetch` and `datasets`. |
| `ROUTEBOOK_DATASETS_API` | the explorer of the endpoint (`https://rinf.data.era.europa.eu/api/v1`) | ERA dataset explorer API, for the publication date and id of each dataset; `none` skips it. |
| `PORT`, `HOST` | `8080`, `0.0.0.0` in the image | Where the server listens. |
| `HTTPS_PROXY`, `NO_PROXY` | none | Outgoing proxy for the SPARQL endpoint and the tile proxy (the image sets `NODE_USE_ENV_PROXY=1`). |
| `ROUTEBOOK_PORT`, `ROUTEBOOK_VERSION` | `8080`, `latest` | Compose only: host port and image tag. |

## Without Docker

Requirements: Node.js 22 or later and pnpm 10.

```bash
pnpm install
pnpm build
pnpm routebook fetch --dataset NOR      # once; writes data/snapshots/nor and data/web/nor
PORT=8080 node scripts/serve.mjs apps/web/dist
```

The server reads `config.json` from the working directory (or `ROUTEBOOK_CONFIG_FILE`). `pnpm dev:web` uses the same `config.json` at the repository root, so you can try map layers while developing.

The built app (`apps/web/dist`) can also be put on any static host: see [GitHub Pages (static)](#github-pages-static).

## Behind a reverse proxy

All URLs in the app are relative, so it can be served under a sub-path (`https://example.org/routebook/`). Forward the whole path; for example with nginx:

```nginx
location /routebook/ {
    proxy_pass http://127.0.0.1:8080/;
}
```

Responses for hashed assets carry long cache headers, the rest `no-cache`. The data bundles are a few MB per country; enable gzip in the proxy or let the Routebook server compress them (it does when the client asks).

## GitHub Pages (static)

The public demo, https://matdata-eu.github.io/rinf-routebook/, is published by [Matdata](https://matdata.eu) with the workflow [`.github/workflows/pages.yml`](../.github/workflows/pages.yml). Every Monday, and when run by hand, it:

1. fetches every RINF dataset on the endpoint (`routebook fetch-all`; a country that fails is reported in the run summary and left out),
2. builds the web app, which copies the data bundles into `apps/web/dist`,
3. writes the static `config.json`, `privacy.html` and `datasets.json` with `node scripts/build-static.mjs apps/web/dist`, from [`deploy/github-pages/config.json`](../deploy/github-pages/config.json),
4. deploys the result to GitHub Pages.

The privacy statement of the demo is [`deploy/github-pages/privacy.html`](../deploy/github-pages/privacy.html): Matdata as the publisher, GitHub as the host, and the map tile and font providers the browser contacts. Keep it up to date when the site changes (new map layers, analytics, ...).

To run it in a fork: set **Settings > Pages > Source** to **GitHub Actions**, replace the files in `deploy/github-pages/` with your own (your name in the privacy statement), and run the workflow. To try a few countries first, run it by hand with e.g. `NOR,BEL` as datasets.

A static site has no server, so there is no tile proxy: layers with `"proxy": true` are left out, and everything in `config.json` is public. Do not put keys in it. Also check that publishing the RINF data fits ERA's reuse conditions for your use.
