# Credits

Routebook is created and maintained by Mathias Vanden Auweele ([Matdata](https://matdata.eu)) and released under the [MIT licence](LICENSE). It builds on the data and software below. Thank you to all of them.

## Data

| What | Source | Terms |
|---|---|---|
| RINF infrastructure data | © [European Union Agency for Railways](https://www.era.europa.eu/), [ERA knowledge graph](https://graph.data.era.europa.eu/) (`rinf-plus` endpoint), ERA ontology | ERA's terms of reuse. The data in each named graph is provided by the infrastructure manager concerned, e.g. **Bane NOR** for Norway. Name ERA and the infrastructure manager when you show the data; the app does this in its footer and map credits. |

Routebook does not ship RINF data: every deployment fetches it from the public endpoint.

## Map backgrounds

| Layer | Provider | Terms |
|---|---|---|
| Streets | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, tiles from tile.openstreetmap.org | ODbL data; the [tile usage policy](https://operations.osmfoundation.org/policies/tiles/) applies to the public tile servers. Use your own tile service for heavy production use. |
| Satellite | [EOxCloudless 2016](https://cloudless.eox.at) by EOX IT Services GmbH, contains modified Copernicus Sentinel data 2016 & 2017 | CC BY 4.0. Only the 2016 mosaic: later years are licensed for non-commercial use only. |
| Map label fonts | [MapLibre demo tiles](https://github.com/maplibre/demotiles) glyph server | Self-host the glyphs for production (`glyphs` in the configuration). |
| Your own layers | configured by the deployer | Between the deployer and the provider. |

## Software

| Project | Used for | Licence |
|---|---|---|
| [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js) | map, route and Drive view | BSD-3-Clause |
| [HiGHS](https://highs.dev/) via [highs-js](https://github.com/lovasoa/highs-js) | solving the schematic layout (WebAssembly) | MIT |
| [railplot](https://github.com/luteberget/railplot) by Bjørnar Luteberget | the schematic layout model (levels, edge order, port shapes) that `packages/schematic` ports to a mixed-integer program | MIT |
| [Vite](https://vite.dev/) | web build and dev server | MIT |
| [TypeScript](https://www.typescriptlang.org/) | language | Apache-2.0 |
| [Vitest](https://vitest.dev/) | tests | MIT |
| [Playwright](https://playwright.dev/) (`playwright-core`) | screenshots | Apache-2.0 |
| [Node.js](https://nodejs.org/) and [pnpm](https://pnpm.io/) | runtime and workspaces | MIT |

The complete dependency list with versions is in `pnpm-lock.yaml`.
