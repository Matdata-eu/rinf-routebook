import type { OperationalPoint } from "@routebook/rinf-client";

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

export interface SearchEntry {
  op: OperationalPoint;
  name: string;
  words: string[];
  uopid: string;
  /** stations (opType 10) rank before other OP types */
  station: boolean;
  routable: boolean;
}

export function buildSearchIndex(ops: OperationalPoint[]): SearchEntry[] {
  return ops.map((op) => {
    const name = normalizeName(op.name);
    return {
      op,
      name,
      words: name.split(" "),
      uopid: op.uopid.toLowerCase(),
      station: op.type?.endsWith("/10") ?? false,
      routable: op.points.length > 0 || op.areas.length > 0,
    };
  });
}

/** Ranked OP search: exact name, exact code, name prefix, word prefix, substring. */
export function searchOps(index: SearchEntry[], query: string, limit = 8): OperationalPoint[] {
  const q = normalizeName(query);
  if (!q) return [];
  const code = query.trim().toLowerCase();
  const scored: Array<{ e: SearchEntry; score: number }> = [];
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
  return scored.slice(0, limit).map((s) => s.e.op);
}
