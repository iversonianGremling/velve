// core.ts — Velve Core IR (the D0 grammar, compiler-architecture-design §11.3) and
// the AST→Core lowering for the **pure compute spine** (D1(i)).
//
// This is the first real backend code. It honors the D0 contract: a fresh, small,
// normalized IR — NOT the annotated AST — in A-Normal Form (every non-trivial
// subexpression is named by a `Let`, every operand is an atom). The erasure law
// (§11.5) holds by construction here: nothing type-level is carried across this
// frontier. Units, refinement predicates, error/effect rows, taint, totality are
// already discharged upstream and simply do not appear below — the lone survivor,
// the width tag, rides `PrimOp` as inert metadata (unset on this JS-only slice).
//
// SCOPE (through D1(iii) tuples): single-clause `def`s; `Lit` (Str/Num/Bool/Unit);
// `Var`; arithmetic/comparison/equality `BinOp`; `UnOp`; saturated `Call` to a user
// `def` or a whitelisted pure builtin; tail-position `If` (incl. else-if ladders);
// `Do` blocks of `let`/expr statements; scalar `match` (D1(ii)); and TUPLES — built
// as values and destructured in `match` arms via positional `PTuple` patterns
// (D1(iii)). Everything else is refused LOUDLY via CompileUnsupported — the frontier
// is explicit, never a silent miscompile. ADT ctors, lists, records, closures-as-
// values, destructuring `let`/params, `Perform` (effects), and non-tail `if` join
// points are the next slices (D1(iii)+, D2).

import type { Module, Expr, Stmt, Lit, Pat, Branch } from "./ast.js";

// ── The node grammar (§11.3) ────────────────────────────────────────────────────

export type IRLit =
  | { t: "Num"; v: number }
  | { t: "Str"; v: string }
  | { t: "Bool"; v: boolean }
  | { t: "Unit" };

// Atoms are trivial — pure, no naming needed.
export type IRAtom =
  | { k: "Lit"; lit: IRLit }
  | { k: "Var"; name: string };

// The width tag the erasure law lets survive: a *representation* choice for native/
// WASM, dropped by JS. Unset throughout this slice (a Num is just a Num on JS).
export type Width = { bits: number; signed: boolean };

// Computations — everything with a value to name; each is the RHS of a `Let`.
export type IRComp =
  | { k: "Atom"; atom: IRAtom }
  | { k: "Call"; fn: string; args: IRAtom[] }          // saturated; fn is a name
  | { k: "PrimOp"; op: string; args: IRAtom[]; width?: Width }
  | { k: "Tuple"; elems: IRAtom[] }                    // build a positional aggregate
  | { k: "Proj"; tuple: IRAtom; index: number };       // read element `index` of a tuple
// Ctor / List / Record / Field / Index / Lambda / Perform — D1(iii)+, D2.

// Expressions — the ANF spine. `Match` does NOT survive into the IR: D1(ii) lowers
// it to the `If`/`Let` decision-spine already here (classic match compilation), so
// the backend never grows a pattern-matching node. `Fail` is the one addition — the
// fall-through when no branch matches, mirroring eval's non-exhaustive RuntimeError.
// The checker's `exhaust` pass means valid programs never reach it; it is a witnessed
// safety net, not a path the differential harness ever exercises.
export type IRExpr =
  | { k: "Ret"; atom: IRAtom }                          // tail / trivial return
  | { k: "Let"; name: string; comp: IRComp; body: IRExpr }
  | { k: "If"; cond: IRAtom; then: IRExpr; else_: IRExpr }
  | { k: "Fail"; msg: string };                         // non-exhaustive fall-through

export interface IRFn { name: string; params: string[]; body: IRExpr }
export interface IRModule { fns: IRFn[]; hasMain: boolean }

// The loud frontier: any AST form outside the supported core throws this, so the
// differential harness reports the file `unsupported` (a clean refusal) rather than
// emitting JS that miscomputes or crashes. The backend-slice analogue of a `_bad`
// guardrail: the guarantee is "refuse, never lie", asserted by the harness.
export class CompileUnsupported extends Error {
  constructor(public form: string) {
    super(`Velve Core (D1): unsupported form — ${form}`);
    this.name = "CompileUnsupported";
  }
}

