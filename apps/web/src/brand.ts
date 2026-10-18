/**
 * The app name as a MatData wordmark: a one-word camel-case name keeps its last part in
 * MatData blue (Route + Book), any other title is written as it is.
 */
export function brandParts(title: string): [string, string] | undefined {
  const m = /^([A-Z]?[^A-Z\s]+)([A-Z][^A-Z\s]+)$/.exec(title.trim());
  return m ? [m[1]!, m[2]!] : undefined;
}

export function renderBrand(el: HTMLElement, title: string): void {
  const parts = brandParts(title);
  if (!parts) {
    el.textContent = title;
    return;
  }
  const tail = document.createElement("b");
  tail.textContent = parts[1];
  el.replaceChildren(parts[0], tail);
}
