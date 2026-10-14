#!/bin/sh
# Routebook container entry point.
#   serve (default)          fetch the datasets in ROUTEBOOK_DATASETS that are not in /data yet, then serve
#   routebook <args>         run the CLI, e.g. "routebook fetch --dataset BEL" or "routebook datasets"
#   anything else            run that command
set -e
cd /app

case "${1:-serve}" in
  serve) ;;
  routebook) shift; exec node apps/cli/dist/index.js "$@" ;;
  *) exec "$@" ;;
esac

# ROUTEBOOK_DATASETS: space or comma separated, e.g. "NOR" or "NOR,0088". ROUTEBOOK_REFRESH=1 fetches them again.
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
