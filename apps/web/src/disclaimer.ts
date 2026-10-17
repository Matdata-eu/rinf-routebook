/**
 * The demo disclaimer: a hazard-striped banner across the top of the app, a
 * notice the user has to acknowledge once per wording, and a stamp on every
 * printed routebook. On by default, because a routebook built on public RINF
 * data as it is must not be mistaken for an operational document. Deployers
 * can change the wording or the publisher name in config.json (`disclaimer`),
 * or switch it off with `"disclaimer": false`, which makes the disclaimer
 * theirs to give.
 */

export interface DisclaimerConfig {
  /** Who publishes the site, named in the notice (default: "The publisher of this site"). */
  publisher?: string;
  /** Replaces the banner line. */
  banner?: string;
  /** Replaces the title of the notice. */
  title?: string;
  /** Replaces the paragraphs of the notice. */
  text?: string[];
  /** Replaces the stamp on printed routebooks. */
  print?: string;
}

export interface Disclaimer {
  publisher: string;
  banner: string;
  title: string;
  text: string[];
  print: string;
}

/** Bump when the default wording changes, so everyone acknowledges the new one. */
export const DISCLAIMER_VERSION = "2026-10-17";
const ACCEPT_KEY = "routebook-disclaimer";

export const DEFAULT_PUBLISHER = "The publisher of this site";

export function defaultDisclaimer(publisher = DEFAULT_PUBLISHER): Disclaimer {
  return {
    publisher,
    banner: "Demo environment: not for operational use. RINF data is shown as published by ERA, without warranty.",
    title: "This is a demonstration",
    text: [
      "Routebook is a demo. It is not meant for a production or operational environment: do not drive, plan or dispatch trains with it. Official routebooks come from the infrastructure manager.",
      "The data is the Register of Infrastructure (RINF) as the infrastructure managers published it through the European Union Agency for Railways (ERA). It is shown as it is: it may be incomplete, out of date or wrong, and parts a routebook needs are missing from RINF altogether (the app marks them).",
      `${publisher} does not manage this data and is not responsible for it. The app, the routes and the routebooks it derives are provided as they are, without any warranty, and ${publisher === DEFAULT_PUBLISHER ? "the publisher accepts" : `${publisher} accepts`} no liability for decisions taken on the basis of what is shown.`,
    ],
    print: "DEMO: NOT FOR OPERATIONAL USE",
  };
}

/** The disclaimer for a configuration: the defaults, the configured parts, or none when switched off. */
export function resolveDisclaimer(config: DisclaimerConfig | boolean | undefined): Disclaimer | undefined {
  if (config === false) return undefined;
  const c = config && typeof config === "object" ? config : {};
  const base = defaultDisclaimer(c.publisher?.trim() || DEFAULT_PUBLISHER);
  const text = Array.isArray(c.text) ? c.text.filter((t): t is string => typeof t === "string" && t.trim() !== "") : [];
  return {
    ...base,
    ...(c.banner?.trim() ? { banner: c.banner.trim() } : {}),
    ...(c.title?.trim() ? { title: c.title.trim() } : {}),
    ...(text.length ? { text } : {}),
    ...(c.print?.trim() ? { print: c.print.trim() } : {}),
  };
}

/** A key for the acknowledgement: the version of the default wording, or a hash of custom wording. */
export function acceptanceKey(d: Disclaimer): string {
  const custom = JSON.stringify([d.title, d.text, d.banner]);
  let h = 0;
  for (const ch of custom) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return `${DISCLAIMER_VERSION}:${(h >>> 0).toString(36)}`;
}

let acceptedNow = false; // when storage is blocked, the acknowledgement lasts for this visit

export function disclaimerAccepted(d: Disclaimer, storage: Pick<Storage, "getItem"> | undefined = safeStorage()): boolean {
  if (acceptedNow) return true;
  try {
    return storage?.getItem(ACCEPT_KEY) === acceptanceKey(d);
  } catch {
    return false;
  }
}

export function acceptDisclaimer(d: Disclaimer, storage: Pick<Storage, "setItem"> | undefined = safeStorage()): void {
  acceptedNow = true;
  try {
    storage?.setItem(ACCEPT_KEY, acceptanceKey(d));
  } catch {
    /* not persisted; accepted for this visit */
  }
}

function safeStorage(): Storage | undefined {
  try {
    return typeof localStorage === "undefined" ? undefined : localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Put the disclaimer on the page: the banner (always visible, also printed), the
 * print stamp, and the notice to acknowledge on the first visit.
 */
export function installDisclaimer(d: Disclaimer, root: Document = document): void {
  const banner = root.getElementById("disclaimer");
  if (banner) {
    banner.replaceChildren();
    const icon = root.createElement("span");
    icon.className = "dc-icon";
    icon.setAttribute("aria-hidden", "true");
    icon.textContent = "⚠";
    const text = root.createElement("span");
    text.className = "dc-text";
    text.textContent = d.banner;
    const more = root.createElement("button");
    more.type = "button";
    more.className = "dc-more";
    more.textContent = "Read the disclaimer";
    more.addEventListener("click", () => showNotice(d, root, false));
    banner.append(icon, text, more);
    banner.hidden = false;
  }
  const stamp = root.getElementById("print-stamp");
  if (stamp) {
    stamp.textContent = d.print;
    stamp.hidden = false;
  }
  if (!disclaimerAccepted(d)) showNotice(d, root, true);
}

function showNotice(d: Disclaimer, root: Document, mustAccept: boolean): void {
  let dlg = root.getElementById("disclaimer-notice") as HTMLDialogElement | null;
  if (!dlg) {
    dlg = root.createElement("dialog");
    dlg.id = "disclaimer-notice";
    dlg.className = "dc-notice";
    dlg.setAttribute("aria-labelledby", "dc-title");
    root.body.append(dlg);
  }
  dlg.replaceChildren();
  const stripe = root.createElement("div");
  stripe.className = "dc-stripe";
  const h = root.createElement("h2");
  h.id = "dc-title";
  h.textContent = d.title;
  dlg.append(stripe, h);
  for (const t of d.text) {
    const p = root.createElement("p");
    p.textContent = t;
    dlg.append(p);
  }
  const btn = root.createElement("button");
  btn.type = "button";
  btn.className = "btn dc-accept";
  btn.textContent = mustAccept ? "I understand, this is a demo" : "Close";
  btn.addEventListener("click", () => {
    if (mustAccept) acceptDisclaimer(d);
    dlg!.close();
  });
  dlg.append(btn);
  // the first notice cannot be dismissed with Escape or a click outside
  dlg.oncancel = (e) => {
    if (mustAccept) e.preventDefault();
  };
  if (typeof dlg.showModal === "function") dlg.showModal();
  else dlg.setAttribute("open", "");
}
