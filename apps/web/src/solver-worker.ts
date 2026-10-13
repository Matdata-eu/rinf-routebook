/// <reference lib="webworker" />
import wasmUrl from "highs/runtime?url";
import { loadHighs, solveWithHighs, type LpProblem, type LpSolution } from "@routebook/schematic";

/**
 * Web Worker that solves the schematic layout models with HiGHS
 * (WebAssembly), so that the page stays responsive while it works.
 * Message in: { id, problems: LpProblem[] }; out: { id, solutions: LpSolution[] }.
 */
declare const self: DedicatedWorkerGlobalScope;

self.onmessage = async (e: MessageEvent<{ id: number; problems: LpProblem[] }>) => {
  const { id, problems } = e.data;
  let solutions: LpSolution[];
  try {
    const highs = await loadHighs({ locateFile: () => wasmUrl });
    solutions = problems.map((p) => solveWithHighs(highs, p));
  } catch {
    solutions = problems.map(() => undefined);
  }
  self.postMessage({ id, solutions });
};
