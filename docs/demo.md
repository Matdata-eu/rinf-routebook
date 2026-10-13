# Demo script

A 5-minute walkthrough for showing Routebook to someone.

## Before the demo

```bash
pnpm install
pnpm fetch:nor     # needs internet once; stores data/snapshots/nor and data/web/nor
pnpm demo          # builds and serves on http://127.0.0.1:4173
```

The demo routes completely offline, because the snapshot is bundled into `apps/web/dist`. Without internet you lose only the OpenStreetMap background and the station labels on the map. The railway lines, stations, routes and routebook all still work.

Tips:

- Use a wide window, or a tablet in portrait.
- Use **Print / PDF** to show the paper version.
- The URL holds the route (`?from=NOOSL&to=NODRM`), so you can bookmark the examples below.

## 1. Oslo S → Drammen (commuter line, about 40 km)

`http://127.0.0.1:4173/?from=NOOSL&to=NODRM`

1. Start with an empty route. Type `osl` in **From** and pick *Oslo S*. Then type `dram` in **To** and pick *Drammen*.
2. Point out that the route is computed on individual tracks (the micro topology), not just station-to-station lines, and it takes milliseconds.
3. Walk down the strip:
   - Line change *B20-Drammensbanen*, then *B30-Askerbanen* and back to B20.
   - The **speed band** changes at stations (40 km/h station tracks).
   - The **gradient band** (red = uphill, blue = downhill).
   - **Lieråstunnelen**: about 10.7 km, from 22.7 km to 33.4 km on the route.
4. Click a tunnel or signal row. The map pans to it.
5. Open **Not available in RINF**: the routebook is honest about what open data can't provide (speed profile, derailers, no-stop zones, …). This is where commercial modules can plug in later.

## 2. Oslo S → Bergen (long distance, about 455 km)

`http://127.0.0.1:4173/?from=NOOSL&to=NOBRG`

1. About 3 800 items over 455 km, computed in the browser in well under a second.
2. The shortest physical route runs via Gjøvikbanen and Roa–Hønefoss, which is not the usual passenger route via Drammen. This shows that routing follows the infrastructure only. Preferred routes and via points are on the roadmap.
3. Use **Show in routebook** to hide km posts and switches, which gives a compact long-distance view.

## 3. Trondheim S → Bodø (Nordlandsbanen, about 726 km)

`http://127.0.0.1:4173/?from=NOTND&to=NOBO`

1. The longest line in the network. It's a good way to show the gradient band across the mountains.
2. **Swap (⇅)** reverses the route. Gradient signs flip, and the signals now apply to the other direction.
3. Try *Narvik → Oslo S*. You get a clear error, because Ofotbanen is only connected to the rest of Norway through Sweden, and the Swedish data is not loaded.

## Talking points

- The open core is MIT and uses only public RINF data from ERA. Credit goes to Bane NOR as the data provider.
- Every routebook item says where it comes from: **R** = RINF, **D** = derived, **≈** = approximate, **!** = missing.
- Next steps: speed profiles, other countries, offline PWA.