// The pure builtin surface this slice emits (mapped to a JS prelude in emitjs.ts).
// A `Call` to anything outside this set ∪ the module's own `def`s is refused.
export const BUILTINS = new Set([
  "print", "println", "toString",
  "abs", "floor", "ceil", "round", "sqrt", "int", "max", "min",
]);

// ── Lowering ────────────────────────────────────────────────────────────────────

interface Bind { name: string; comp: IRComp }

// One step of a compiled pattern: introduce a name, or assert an atom is truthy
// (else the branch falls through). A flat list of these folds into the decision-spine.
type MatchStep =
  | { s: "bind"; bind: Bind }
  | { s: "test"; binds: Bind[]; atom: IRAtom };

class Lowering {
  private n = 0;
  constructor(private userFns: Set<string>) {}
  private fresh(): string { return `_t${this.n++}`; }

  fn(params: string[], body: Expr): IRExpr {
    return this.tail(body, new Set(params));
  }

  // Tail position — yields an IRExpr (the `If`/`Ret` spine).
  private tail(e: Expr, scope: Set<string>): IRExpr {
    switch (e.tag) {
      case "Do": return this.block(e.stmts, scope);
      case "If": {
        const c = this.norm(e.cond, scope);
        const then = this.tail(e.then, new Set(scope));
        const els = e.else_ ? this.tail(e.else_, new Set(scope)) : RET_UNIT;
        return wrap(c.binds, { k: "If", cond: c.atom, then, else_: els });
      }
      case "Match": return this.matchE(e.subject, e.branches, scope);
      default: {
        const c = this.norm(e, scope);
        return wrap(c.binds, { k: "Ret", atom: c.atom });
      }
    }
  }

  // `match` lowering (D1(ii)). The subject is named once; branches compile to a
  // nested `If` decision-spine built back-to-front, terminating in `Fail`. Only
  // SCALAR patterns are in this slice — PWild/PVar/PTyped (irrefutable, maybe bind)
  // and PLit (an `==` test). Constructor/tuple/record/atom patterns destructure
  // heap values that the compute spine has no values for yet, so they trip the
  // frontier (D1(iii)). Match is supported in TAIL position only; as a mid-block
  // value it still routes through normComp's default → CompileUnsupported.
  private matchE(subjectExpr: Expr, branches: Branch[], scope: Set<string>): IRExpr {
    const s = this.norm(subjectExpr, scope);
    let chain: IRExpr = { k: "Fail", msg: "non-exhaustive match" };
    for (let i = branches.length - 1; i >= 0; i--) {
      chain = this.branch(branches[i]!, s.atom, scope, chain);
    }
    return wrap(s.binds, chain);
  }

  // One branch: if its pattern matches the subject atom (and any guard holds), run
  // the body in the extended scope; otherwise fall through to `next`. The pattern
  // compiles to a flat list of `MatchStep`s (binds and truthy-tests, in order);
  // folding them back-to-front threads each test's else-edge to `next`, so any
  // failure anywhere in a nested pattern falls through cleanly.
  private branch(br: Branch, subj: IRAtom, scope: Set<string>, next: IRExpr): IRExpr {
    const p = this.pattern(br.pat, subj, scope);
    let then = this.tail(br.body, p.scope);
    if (br.guard) {
      const g = this.norm(br.guard, p.scope);
      then = wrap(g.binds, { k: "If", cond: g.atom, then, else_: next });
    }
    for (let i = p.steps.length - 1; i >= 0; i--) {
      const st = p.steps[i]!;
      if (st.s === "bind") then = { k: "Let", name: st.bind.name, comp: st.bind.comp, body: then };
      else then = wrap(st.binds, { k: "If", cond: st.atom, then, else_: next });
    }
    return then;
  }

