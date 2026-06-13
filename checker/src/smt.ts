// The Tier-2 Z3 back-end (north-star §3.3). One primitive serves every
// obligation: a set of facts that must be UNSAT over the reals.
//
//   • `nonzero` residue (facts.ts): path facts ∧ divisor == 0 — UNSAT means
//     the divisor is proved nonzero on that path.
//   • `@total` measure jobs (terminates.ts): per recursive call, path facts
//     ∧ ¬(arg ≤ param − 1), and path facts ∧ param < 0 — both UNSAT for one
//     argument position means the fn unit-decreases a floored measure. A
//     `floor(e)` term in any fact becomes a fresh Int-sorted const bracketed
//     by `e − 1 < ⌊e⌋ ≤ e` — integrality is what lets a halving measure prove
//     unit-decrease on span ∈ [1, 2) (⌊span/2⌋ is pinned to 0 there ≤ span − 1).
//   • `bounds` residue (facts.ts): two queries per index read — path facts
//     ∧ index < 0, and path facts ∧ index ≥ length(xs) — both UNSAT means
//     the read is in range. `length(x)` terms become Int-sorted constants
//     `len$x` with `len$x >= 0` asserted (the builtin's actual range);
//     Int-sortedness is what turns `length(xs) > 0` into ≥ 1, so the
//     last-element idiom `xs[length(xs) - 1]` proves.
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
import type { Span } from "./span.js";
import type { Diagnostic } from "./resolve.js";
import type { Obligation, Fact, BoundsObligation, ArithObligation, OverflowObligation, CmpOp } from "./facts.js";
import { residueFloorDiags, boundsFloorDiags, arithFloorDiags, overflowFloorDiags, widthRange, mkFact, numE, varE } from "./facts.js";
import type { MeasureJob } from "./terminates.js";
import { measureFailDiag } from "./terminates.js";

// Negate a domain constraint: `arg op k` must hold, so the solver looks for a
// model of `arg ¬op k` consistent with the path facts. UNSAT ⟹ proved.
const NEG_CONSTRAINT: Record<">=" | ">" | "<=" | "<", CmpOp> =
  { ">=": "<", ">": "<=", "<=": ">", "<": ">=" };

