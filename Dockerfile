# syntax=docker/dockerfile:1

# Routebook: web app + RINF data fetcher + server, in one image.
# The output is JavaScript and WebAssembly only, so it is built once on the build
# platform and copied into the image of every target platform.
FROM --platform=$BUILDPLATFORM node:22-alpine AS build
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/cli/package.json apps/cli/
COPY apps/web/package.json apps/web/
COPY packages/core-extensions/package.json packages/core-extensions/
COPY packages/rinf-client/package.json packages/rinf-client/
COPY packages/routebook/package.json packages/routebook/
COPY packages/routing/package.json packages/routing/
COPY packages/schematic/package.json packages/schematic/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm build \
 && CI=true pnpm install --prod --frozen-lockfile --offline \
 && chmod -R a+rX /app

FROM node:22-alpine
LABEL org.opencontainers.image.title="Routebook" \
      org.opencontainers.image.description="Open-source railway routebook built on public ERA RINF data" \
      org.opencontainers.image.source="https://github.com/Matdata-eu/rinf-routebook" \
      org.opencontainers.image.documentation="https://github.com/Matdata-eu/rinf-routebook#readme" \
      org.opencontainers.image.licenses="MIT"
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    ROUTEBOOK_DATA_DIR=/data \
    ROUTEBOOK_CONFIG_FILE=/config/config.json \
    # use HTTP(S)_PROXY / NO_PROXY for the SPARQL endpoint and the tile proxy, when set
    NODE_USE_ENV_PROXY=1
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps/cli ./apps/cli
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY --from=build /app/scripts/serve.mjs /app/scripts/runtime-config.mjs ./scripts/
COPY docker/entrypoint.sh /usr/local/bin/routebook-entrypoint
RUN chmod 0755 /usr/local/bin/routebook-entrypoint \
 && rm -rf packages/*/src apps/cli/src \
 && mkdir -p /data /config && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=10m CMD wget -qO- "http://127.0.0.1:${PORT}/healthz" >/dev/null || exit 1
ENTRYPOINT ["routebook-entrypoint"]
CMD ["serve"]
