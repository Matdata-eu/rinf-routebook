/// <reference lib="webworker" />
import wasmUrl from "highs/runtime?url";
import { loadHighs, solveWithHighs, type LpProblem, type LpSolution } from "@routebook/schematic";

/**
 * Web Worker that solves the schematic layout models with HiGHS
 * (WebAssembly), so that the page stays responsive while it works.
 * Message in: { id, problems: [{ index, problem }] }, answered with one
 * { id, index, solution } per model, in the order given; or { cancel: id }:
 * the models of requests up to that id that are not started yet are dropped
 * (they are still answered, without a solution, so the request ends).
 */
declare const self: DedicatedWorkerGlobalScope;

type Job = { id: number; index: number; problem: LpProblem };
const queue: Job[] = [];
let cancelled = -1;
let busy = false;

async function work(): Promise<void> {
  if (busy) return;
  busy = true;
  for (let job = queue.shift(); job; job = queue.shift()) {
    let solution: LpSolution;
    if (job.id > cancelled) {
      try {
        solution = solveWithHighs(await loadHighs({ locateFile: () => wasmUrl }), job.problem);
      } catch {
        solution = undefined;
      }
      // let a cancel message in between two models
      await new Promise((r) => setTimeout(r, 0));
    }
    self.postMessage({ id: job.id, index: job.index, solution });
  }
  busy = false;
}

self.onmessage = (e: MessageEvent<{ id: number; problems: Array<{ index: number; problem: LpProblem }> } | { cancel: number }>) => {
  if ("cancel" in e.data) {
    cancelled = Math.max(cancelled, e.data.cancel);
    return;
  }
  const { id, problems } = e.data;
  for (const p of problems) queue.push({ id, ...p });
  void work();
};
