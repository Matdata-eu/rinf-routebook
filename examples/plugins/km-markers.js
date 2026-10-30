// An example RouteBook plugin: a marker every 10 km of the route, in the routebook and on the map.
// Plain JavaScript with no imports, so a deployment can serve it as it is: copy it to
// <data>/plugins/ and add "plugins": ["plugins/km-markers.js"] to config.json (see docs/plugins.md).
// MIT licence, like the rest of the repository.

const EVERY = 10_000; // metres

/** @type {import("@routebook/core-extensions").RoutebookPlugin} */
export default {
  id: "km-markers",
  name: "10 km markers",
  version: "1.0.0",
  license: "MIT",
  itemProviders: [
    {
      id: "markers",
      provideItems({ routebook }) {
        const items = [];
        for (let d = EVERY; d < routebook.length; d += EVERY) {
          // kinds a plugin adds are namespaced with its id
          items.push({ kind: "km-markers:marker", distance: d, label: `${d / 1000} km from the start`, quality: "derived" });
        }
        return items;
      },
    },
  ],
};
