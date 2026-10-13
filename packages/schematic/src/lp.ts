/**
 * A small builder for mixed-integer models in CPLEX LP format, the text
 * format HiGHS reads. Kept independent of the solver so that the model can
 * be built on one thread and solved on another (a Web Worker in the app).
 */
export type Terms = Array<[name: string, coef: number]>;

/** A linear expression: variables with coefficients plus a constant. */
export class Lin {
  readonly terms = new Map<string, number>();
  constant = 0;

  static of(...parts: Array<[string, number] | number>): Lin {
    const l = new Lin();
    for (const p of parts) {
      if (typeof p === "number") l.constant += p;
      else l.add(p[0], p[1]);
    }
    return l;
  }

  add(name: string, coef: number): this {
    if (coef !== 0) this.terms.set(name, (this.terms.get(name) ?? 0) + coef);
    return this;
  }

  plus(other: Lin, k = 1): this {
    for (const [n, c] of other.terms) this.add(n, k * c);
    this.constant += k * other.constant;
    return this;
  }
}

const num = (v: number) => {
  const r = Math.round(v * 1e6) / 1e6;
  return Number.isInteger(r) ? String(r) : r.toFixed(6).replace(/0+$/, "");
};

function expr(terms: Iterable<[string, number]>): string {
  let s = "";
  for (const [n, c] of terms) {
    if (Math.abs(c) < 1e-12) continue;
    const a = Math.abs(c);
    s += `${c < 0 ? " - " : s ? " + " : " "}${a === 1 ? "" : `${num(a)} `}${n}`;
  }
  return s || " 0 zero";
}

export interface Var {
  lo: number;
  hi: number;
  kind: "cont" | "int" | "bin";
}

export class LpModel {
  private readonly vars = new Map<string, Var>();
  private readonly rows: string[] = [];
  private readonly objective = new Map<string, number>();
  private usesZero = false;

  /** Declare a variable (idempotent). */
  v(name: string, lo: number, hi: number, kind: Var["kind"] = "cont"): string {
    if (!this.vars.has(name)) this.vars.set(name, { lo, hi, kind });
    return name;
  }

  has(name: string): boolean {
    return this.vars.has(name);
  }

  minimize(name: string, coef: number): void {
    if (coef !== 0) this.objective.set(name, (this.objective.get(name) ?? 0) + coef);
  }

  /** lhs (op) 0, the constant of `lhs` moved to the right-hand side; a constraint without variables is checked here. */
  row(lhs: Lin, op: ">=" | "<=" | "=", rhs = 0): boolean {
    const r = rhs - lhs.constant;
    if (lhs.terms.size === 0) {
      const ok = op === ">=" ? r <= 1e-9 : op === "<=" ? r >= -1e-9 : Math.abs(r) < 1e-9;
      if (!ok) this.rows.push(` c${this.rows.length}: zero ${op} ${num(r)}`), (this.usesZero = true);
      return ok;
    }
    this.rows.push(` c${this.rows.length}:${expr(lhs.terms)} ${op} ${num(r)}`);
    return true;
  }

  get size(): { vars: number; rows: number } {
    return { vars: this.vars.size, rows: this.rows.length };
  }

  toString(): string {
    const out = ["Minimize", ` obj:${expr(this.objective)}`, "Subject To", ...this.rows];
    if (this.usesZero || this.objective.size === 0) out.push(" czero: zero = 0");
    out.push("Bounds");
    const gen: string[] = [], bin: string[] = [];
    for (const [n, v] of this.vars) {
      const lo = v.lo === -Infinity ? "-inf" : num(v.lo);
      const hi = v.hi === Infinity ? "+inf" : num(v.hi);
      out.push(` ${lo} <= ${n} <= ${hi}`);
      if (v.kind === "int") gen.push(n);
      if (v.kind === "bin") bin.push(n);
    }
    if (this.usesZero || this.objective.size === 0) out.push(" zero = 0");
    if (gen.length) out.push("General", ...chunks(gen));
    if (bin.length) out.push("Binary", ...chunks(bin));
    out.push("End");
    return out.join("\n");
  }
}

function chunks(names: string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < names.length; i += 20) out.push(" " + names.slice(i, i + 20).join(" "));
  return out;
}
