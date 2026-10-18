/**
 * The Datasets dialog: every RINF dataset the deployment knows, what ERA
 * published for it (infrastructure manager, publication date, dataset id),
 * when it was fetched and whether the last update worked. Modelled on the
 * Datasets dialog of RINF Atlas, which links from here.
 */
import type { NetworkBordersIndex } from "@routebook/rinf-client/network-index";
import { atlasLink, fmtDate, imNames, latestOf, loadable, type DatasetCatalogue, type DatasetInfo } from "./datasets.js";

export interface DatasetsDialogOptions {
  /** The dataset shown in the app, when it is limited to one. */
  current?: string;
  /** Base URL of a RINF Atlas instance for the "Atlas" links, or false for none. */
  atlasUrl?: string | false;
  /** The border links between the datasets, for the "Border links" column and the unmatched list. */
  borders?: NetworkBordersIndex;
  /** Called when the user opens another dataset. */
  onOpen: (id: string | undefined) => void;
}

const STATUS: Record<NonNullable<DatasetInfo["status"]>, string> = { loaded: "Up to date", stale: "Newer data published", pending: "Fetching", failed: "Update failed", removed: "Removed from ERA" };
/** The signal aspect each status shows (MatData SignalStatus: go, caution, stop). */
const ASPECT: Record<NonNullable<DatasetInfo["status"]>, "go" | "caution" | "stop"> = { loaded: "go", stale: "caution", pending: "caution", failed: "stop", removed: "caution" };

type SortKey = "name" | "im" | "publishedAt" | "fetchedAt" | "status" | "ops" | "borders";

let dialog: HTMLDialogElement | undefined;
let sortKey: SortKey = "name";
let sortDesc = false;
let needle = "";

function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Record<string, string | boolean | undefined> = {}, ...children: Array<Node | string | undefined>): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") el.className = String(v);
    else if (k === "text") el.textContent = String(v);
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children) if (c !== undefined) el.append(c);
  return el;
}

function statusOf(d: DatasetInfo): NonNullable<DatasetInfo["status"]> {
  return d.status ?? "loaded";
}

function sorted(list: DatasetInfo[], borders?: NetworkBordersIndex): DatasetInfo[] {
  const key = (d: DatasetInfo): string | number => {
    switch (sortKey) {
      case "borders": return borders?.datasets[d.id]?.links ?? 0;
      case "im": return imNames(d).toLowerCase();
      case "publishedAt": return d.publishedAt ?? "";
      case "fetchedAt": return d.fetchedAt ?? "";
      case "status": return ["failed", "pending", "stale", "removed", "loaded"].indexOf(statusOf(d));
      case "ops": return d.ops ?? 0;
      default: return d.name.toLowerCase();
    }
  };
  return [...list].sort((a, b) => {
    const x = key(a), y = key(b);
    const c = typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
    return (sortDesc ? -c : c) || a.name.localeCompare(b.name);
  });
}

