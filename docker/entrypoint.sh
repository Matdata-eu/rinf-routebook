#!/bin/sh
# Routebook container entry point.
#   serve (default)          serve the app; the server runs "routebook sync" next to itself, which fetches
#                            the datasets in ROUTEBOOK_DATASETS and keeps them current (ROUTEBOOK_SYNC_MINUTES,
#                            default 60). With ROUTEBOOK_SYNC_MINUTES=0 the datasets that are not in /data
#                            yet are fetched once, before the server starts.
#   routebook <args>         run the CLI, e.g. "routebook fetch --dataset BEL" or "routebook datasets"
#   anything else            run that command
set -e
cd /app

case "${1:-serve}" in
  serve) ;;
  routebook) shift; exec node apps/cli/dist/index.js "$@" ;;
  *) exec "$@" ;;
esac

if [ "${ROUTEBOOK_SYNC_MINUTES:-60}" != "0" ]; then
  if [ -z "$(ls -A "$ROUTEBOOK_DATA_DIR/web" 2>/dev/null)" ]; then
    echo "No RINF data in $ROUTEBOOK_DATA_DIR yet: the sync fetches ${ROUTEBOOK_DATASETS:-nothing (set ROUTEBOOK_DATASETS, e.g. NOR)} while the server starts; the app lists the datasets as pending until then."
  fi
  if [ "${ROUTEBOOK_REFRESH:-0}" = "1" ]; then
    echo "ROUTEBOOK_REFRESH=1: fetching ${ROUTEBOOK_DATASETS:-the datasets in the catalogue} again before the server starts..."
    node apps/cli/dist/index.js sync --once --force || echo "Could not fetch the RINF data; starting with the data that is there." >&2
  fi
  exec node scripts/serve.mjs apps/web/dist
fi

# ROUTEBOOK_DATASETS: space or comma separated, e.g. "NOR" or "NOR,0088", or "all" for every RINF
# dataset on the endpoint. ROUTEBOOK_REFRESH=1 fetches them again.
if [ "$(echo "${ROUTEBOOK_DATASETS:-}" | tr 'A-Z' 'a-z')" = "all" ]; then
  if [ "${ROUTEBOOK_REFRESH:-0}" = "1" ] || [ ! -f "$ROUTEBOOK_DATA_DIR/web/datasets.json" ]; then
    echo "Fetching every RINF dataset (this takes a while: one country after the other)..."
    node apps/cli/dist/index.js fetch-all || echo "Could not fetch the RINF data; starting with the data that is there." >&2
  fi
  ROUTEBOOK_DATASETS=""
fi
for ds in $(echo "${ROUTEBOOK_DATASETS:-}" | tr ',' ' '); do
  id=$(echo "$ds" | tr 'A-Z' 'a-z')
  if [ "${ROUTEBOOK_REFRESH:-0}" = "1" ] || [ ! -f "$ROUTEBOOK_DATA_DIR/web/$id/meta.json" ]; then
    echo "Fetching RINF dataset $ds (this takes a minute or two per country)..."
    node apps/cli/dist/index.js fetch --dataset "$ds" || echo "Could not fetch $ds; starting with the data that is there." >&2
  fi
done

if [ -z "$(ls -A "$ROUTEBOOK_DATA_DIR/web" 2>/dev/null)" ]; then
  echo "No RINF data in $ROUTEBOOK_DATA_DIR yet. Set ROUTEBOOK_DATASETS (e.g. NOR) or run: docker compose run --rm routebook routebook fetch --dataset NOR" >&2
fi
exec node scripts/serve.mjs apps/web/dist