  // Compile a pattern against the subject atom into an ordered `MatchStep[]`: a
  // `bind` introduces a name (a variable, or a tuple-element projection), a `test`
  // is an atom that must be truthy or the branch falls through. `scope` is the body
  // scope after the pattern's bindings. Mirrors eval.ts matchInto: PLit compares
  // with `==` (eval's strict `v === lit.value`); PTuple projects each slot and
  // recurses (the arity is type-guaranteed, so the tuple shape itself is no test).
  private pattern(p: Pat, subj: IRAtom, scope: Set<string>):
    { steps: MatchStep[]; scope: Set<string> } {
    switch (p.tag) {
      case "PWild":
        return { steps: [], scope };
      case "PVar": case "PTyped": {
        // `match n | n -> …` binds the subject to its own name: emitting `const n = n`
        // is a TDZ crash in JS. The rebind is identity — the name is already in scope
        // holding that value — so skip it. (eval gets this free via env child.)
        if (subj.k === "Var" && subj.name === p.name) return { steps: [], scope };
        const ns = new Set(scope); ns.add(p.name);
        return { steps: [{ s: "bind", bind: { name: p.name, comp: { k: "Atom", atom: subj } } }], scope: ns };
      }
      case "PLit": {
        const litAtom: IRAtom = { k: "Lit", lit: lowerLit(p.lit) };
        const t = this.fresh();
        return {
          steps: [{ s: "test", binds: [{ name: t, comp: { k: "PrimOp", op: "==", args: [subj, litAtom] } }], atom: { k: "Var", name: t } }],
          scope,
        };
      }
      case "PTuple": {
        // Project each slot to a fresh name, then recurse the sub-pattern against it.
        // Projection binds precede the sub-pattern's steps, so nested tests see the
        // already-extracted element. Scope accumulates left-to-right across slots.
        const steps: MatchStep[] = [];
        let sc = scope;
        for (let i = 0; i < p.elems.length; i++) {
          const slot = this.fresh();
          steps.push({ s: "bind", bind: { name: slot, comp: { k: "Proj", tuple: subj, index: i } } });
          const sub = this.pattern(p.elems[i]!, { k: "Var", name: slot }, sc);
          steps.push(...sub.steps);
          sc = sub.scope;
        }
        return { steps, scope: sc };
      }
      default:
        throw new CompileUnsupported(`match pattern ${p.tag} (heap-value destructuring — D1(iii)+)`);
    }
  }

  // A `Do`/`Try`-free block of statements; the last statement is the block's value.
  private block(stmts: Stmt[], scope: Set<string>): IRExpr {
    if (stmts.length === 0) return RET_UNIT;
    const head = stmts[0]!;
    const rest = stmts.slice(1);
    const last = rest.length === 0;
    switch (head.tag) {
      case "SBind": {
        if (!head.declares) throw new CompileUnsupported("reassignment (D1 later)");
        const name = patName(head.pat);
        const c = this.normComp(head.value, scope);
        const next = new Set(scope); next.add(name);
        // A trailing `let` makes the block's value Unit (it binds, yields nothing).
        const cont = last ? RET_UNIT : this.block(rest, next);
        return wrap(c.binds, { k: "Let", name, comp: c.comp, body: cont });
      }
      case "SExpr": {
        if (last) return this.tail(head.expr, scope);
        const c = this.normComp(head.expr, scope);
        return wrap(c.binds, { k: "Let", name: this.fresh(), comp: c.comp, body: this.block(rest, scope) });
      }
      case "SReturn":
        return head.value ? this.tail(head.value, scope) : RET_UNIT;
      default:
        throw new CompileUnsupported(`statement ${head.tag}`);
    }
  }

  // Normalize an expression to an ATOM, accumulating the `Let`-able binds it needs.
  private norm(e: Expr, scope: Set<string>): { binds: Bind[]; atom: IRAtom } {
    if (e.tag === "Lit") return { binds: [], atom: { k: "Lit", lit: lowerLit(e.lit) } };
    if (e.tag === "Var") {
      if (!scope.has(e.name)) throw new CompileUnsupported(`free variable '${e.name}' (no first-class fns/ctors yet)`);
      return { binds: [], atom: { k: "Var", name: e.name } };
    }
    const c = this.normComp(e, scope);
    const t = this.fresh();
    return { binds: [...c.binds, { name: t, comp: c.comp }], atom: { k: "Var", name: t } };
  }

