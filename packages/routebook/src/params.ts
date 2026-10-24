import type { Track } from "@routebook/rinf-client";

/** Groups of section parameters, as the line strip shows them in its bands. */
export type ParamGroup = "energy" | "protection" | "radio" | "infrastructure";

export interface ParamInfo {
  key: string;
  label: string;
  group: ParamGroup;
  /** RINF index of the parameter (Commission Implementing Regulation (EU) 2019/777, appendix). */
  rinf: string;
  unit?: string;
}

/** The section parameters of a track, in the order the section card lists them. */
export const PARAMS: ParamInfo[] = [
  { key: "contactLine", label: "Contact line system", group: "energy", rinf: "1.1.1.2.2.1.1" },
  { key: "energySupply", label: "Energy supply system", group: "energy", rinf: "1.1.1.2.2.1.2" },
  { key: "maxTrainCurrent", label: "Maximum train current", group: "energy", rinf: "1.1.1.2.2.2", unit: "A" },
  { key: "raisedPantographs", label: "Raised pantographs", group: "energy", rinf: "1.1.1.2.2.4" },
  { key: "pantographHead", label: "TSI pantograph head", group: "energy", rinf: "1.1.1.2.3.1" },
  { key: "protectionLegacy", label: "Class B train protection", group: "protection", rinf: "1.1.1.3.3.1" },
  { key: "otherProtection", label: "Other train protection", group: "protection", rinf: "1.1.1.3.3.4" },
  { key: "etcsLevel", label: "ETCS level", group: "protection", rinf: "1.1.1.3.2.1" },
  { key: "etcsBaseline", label: "ETCS baseline", group: "protection", rinf: "1.1.1.3.2.2" },
  { key: "gsmR", label: "GSM-R version", group: "radio", rinf: "1.1.1.3.5.1" },
  { key: "legacyRadio", label: "Other radio system", group: "radio", rinf: "1.1.1.3.5.7" },
  { key: "gauge", label: "Track gauge", group: "infrastructure", rinf: "1.1.1.1.4.1", unit: "mm" },
  { key: "gauging", label: "Gauging profile", group: "infrastructure", rinf: "1.1.1.1.3.1.1" },
  { key: "lineCategory", label: "Line category (load)", group: "infrastructure", rinf: "1.1.1.1.2.4" },
];

export const PARAM_INFO = new Map(PARAMS.map((p) => [p.key, p]));

/**
 * Why a parameter has the value it has on a track:
 * - value: the IM publishes it
 * - notApplicable: the IM says it does not apply (e.g. no ETCS)
 * - notYetAvailable: the IM says it will publish it later
 * - notPublished: RINF has nothing about it, not even a statement
 * - noTrack: the route runs over an element that belongs to no RINF track
 */
export type ParamState = "value" | "notApplicable" | "notYetAvailable" | "notPublished" | "noTrack";

export const PARAM_STATE_LABELS: Record<ParamState, string> = {
  value: "From RINF",
  notApplicable: "Not applicable",
  notYetAvailable: "Not yet available",
  notPublished: "Not published",
  noTrack: "No RINF track here",
};

/** A parameter's value and state on a track (or on a stretch, which carries the same fields). */
export function paramOf(t: Pick<Track, "params" | "notApplicable" | "notYetAvailable"> | undefined, key: string): { state: ParamState; value?: string } {
  if (!t) return { state: "noTrack" };
  const value = t.params?.[key];
  if (value !== undefined) return { state: "value", value };
  if (t.notApplicable?.includes(key)) return { state: "notApplicable" };
  if (t.notYetAvailable?.includes(key)) return { state: "notYetAvailable" };
  return { state: "notPublished" };
}

/** Energy as a driver reads it: the supply system (AC 15kV-16.7Hz), or the contact line type when there is none (Not electrified). */
export function energyOf(t: Pick<Track, "params"> | undefined): string | undefined {
  return t?.params?.energySupply ?? t?.params?.contactLine;
}

/** ETCS as a driver reads it: "ETCS level 2", "No ETCS" where the IM says it does not apply, else undefined. */
export function etcsOf(t: Pick<Track, "params" | "notApplicable"> | undefined): string | undefined {
  const level = t?.params?.etcsLevel;
  if (level) return `ETCS level ${level}`;
  return t?.notApplicable?.includes("etcsLevel") ? "No ETCS" : undefined;
}

type ParamSource = Pick<Track, "params" | "notApplicable" | "notYetAvailable">;

/** The parameters whose change along the route becomes a routebook item, with how to read them. */
export const CHANGE_PARAMS: Array<{ param: string; label: string; read: (t: ParamSource) => string | undefined }> = [
  { param: "energy", label: "Energy", read: energyOf },
  { param: "classB", label: "Class B train protection", read: (t) => t.params?.protectionLegacy },
  { param: "etcs", label: "ETCS", read: etcsOf },
  { param: "gsmR", label: "Radio", read: (t) => t.params?.gsmR },
  { param: "gauge", label: "Track gauge", read: (t) => t.params?.gauge },
];