function render(catalogue: DatasetCatalogue, opts: DatasetsDialogOptions): void {
  if (!dialog) return;
  const body = dialog.querySelector<HTMLElement>(".ds-body")!;
  body.replaceChildren();
  const q = needle.trim().toLowerCase();
  const rows = sorted(catalogue.datasets, opts.borders).filter((d) => !q || `${d.name} ${d.id} ${imNames(d)} ${d.graphs?.map((g) => `${g.imCode} ${g.country ?? ""} ${g.datasetId ?? ""}`).join(" ") ?? ""}`.toLowerCase().includes(q));
  const head = (label: string, key: SortKey, cls = "") =>
    h("th", { class: `${cls}${sortKey === key ? (sortDesc ? " sorted desc" : " sorted") : ""}`, scope: "col" }, h("button", { type: "button", text: label, "aria-label": `Sort by ${label}` }));
  const table = h(
    "table",
    { class: "ds-table" },
    h("thead", {}, h("tr", {}, head("Network", "name"), head("Infrastructure manager", "im"), head("ERA publication", "publishedAt"), head("Fetched", "fetchedAt"), head("Status", "status"), head("Stations", "ops", "num"), head("Border links", "borders", "num"), h("th", { scope: "col", text: "" }))),
  );
  table.querySelectorAll<HTMLButtonElement>("th button").forEach((b, i) => {
    const keys: SortKey[] = ["name", "im", "publishedAt", "fetchedAt", "status", "ops", "borders"];
    b.addEventListener("click", () => {
      const k = keys[i]!;
      if (sortKey === k) sortDesc = !sortDesc;
      else {
        sortKey = k;
        sortDesc = k === "publishedAt" || k === "fetchedAt" || k === "ops";
      }
      render(catalogue, opts);
    });
  });
  const tbody = h("tbody");
  for (const d of rows) {
    const status = statusOf(d);
    const graphs = d.graphs ?? [];
    const ids = [...new Set(graphs.map((g) => g.datasetId).filter((x): x is string => !!x))];
    const files = [...new Set(graphs.map((g) => g.fileName).filter((x): x is string => !!x))];
    const pub = h("td", {}, h("span", { text: fmtDate(d.publishedAt) }), ids.length ? h("small", { text: `dataset ${ids.join(", ")}`, title: files.join(", ") }) : undefined);
    const detail =
      status === "failed" ? d.error
      : status === "removed" ? "The data that was fetched earlier is still on offer."
      : status === "stale" ? `ERA published this dataset on ${fmtDate(latestOf(d.latest))}; the next update fetches it. Until then the data of ${fmtDate(d.publishedAt)} is shown.`
      : status === "pending" ? "ERA publishes this dataset; it is being fetched for the first time."
      : undefined;
    const canOpen = loadable([d]).length > 0;
    const atlas = atlasLink(opts.atlasUrl, graphs);
    const actions = h(
      "td",
      { class: "ds-actions" },
      canOpen ? h("button", { type: "button", class: "btn small", text: d.id === opts.current ? "Shown" : "Show", disabled: d.id === opts.current, title: `Show only the ${d.name} network on the map and in the search` }) : undefined,
      atlas ? h("a", { class: "btn small", href: atlas, target: "_blank", rel: "noopener", text: "Atlas", title: "Browse this dataset in RINF Atlas" }) : undefined,
    );
    actions.querySelector("button")?.addEventListener("click", () => {
      dialog?.close();
      opts.onOpen(d.id);
    });
    tbody.append(
      h(
        "tr",
        { class: `ds-${status}${d.id === opts.current ? " current" : ""}` },
        h("td", {}, h("b", { text: d.name }), h("small", { text: graphs.length ? graphs.map((g) => g.imCode).join(", ") : d.id })),
        h("td", { text: imNames(d) || "–" }),
        pub,
        h("td", { text: fmtDate(d.fetchedAt, true) }),
        h("td", {}, h("span", { class: `ds-status md-signal-${ASPECT[status]}` }, h("span", { class: "md-lamps", "aria-hidden": "true" }, h("i", { class: "md-lamp" }), h("i", { class: "md-lamp" }), h("i", { class: "md-lamp" })), STATUS[status]), detail ? h("small", { text: detail }) : undefined),
        h("td", { class: "num", text: d.ops ? d.ops.toLocaleString() : "–" }),
        borderCell(d, catalogue, opts.borders),
        actions,
      ),
    );
  }
  table.append(tbody);
  body.append(rows.length ? table : h("p", { class: "muted", text: catalogue.datasets.length ? "No dataset matches." : "No datasets listed: this deployment serves one bundle without a catalogue." }));
  const unmatched = opts.borders?.unmatched.filter((u) => !q || rows.some((d) => d.id === u.dataset)) ?? [];
  if (opts.borders && (opts.borders.links.length || unmatched.length)) {
    const nameOf = (id: string) => catalogue.datasets.find((d) => d.id === id)?.name ?? id;
    const details = h("details", { class: "ds-borders" }, h("summary", { text: `Border links: ${opts.borders.links.length} between the networks (same border point declared by both infrastructure managers, or two border points within ${opts.borders.threshold} m), derived by Routebook because RINF has none. ${unmatched.length} border point${unmatched.length === 1 ? "" : "s"} without a partner.` }));
    if (unmatched.length) {
      details.append(h("p", { class: "muted", text: "Border points no other dataset declares nearby; routes cannot cross there. Worth reporting to the infrastructure managers." }));
      const ul = h("ul");
      for (const u of unmatched) ul.append(h("li", {}, h("b", { text: nameOf(u.dataset) }), ` ${u.name} (${u.uopid})${u.reason === "no position" ? ", no position on the track network" : ""}`));
      details.append(ul);
    }
    body.append(details);
  }
}

function borderCell(d: DatasetInfo, catalogue: DatasetCatalogue, borders?: NetworkBordersIndex): HTMLTableCellElement {
  const b = borders?.datasets[d.id];
  if (!b || (!b.links && !b.unmatched)) return h("td", { class: "num", text: "–" });
  const nameOf = (id: string) => catalogue.datasets.find((x) => x.id === id)?.name ?? id;
  const withWhom = Object.entries(b.with).map(([id, n]) => `${nameOf(id)} ${n}`).join(", ");
  return h("td", { class: "num" }, h("span", { text: String(b.links), title: withWhom }), withWhom ? h("small", { text: withWhom }) : undefined, b.unmatched ? h("small", { class: "warn", text: `${b.unmatched} unmatched` }) : undefined);
}

/** Open the dialog (built on first use). */
export function openDatasetsDialog(catalogue: DatasetCatalogue, opts: DatasetsDialogOptions): void {
  if (!dialog) {
    dialog = h("dialog", { class: "ds-dialog", "aria-labelledby": "ds-title" });
    const search = h("input", { type: "search", placeholder: "Filter by network, manager, country or dataset id", "aria-label": "Filter datasets" });
    search.addEventListener("input", () => {
      needle = search.value;
      render(catalogue, opts);
    });
    const close = h("button", { type: "button", class: "btn icon", text: "×", "aria-label": "Close", title: "Close" });
    close.addEventListener("click", () => dialog!.close());
    const checked = catalogue.checkedAt ? `Last checked against ERA ${fmtDate(catalogue.checkedAt, true)}` : "When ERA was last checked is not recorded";
    const endpoint = catalogue.endpoint ?? catalogue.datasets.find((d) => d.endpoint)?.endpoint;
    dialog.append(
      h("header", { class: "ds-head" }, h("h2", { id: "ds-title", text: "RINF datasets" }), search, close),
      h("p", { class: "ds-intro muted" }, `Each network is one or more RINF datasets, published by ERA for an infrastructure manager and fetched by this Routebook. ${checked}${endpoint ? `, endpoint ${endpoint.replace(/^https?:\/\//, "")}` : ""}.`),
      h("div", { class: "ds-body" }),
    );
    dialog.addEventListener("click", (e) => {
      if (e.target === dialog) dialog!.close();
    });
    document.body.append(dialog);
  }
  render(catalogue, opts);
  dialog.showModal();
}
