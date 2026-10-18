/**
 * Lowercase, strip diacritics and fold Nordic letters so that "lillestrom"
 * finds "Lillestrøm" and "asker" finds "Åsker".
 */
export function normalizeName(s: string): string {
  return s
    .toLowerCase()
    .replace(/ø/g, "o")
    .replace(/æ/g, "ae")
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

/** What the search needs of an operational point: an index entry or a full OP of a bundle. */
export interface Searchable {
  uopid: string;
  name: string;
  /** era:opType IRI or its last part ("10" = station). */
  type?: string;
  /** Can be the end of a route (an index entry says so; a full OP has points or areas). */
  routable?: boolean;
  points?: unknown[];
  areas?: unknown[];
}

export interface SearchEntry<T extends Searchable = Searchable> {
  item: T;
  name: string;
  words: string[];
  uopid: string;
  /** stations (opType 10) rank before other OP types */
  station: boolean;
  routable: boolean;
}

export function isStation(type: string | undefined): boolean {
  return type === "10" || (type?.endsWith("/10") ?? false);
}

export function buildSearchIndex<T extends Searchable>(items: T[]): SearchEntry<T>[] {
  return items.map((item) => {
    const name = normalizeName(item.name);
    return {
      item,
      name,
      words: name.split(" "),
      uopid: item.uopid.toLowerCase(),
      station: isStation(item.type),
      routable: item.routable ?? ((item.points?.length ?? 0) > 0 || (item.areas?.length ?? 0) > 0),
    };
  });
}

/** Ranked OP search: exact name, exact code, name prefix, word prefix, substring. */
export function searchOps<T extends Searchable>(index: SearchEntry<T>[], query: string, limit = 8): T[] {
  const q = normalizeName(query);
  if (!q) return [];
  const code = query.trim().toLowerCase();
  const scored: Array<{ e: SearchEntry<T>; score: number }> = [];
  for (const e of index) {
    let score: number;
    if (e.name === q) score = 0;
    else if (e.uopid === code) score = 1;
    else if (e.name.startsWith(q)) score = 2;
    else if (e.words.some((w) => w.startsWith(q))) score = 3;
    else if (e.name.includes(q) || e.uopid.startsWith(code)) score = 4;
    else continue;
    if (!e.routable) score += 10;
    scored.push({ e, score });
  }
  scored.sort(
    (a, b) =>
      a.score - b.score ||
      Number(b.e.station) - Number(a.e.station) ||
      a.e.name.length - b.e.name.length ||
      a.e.name.localeCompare(b.e.name),
  );
  return scored.slice(0, limit).map((s) => s.e.item);
}
