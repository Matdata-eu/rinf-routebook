import type { LpProblem, LpSolution, LpSolver } from "@routebook/schematic";

/** Solutions kept for models seen before (a route picked again, or a station two routes share). */
const CACHE_LIMIT = 600;

/**
 * An LpSolver backed by a Web Worker running HiGHS (solver-worker.ts). The
 * worker is started on first use and kept for later routes. It answers one
 * model at a time, so the caller can draw each window as it is solved; a
 * request that a newer one has superseded is dropped from the worker's queue
 * (`cancel`), and the solutions are kept by model text, so a model solved
 * before is answered at once.
 */
export function workerSolver(): LpSolver & { cancel: () => void } {
  let worker: Worker | undefined;
  let next = 0;
  let current = -1;
  const cache = new Map<string, LpSolution>();
  const pending = new Map<number, { on: (index: number, s: LpSolution) => void; fail: () => void }>();
  const start = () => {
    const w = new Worker(new URL("./solver-worker.ts", import.meta.url), { type: "module" });
    w.onmessage = (e: MessageEvent<{ id: number; index: number; solution: LpSolution }>) => pending.get(e.data.id)?.on(e.data.index, e.data.solution);
    w.onerror = () => {
      // the worker died (e.g. the WebAssembly could not load): no solutions, the heuristic layout stays
      for (const p of [...pending.values()]) p.fail();
      pending.clear();
      worker = undefined;
    };
    return w;
  };
  const solver: LpSolver = (problems: LpProblem[], onSolution) =>
    new Promise((resolve) => {
      const id = next++;
      current = id;
      const out: LpSolution[] = new Array<LpSolution>(problems.length).fill(undefined);
      let left = problems.length;
      const done = (index: number, s: LpSolution, fresh: boolean) => {
        out[index] = s;
        if (fresh && s) {
          if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!);
          cache.set(problems[index]!.lp, s);
        }
        onSolution?.(index, s);
        if (--left === 0) {
          pending.delete(id);
          resolve(out);
        }
      };
      const todo: Array<{ index: number; problem: LpProblem }> = [];
      problems.forEach((problem, index) => {
        if (cache.has(problem.lp)) done(index, cache.get(problem.lp), false);
        else todo.push({ index, problem });
      });
      if (!todo.length) return void (problems.length || resolve(out));
      pending.set(id, {
        on: (index, s) => done(index, s, true),
        fail: () => resolve(out),
      });
      worker ??= start();
      worker.postMessage({ id, problems: todo });
    });
  return Object.assign(solver, {
    /** Stop working on the models asked for so far (the one being solved is finished first). */
    cancel: () => {
      if (current >= 0) worker?.postMessage({ cancel: current });
    },
  });
}
