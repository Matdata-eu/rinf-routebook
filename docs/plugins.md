# Plugins

RouteBook's core (this repository, MIT) only uses public RINF data. Everything else, such as an
infrastructure manager's detailed speed profile, timetable-aware routing or a commercial module,
lives in a separate package that implements `RoutebookPlugin` from `@routebook/core-extensions`
and is loaded at runtime. A plugin never needs a fork of the core.

## What a plugin can add

```ts
import type { RoutebookPlugin } from "@routebook/core-extensions";

const plugin: RoutebookPlugin = {
  id: "acme",              // lower case, digits and "-"; also the namespace of its item kinds
  name: "Acme speed boards",
  version: "1.0.0",
  itemProviders: [{ id: "boards", fillsGaps: ["speedBoards"], provideItems: (ctx) => [...] }],
  overlays: [{ id: "works", getLayers: (ctx) => [{ id: "works", title: "Works", geojson }] }],
  costModels: [{ id: "acme-fastest", create: (snapshot) => costModel }],
};
export default plugin;
```

- **Item providers** add routebook items. Their kinds must be namespaced (`acme:board`); a
  provider that supplies one of the gaps the core lists (`RINF_GAPS`) declares it in `fillsGaps`,
  and the gap is then dropped from the routebook. Providers run in registration order; their
  items are merged into the core items and sorted by distance.
- **Overlays** are map layers as GeoJSON. In the web app each one becomes a source and a layer
  `plugin-<id>` under the route. `style` may be a MapLibre layer fragment (`{ type: "line",
  paint: {...} }`); without it, points are drawn as circles and anything else as lines.
- **Cost models** change which route is found. Pick one by id with `costModel` in config.json
  (web) or `--cost <id>` (CLI).

What a provider gets (`RouteContext`): the `snapshot`, the `route` (element steps) and the core
`routebook`. In the web app the snapshot is the expanded web bundle (geometry simplified to about
1 m); on a route across infrastructure managers it is the merged bundle of every dataset on the
way, and `datasets` lists them in travel order. Plugins must not change any of it.

A module may export one plugin, a list of them, or a function that returns either (it may be
async), as its default export or as `plugin` / `plugins`. A module that throws, or a provider
that fails, never takes the app down: in the web app the routebook is shown without the plugin's
items, with a note in the status line, and the error goes to the browser console.

## Web app

1. Build the plugin as one browser ES module (bundle its dependencies; the core packages are not
   shared at runtime, so a plugin only needs their types).
2. Put the file in the server's plugins folder: `<data>/plugins/` by default, or
   `ROUTEBOOK_PLUGINS_DIR`. The server serves it at `plugins/<file>`, also under a sub-path.
3. Name it in config.json:

   ```json
   { "plugins": ["plugins/acme.js"], "costModel": "acme-fastest" }
   ```

The Content-Security-Policy only allows scripts from the app's own origin, which is why plugins
are served by the deployment rather than from a CDN. With your own `contentSecurityPolicy` in
the configuration you can widen that, at your own risk.

[`examples/plugins/km-markers.js`](../examples/plugins/km-markers.js) is a working example with
no build step: copy it to `data/plugins/` and add `"plugins": ["plugins/km-markers.js"]`.

## CLI

```sh
pnpm routebook route NOOSL NODRM --plugin ./examples/plugins/km-markers.js
pnpm routebook route NOOSL NODRM --plugin @acme/routebook-plugin --cost acme-fastest
```

`--plugin` takes a path (relative to the working directory) or a package name and can be given
more than once.

## Licensing

Plugins are separate works: they may carry any licence, including a proprietary one, as long as
they only use the core through its published interface. The core never imports a plugin.
