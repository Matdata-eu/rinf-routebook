# The public instance: routebook.matdata.eu

This folder is the configuration of the public demo that [Matdata](https://matdata.eu) runs, next to [RINF Atlas](https://rinf-atlas.matdata.eu), with the complete RINF data. It is here so that the configuration and the privacy statement are versioned and reviewable, and as an example of a complete deployment. Deployers of their own instance: start from [docs/deployment.md](../../docs/deployment.md) and replace the publisher and the privacy statement with yours.

| File | What |
|---|---|
| `docker-compose.yml` | the image from `ghcr.io/matdata-eu/rinf-routebook`, every dataset (`ROUTEBOOK_DATASETS=all`) kept current by the hourly sync, a bigger heap for the largest networks, the data in a volume, the port bound to localhost for the reverse proxy |
| `config.json` | title, Esri World Imagery as the default background (`aerial`, through the tile proxy with the key from `.env`), the disclaimer naming Matdata, the privacy statement, the links into RINF Atlas |
| `privacy.html` | the privacy statement: Matdata as publisher and host, the map providers, no tracking |
| `.env.example` | `ESRI_API_KEY` and the host port |

## Running it

```bash
git clone https://github.com/Matdata-eu/rinf-routebook.git
cd rinf-routebook/deploy/matdata
cp .env.example .env                 # ESRI_API_KEY
docker compose up -d
curl -s http://127.0.0.1:8081/healthz
```

The server answers at once; the sync fetches the datasets one after the other, a few hours for all of RINF (`docker compose logs -f` shows each dataset and, at the end of each pass, the peak memory). The app lists each dataset as *Fetching* until it is there, and `/healthz` counts `loaded`, `pending` and `failed`.

The reverse proxy that fronts RINF Atlas gets one more virtual host with TLS, forwarding `routebook.matdata.eu` to `127.0.0.1:8081` with the `Accept-Encoding` header passed through (the bundles are served precompressed); see [Behind a reverse proxy](../../docs/deployment.md#behind-a-reverse-proxy). Nothing in the proxy needs to cache: the server sets the cache headers and ETags itself.

## Updating

```bash
docker compose pull && docker compose up -d
```

The data stays in the `routebook-data` volume; a new image does not refetch it. The sync picks up new ERA publications on its own. Watch `/healthz` (`failed` above zero means a dataset's last fetch failed; the previous data stays on offer) and the container's health, which Docker checks every 30 s.
