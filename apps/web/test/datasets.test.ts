import { describe, expect, it } from "vitest";
import { examplesFor, loadDatasets, pickDataset, rinfAttribution } from "../src/datasets.js";

const list = [
  { id: "bel", name: "Belgium" },
  { id: "nor", name: "Norway", imName: "Bane NOR" },
];

describe("datasets", () => {
  it("picks the requested dataset, then the configured default, then the first", () => {
    expect(pickDataset(list, "NOR")).toBe("nor");
    expect(pickDataset(list, "xxx", "nor")).toBe("nor");
    expect(pickDataset(list, null)).toBe("bel");
    // no datasets.json (static hosting of a single bundle): trust the URL, default nor
    expect(pickDataset([], "swe")).toBe("swe");
    expect(pickDataset([], null)).toBe("nor");
  });

  it("credits ERA and the infrastructure manager", () => {
    expect(rinfAttribution({ country: "NOR", imName: "Bane NOR" }, { html: false })).toBe("RINF data © European Union Agency for Railways, provided by Bane NOR");
    expect(rinfAttribution({ country: "BEL" })).toMatch(/^RINF data © <a href="https:\/\/graph\.data\.era\.europa\.eu\/">/);
  });

  it("has examples for Norway and lets the configuration replace them", () => {
    expect(examplesFor("nor").map((e) => e.from)).toContain("NOOSL");
    expect(examplesFor("bel")).toEqual([]);
    expect(examplesFor("bel", { bel: [{ from: "BEBRU", to: "BEANT" }] })).toEqual([{ from: "BEBRU", to: "BEANT" }]);
  });

  it("reads datasets.json and tolerates its absence", async () => {
    const res = (body: string, status = 200) => (async () => new Response(body, { status })) as unknown as typeof fetch;
    expect(await loadDatasets("datasets.json", res(JSON.stringify([{ id: "nor", name: "" }, { nope: 1 }])))).toEqual([{ id: "nor", name: "nor" }]);
    expect(await loadDatasets("datasets.json", res("", 404))).toEqual([]);
  });
});
