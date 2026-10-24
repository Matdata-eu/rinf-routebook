/**
 * The Help dialog: a short user guide, one foldable section per topic, as in RINF Atlas.
 * Controls are named by their label, not by where they sit, so the guide survives layout changes.
 * It also says what a route is based on and what a dataset needs in RINF for Routebook to work.
 */
import { MIN_SIGNALS_PER_KM } from "./datasets.js";

let dialog: HTMLDialogElement | undefined;

type Part = string | Node;

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls: string | undefined, ...children: Part[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  e.append(...children);
  return e;
}

const b = (text: string) => el("strong", undefined, text);
const code = (text: string) => el("code", undefined, text);

function section(title: string, open: boolean, ...items: Part[][]): HTMLDetailsElement {
  const d = el("details", "help-sec", el("summary", undefined, title), el("ul", undefined, ...items.map((parts) => el("li", undefined, ...parts))));
  d.open = open;
  return d;
}

export function openHelp(opts: { onDatasets?: () => void } = {}): void {
  if (!dialog) {
    dialog = el("dialog", "help-dialog");
    dialog.setAttribute("aria-labelledby", "help-title");
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog!.close();
    });
    const close = el("button", "btn icon", "×");
    close.type = "button";
    close.title = "Close";
    close.setAttribute("aria-label", "Close");
    close.addEventListener("click", () => dialog!.close());
    const datasetsLink = el("button", "link", "Datasets");
    datasetsLink.type = "button";
    datasetsLink.addEventListener("click", () => {
      dialog!.close();
      opts.onDatasets?.();
    });
    const title = el("h2", undefined, "How to use RouteBook");
    title.id = "help-title";
    dialog.append(
      el("header", "help-head", title, close),
      el(
        "div",
        "help-body",
        el("p", "muted", "RouteBook computes a train route between two operational points on the track network that infrastructure managers publish in the EU Register of Infrastructure (RINF), and lists what a driver meets along it. Open a topic below."),
        section(
          "Choosing a route",
          true,
          ["Click an operational point on the map: the first click is the ", b("origin"), ", the second the ", b("destination"), ". With a route on the map, the next click starts a new route from the point you clicked."],
          ["Or type a station name or code in ", b("From"), " and ", b("To"), ". ", b("⇅"), " swaps them and ", b("Clear"), " removes the route."],
          [b("Grey points"), " have no position on the track network in RINF: a route cannot start or end there. They are on the map so you can see where RINF knows a station but not the track it is on."],
          ["With several networks, ", b("Network"), " limits the map and the search to one of them. ", b("All networks"), " shows every dataset; a route may cross a border where the two infrastructure managers' border points meet."],
          ["The address bar always holds the current route, view and map layers: copy it to share exactly this view."],
        ),
        section(
          "How the route is found",
          false,
          ["The route runs on RINF's ", b("micro topology"), ": the linear elements (pieces of track, ", code("era:LinearElement"), ") and the net relations that say which ends join and whether a train can pass (", code("era:NetRelation"), ", navigability ", code("Both"), ")."],
          ["Each end of the route is where RINF puts the operational point on that network: its net reference (", code("era:netReference"), ", a point or an area on one or more linear elements)."],
          ["Among all connected paths, RouteBook takes the shortest, with a preference for running tracks over sidings. It is not a timetabled path: it may differ from the route a train would actually be given."],
          ["Between two networks, RINF has no net relations, so RouteBook joins them itself where both infrastructure managers declare the same border point, or two border points lie close together. The routebook marks where the route crosses."],
        ),
        section(
          "The routebook",
          false,
          ["The panel lists, in order of distance, what the route meets: national lines, speed, gradient, operational points, tunnels, signals, switches, level crossings, kilometre posts, phase and system separations, and where a section parameter changes (energy, class B, ETCS, GSM-R, gauge). ", b("Show in routebook"), " chooses which kinds to list."],
          ["Each row says where its value comes from: taken from RINF, derived by RouteBook, approximate, or missing. Missing data is listed rather than guessed."],
          [b("Section parameters on this route"), " shows, per parameter, how much of the route RINF gives a value for, and why it does not elsewhere: the infrastructure manager declares it ", b("not applicable"), " or ", b("not yet available"), ", or RINF does not say (", b("not published"), ")."],
          ["Click a row to see the spot on the map or in the schematic. ", b("Print / PDF"), " gives a paper routebook with the data credit and the RINF publication it was made from."],
        ),
        section(
          "Map, Schematic, Strip and Drive",
          false,
          [b("Map"), ": the route over the network. The ", b("Map layers"), " button next to the zoom buttons switches the background and adds overlays: ", b("OpenRailwayMap"), " draws the railway infrastructure from OpenStreetMap over the map, in the Map and in the Drive view."],
          ["Whoever runs this site may add their own backgrounds and overlays to that menu, such as aerial photos."],
          [b("Schematic"), ": the route as a straight line with every track around it in its own lane. Zoom with the buttons or Ctrl / Cmd + mouse wheel."],
          [b("Strip"), ": the route as vertical bands like a paper route book: kilometres, gradient, speed, energy, class B, ETCS, GSM-R, tunnels and separations, the operational points, signals and changes, and the times. Choose 2 to 60 km per screen, ahead up or down, and ", b("Run"), " a train that the strip follows. Hatched means not published, dotted not yet available, grey not applicable."],
          ["Click the strip for the ", b("section card"), ": every parameter in force there, with its RINF state. Set ", b("Departs"), " for clock times (without it the times count from the start), and click an operational point's time to stop there or pass it. The times come from the Drive train at the RINF maximum speeds, with a minute at each stop: a rough guide, not a running-time calculation."],
          [b("Drive"), ": follow a train along the route, satnav style. Play, pause and drag the slider; the routebook scrolls along."],
          ["The theme button switches between light and dark."],
        ),
        section(
          "What RINF must contain",
          false,
          ["RouteBook works on any RINF dataset, but only as well as the data allows. A dataset needs:"],
          [b("Linear elements and net relations"), ": without a micro topology there is nothing to route on, and without net relations the pieces of track are not connected."],
          [b("Operational points on the topology"), ": a net reference from each operational point to the linear elements it lies on. Points without one appear grey on the map and cannot be an end of a route."],
          [b("A geometry"), " for operational points and sections of line (", code("geo:hasGeometry"), " on the point or on its net reference), to draw them on the map; and one per linear element to draw the route itself."],
          [b("Signals"), " and the other track-side elements with a position on the linear elements, for a useful routebook. A dataset counts as ready from ", `${MIN_SIGNALS_PER_KM}`, " signals per kilometre of track; Norway has about one."],
          ["Speeds, gradients, tunnels, switches, level crossings and kilometre posts come from the same data when it is there; the routebook says what is missing."],
          ["The ", datasetsLink, " button lists every dataset with its ", b("Routing"), " state: ", b("Ready"), ", ", b("Few signals"), " (routes work, the routebook is thin), or ", b("⚠"), " when routing is not possible and why. Missing data is best reported to the infrastructure manager."],
        ),
        section(
          "Datasets and updates",
          false,
          ["RouteBook keeps a copy of each RINF dataset and checks ERA regularly for new publications. The ", b("Datasets"), " dialog says when each was published by ERA and fetched here, and whether the last update worked."],
          ["The footer and the printed routebook name the RINF publication the route was made from."],
        ),
      ),
    );
    document.body.append(dialog);
  }
  dialog.showModal();
}
