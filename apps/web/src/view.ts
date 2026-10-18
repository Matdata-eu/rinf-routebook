import type { Routebook } from "@routebook/routebook";
import { KIND_LABELS, QUALITY_LABELS, gradientColor, speedColor, stripRows } from "./strip.js";

const km = (m: number) => (m / 1000).toFixed(3);

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

/** Small inline SVG symbols, readable in print. */
function symbol(kind: string, data?: Record<string, unknown>): SVGSVGElement | HTMLElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("class", "sym");
  svg.setAttribute("aria-hidden", "true");
  const paths: Record<string, string> = {
    signal: `<line x1="10" y1="19" x2="10" y2="9" stroke="currentColor" stroke-width="2"/><circle cx="10" cy="6" r="5" fill="var(--sig, #c0392b)" stroke="currentColor" stroke-width="1.2"/>`,
    switch: `<path d="M3 17 L10 10 L10 3 M10 10 L17 17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"/>`,
    tunnel: `<path d="M2 18 V10 A8 8 0 0 1 18 10 V18" fill="none" stroke="currentColor" stroke-width="2.2"/><path d="M6 18 V11 A4 4 0 0 1 14 11 V18" fill="var(--ink-muted)"/>`,
    kmPost: `<rect x="5" y="5" width="10" height="10" transform="rotate(45 10 10)" fill="var(--surface-raised)" stroke="currentColor" stroke-width="1.6"/>`,
    levelCrossing: `<path d="M4 4 L16 16 M16 4 L4 16" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/>`,
    op: `<rect x="3" y="5" width="14" height="10" rx="2" fill="var(--ink)"/>`,
    origin: `<circle cx="10" cy="10" r="7" fill="var(--from)"/>`,
    destination: `<circle cx="10" cy="10" r="7" fill="var(--to)"/>`,
    speed: `<circle cx="10" cy="10" r="7.5" fill="#fff" stroke="#c0392b" stroke-width="2.5"/>`,
    gradient: `<path d="M2 16 L18 6 L18 16 Z" fill="var(--line-strong)"/>`,
    line: `<path d="M2 10 H18" stroke="var(--brand)" stroke-width="4"/>`,
    border: `<path d="M4 18 V3" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M5 3 H16 L13 7 L16 11 H5 Z" fill="var(--brand-strong)"/>`,
    missing: `<path d="M10 2 L19 18 H1 Z" fill="var(--amber)" stroke="var(--amber-ink)" stroke-width="1.2"/><text x="10" y="16" font-size="10" font-weight="700" text-anchor="middle" fill="var(--on-amber)">!</text>`,
  };
  const signalColors: Record<string, string> = {
    home: "#c0392b", exit: "#8e44ad", block: "#27ae60", intermediate: "#e67e22", shunting: "#7f8c8d", distant: "#f1c40f",
  };
  svg.innerHTML = paths[kind] ?? `<circle cx="10" cy="10" r="4" fill="#666"/>`;
  if (kind === "signal") svg.style.setProperty("--sig", signalColors[String(data?.signalType)] ?? "#c0392b");
  return svg;
}

export interface StripOptions {
  hiddenKinds: Set<string>;
  onSelect: (index: number) => void;
}

