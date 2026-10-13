# RINF data coverage: Norway (Bane NOR)

Checked on 2026-10-13 against the public ERA knowledge graph. This uses public RINF data only.

## Endpoint

| | |
|---|---|
| SPARQL endpoint | `https://graph.data.era.europa.eu/repositories/rinf-plus` (POST `query=`, no auth, `Accept: text/csv` or `application/sparql-results+json`) |
| Norway data | named graph `<http://data.europa.eu/949/graph/0076>` (one graph per IM code; about 1.59 M triples) |
| IM / country | `era:infrastructureManager <http://data.europa.eu/949/body/organisation/organisationRole/0076_IM>`, `era:inCountry <http://publications.europa.eu/resource/authority/country/NOR>` |
| Resource IRIs | `https://data.banenor.no/data/...` |
| Ontology | ERA ontology v3.3.4, in graph `<http://data.europa.eu/949/graph/rinf/ontology>` (SKOS concepts are in `.../graph/rinf/skos`) |

`https://graph.data.era.europa.eu/repositories/ERA-KG` returns **401**, so it isn't public. Use `rinf-plus`.

All queries are in [`queries/`](queries/), and the routing check is [`queries/route_test.py`](queries/route_test.py).

## Counts (Norway graph)

| Object | Class | Count |
|---|---|---|
| Operational points | `era:OperationalPoint` | 734 (402 station, 150 technical change, 132 passenger stop, 46 junction, 4 border point) |
| Sections of line | `era:SectionOfLine` | 717 |
| Tracks | `era:Track` | 3 660 (2 244 `era:RunningTrack`, 1 416 `era:Siding`) |
| Micro NetElements | `era:LinearElement` | 7 759 (5 322 km in total) |
| Meso NetElements | none | 0. There are no meso `era:LinearElement`s. OP/SoL geometries have IRIs named `_netelement_meso_*_geom`, but they are only geometry nodes |
| NetRelations | `era:NetRelation` | 12 884 (9 007 navigability `Both`, 3 877 `None`) |
| Signals | `era:Signal` | 5 291 |
| Switches | `era:Switch` | 3 568 |
| Km posts | `era:KilometricPost` | 8 805 (8 073 physical "Km merke" boards + 732 LRS reference posts) |
| Linear positioning systems | `era:LinearPositioningSystem` | 36 (= national lines B01–B40) |
| Tunnels / bridges | `era:Tunnel` / `era:Bridge` | 1 024 / 2 575 |
| Level crossings | `era:LevelCrossing` | 1 727 |
| Platform edges | `era:PlatformEdge` | 754 |

### How the levels are linked

- RINF has no `era:hasImplementation` and no meso-to-micro NetElement hierarchy, in Norway or in any other graph.
- **Each OP and SoL links straight to the micro topology** through `era:netReference` → `era:NetAreaReference` → `era:includes` (an rdf:List) → `era:NetLinearReference` → `startsAt` / `endsAt` → `era:TopologicalCoordinate` (`onLinearElement`, `offsetFromOrigin` in metres). 723/734 OPs (98.5 %) and 717/717 SoLs (100 %) have this.
- 636 OPs also have a `era:NetPointReference` (a centre point with a km coordinate).
- Every point and linear reference has both a topological coordinate (`hasTopoCoordinate`) and an LRS coordinate (`hasLrsCoordinate` → `era:kmPost` with `era:kilometer` + `era:offsetFromKilometricPost`). So the km position is available for each signal, switch, tunnel start/end and so on.
- In the meso layer, the SoL has `opStart`/`opEnd` (OP graph, 100 %), `era:hasPart` → running tracks, and `era:nationalLine` → line.

## Is OP-to-OP routing on the micro topology feasible? Yes

I tested this with `route_test.py`, using Dijkstra over (element, end) states. Element length is the cost. Only `Both` relations are followed, so the `None` relations (switch leg-to-leg) prevent U-turns at switches.

- No relation points to a missing element. 85 elements have no relations at all.
- There are 89 connected components. The largest one has 7 414 elements (**5 233 km, 98.3 % of the network**) and touches 711 of the 723 referenced OPs. The second one (254 elements) is the Ofotbanen (Narvik), which only connects to the rest of the network through Sweden. The others are small fragments.

| Route | Result (distance between OP area boundaries) |
|---|---|
| Oslo S → Lillestrøm | 9.43 km, 7 elements: via the Gardermobanen / Romeriksporten tunnel. 14 signals, 2 switches and 21 km posts are on the route elements |
| Oslo S → Drammen | 38.77 km, 67 elements; 108 signals, 44 switches, 54 km posts |
| Oslo S → Bergen | 454.5 km |
| Oslo S → Trondheim S | 543.8 km |
| Oslo S → Stavanger | 579.0 km |
| Trondheim S → Bodø | 725.3 km |
| Narvik → Oslo S | no route (expected: the line is cut off at the border) |

I checked the element lengths against the WKT geometry length, and they agree within about 0.5 %. The distances are measured between the **edges of the OP areas**, and Norwegian station areas are large. For example, the Lillestrøm area starts about 4 km before the platform. For the routebook, measure from the OP's `NetPointReference` (where present) or from a chosen platform or track instead.

Routing caveats:

- The `Both`/`None` navigability is the only movement restriction. There is no direction-of-travel restriction, no per-track usage (passenger/freight), and no information about which track is the "normal" one. Dijkstra therefore picks the shortest physical path, which may run through a station siding. A preference such as "use running tracks" or "use the main track" would need a cost on `era:RunningTrack` vs `era:Siding` membership (`Track.netReference` → linear location).
- `era:validity` is set on every element and relation (for example 2019-01-01 or 2024-12-10 to "no end known"). The app should filter by date.

## Routebook field coverage (Norway)

