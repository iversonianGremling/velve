// The Tier-2 Z3 back-end (north-star §3.3): discharges the `nonzero` residue
// the interval floor couldn't settle (facts.ts). Per obligation, the query is
// REFUTATION over the reals: assert every path fact, assert `divisor == 0`,
// and UNSAT means no value assignment satisfies both — the divisor is proved
// nonzero on that path. SAT yields a counterexample (surfaced in the error),
// UNKNOWN is a conservative error.
//
// The solver only ever REMOVES errors the floor would have raised — a sat or
// unknown verdict produces the same class of error the LSP's floor fallback
// shows — so wiring Z3 in can never accept code the floor-only pipeline
// would (it accepts strictly more, errors strictly less).
//
// z3-solver loads LAZILY (the WASM init is ~120ms and spawns worker threads)
// and only here, so a check with an empty residue never pays for it; the CLI
// terminates the worker threads afterward or Node would never exit. If the
// package isn't installed, every obligation falls back to the floor error
// with an install hint appended — conservative, never a crash.
import type { Expr } from "./ast.js";
import type { Diagnostic } from "./resolve.js";
import type { Obligation, Fact } from "./facts.js";
import { residueFloorDiags } from "./facts.js";

export async function dischargeNonZero(residue: Obligation[]): Promise<Diagnostic[]> {
  if (residue.length === 0) return [];
  let z3: typeof import("z3-solver");
  try {
    z3 = await import("z3-solver");
  } catch {
    return residueFloorDiags(residue).map(d => ({ ...d,
      message: `${d.message} [z3-solver is not installed — \`npm install\` in checker/ enables the Tier-2 solver fall-through]` }));
  }
  const { Context, em } = await z3.init();
  const Z3 = Context("main");
  const diags: Diagnostic[] = [];
  try {
    for (const ob of residue) {
      const names = new Set<string>();
      for (const f of ob.facts) for (const n of f.names) names.add(n);
      collectNames(ob.divisor, names);
      const consts = new Map([...names].map(n => [n, Z3.Real.const(n)] as const));

      const solver = new Z3.Solver();
      for (const f of ob.facts) solver.add(cmp(Z3, f, consts));
      const divisor = term(Z3, ob.divisor, consts);
      solver.add(divisor.eq(Z3.Real.val(0)));

      const verdict = await solver.check();
      if (verdict === "unsat") continue;  // proved nonzero on this path
      let detail: string;
      if (verdict === "sat") {
        const model = solver.model();
        const example = [...consts.entries()]
          .map(([n, c]) => `${n} = ${model.eval(c, true).toString()}`).join(", ");
        detail = `Z3 found a zero divisor consistent with every fact on this path (${example})`;
      } else {
        detail = "Z3 returned unknown — conservatively rejected";
      }
      diags.push({ kind: "error", span: ob.span,
        message: `proof obligation 'nonzero': cannot prove the divisor nonzero — ${detail} (the module declares proofs: [nonzero])` });
    }
  } finally {
    em.PThread.terminateAllThreads();
  }
  return diags;
}

// z3-solver brands every term with the context name as a string-literal type
// parameter, which TS can't thread through a Map without exploding — the
// solver surface is typed loosely on purpose; the translatable-fragment
// invariant (facts.ts) is what actually keeps these calls well-formed.
type Ctx = any;
type Arith = any;

function collectNames(e: Expr, into: Set<string>): void {
  switch (e.tag) {
    case "Var": into.add(e.name); break;
    case "BinOp": collectNames(e.left, into); collectNames(e.right, into); break;
    case "UnOp": collectNames(e.expr, into); break;
  }
}

// Both functions only ever see the `translatable` fragment (facts.ts) — the
// throw is an invariant violation, not a user error path.
function term(Z3: Ctx, e: Expr, consts: Map<string, Arith>): Arith {
  switch (e.tag) {
    case "Var": return consts.get(e.name)!;
    case "Lit":
      if (e.lit.tag === "Num") return Z3.Real.val(e.lit.value);
      break;
    case "BinOp": {
      const l = term(Z3, e.left, consts), r = term(Z3, e.right, consts);
      if (e.op === "+") return l.add(r);
      if (e.op === "-") return l.sub(r);
      if (e.op === "*") return l.mul(r);
      break;
    }
    case "UnOp":
      if (e.op === "-") return term(Z3, e.expr, consts).neg();
      break;
  }
  throw new Error(`smt: untranslatable term reached the solver: ${e.tag}`);
}

function cmp(Z3: Ctx, f: Fact, consts: Map<string, Arith>) {
  const l = term(Z3, f.lhs, consts), r = term(Z3, f.rhs, consts);
  switch (f.op) {
    case "==": return l.eq(r);
    case "!=": return l.neq(r);
    case "<":  return l.lt(r);
    case "<=": return l.le(r);
    case ">":  return l.gt(r);
    case ">=": return l.ge(r);
  }
}
