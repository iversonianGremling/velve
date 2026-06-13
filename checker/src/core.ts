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
// SCOPE (D1(i)): single-clause `def`s; `Lit` (Str/Num/Bool/Unit); `Var`; arithmetic
// /comparison/equality `BinOp`; `UnOp`; saturated `Call` to a user `def` or a
// whitelisted pure builtin; tail-position `If` (incl. else-if ladders); `Do` blocks
// of `let`/expr statements. Everything else is refused LOUDLY via CompileUnsupported
// — the compiler's frontier is explicit, never a silent miscompile. `Match`, lists/
// records/tuples/closures-as-values, `Perform` (effects), and non-tail `if` join
// points are the next slices (D1(ii)+, D2).

import type { Module, Expr, Stmt, Lit, Pat } from "./ast.js";

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
  | { k: "PrimOp"; op: string; args: IRAtom[]; width?: Width };
// Ctor / Tuple / List / Record / Field / Index / Lambda / Perform — D1(ii)+, D2.

// Expressions — the ANF spine. (Match — D1(ii).)
export type IRExpr =
  | { k: "Ret"; atom: IRAtom }                          // tail / trivial return
  | { k: "Let"; name: string; comp: IRComp; body: IRExpr }
  | { k: "If"; cond: IRAtom; then: IRExpr; else_: IRExpr };

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
      case "Match": throw new CompileUnsupported("match (D1(ii))");
      default: {
        const c = this.norm(e, scope);
        return wrap(c.binds, { k: "Ret", atom: c.atom });
      }
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