/** Render the routebook header, gap list and the vertical strip into `root`. */
export function renderRoutebook(root: HTMLElement, rb: Routebook, opts: StripOptions): void {
  root.replaceChildren();

  const head = el("header", "rb-head");
  const title = el("h2", "rb-title", `${rb.from.name} → ${rb.to.name}`);
  const sub = el(
    "p",
    "rb-sub",
    `${(rb.length / 1000).toFixed(1)} km · ${rb.items.length} items · start: OP ${rb.endpointModes.from === "point" ? "centre" : "area edge"}, end: OP ${rb.endpointModes.to === "point" ? "centre" : "area edge"}`,
  );
  const printBtn = el("button", "btn", "Print / PDF");
  printBtn.type = "button";
  printBtn.addEventListener("click", () => window.print());
  head.append(title, sub, printBtn);

  const gaps = el("details", "rb-gaps");
  gaps.open = false;
  gaps.append(el("summary", undefined, `Not available in RINF (${rb.gaps.length}) — shown as placeholders`));
  const gl = el("ul");
  for (const g of rb.gaps) {
    const li = el("li");
    li.append(el("strong", undefined, g.field), document.createTextNode(`: ${g.reason}`));
    gl.append(li);
  }
  gaps.append(gl);

  const legend = el("div", "rb-legend");
  for (const [q, l] of Object.entries(QUALITY_LABELS)) {
    const entry = el("span");
    entry.append(el("span", `q q-${q}`, l.short), document.createTextNode(l.title));
    legend.append(entry);
  }

  const strip = el("ol", "rb-strip");
  strip.setAttribute("aria-label", "Routebook");
  const cols = el("li", "rb-row rb-cols");
  cols.setAttribute("aria-hidden", "true");
  for (const [c, t] of [["c-dist", "km"], ["c-speed", "km/h"], ["c-grad", "‰"], ["c-km", "Line km"], ["c-sym", ""], ["c-label", "Item"], ["c-q", "Q"]]) {
    cols.append(el("span", c, t));
  }
  strip.append(cols);

  for (const row of stripRows(rb)) {
    const { item } = row;
    if (opts.hiddenKinds.has(item.kind)) continue;
    const li = el("li", `rb-row kind-${item.kind} q-${item.quality}`);
    li.tabIndex = 0;
    li.dataset.index = String(row.index);
    if (item.kind === "line") {
      li.classList.add("rb-linechange");
    }

    li.append(el("span", "c-dist", km(item.distance)));

    const sp = el("span", `c-speed band${row.speedMissing ? " band-missing" : ""}`, row.speedChanged ? (row.speed !== undefined ? String(row.speed) : "?") : "");
    sp.style.background = row.speedMissing ? "" : speedColor(row.speed);
    li.append(sp);

    const gr = el(
      "span",
      "c-grad band",
      row.gradientChanged && row.gradient !== undefined ? `${row.gradient > 0 ? "+" : ""}${row.gradient.toFixed(1)}` : "",
    );
    gr.style.background = gradientColor(row.gradient);
    li.append(gr);

    li.append(el("span", "c-km", item.km !== undefined ? item.km.toFixed(3) : "–"));

    const sym = el("span", "c-sym");
    sym.append(symbol(item.kind, item.data));
    sym.title = KIND_LABELS[item.kind] ?? item.kind;
    li.append(sym);

    const label = el("span", "c-label");
    label.append(el("span", "lbl", item.label ?? KIND_LABELS[item.kind] ?? item.kind));
    const extra: string[] = [];
    if (item.kind === "signal" && item.data?.signalType) extra.push(String(item.data.signalType));
    if (item.kind === "tunnel" && item.data?.boundary) extra.push(String(item.data.boundary));
    if (item.kind === "tunnel" && typeof item.data?.length === "number") extra.push(`${Math.round(item.data.length as number)} m`);
    if (item.kind === "op" && item.data?.reference === "area-entry") extra.push("area entry");
    if (item.kind === "missing") extra.push(item.note ?? "no data in RINF");
    if (item.kind === "border") extra.push("border link derived by Routebook");
    if (extra.length) label.append(el("small", undefined, extra.join(" · ")));
    li.append(label);

    const q = el("span", `c-q q q-${item.quality}`, QUALITY_LABELS[item.quality].short);
    q.title = QUALITY_LABELS[item.quality].title + (item.note ? ` — ${item.note}` : "");
    li.append(q);

    li.addEventListener("click", () => opts.onSelect(row.index));
    li.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        opts.onSelect(row.index);
      }
    });
    strip.append(li);
  }

  root.append(head, legend, gaps, strip);
}

export function markSelected(root: HTMLElement, index: number): void {
  root.querySelectorAll(".rb-row.selected").forEach((e) => e.classList.remove("selected"));
  root.querySelector(`.rb-row[data-index="${index}"]`)?.classList.add("selected");
}
