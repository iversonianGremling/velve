// The Tier-2 Z3 measure check for `@total` (north-star §3.3; the
// `proof.terminates` fall-through totality-design §3 promised). Takes the
// fns Tier-1 handed over (total.ts MeasureCandidate: the decrease check was
// the ONLY failure) and tries to prove, per argument position, that every
// recursive call UNIT-DECREASES a floored measure:
//
//   for each recursive call with path facts F, measure param n, arg e:
//     F ⟹ e ≤ n − 1     (decrease by at least 1)
//     F ⟹ n ≥ 0         (bounded below on every recursing path)
//
// Both are refutation queries (assert F plus the negation; UNSAT ⟹ proved),
// so they ride the same smt.ts engine as `nonzero`. One position where every
// call proves ⟹ the fn terminates: depth is bounded by the measure at entry.
//
// Unit decrease over the REALS is what makes this sound for Velve's float
// Numbers — strict decrease alone is not well-founded (n/2 walks 1, ½, ¼, …
// forever), but stepping by ≥ 1 above a floor is finite. This is why
// `halve(n / 2)` needs its guard to exclude (0, 2): `if n < 2` proves
// (n ≥ 2 ⟹ n/2 ≤ n − 1), `if n <= 0` does not — and Z3's counterexample
// (n = 1) says exactly that. Honesty bound, same family as Number ≠ Nat: at
// magnitudes ≥ 2^53 float rounding can absorb a unit decrease (1e300 - 1 ==
// 1e300), so the proof is exact only below that.
//
// The fact env (facts.ts) supplies F — if/match/guard facts plus multi-clause
// literal heads — which is what lets a NON-CONSTANT decrease prove:
// `shrink(n - k, k)` under `k >= 1` is beyond any structural check.
//
// A FLOORED measure rides the same engine with no change here: `floor(e)` is
// now in the translatable fragment (facts.ts), modeled by smt.ts as an
// Int-sorted term bracketed by e − 1 < ⌊e⌋ ≤ e. A binary search recursing on
// `floor(span / 2)` then proves unit-decrease — over ℝ that halving overshoots
// for span ∈ [1, 2), but integrality pins ⌊span/2⌋ to 0 there, which IS
// ≤ span − 1 (the runtime-floor analog of the bounds-soundness argument). The
// existing "unit decrease over ℝ above a floor is finite" soundness covers it.
import type { Expr, FnClause } from "./ast.js";
import type { Span } from "./span.js";
import type { Diagnostic, ResolutionMap } from "./resolve.js";
import type { MeasureCandidate } from "./total.js";
import type { Fact, Env } from "./facts.js";
import { walkFacts, clauseEnv, translatable, mkFact, varE, numE } from "./facts.js";

// One argument position's proof attempt: every query must be UNSAT.
export interface MeasureAttempt { pos: number; queries: Fact[][] }

export interface MeasureJob {
  fnName: string;
  span: Span;                 // the offending recursive call (error position)
  attempts: MeasureAttempt[]; // any attempt fully UNSAT ⟹ the fn proves
}

export interface MeasureBuild { jobs: MeasureJob[]; diagnostics: Diagnostic[] }

export function measureFailDiag(name: string, span: Span, detail: string): Diagnostic {
  return { kind: "error", span,
    message: `@total function '${name}' may not terminate — no argument position structurally decreases across every recursive call, and the Z3 measure check could not prove a unit decrease with floor${detail}` };
}

// Build the solver jobs. Candidates where NO position yields translatable
// queries fail here, sync — same conservative message the solver path uses.
export function buildMeasureJobs(candidates: MeasureCandidate[], resolutions: ResolutionMap): MeasureBuild {
  const out: MeasureBuild = { jobs: [], diagnostics: [] };
  for (const c of candidates) {
    const attempts: MeasureAttempt[] = [];
    const arity = c.decl.clauses[0]?.params.length ?? 0;
    for (let pos = 0; pos < arity; pos++) {
      const attempt = buildAttempt(c.decl.name, c.decl.clauses, pos, resolutions);
      if (attempt) attempts.push(attempt);
    }
    if (attempts.length === 0)
      out.diagnostics.push(measureFailDiag(c.decl.name, c.span,
        " (no argument position is a solver-translatable measure)"));
    else
      out.jobs.push({ fnName: c.decl.name, span: c.span, attempts });
  }
  return out;
}

// One position across every clause: each clause must bind a plain name
// there, and every recursive call must pass a translatable term at it.
function buildAttempt(fnName: string, clauses: FnClause[], pos: number, resolutions: ResolutionMap): MeasureAttempt | null {
  const queries: Fact[][] = [];
  for (const [ci, clause] of clauses.entries()) {
    const pat = clause.params[pos]?.pat;
    if (pat?.tag !== "PVar" && pat?.tag !== "PTyped") return null;
    const param = pat.name;
    let viable = true;
    walkFacts(clause.body, clauseEnv(clauses, ci), (e: Expr, env: Env) => {
      if (!viable || e.tag !== "Call") return;
      if (e.fn.tag !== "Var" || e.fn.name !== fnName) return;
      if (resolutions.get(e.fn)?.kind !== "fn") return;  // shadowed: not a recursive call
      const arg = e.args[pos];
      if (!arg || e.named.length > 0 || !translatable(arg)) { viable = false; return; }
      const paramV = varE(param, e.span);
      // decrease: F ∧ arg > param - 1 must be unsat
      queries.push([...env, mkFact(arg, ">", { tag: "BinOp", op: "-", left: paramV, right: numE(1, e.span), span: e.span })]);
      // floor: F ∧ param < 0 must be unsat
      queries.push([...env, mkFact(paramV, "<", numE(0, e.span))]);
    }, resolutions);
    if (!viable) return null;
  }
  return queries.length > 0 ? { pos, queries } : null;
}