export async function discharge(residue: Obligation[], jobs: MeasureJob[], bounds: BoundsObligation[], arith: ArithObligation[], overflow: OverflowObligation[]): Promise<Diagnostic[]> {
  if (residue.length === 0 && jobs.length === 0 && bounds.length === 0 && arith.length === 0 && overflow.length === 0) return [];
  let z3: typeof import("z3-solver");
  try {
    z3 = await import("z3-solver");
  } catch {
    const hint = " [z3-solver is not installed — `npm install` in checker/ enables the Tier-2 solver fall-through]";
    return [
      ...residueFloorDiags(residue).map(d => ({ ...d, message: d.message + hint })),
      ...jobs.map(j => measureFailDiag(j.fnName, j.span, hint)),
      ...boundsFloorDiags(bounds).map(d => ({ ...d, message: d.message + hint })),
      ...arithFloorDiags(arith).map(d => ({ ...d, message: d.message + hint })),
      ...overflowFloorDiags(overflow).map(d => ({ ...d, message: d.message + hint })),
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

    for (const ob of bounds) {
      const lenE = lenCall(ob.obj, ob.span);
      const low = await checkUnsat(Z3, [...ob.facts, mkFact(ob.index, "<", numE(0, ob.span))]);
      const high = low.verdict === "unsat"
        ? await checkUnsat(Z3, [...ob.facts, mkFact(ob.index, ">=", lenE)])
        : null;
      if (high?.verdict === "unsat") continue;  // both sides proved
      const r = high ?? low;
      // A witness obligation is a call ARGUMENT demanded in range for the
      // callee's read (Tier-1.5, facts.ts) — same query, honest prose.
      const what = ob.witness ? "the argument" : "the index";
      const side = high ? `may reach length('${ob.obj}')` : "may be negative";
      const detail = r.verdict === "sat"
        ? `${what} ${side} — Z3 found a model consistent with every fact on this path (${r.example})`
        : `${what} ${side} — Z3 returned unknown, conservatively rejected`;
      diags.push({ kind: "error", span: ob.span,
        message: `proof obligation 'bounds': cannot prove ${ob.witness ? `witness '${ob.witness}'` : "the index in range"} — ${detail} (the module declares proofs: [bounds])` });
    }

    for (const ob of arith) {
      const neg = mkFact(ob.arg, NEG_CONSTRAINT[ob.need.op], numE(ob.need.k, ob.span));
      const r = await checkUnsat(Z3, [...ob.facts, neg]);
      if (r.verdict === "unsat") continue;  // argument proved inside the domain
      const detail = r.verdict === "sat"
        ? `Z3 found an out-of-domain argument consistent with every fact on this path (${r.example})`
        : "Z3 returned unknown — conservatively rejected";
      diags.push({ kind: "error", span: ob.span,
        message: `proof obligation 'arith': cannot prove ${ob.fn}'s argument ${ob.need.op} ${ob.need.k} — ${detail} (the module declares proofs: [arith])` });
    }

    // `overflow`: the same two-sided query as `bounds`, against the width's
    // range instead of a list length. result < min OR result > max both UNSAT
    // ⟹ the sum is proved in range; the seeds (`0 ≤ a ≤ 255` etc., facts.ts)
    // give the solver the operand ranges it needs to conclude.
    for (const ob of overflow) {
      const { min, max } = widthRange(ob.width);
      const low = await checkUnsat(Z3, [...ob.facts, mkFact(ob.result, "<", numE(min, ob.span))]);
      const high = low.verdict === "unsat"
        ? await checkUnsat(Z3, [...ob.facts, mkFact(ob.result, ">", numE(max, ob.span))])
        : null;
      if (high?.verdict === "unsat") continue;  // both sides proved
      const r = high ?? low;
      const side = high ? `may exceed ${max}` : `may fall below ${min}`;
      const detail = r.verdict === "sat"
        ? `the result ${side} — Z3 found a model consistent with every fact on this path (${r.example})`
        : `the result ${side} — Z3 returned unknown, conservatively rejected`;
      diags.push({ kind: "error", span: ob.span,
        message: `proof obligation 'overflow': cannot prove the ${ob.width.bits}-bit ${ob.width.signed ? "signed" : "unsigned"} result in range — ${detail} (the module declares proofs: [overflow])` });
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

// The synthesized `length(obj)` node for the upper-bound query — shaped
// exactly like a source-level builtin call, so `term` translates it the
// same way (a synthesized Var has no resolution entry, i.e. reads as the
// builtin, which it is).
function lenCall(obj: string, span: Span): Expr {
  return { tag: "Call", fn: varE("length", span), args: [varE(obj, span)], named: [], span };
}

// Assert every fact; UNSAT proves the conjunction impossible. SAT returns a
// model over the mentioned names as the counterexample. Length terms get
// Int-sorted constants with `>= 0` asserted — adding the builtin's true
// range only ever strengthens toward UNSAT, never weakens.
async function checkUnsat(Z3: Ctx, facts: Fact[]): Promise<{ verdict: string; example?: string }> {
  const names = new Set<string>(), lens = new Set<string>();
  const floors = new Map<string, Expr>();  // canonical key → the floored inner term
  for (const f of facts) {
    for (const n of f.names) names.add(n);
    collectInterp(f.lhs, lens, floors); collectInterp(f.rhs, lens, floors);
  }
  const consts = new Map([...names].map(n => [n, Z3.Real.const(n)] as const));
  // Int-sorted underneath, ToReal-wrapped so it compares against Real terms
  // (the wrap keeps the integrality constraint — that's the whole point).
  for (const n of lens) consts.set(`len$${n}`, Z3.ToReal(Z3.Int.const(`len$${n}`)));
  // `floor(e)` rides the SAME Int-sorted trick: a fresh integer per distinct
  // inner term, bracketed by `e − 1 < ⌊e⌋ ≤ e`. Create every floor const first
  // (a nested ⌊…⌊…⌋…⌋ inner refers to another), then assert the brackets.
  for (const k of floors.keys()) consts.set(`flr$${k}`, Z3.ToReal(Z3.Int.const(`flr$${k}`)));
  const solver = new Z3.Solver();
  for (const n of lens) solver.add(consts.get(`len$${n}`)!.ge(0));
  for (const [k, inner] of floors) {
    const f = consts.get(`flr$${k}`)!, ie = term(Z3, inner, consts);
    solver.add(f.le(ie));
    solver.add(f.gt(ie.sub(Z3.Real.val(1))));
  }
  for (const f of facts) solver.add(cmp(Z3, f, consts));
  const verdict = await solver.check();
  if (verdict !== "sat") return { verdict };
  const model = solver.model();
  const example = [...consts.entries()]
    .filter(([n]) => !lens.has(n) && !n.startsWith("flr$"))  // lists/floor-helpers have no standalone value
    .map(([n, c]) => `${n.replace(/^len\$(.*)$/, "length($1)")} = ${model.eval(c, true).toString()}`).join(", ");
  return { verdict, example };
}

// Interpreted-call occurrences inside a vetted fact term: `length(x)` (an Int
// length symbol) and `floor(e)` (an Int floored term). Shape-only on purpose —
// the collection side (facts.ts `lenArg`/`floorArg`) already vetted the callee
// resolves to the builtin before the term entered a fact.
function collectInterp(e: Expr, lens: Set<string>, floors: Map<string, Expr>): void {
  switch (e.tag) {
    case "Call": {
      const inner = floorInner(e);
      if (inner) { floors.set(floorKey(inner), inner); collectInterp(inner, lens, floors); return; }
      const a = e.args[0]; if (a?.tag === "Var") lens.add(a.name); return;
    }
    case "BinOp": collectInterp(e.left, lens, floors); collectInterp(e.right, lens, floors); return;
    case "UnOp": collectInterp(e.expr, lens, floors); return;
  }
}

// The floored inner term of a `floor(e)` / `Math.floor(e)` call, or null. Pure
// syntax (the fragment was vetted upstream), distinguishing floor from length
// by callee name so `floor(x)`'s arg is never mistaken for a length symbol.
function floorInner(e: Expr): Expr | null {
  if (e.tag !== "Call" || e.args.length !== 1) return null;
  const isFloor = (e.fn.tag === "Var" && e.fn.name === "floor")
    || (e.fn.tag === "Field" && e.fn.field === "floor");
  return isFloor ? (e.args[0] ?? null) : null;
}

// A canonical key for a floored inner term: two syntactically equal floors map
// to the SAME Int const (so they're provably equal). Only the translatable
// fragment reaches here.
function floorKey(e: Expr): string {
  switch (e.tag) {
    case "Var": return e.name;
    case "Lit": return e.lit.tag === "Num" ? String(e.lit.value) : "?";
    case "BinOp": return `(${floorKey(e.left)}${e.op}${floorKey(e.right)})`;
    case "UnOp": return `(${e.op}${floorKey(e.expr)})`;
    case "Call": {
      const inner = floorInner(e);
      if (inner) return `floor(${floorKey(inner)})`;
      const a = e.args[0];
      return a?.tag === "Var" ? `length(${a.name})` : "?";
    }
    default: return "?";
  }
}

// Both functions only ever see the `translatable` fragment (facts.ts) — the
// throw is an invariant violation, not a user error path.
function term(Z3: Ctx, e: Expr, consts: Map<string, Arith>): Arith {
  switch (e.tag) {
    case "Var": return consts.get(e.name)!;
    case "Call": {
      const inner = floorInner(e);
      if (inner) return consts.get(`flr$${floorKey(inner)}`)!;
      const a = e.args[0];
      if (a?.tag === "Var") return consts.get(`len$${a.name}`)!;
      break;
    }
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
