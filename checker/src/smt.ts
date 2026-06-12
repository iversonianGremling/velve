// The Tier-2 Z3 back-end (north-star §3.3). One primitive serves every
// obligation: a set of facts that must be UNSAT over the reals.
//
//   • `nonzero` residue (facts.ts): path facts ∧ divisor == 0 — UNSAT means
//     the divisor is proved nonzero on that path.
//   • `@total` measure jobs (terminates.ts): per recursive call, path facts
//     ∧ ¬(arg ≤ param − 1), and path facts ∧ param < 0 — both UNSAT for one
//     argument position means the fn unit-decreases a floored measure.
//
// SAT yields a counterexample (surfaced in the error), UNKNOWN is a
// conservative error. The solver only ever REMOVES errors the sync floor
// would have raised — a sat/unknown verdict produces the same class of error
// the LSP's floor fallback shows — so wiring Z3 in can never accept code the
// floor-only pipeline would (it accepts strictly more, errors strictly less).
//
// z3-solver loads LAZILY (the WASM init is ~120ms and spawns worker threads)
// and only here, so a check with nothing to discharge never pays for it; the
// CLI terminates the worker threads afterward or Node would never exit. If
// the package isn't installed, everything falls back to the floor error with
// an install hint appended — conservative, never a crash.
import type { Expr } from "./ast.js";
import type { Diagnostic } from "./resolve.js";
import type { Obligation, Fact } from "./facts.js";
import { residueFloorDiags, mkFact, numE } from "./facts.js";
import type { MeasureJob } from "./terminates.js";
import { measureFailDiag } from "./terminates.js";

export async function discharge(residue: Obligation[], jobs: MeasureJob[]): Promise<Diagnostic[]> {
  if (residue.length === 0 && jobs.length === 0) return [];
  let z3: typeof import("z3-solver");
  try {
    z3 = await import("z3-solver");
  } catch {
    const hint = " [z3-solver is not installed — `npm install` in checker/ enables the Tier-2 solver fall-through]";
    return [
      ...residueFloorDiags(residue).map(d => ({ ...d, message: d.message + hint })),
      ...jobs.map(j => measureFailDiag(j.fnName, j.span, hint)),
    ];
  }
  const { Context, em } = await z3.init();
  const Z3 = Context("main");
  const diags: Diagnostic[] = [];
  try {
    for (const ob of residue) {
      const r = await checkUnsat(Z3, [...ob.facts, mkFact(ob.divisor, "==", numE(0, ob.span))]);
      if (r.verdict === "unsat") continue;  // proved nonzero on this path
      const detail = r.verdict === "sat"
        ? `Z3 found a zero divisor consistent with every fact on this path (${r.example})`
        : "Z3 returned unknown — conservatively rejected";
      diags.push({ kind: "error", span: ob.span,
        message: `proof obligation 'nonzero': cannot prove the divisor nonzero — ${detail} (the module declares proofs: [nonzero])` });
    }

    for (const job of jobs) {
      let detail = "";
      let proved = false;
      for (const attempt of job.attempts) {
        let ok = true;
        for (const q of attempt.queries) {
          const r = await checkUnsat(Z3, q);
          if (r.verdict !== "unsat") {
            ok = false;
            // Keep the FIRST attempt's counterexample — earlier positions are
            // the likelier intended measure, so their model names the bug.
            if (detail === "")
              detail = r.verdict === "sat"
                ? ` (at parameter ${attempt.pos + 1} e.g. ${r.example})`
                : ` (Z3 returned unknown at parameter ${attempt.pos + 1})`;
            break;
          }
        }
        if (ok) { proved = true; break; }
      }
      if (!proved) diags.push(measureFailDiag(job.fnName, job.span, detail));
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

// Assert every fact; UNSAT proves the conjunction impossible. SAT returns a
// model over the mentioned names as the counterexample.
async function checkUnsat(Z3: Ctx, facts: Fact[]): Promise<{ verdict: string; example?: string }> {
  const names = new Set<string>();
  for (const f of facts) for (const n of f.names) names.add(n);
  const consts = new Map([...names].map(n => [n, Z3.Real.const(n)] as const));
  const solver = new Z3.Solver();
  for (const f of facts) solver.add(cmp(Z3, f, consts));
  const verdict = await solver.check();
  if (verdict !== "sat") return { verdict };
  const model = solver.model();
  const example = [...consts.entries()]
    .map(([n, c]) => `${n} = ${model.eval(c, true).toString()}`).join(", ");
  return { verdict, example };
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
      if (e.op === "/") return l.div(r);  // divisor is a nonzero literal (translatable)
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
