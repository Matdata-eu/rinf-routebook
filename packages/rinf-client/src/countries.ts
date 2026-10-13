/**
 * RINF country graphs. The ERA knowledge graph holds one named graph per
 * infrastructure manager code. Only Norway has been checked so far
 * (docs/data-coverage-norway.md); others can be added once verified.
 */
export interface CountryGraph {
  /** ISO 3166-1 alpha-3, as used by the EU country authority table. */
  code: string;
  name: string;
  graph: string;
  imName: string;
}

export const COUNTRIES: Record<string, CountryGraph> = {
  NOR: {
    code: "NOR",
    name: "Norway",
    graph: "http://data.europa.eu/949/graph/0076",
    imName: "Bane NOR",
  },
};

export function countryGraph(code: string): CountryGraph {
  const c = COUNTRIES[code.toUpperCase()];
  if (!c) throw new Error(`Unknown country ${code}; known: ${Object.keys(COUNTRIES).join(", ")}`);
  return c;
}
