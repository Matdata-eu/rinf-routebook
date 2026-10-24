import { describe, expect, it } from "vitest";
import { assembleSnapshot, raisedPantographsText, type RawResults } from "@routebook/rinf-client";

const ERA = "http://data.europa.eu/949/";
const empty = (): RawResults => ({ ops: [], opAreas: [], opPoints: [], lines: [], sols: [], netelements: [], netrelations: [], tracks: [], trackElements: [], trackParents: [], features: [], tunnels: [], tunnelAreas: [], geometry: [] });
const meta = { endpoint: "e", graph: "g", country: "NOR" };

describe("section parameters", () => {
  const r = empty();
  r.tracks = [{ track: "t1", kind: `${ERA}RunningTrack` }, { track: "t2", kind: `${ERA}RunningTrack` }];
  r.trackParams = [
    { track: "t1", key: "energySupply", v: `${ERA}concepts/energy-supply-systems/AC20`, label: "AC 15kV-16.7Hz" },
    { track: "t1", key: "contactLine", v: `${ERA}concepts/contact-line-systems/10`, label: "Overhead contact line (OCL)" },
    { track: "t1", key: "protectionLegacy", v: `${ERA}concepts/x/2`, label: "PZB" },
    { track: "t1", key: "protectionLegacy", v: `${ERA}concepts/x/1`, label: "LZB" },
    { track: "t1", key: "raisedPantographs.number", v: "2" },
    { track: "t1", key: "raisedPantographs.distance", v: "250" },
    { track: "t1", key: "raisedPantographs.speed", v: "200" },
    { track: "t2", key: "gauge", v: `${ERA}concepts/nominal-track-gauges/30` },
    { track: "nope", key: "gauge", v: "1435" },
  ];
  r.trackStates = [
    { track: "t1", state: `${ERA}notApplicable`, prop: `${ERA}etcs` },
    { track: "t2", state: `${ERA}notYetAvailable`, prop: `${ERA}contactLineSystem` },
    // a statement next to a value: the value wins
    { track: "t1", state: `${ERA}notYetAvailable`, prop: `${ERA}energySupplySystem` },
    { track: "t2", state: `${ERA}notYetAvailable`, prop: `${ERA}somethingElse` },
  ];
  r.trackSeparations = [
    { track: "t1", sep: "p1", kind: "phase", km: "8.8467E1", length: "54", pantographLowered: "false", switchOffBreaker: "true" },
    { track: "t1", sep: "p1", kind: "phase", km: "88.467" },
  ];
  const s = assembleSnapshot(r, meta);
  const [t1, t2] = s.tracks;

  it("keeps the labels of the values, several values joined", () => {
    expect(t1!.params).toEqual({
      contactLine: "Overhead contact line (OCL)",
      energySupply: "AC 15kV-16.7Hz",
      raisedPantographs: "2 pantographs at least 250 m apart, up to 200 km/h",
      protectionLegacy: "LZB, PZB",
    });
    // no label: the code at the end of the concept IRI
    expect(t2!.params).toEqual({ gauge: "30" });
  });

  it("maps not applicable / not yet available statements to the parameters they cover", () => {
    expect(t1!.notApplicable).toEqual(["etcsLevel", "etcsBaseline"]);
    expect(t1!.notYetAvailable ?? []).toEqual([]);
    expect(t2!.notYetAvailable).toEqual(["contactLine", "energySupply", "maxTrainCurrent"]);
  });

  it("reads separations once, with their flags", () => {
    expect(t1!.separations).toEqual([{ id: "p1", kind: "phase", km: 88.467, length: 54, pantographLowered: false, switchOffBreaker: true }]);
    expect(t2!.separations).toBeUndefined();
  });

  it("words the raised pantographs requirement", () => {
    expect(raisedPantographsText("1", "0", "40")).toBe("1 pantograph, up to 40 km/h");
    expect(raisedPantographsText(undefined, undefined, undefined)).toBeUndefined();
  });

  it("leaves tracks alone when the results have no parameters (data fetched before)", () => {
    const old = empty();
    old.tracks = [{ track: "t1", kind: `${ERA}RunningTrack` }];
    expect(assembleSnapshot(old, meta).tracks[0]).not.toHaveProperty("params");
  });
});