  // Normalize an expression to a COMPUTATION (the RHS of a `Let`).
  private normComp(e: Expr, scope: Set<string>): { binds: Bind[]; comp: IRComp } {
    switch (e.tag) {
      case "Lit": return { binds: [], comp: { k: "Atom", atom: { k: "Lit", lit: lowerLit(e.lit) } } };
      case "Var": {
        if (!scope.has(e.name)) throw new CompileUnsupported(`free variable '${e.name}'`);
        return { binds: [], comp: { k: "Atom", atom: { k: "Var", name: e.name } } };
      }
      case "BinOp": {
        // Short-circuit `&&`/`||` and pipe `|>` need control flow / first-class fns;
        // they join in a later slice. Arithmetic/comparison/equality/`++` are pure
        // strict PrimOps.
        if (!ARITH.has(e.op)) throw new CompileUnsupported(`operator '${e.op}' (D1 later)`);
        const l = this.norm(e.left, scope), r = this.norm(e.right, scope);
        return { binds: [...l.binds, ...r.binds], comp: { k: "PrimOp", op: e.op, args: [l.atom, r.atom] } };
      }
      case "UnOp": {
        const x = this.norm(e.expr, scope);
        return { binds: x.binds, comp: { k: "PrimOp", op: "u" + e.op, args: [x.atom] } };
      }
      case "Tuple": {
        // The first heap value (D1(iii)). Positional, fixed-arity; each element
        // normalizes to an atom. Display is `(a, b, …)` — the runtime `$tuple`
        // wrapper carries a tag so `$show` reproduces value.ts's VTuple exactly.
        const parts = e.elems.map(x => this.norm(x, scope));
        return { binds: parts.flatMap(p => p.binds), comp: { k: "Tuple", elems: parts.map(p => p.atom) } };
      }
      case "Call": {
        if (e.fn.tag !== "Var") throw new CompileUnsupported("call of a computed function");
        if (e.named.length) throw new CompileUnsupported("named arguments (D1 later)");
        const fn = e.fn.name;
        if (!this.userFns.has(fn) && !BUILTINS.has(fn))
          throw new CompileUnsupported(`call to '${fn}' (not a def or supported builtin)`);
        const parts = e.args.map(a => this.norm(a, scope));
        return { binds: parts.flatMap(p => p.binds), comp: { k: "Call", fn, args: parts.map(p => p.atom) } };
      }
      default:
        throw new CompileUnsupported(e.tag);
    }
  }
}

const RET_UNIT: IRExpr = { k: "Ret", atom: { k: "Lit", lit: { t: "Unit" } } };

// Strict, pure operators that map 1:1 onto a JS operator (emitjs.ts owns the table).
const ARITH = new Set(["+", "-", "*", "/", "%", "**", "^", "<", ">", "<=", ">=", "==", "!=", "++"]);

function wrap(binds: Bind[], body: IRExpr): IRExpr {
  let e = body;
  for (let i = binds.length - 1; i >= 0; i--) { const b = binds[i]!; e = { k: "Let", name: b.name, comp: b.comp, body: e }; }
  return e;
}

function lowerLit(l: Lit): IRLit {
  switch (l.tag) {
    case "Num":  return { t: "Num", v: l.value };
    case "Str":  return { t: "Str", v: l.value };
    case "Bool": return { t: "Bool", v: l.value };
    case "Unit": return { t: "Unit" };
    // :atoms fold to tagged runtime values and Durations fold to Num(ms) (§11.3);
    // both land in a later slice — refuse rather than guess their `display`.
    case "Atom":     throw new CompileUnsupported(`atom literal :${l.name}`);
    case "Duration": throw new CompileUnsupported("duration literal");
  }
}

function patName(p: Pat): string {
  if (p.tag === "PVar") return p.name;
  if (p.tag === "PTyped") return p.name;
  if (p.tag === "PWild") return "_";
  throw new CompileUnsupported(`binding pattern ${p.tag}`);
}

export function lowerModule(mod: Module): IRModule {
  const userFns = new Set<string>();
  for (const d of mod.decls) if (d.tag === "DFn") userFns.add(d.name);

  const fns: IRFn[] = [];
  let hasMain = false;
  for (const d of mod.decls) {
    // Non-`def` decls carry no top-level runtime computation in the pure core
    // (a `type`'s constructors, an `import`'s names): skip them. Any *use* of what
    // they introduce trips the frontier inside the def that uses it.
    if (d.tag !== "DFn") continue;
    if (d.clauses.length !== 1) throw new CompileUnsupported(`multi-clause def '${d.name}' (D1(ii))`);
    const cl = d.clauses[0]!;
    const params = cl.params.map(p => patName(p.pat));
    fns.push({ name: d.name, params, body: new Lowering(userFns).fn(params, cl.body) });
    if (d.name === "main") hasMain = true;
  }
  return { fns, hasMain };
}
