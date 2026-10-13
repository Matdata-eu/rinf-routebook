import type { LpProblem, LpSolution, LpSolver } from "@routebook/schematic";

/**
 * An LpSolver backed by a Web Worker running HiGHS (solver-worker.ts). The
 * worker is started on first use and kept for later routes; a request that
 * a newer one has superseded is still answered, the caller decides whether
 * it still wants the result.
 */
export function workerSolver(): LpSolver {
  let worker: Worker | undefined;
  let next = 0;
  const pending = new Map<number, (s: LpSolution[]) => void>();
  const start = () => {
    const w = new Worker(new URL("./solver-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; solutions: LpSolution[] }>) => {
      pending.get(e.data.id)?.(e.data.solutions);
      pending.delete(e.data.id);
    };
    w.onerror = () => {
      // the worker died (e.g. the WebAssembly could not load): no solutions, the heuristic layout stays
      for (const [id, done] of pending) done([]), pending.delete(id);
      worker = undefined;
    };
    return w;
  };
  return (problems: LpProblem[]) =>
    new Promise((resolve) => {
      worker ??= start();
      const id = next++;
      pending.set(id, resolve);
      worker.postMessage({ id, problems });
    });
}
