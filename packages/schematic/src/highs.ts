import type { LpProblem, LpSolution, LpSolver } from "./solver.js";

/** The part of the highs-js module this package uses. */
export interface HighsLike {
  solve(problem: string, options?: Record<string, unknown>): { Status: string; ObjectiveValue: number; Columns: Record<string, { Primal?: number }> };
}

export interface HighsLoadOptions {
  /** URL of highs.wasm in a browser (the bundler's asset URL); Node finds it beside the loader. */
  locateFile?: (file: string) => string;
}

let shared: Promise<HighsLike> | undefined;

/** Load HiGHS (WebAssembly) once per thread. */
export function loadHighs(opts: HighsLoadOptions = {}): Promise<HighsLike> {
  if (!shared) {
    shared = import("highs").then((mod) => {
      const load = (mod as unknown as { default: (o?: object) => Promise<HighsLike> }).default;
      return load(opts.locateFile ? { locateFile: opts.locateFile } : {});
    });
    shared.catch(() => (shared = undefined));
  }
  return shared;
}

/** Solve one LP-format model with HiGHS: the primal values, or undefined without a usable solution. */
export function solveWithHighs(highs: HighsLike, p: LpProblem): LpSolution {
  try {
    const r = highs.solve(p.lp, { output_flag: false, time_limit: p.timeLimit, mip_rel_gap: 1e-4 });
    // a time limit can still leave a feasible incumbent; anything without primal values is no solution
    if (r.Status !== "Optimal" && r.Status !== "Time limit reached") return undefined;
    if (!Number.isFinite(r.ObjectiveValue) || Math.abs(r.ObjectiveValue) > 1e15) return undefined;
    const out: Record<string, number> = {};
    for (const [name, c] of Object.entries(r.Columns)) {
      if (typeof c.Primal !== "number" || !Number.isFinite(c.Primal)) return undefined;
      out[name] = c.Primal;
    }
    return out;
  } catch {
    return undefined;
  }
}

/** An LpSolver that runs HiGHS in this thread. */
export function highsSolver(opts: HighsLoadOptions = {}): LpSolver {
  return async (problems) => {
    const highs = await loadHighs(opts);
    return problems.map((p) => solveWithHighs(highs, p));
  };
}