The fill is measured against the parent population that is shown.

| Routebook field | RINF class / property | Fill (Norway) | Notes |
|---|---|---|---|
| Line number + name | `era:SectionOfLine` `era:nationalLine` → `era:LinearPositioningSystem` `rdfs:label` | **100 %** (717/717 SoL) | Labels look like "B20-Drammensbanen". There are 30 lines in use (B01–B40). `era:lineNationalId` is not used |
| OP name / code / type | `era:opName`, `era:uopid`, `era:opType` | **100 %** (734) | The `uopid` is the NO code (NOOSL, NOLLS…). Junctions are explicit (46) |
| Signals: presence and position | `era:Signal` + `era:netReference` → `NetPointReference` (topo + km) | **100 %** (5 291) | Each signal has a position on a micro element and a km coordinate |
| Signals: direction / side | `NetPointReference` `era:appliesToDirection`; the side is only encoded in the IRI | **100 %** for direction | `era:signalOrientation` is not used (it is used in only 4 graphs EU-wide) |
| Signals: id | `rdfs:label`, e.g. "HS 4388B", "HsA(727)Skjelbred blp." | 100 % as label, **0 %** as `era:signalId` | The label contains the id, so it has to be parsed |
| Signals: type | `era:signalType` | **100 %** | Home 828, Exit 1 407, Intermediate 514, Block 412, Shunting 2 130. There are no distant/pre-signals or speed boards |
| Signals: geometry | `geo:hasGeometry` | 84 % (4 459) | This doesn't matter: the position can be derived from the topo coordinate |
| Km posts / linear positions | `era:KilometricPost` (`kmPostName`, `netReference`) + LRS coordinates on every reference | **100 %** | 8 073 physical km boards are on the topology. Every feature also has a km and an offset |
| Switches | `era:Switch` + `era:netReference` | 96.5 % positioned (3 443/3 568) | Label only (e.g. "Spv 246"). There is no switch type, no orientation and no diverging speed |
| Derailers / catch points | none | **0 %** | No such class exists in ERA ontology v3.3.4 |
| Branching points | derived from `era:NetRelation` (element ends with ≥ 2 navigable continuations) + switches + `opType` = junction | derivable | The topology is complete enough to detect them; see the routing section |
| Gradient | `era:RunningTrack` `era:gradientProfile` (string "‰(+km), …", e.g. `-9.0(+110.998), -4.7(+111.045)`) | 57 % of running tracks (1 282/2 244); **96.5 % of SoLs** (692/717) have at least one track with it | It is a free-text profile per track, keyed to line km, and the app has to parse it. `era:gradient` (a single value) is only on 61 sidings. The tracks without it are mostly station tracks |
| Tunnels | `era:Tunnel` (`tunnelIdentification`, `lengthOfTunnel`, `lineReferenceTunnelStart/End`) | **100 %** (1 024) | The start and end have topo and km coordinates. Some "tunnels" are overcrossings (IRI `_overcrossing_`), e.g. 56 m long |
| No-stop zones | `era:lengthOfNonStoppingArea` (on phase info) / `era:PhaseInfo` | **~0 %** | `lengthOfNonStoppingArea` isn't used anywhere. Only 15 `PhaseInfo` exist in Norway. RINF has no general "no-stop zone" concept |
| Max speed | `era:RunningTrack` `era:maximumPermittedSpeed` | 95.9 % of running tracks (2 152/2 244); **97.6 % of SoLs** (700/717) | There is **one value per track per SoL or station**. There are no speed sections, profiles or speed-board positions. 1 045 tracks have 40 km/h, which are mostly station tracks |
| Geometry for the map | `geo:hasGeometry/geo:asWKT` (WGS84 lon/lat) | OP 100 %, SoL 100 %, micro LinearElement 100 %, switch 99.5 %, tunnel/bridge/LC/platform 100 % | This is enough for both the meso and the micro map |
| Platforms | `era:PlatformEdge` (`platformId`, `lengthOfPlatform`, `platformHeight`) | 100 % (754) | |
| Level crossings | `era:LevelCrossing` | 100 % positioned (1 727) | Label only; there is no protection type |

## Top gaps for a routebook

1. **Speed is too coarse**: RINF only has one `maximumPermittedSpeed` per track per SoL. There are no speed restriction sections, no speed-board positions and no train-category speeds. A real routebook needs a speed profile along km.
2. **No derailers / catch points and no no-stop zones**: these concepts don't exist in RINF (ontology v3.3.4).
3. **Signals are thin**: there is no `signalId` property (the id is embedded in the label) and no distant/pre-signals or other boards. The side is only in the IRI. The position and direction are complete.
4. **Switches have no attributes**: no type, no orientation, no diverging-track speed. Branching has to be derived from the topology.
5. **Gradient is a string per track** keyed to line km. It can be parsed, but it isn't positioned on the topology, and station tracks are mostly missing it.
6. **No routing semantics**: there is no main/normal track and no permitted direction beyond `Both`/`None`. The app needs its own cost model, for example preferring running tracks over sidings.
7. **OP areas are large**: OP-to-OP distances need a reference point, such as `NetPointReference` (636/734 OPs) or a platform.

## Conclusion

Norway's public RINF data is good enough for the first feature:

- the meso map (OPs and SoLs with WKT, line numbers),
- routing between OPs on the micro topology (one connected network covering 98 % of the length, with clean `Both`/`None` navigability),
- a linear routebook showing km, signals (type and direction), switches, km boards, tunnels, bridges, level crossings, platforms, and a coarse gradient and speed.

The fields that are missing or weak are listed under the top gaps above: detailed speed profiles, derailers and catch points, no-stop zones, and switch attributes. These would need another data source later, for example an IM-specific feed or a commercial add-on.
