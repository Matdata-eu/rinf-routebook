import type { Gap } from "./types.js";

/**
 * Routebook fields that RINF (ERA ontology v3.3.4, Norway data checked
 * 2026-10-13, see docs/data-coverage-norway.md) does not provide. They are
 * reported on every routebook so the UI can show explicit placeholders.
 */
export const RINF_GAPS: Gap[] = [
  {
    field: "speedProfile",
    reason: "RINF only has era:maximumPermittedSpeed per track (one value per SoL/station track); no speed sections or speed-board positions.",
  },
  { field: "derailers", reason: "No derailer / catch point class in the ERA ontology." },
  { field: "noStopZones", reason: "No general no-stop zone concept in RINF (era:lengthOfNonStoppingArea is unused)." },
  { field: "switchAttributes", reason: "era:Switch has only a label and position: no type, orientation or diverging speed." },
  { field: "signalId", reason: "era:signalId is not filled for Norway; the label carries the signal name." },
  { field: "distantSignalsAndBoards", reason: "Only main/shunting signal types are present; no distant signals or lineside boards." },
];
