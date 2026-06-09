import type { Span } from "./span.js";
import { freshVar, typeToString } from "./types.js";
import { stdlibLookup, stdlibModule } from "./stdlib.js";
import type { Type, Field } from "./types.js";
import type {
  Module, Decl, Expr, Stmt, Pat, FnClause, FnSig, SagaStmt,
  TypeRef, Lit, Param,
} from "./ast.js";
import type { ResolutionMap, Diagnostic } from "./resolve.js";
import { resolveNamedCall, needsResolution, type ParamSlot } from "./callresolve.js";

// ── Type schemes ──────────────────────────────────────────────────────────────

interface Scheme {
  forall: number[];
  type: Type;
}

function mono(t: Type): Scheme { return { forall: [], type: t }; }

function instantiate(s: Scheme): Type {
  if (s.forall.length === 0) return s.type;
  const sub = new Map<number, Type>();
  for (const id of s.forall) sub.set(id, freshVar());
  return substVars(s.type, sub);
}

function generalize(env: TypeEnv, subst: Subst, t: Type): Scheme {
  const envFree = env.freeVars(subst);
  const free = [...freeVars(subst.apply(t))].filter(id => !envFree.has(id));
  return { forall: free, type: subst.apply(t) };
}

// ── Substitution ──────────────────────────────────────────────────────────────

class Subst {
  private map = new Map<number, Type>();

  extend(id: number, t: Type): void {
    const resolved = this.apply(t);
    if (resolved.tag === "Var" && resolved.id === id) return;
    if (freeVars(resolved).has(id)) return; // occurs check — skip infinite types
    for (const [k, v] of this.map) this.map.set(k, applyOne(v, id, resolved));
    this.map.set(id, resolved);
  }

  apply(t: Type): Type {
    switch (t.tag) {
      case "Var":        return this.map.get(t.id) ?? t;
      case "Prim": case "Atom": case "Unknown": return t;
      case "Named":      return { ...t, args: t.args.map(a => this.apply(a)) };
      case "Fn":         return { ...t, params: t.params.map(p => this.apply(p)), ret: this.apply(t.ret) };
      case "SagaFn":     return { ...t, params: t.params.map(p => this.apply(p)), ret: this.apply(t.ret) };
      case "Tuple":      return { ...t, elems: t.elems.map(e => this.apply(e)) };
      case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: this.apply(f.type) })) };
      case "Tainted":    return { ...t, inner: this.apply(t.inner) };
      case "Async":      return { ...t, inner: this.apply(t.inner) };
      case "Stream":     return { ...t, inner: this.apply(t.inner) };
      case "Refinement": return { ...t, base: this.apply(t.base) };
    }
  }
}

function applyOne(t: Type, id: number, rep: Type): Type {
  switch (t.tag) {
    case "Var":        return t.id === id ? rep : t;
    case "Prim": case "Atom": case "Unknown": return t;
    case "Named":      return { ...t, args: t.args.map(a => applyOne(a, id, rep)) };
    case "Fn":         return { ...t, params: t.params.map(p => applyOne(p, id, rep)), ret: applyOne(t.ret, id, rep) };
    case "SagaFn":     return { ...t, params: t.params.map(p => applyOne(p, id, rep)), ret: applyOne(t.ret, id, rep) };
    case "Tuple":      return { ...t, elems: t.elems.map(e => applyOne(e, id, rep)) };
    case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: applyOne(f.type, id, rep) })) };
    case "Tainted":    return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Async":      return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Stream":     return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Refinement": return { ...t, base: applyOne(t.base, id, rep) };
  }
}

function freeVars(t: Type): Set<number> {
  const s = new Set<number>();
  collectFree(t, s);
  return s;
}

function collectFree(t: Type, acc: Set<number>): void {
  switch (t.tag) {
    case "Var":        acc.add(t.id); break;
    case "Named":      t.args.forEach(a => collectFree(a, acc)); break;
    case "Fn":         t.params.forEach(p => collectFree(p, acc)); collectFree(t.ret, acc); break;
    case "SagaFn":     t.params.forEach(p => collectFree(p, acc)); collectFree(t.ret, acc); break;
    case "Tuple":      t.elems.forEach(e => collectFree(e, acc)); break;
    case "Record":     t.fields.forEach(f => collectFree(f.type, acc)); break;
    case "Tainted": case "Async": case "Stream": collectFree(t.inner, acc); break;
    case "Refinement": collectFree(t.base, acc); break;
  }
}

function substVars(t: Type, sub: Map<number, Type>): Type {
  switch (t.tag) {
    case "Var":        return sub.get(t.id) ?? t;
    case "Named":      return { ...t, args: t.args.map(a => substVars(a, sub)) };
    case "Fn":         return { ...t, params: t.params.map(p => substVars(p, sub)), ret: substVars(t.ret, sub) };
    case "SagaFn":     return { ...t, params: t.params.map(p => substVars(p, sub)), ret: substVars(t.ret, sub) };
    case "Tuple":      return { ...t, elems: t.elems.map(e => substVars(e, sub)) };
    case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: substVars(f.type, sub) })) };
    case "Tainted":    return { ...t, inner: substVars(t.inner, sub) };
    case "Async":      return { ...t, inner: substVars(t.inner, sub) };
    case "Stream":     return { ...t, inner: substVars(t.inner, sub) };
    case "Refinement": return { ...t, base: substVars(t.base, sub) };
    default:           return t;
  }
}

// ── Type environment ──────────────────────────────────────────────────────────

class TypeEnv {
  private schemes = new Map<string, Scheme>();
  constructor(public readonly parent: TypeEnv | null = null) {}

  define(name: string, s: Scheme): void { this.schemes.set(name, s); }
  defineMono(name: string, t: Type): void { this.define(name, mono(t)); }

  lookup(name: string): Scheme | null {
    return this.schemes.get(name) ?? this.parent?.lookup(name) ?? null;
  }

  child(): TypeEnv { return new TypeEnv(this); }

  allSchemes(): Map<string, Scheme> {
    const result = new Map<string, Scheme>();
    let e: TypeEnv | null = this;
    while (e) {
      for (const [name, scheme] of e.schemes) {
        if (!result.has(name)) result.set(name, scheme);
      }
      e = e.parent;
    }
    return result;
  }

  // Free type variables across all schemes in this env chain (excluding quantified ones).
  freeVars(subst: Subst): Set<number> {
    const s = new Set<number>();
    let e: TypeEnv | null = this;
    while (e) {
      for (const scheme of e.schemes.values()) {
        for (const id of freeVars(subst.apply(scheme.type))) {
          if (!scheme.forall.includes(id)) s.add(id);
        }
      }
      e = e.parent;
    }
    return s;
  }
}

// ── TypeRef → Type ────────────────────────────────────────────────────────────

// Registry of declared type aliases (and refinements), populated once per `infer`
// run before any body is type-checked. A refinement (`type T = Base where p`) is
// transparent for typing — it resolves to `Base`, so `T` is usable anywhere `Base`
// is; the predicate is only enforced at runtime via `T.parse`.
let TYPE_ALIASES = new Map<string, { params: string[]; body: TypeRef }>();
// Refinement types (`type T = Base where p`) are kept separately: they resolve to
// a `Refinement` type (transparent to `Base` during unification) that still carries
// the predicate AST, so literal arguments can be checked at compile time.
// A refinement may be DEPENDENT — parameterized over value(s) its predicate
// references (`type InBounds n = Number where 0 <= value && value < n`). `params`
// holds those parameter names; at a call site they're bound from the dependent
// argument expressions carried on the use (`InBounds(listLength xs)`).
let REFINEMENTS = new Map<string, { params: string[]; baseRef: TypeRef; pred: Expr }>();
// Function parameter names (first clause), so a dependent refinement argument like
// `listLength list` can be resolved against the actual call arguments.
let FN_PARAMS = new Map<string, string[]>();
// Full parameter slots (first clause) for named-argument / default resolution.
let FN_SIGS = new Map<string, ParamSlot[]>();
const ALIAS_RESOLVING = new Set<string>();   // cycle guard

function resolveRef(ref: TypeRef, tp: Map<string, Type>, sagas?: Map<string, Type>): Type {
  switch (ref.tag) {
    case "TRNamed": {
      if (tp.has(ref.name)) return tp.get(ref.name)!;
      const refinement = REFINEMENTS.get(ref.name);
      if (refinement && !ALIAS_RESOLVING.has(ref.name)) {
        ALIAS_RESOLVING.add(ref.name);
        // Bind the refinement's params into the base just like a type alias, so a
        // type argument flows through (`NonEmpty(Number)` → base `List(Number)`).
        // A dependent VALUE argument (TRExpr) resolves to Unknown here — it never
        // appears in the base, only in the predicate (folded at the call site).
        const localTp = new Map(tp);
        refinement.params.forEach((p, i) =>
          localTp.set(p, ref.args[i] ? resolveRef(ref.args[i]!, tp, sagas) : freshVar(p)));
        const base = resolveRef(refinement.baseRef, localTp, sagas);
        ALIAS_RESOLVING.delete(ref.name);
        // Carry dependent value-arguments (`InBounds(length xs)`) positionally,
        // aligned with the refinement's params, so they can be folded at call sites.
        const depArgs = ref.args.map(a => (a.tag === "TRExpr" ? a.expr : null));
        return depArgs.some(Boolean)
          ? { tag: "Refinement", base, pred: ref.name, args: depArgs }
          : { tag: "Refinement", base, pred: ref.name };
      }
      const alias = TYPE_ALIASES.get(ref.name);
      if (alias && !ALIAS_RESOLVING.has(ref.name)) {
        ALIAS_RESOLVING.add(ref.name);
        const localTp = new Map(tp);
        alias.params.forEach((p, i) =>
          localTp.set(p, ref.args[i] ? resolveRef(ref.args[i]!, tp, sagas) : freshVar(p)));
        const expanded = resolveRef(alias.body, localTp, sagas);
        ALIAS_RESOLVING.delete(ref.name);
        return expanded;
      }
      const args = ref.args.map(a => resolveRef(a, tp, sagas));
      // A bare saga name used as a type annotation means "a handle for this saga".
      if (sagas?.has(ref.name) && ref.args.length === 0)
        return { tag: "Named", name: "Saga", args: [sagas.get(ref.name)!] };
      switch (ref.name) {
        case "String":  return { tag: "Prim", kind: "String" };
        case "Number":  return { tag: "Prim", kind: "Number" };
        case "Bool":    return { tag: "Prim", kind: "Bool" };
        case "()":      return { tag: "Prim", kind: "Unit" };
        case "Unknown": return { tag: "Unknown" };
        // A `Stream(T)` annotation must resolve to the canonical Stream variant, not a
        // generic Named, so it unifies with stream values and combinator results.
        case "Stream":  return { tag: "Stream", inner: args[0] ?? freshVar() };
        case "Async":   return { tag: "Async",  inner: args[0] ?? freshVar() };
        default:        return { tag: "Named", name: ref.name, args };
      }
    }
    case "TRAtom":   return { tag: "Atom", name: ref.name };
    case "TRFn":     return { tag: "Fn", params: ref.params.map(p => resolveRef(p, tp, sagas)), ret: resolveRef(ref.ret, tp, sagas), effects: ref.effects };
    case "TRTuple":  return { tag: "Tuple", elems: ref.elems.map(e => resolveRef(e, tp, sagas)) };
    case "TRRecord": return { tag: "Record", fields: ref.fields.map(f => ({ name: f.name, type: resolveRef(f.type, tp, sagas), optional: f.optional })) };
    case "TRPtr":    return { tag: "Named", name: "Ptr", args: [resolveRef(ref.inner, tp, sagas)] };  // lifetime is borrow-checker-only
    case "TRExpr":   return { tag: "Unknown" };  // a value-arg only matters for dependent refinements (handled above); opaque elsewhere
  }
}

// Walk all decls (descending into modules) and register every type alias /
// refinement so `resolveRef` can expand them transparently, regardless of order.
function registerAliases(decls: Decl[]): void {
  for (const decl of decls) {
    if (decl.tag === "DModule") registerAliases(decl.decls);
    else if (decl.tag === "DType" && decl.body.tag === "TBAlias") {
      TYPE_ALIASES.set(decl.name, { params: decl.params, body: decl.body.ref });
      if (decl.body.pred)
        REFINEMENTS.set(decl.name, { params: decl.params, baseRef: decl.body.ref, pred: decl.body.pred });
    }
    else if (decl.tag === "DFn") {
      const clause = decl.clauses[0];
      if (clause) {
        FN_PARAMS.set(decl.name, clause.params.map(paramName));
        FN_SIGS.set(decl.name, clause.params.map(p => ({
          name: paramName(p),
          keywordOnly: p.keywordOnly === true,
          ...(p.default_ ? { default_: p.default_ } : {}),
        })));
      }
    }
  }
}

// The binding name a parameter introduces (`"" ` for non-binding patterns like
// literals or `_`), used to map dependent refinement args to call arguments.
function paramName(p: Param): string {
  if (p.pat.tag === "PVar" || p.pat.tag === "PTyped") return p.pat.name;
  return "";
}

// A compile-time constant value: a JS primitive or a (possibly nested) list of them.
export type ConstVal = number | string | boolean | ConstVal[];
export const EMPTY_ENV: Map<string, ConstVal> = new Map();

// Constant-fold an expression against a binding environment (`value` for the
// refinement subject, plus any in-scope names — fn params at a call site, dependent
// refinement params). Returns `undefined` when the expression isn't a compile-time
// constant (an unbound name, an unsupported call, etc.) — callers treat that as
// "skip, rely on the runtime `.parse` check instead". Deliberately a small subset:
// literals, list literals, arithmetic/comparison/logical operators, `!`/unary-minus,
// `matches(value, "regex")`, and `listLength`/`length` of a constant list (so
// dependent bounds like `InBounds(listLength xs)` can be folded).
export function constEval(e: Expr, env: Map<string, ConstVal>): ConstVal | undefined {
  switch (e.tag) {
    case "Lit":
      if (e.lit.tag === "Num" || e.lit.tag === "Str" || e.lit.tag === "Bool") return e.lit.value;
      return undefined;
    case "Var":
      return env.has(e.name) ? env.get(e.name)! : undefined;
    case "List": {
      const out: ConstVal[] = [];
      for (const el of e.elems) {
        const v = constEval(el, env);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case "UnOp": {
      const x = constEval(e.expr, env);
      if (x === undefined) return undefined;
      if (e.op === "!" && typeof x === "boolean") return !x;
      if (e.op === "-" && typeof x === "number")  return -x;
      return undefined;
    }
    case "BinOp": {
      // Short-circuit logical operators so a non-constant operand on the dead side
      // doesn't sink the whole fold.
      if (e.op === "&&" || e.op === "||") {
        const l = constEval(e.left, env);
        if (typeof l !== "boolean") return undefined;
        if (e.op === "&&" && !l) return false;
        if (e.op === "||" && l)  return true;
        const r = constEval(e.right, env);
        return typeof r === "boolean" ? r : undefined;
      }
      const l = constEval(e.left, env);
      const r = constEval(e.right, env);
      if (l === undefined || r === undefined) return undefined;
      const nums = typeof l === "number" && typeof r === "number";
      switch (e.op) {
        case "+":  return nums ? (l as number) + (r as number) : (typeof l === "string" && typeof r === "string") ? l + r : undefined;
        case "-":  return nums ? (l as number) - (r as number) : undefined;
        case "*":  return nums ? (l as number) * (r as number) : undefined;
        case "/":  return nums ? (l as number) / (r as number) : undefined;
        case "%":  return nums ? (l as number) % (r as number) : undefined;
        case "==": return typeof l !== "object" && typeof r !== "object" ? l === r : undefined;
        case "!=": return typeof l !== "object" && typeof r !== "object" ? l !== r : undefined;
        case "<":  return nums ? (l as number) <  (r as number) : undefined;
        case "<=": return nums ? (l as number) <= (r as number) : undefined;
        case ">":  return nums ? (l as number) >  (r as number) : undefined;
        case ">=": return nums ? (l as number) >= (r as number) : undefined;
        default:   return undefined;
      }
    }
    case "Call": {
      // listLength xs / length xs — folds a constant list for dependent bounds.
      if (e.fn.tag === "Var" && (e.fn.name === "listLength" || e.fn.name === "length") && e.args.length === 1) {
        const xs = constEval(e.args[0]!, env);
        if (Array.isArray(xs)) return xs.length;
        return undefined;
      }
      // matches(value, "regex") — the canonical String-refinement predicate.
      if (e.fn.tag === "Var" && e.fn.name === "matches" && e.args.length === 2) {
        const subj = constEval(e.args[0]!, env);
        const pat  = constEval(e.args[1]!, env);
        if (typeof subj === "string" && typeof pat === "string") {
          try { return new RegExp(pat).test(subj); } catch { return undefined; }
        }
      }
      return undefined;
    }
    default: return undefined;
  }
}

function sigToFnType(sig: FnSig, tp: Map<string, Type>): Type {
  return { tag: "Fn", params: sig.params.map(p => resolveRef(p, tp)), ret: resolveRef(sig.ret, tp), effects: sig.effects };
}

// ── TxResult(T) — the transaction-outcome ADT ─────────────────────────────────
// A `transaction` yields a distinctly-typed `TxResult(T)`, NOT a plain Result.
// Its five constructors SHARE the `Ok`/`Error` names with Result (constructor
// sharing): which ADT a `| Ok v ->` arm belongs to is decided by the EXPECTED
// type at the match site, not by the constructor name alone. `Conflict`/`Timeout`
// carry typed payloads so `c.retries` / `c.after` are real Numbers, and
// `Cancelled` is nullary. Returns the ctor's type given the result element `t`,
// or null if `name` is not a TxResult constructor (→ caller falls back to lenient).
const TX_RESULT_CTORS = new Set(["Ok", "Error", "Conflict", "Timeout", "Cancelled"]);
function txResultCtorType(name: string, t: Type): Type | null {
  const num: Type = { tag: "Prim", kind: "Number" };
  const tx: Type = { tag: "Named", name: "TxResult", args: [t] };
  const rec = (field: string): Type =>
    ({ tag: "Record", fields: [{ name: field, type: num, optional: false }] });
  const fn = (param: Type): Type => ({ tag: "Fn", params: [param], ret: tx, effects: [] });
  switch (name) {
    case "Ok":        return fn(t);
    case "Error":     return fn(freshVar("e"));     // abort payload — polymorphic
    case "Conflict":  return fn(rec("retries"));
    case "Timeout":   return fn(rec("after"));
    case "Cancelled": return tx;                     // nullary
    default:          return null;
  }
}

// ── Async(a) — the loading-state ADT (SPEC §2.10) ─────────────────────────────
// `Before | During | After(a) | Error String`. Like TxResult, its `Error` ctor
// SHARES the name with Result, so a `| Error e ->` arm against an `Async(a)`
// scrutinee is disambiguated by the EXPECTED type here, not the name. Before/During
// are nullary; After carries the payload; Error carries a String. Returns null for
// non-Async ctors (→ caller falls back to lenient env lookup).
const ASYNC_CTORS = new Set(["Before", "During", "After", "Error"]);
function asyncCtorType(name: string, t: Type): Type | null {
  const str: Type = { tag: "Prim", kind: "String" };
  const async: Type = { tag: "Async", inner: t };
  const fn = (param: Type): Type => ({ tag: "Fn", params: [param], ret: async, effects: [] });
  switch (name) {
    case "Before":  return async;          // nullary
    case "During":  return async;          // nullary
    case "After":   return fn(t);
    case "Error":   return fn(str);        // `Error String`
    default:        return null;
  }
}

// ── Prelude ───────────────────────────────────────────────────────────────────

function buildPrelude(): TypeEnv {
  const env = new TypeEnv();
  const a = freshVar("a"), e = freshVar("e"), b = freshVar("b");
  const num: Type = { tag: "Prim", kind: "Number" };
  const str: Type = { tag: "Prim", kind: "String" };
  const resultA: Type = { tag: "Named", name: "Result", args: [a, e] };
  const listA:   Type = { tag: "Named", name: "List",   args: [a] };
  const listB:   Type = { tag: "Named", name: "List",   args: [b] };

  const fn = (params: Type[], ret: Type): Type => ({ tag: "Fn", params, ret, effects: [] });

  // Result constructors
  env.define("Ok",    { forall: [a.id, e.id], type: fn([a], resultA) });
  env.define("Error", { forall: [a.id, e.id], type: fn([e], resultA) });

  // Async(a) loading-state ctors (SPEC §2.10). Before/During are nullary values;
  // After carries the payload. `Error` is shared with Result (defined above) — an
  // `Error` used where Async is expected is disambiguated at the match site
  // (see PCtor / asyncCtorType). `Async` is the canonical `{tag:"Async"}` variant.
  const asyncA: Type = { tag: "Async", inner: a };
  env.define("Before", { forall: [a.id], type: asyncA });
  env.define("During", { forall: [a.id], type: asyncA });
  env.define("After",  { forall: [a.id], type: fn([a], asyncA) });

  // Layout `Length` ADT (named `Length`, not `Unit` — `Unit` is the () type).
  // `Px/Fr/Pct` carry a Number; `Fit`/`Fill` are nullary. A bare Number coerces
  // to `Px` at the prop-check site (see case "Element").
  const length: Type = { tag: "Named", name: "Length", args: [] };
  env.define("Px",   { forall: [], type: fn([num], length) });
  env.define("Fr",   { forall: [], type: fn([num], length) });
  env.define("Pct",  { forall: [], type: fn([num], length) });
  env.define("Fit",  { forall: [], type: length });
  env.define("Fill", { forall: [], type: length });
  // `Clamp lo hi` — a fluid band (§9.4): ≥lo, ≤hi, fluid between. One concept
  // replacing min/max/clamp; lowers to CSS `clamp(lo, 100%, hi)`. Both bounds px.
  env.define("Clamp", { forall: [], type: fn([num, num], length) });

  // Layout `Breakpoint` — closed responsive variant (§9.2). Nullary atoms with
  // default Tailwind-aligned cutoffs (Mobile <640, Tablet 640–1024, Desktop
  // 1024–1536, Wide ≥1536). Being a closed type, `match` over it inherits the
  // exhaustiveness guardrail for free (see exhaust.ts).
  const breakpoint: Type = { tag: "Named", name: "Breakpoint", args: [] };
  env.define("Mobile",  { forall: [], type: breakpoint });
  env.define("Tablet",  { forall: [], type: breakpoint });
  env.define("Desktop", { forall: [], type: breakpoint });
  env.define("Wide",    { forall: [], type: breakpoint });
  // `viewport` — the read-only reactive root (§9.1). A responsive value is just
  // `match viewport.breakpoint | …`, which inherits Breakpoint exhaustiveness.
  // Source-only (nothing writes back), so a viewport-driven layout is acyclic by
  // construction. (The `responsive` keyword sugar + prop-site auto-collapse await
  // the convergence pass, build-order #6.)
  env.define("viewport", { forall: [], type: { tag: "Record", fields: [
    { name: "width",      type: num,        optional: false },
    { name: "height",     type: num,        optional: false },
    { name: "breakpoint", type: breakpoint, optional: false },
  ] } });
  // Convergence vocabulary (§6): cross-element prop references. Typed loosely
  // (Unknown) — `scope.prop` resolves to a fresh var via the Field rule, so it
  // unifies with whatever the prop expects; the real (element,prop) graph is
  // resolved at convergence time, not here. `sum`/`avg` aggregate `children.p`.
  const unknown: Type = { tag: "Unknown" };
  env.define("self",     { forall: [], type: unknown });
  env.define("parent",   { forall: [], type: unknown });
  env.define("prev",     { forall: [], type: unknown });
  env.define("next",     { forall: [], type: unknown });
  env.define("children", { forall: [], type: unknown });
  env.define("sum",      { forall: [], type: fn([unknown], num) });
  env.define("avg",      { forall: [], type: fn([unknown], num) });

  // ── State taxonomy (§12) — interaction + content states as closed variants ────
  // Exhaustive `match` over these makes state coverage a COMPILE requirement, not
  // a guideline (the UI Stack / Material insight). `Interaction` = the precedence-
  // resolved visual state; `UIState` = the five UI-Stack content states, incl.
  // `Partial` (which `Async` lacks) and `Failed` (NOT `Error` — that's the Result
  // constructor). Loading stays `Async`. Both are closed → see exhaust.ts.
  const interaction: Type = { tag: "Named", name: "Interaction", args: [] };
  for (const n of ["Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled"])
    env.define(n, { forall: [], type: interaction });
  const uistate: Type = { tag: "Named", name: "UIState", args: [] };
  for (const n of ["Empty", "Loading", "Partial", "Failed", "Ideal"])
    env.define(n, { forall: [], type: uistate });
  // Precedence resolver: facet booleans → the one Interaction to style
  // (Disabled > Pressed > Dragged > Focused > Hovered > Idle). The facet record is
  // typed loosely (like the convergence vocab); the OUTPUT is the typed ADT.
  env.define("interactionOf", { forall: [], type: fn([unknown], interaction) });
  // Orthogonal facet enums (§12.1): toggle/selection and validation axes — closed
  // variants like the others, distinct from the precedence-resolved Interaction.
  const toggle: Type = { tag: "Named", name: "Toggle", args: [] };
  for (const n of ["Off", "On", "Mixed"]) env.define(n, { forall: [], type: toggle });
  const validity: Type = { tag: "Named", name: "Validity", args: [] };
  for (const n of ["Valid", "Invalid", "Pending"]) env.define(n, { forall: [], type: validity });
  // `Interaction.all` / `UIState.all` / … — full enumerations for the sandbox (§13.3).
  const listOf = (t: Type): Type => ({ tag: "Named", name: "List", args: [t] });
  const allRec = (t: Type): Scheme => ({ forall: [], type: { tag: "Record", fields: [{ name: "all", type: listOf(t), optional: false }] } });
  env.define("Interaction", allRec(interaction));
  env.define("UIState",     allRec(uistate));
  env.define("Toggle",      allRec(toggle));
  env.define("Validity",    allRec(validity));
  // `raw(n)` — the off-scale escape (§4.2). Runtime identity; its only job is to be
  // opaque to `constEval`, so a value wrapped in `raw` skips the token-scale check.
  env.define("raw",  { forall: [], type: fn([num], num) });

  // List ops
  const outOfBounds: Type = { tag: "Atom", name: "outOfBounds" };
  env.define("listLength",  { forall: [a.id],         type: fn([listA], num) });
  env.define("listGet",     { forall: [a.id],         type: fn([listA, num], { tag: "Named", name: "Result", args: [a, outOfBounds] }) });
  env.define("listReverse", { forall: [a.id],         type: fn([listA], listA) });
  env.define("listTake",    { forall: [a.id],         type: fn([listA, num], listA) });
  env.define("listDrop",    { forall: [a.id],         type: fn([listA, num], listA) });
  env.define("listHead",    { forall: [a.id, e.id],   type: fn([listA], { tag: "Named", name: "Result", args: [a, e] }) });
  env.define("listFilter",  { forall: [a.id],         type: fn([listA, fn([a], { tag: "Prim", kind: "Bool" })], listA) });
  env.define("listMap",     { forall: [a.id, b.id],   type: fn([listA, fn([a], b)], listB) });

  // Stream combinators (data-first, so they chain with `|>`)
  const streamA: Type = { tag: "Stream", inner: a };
  const streamB: Type = { tag: "Stream", inner: b };
  const boolT:   Type = { tag: "Prim", kind: "Bool" };
  env.define("streamMap",    { forall: [a.id, b.id], type: fn([streamA, fn([a], b)], streamB) });
  env.define("streamFilter", { forall: [a.id],       type: fn([streamA, fn([a], boolT)], streamA) });
  env.define("streamTake",   { forall: [a.id],       type: fn([streamA, num], streamA) });
  // fold's reducer is 2-arg `(acc, item)` — written `fn (acc x) -> …`.
  env.define("streamFold",   { forall: [a.id, b.id], type: fn([streamA, b, fn([b, a], b)], b) });
  env.define("streamMerge",    { forall: [a.id],     type: fn([streamA, streamA], streamA) });
  // externSource(setup) — the input FFI: setup gets `push: a -> Unit` and `done: () -> Unit`.
  const unitT: Type = { tag: "Prim", kind: "Unit" };
  env.define("externSource", { forall: [a.id], type: fn([fn([fn([a], unitT), fn([], unitT)], unitT)], streamA) });
  env.define("streamDebounce", { forall: [a.id],     type: fn([streamA, num], streamA) });
  env.define("streamThrottle", { forall: [a.id],     type: fn([streamA, num], streamA) });
  env.define("listFlatMap", { forall: [a.id, b.id],   type: fn([listA, fn([a], listB)], listB) });
  env.define("listReduce",  { forall: [a.id, b.id],   type: fn([listA, b, fn([b, a], b)], b) });
  env.define("listFind",    { forall: [a.id, e.id],   type: fn([listA, fn([a], { tag: "Prim", kind: "Bool" })], { tag: "Named", name: "Result", args: [a, e] }) });
  env.define("listAny",     { forall: [a.id],         type: fn([listA, fn([a], { tag: "Prim", kind: "Bool" })], { tag: "Prim", kind: "Bool" }) });
  env.define("listAll",     { forall: [a.id],         type: fn([listA, fn([a], { tag: "Prim", kind: "Bool" })], { tag: "Prim", kind: "Bool" }) });
  env.define("listZip",     { forall: [a.id, b.id],   type: fn([listA, listB], { tag: "Named", name: "List", args: [{ tag: "Tuple", elems: [a, b] }] }) });
  env.define("listConcat",  { forall: [a.id],         type: fn([{ tag: "Named", name: "List", args: [listA] }], listA) });
  env.define("indexedMap",  { forall: [a.id, b.id],   type: fn([listA, fn([a, num], b)], listB) });
  env.define("collectOk",   { forall: [a.id, e.id],   type: fn([{ tag: "Named", name: "List", args: [resultA] }], listA) });
  env.define("sortBy",      { forall: [a.id, b.id],   type: fn([listA, fn([a], b)], listA) });
  // Parallel combinators: ordinary mapper/predicate; pmap/pfilter run each call
  // concurrently on the scheduler and return the resolved list (plain-in/out, so
  // they compose with `|>` and effectful mappers like `oks |> pmap enrich`).
  env.define("pmap",        { forall: [a.id, b.id],   type: fn([listA, fn([a], b)], listB) });
  env.define("pfilter",     { forall: [a.id],         type: fn([listA, fn([a], { tag: "Prim", kind: "Bool" })], listA) });
  env.define("identity",    { forall: [a.id],         type: fn([a], a) });

  // String ops
  env.define("splitCsv",    { forall: [],             type: fn([str], { tag: "Named", name: "List", args: [str] }) });
  env.define("splitLines",  { forall: [],             type: fn([str], { tag: "Named", name: "List", args: [str] }) });
  env.define("splitOn",     { forall: [],             type: fn([str, str], { tag: "Named", name: "List", args: [str] }) });
  env.define("strTrim",     { forall: [],             type: fn([str], str) });
  env.define("strLength",   { forall: [],             type: fn([str], num) });
  env.define("strContains", { forall: [],             type: fn([str, str], { tag: "Prim", kind: "Bool" }) });
  env.define("strToUpper",  { forall: [],             type: fn([str], str) });
  env.define("strToLower",  { forall: [],             type: fn([str], str) });
  env.define("parseNumber", { forall: [e.id],         type: fn([str], { tag: "Named", name: "Result", args: [num, e] }) });
  env.define("toString",    { forall: [a.id],         type: fn([a], str) });

  // Number ops
  env.define("floor",   { forall: [], type: fn([num], num) });
  env.define("ceil",    { forall: [], type: fn([num], num) });
  env.define("round",   { forall: [], type: fn([num], num) });
  env.define("abs",     { forall: [], type: fn([num], num) });
  env.define("min",     { forall: [], type: fn([num, num], num) });
  env.define("max",     { forall: [], type: fn([num, num], num) });
  env.define("clamp",   { forall: [], type: fn([num, num, num], num) });

  // Async / concurrency
  env.define("parallel",    { forall: [a.id], type: fn([listA], listA) });
  // UI: render a view-DSL element tree to an HTML string.
  env.define("html",        { forall: [], type: fn([{ tag: "Named", name: "Element", args: [] }], { tag: "Prim", kind: "String" }) });
  // `uiModel(element)` — serialize the element tree to an analyzable text outline.
  env.define("uiModel",     { forall: [], type: fn([{ tag: "Named", name: "Element", args: [] }], { tag: "Prim", kind: "String" }) });
  // `analyze(element)` — lint report (§13.2): inconsistency/duplication/a11y/structure.
  env.define("analyze",     { forall: [], type: fn([{ tag: "Named", name: "Element", args: [] }], { tag: "Prim", kind: "String" }) });
  // `uiJson(element)` — the UI model serialized as JSON.
  env.define("uiJson",      { forall: [], type: fn([{ tag: "Named", name: "Element", args: [] }], { tag: "Prim", kind: "String" }) });
  // `sandbox(name, variants, render)` — a text Storybook (§13.3): map a render fn
  // over each variant (e.g. `Interaction.all`) and dump uiModel + html per variant.
  env.define("sandbox",     { forall: [a.id], type: fn([str, listA, fn([a], { tag: "Named", name: "Element", args: [] })], str) });
  // `interactive(view, steps)` — headless retained runtime (§8): drive scripted
  // events through `view` and report the reconciliation patches per step. `view`
  // is a thunk → Element; steps are `{ target, event }` records (read loosely).
  env.define("interactive", { forall: [a.id], type: fn([fn([], { tag: "Named", name: "Element", args: [] }), listA], str) });
  // `domHost(view, steps)` — browser host: emits a self-contained HTML replay page.
  env.define("domHost",     { forall: [a.id], type: fn([fn([], { tag: "Named", name: "Element", args: [] }), listA], str) });
  env.define("sleep",       { forall: [],     type: fn([num],   { tag: "Named", name: "Async", args: [{ tag: "Prim", kind: "Unit" }] }) });
  env.define("journalOf",   { forall: [],     type: fn([{ tag: "Prim", kind: "String" }], { tag: "Named", name: "List", args: [{ tag: "Prim", kind: "String" }] }) });
  env.define("crash",       { forall: [b.id],  type: fn([{ tag: "Prim", kind: "String" }], b) });
  env.define("timeout",     { forall: [a.id], type: fn([num, { tag: "Named", name: "Async", args: [a] }], { tag: "Named", name: "Result", args: [a, { tag: "Atom", name: "timeout" }] }) });

  // Network (effect-typed, simplified)
  const asyncResultStr: Type = { tag: "Named", name: "Async", args: [{ tag: "Named", name: "Result", args: [str, str] }] };
  for (const name of ["netGet", "netPost", "netDelete", "httpGet", "httpPost", "httpPut", "httpPatch"]) {
    env.defineMono(name, fn([str], asyncResultStr));
  }

  return env;
}

// ── Inference context ─────────────────────────────────────────────────────────

interface Ctx {
  subst: Subst;
  returnType: Type | null;
  // null = unchecked mode (fn has no effect annotation); string[] = declared capabilities
  effects: string[] | null;
  // true while inside a saga step body — bans ? and ?: (use explicit match + :abort)
  inSagaStep: boolean;
  diagnostics: Diagnostic[];
  resolutions: ResolutionMap;
}

// ── Unification ───────────────────────────────────────────────────────────────

function unify(a: Type, b: Type, ctx: Ctx, span: Span, hint?: string): void {
  const ta = ctx.subst.apply(a);
  const tb = ctx.subst.apply(b);

  if (ta.tag === "Var") { ctx.subst.extend(ta.id, tb); return; }
  if (tb.tag === "Var") { ctx.subst.extend(tb.id, ta); return; }
  if (ta.tag === "Unknown" || tb.tag === "Unknown") return;

  // Refinement types are transparent to their base: `type Age = Number where …`
  // unifies with `Number` (and with other refinements over `Number`). The
  // predicate is enforced separately — at runtime via `.parse`, and at compile
  // time for literal arguments (see checkRefinementLits).
  if (ta.tag === "Refinement") { unify(ta.base, tb, ctx, span, hint); return; }
  if (tb.tag === "Refinement") { unify(ta, tb.base, ctx, span, hint); return; }

  if (ta.tag === "Prim" && tb.tag === "Prim" && ta.kind === tb.kind) return;
  if (ta.tag === "Atom" && tb.tag === "Atom" && ta.name === tb.name) return;

  if (ta.tag === "Named" && tb.tag === "Named" && ta.name === tb.name && ta.args.length === tb.args.length) {
    for (let i = 0; i < ta.args.length; i++) unify(ta.args[i]!, tb.args[i]!, ctx, span);
    return;
  }

  if (ta.tag === "Fn" && tb.tag === "Fn" && ta.params.length === tb.params.length) {
    for (let i = 0; i < ta.params.length; i++) unify(ta.params[i]!, tb.params[i]!, ctx, span);
    unify(ta.ret, tb.ret, ctx, span);
    return;
  }

  if (ta.tag === "Tuple" && tb.tag === "Tuple" && ta.elems.length === tb.elems.length) {
    for (let i = 0; i < ta.elems.length; i++) unify(ta.elems[i]!, tb.elems[i]!, ctx, span);
    return;
  }

  if (ta.tag === "Record" && tb.tag === "Record") {
    // Width subtyping: `tb` is the demanded/expected shape, `ta` the concrete
    // value. Every non-optional field demanded by `tb` must exist in `ta` (with
    // matching type); `ta` is allowed to carry extra fields (e.g. accessing one
    // field of a larger record, or passing a wider record where a narrower one
    // is expected).
    for (const fb of tb.fields) {
      const fa = ta.fields.find(f => f.name === fb.name);
      if (fa) unify(fa.type, fb.type, ctx, span);
      else if (!fb.optional) err(ctx, span, `missing record field '${fb.name}'`);
    }
    return;
  }

  if (ta.tag === "Tainted" && tb.tag === "Tainted") { unify(ta.inner, tb.inner, ctx, span); return; }
  if (ta.tag === "Tainted") { unify(ta.inner, tb, ctx, span); return; }

  if (ta.tag === "Async"  && tb.tag === "Async")  { unify(ta.inner, tb.inner, ctx, span); return; }
  if (ta.tag === "Stream" && tb.tag === "Stream") { unify(ta.inner, tb.inner, ctx, span); return; }

  if (ta.tag === "SagaFn" && tb.tag === "SagaFn" && ta.name === tb.name) return;

  // Named("()",[]) ≡ Prim("Unit")
  if (isUnit(ta) && isUnit(tb)) return;

  // Named("Atom",[]) is the supertype of all specific atoms — :ok, :err, etc.
  if (ta.tag === "Named" && ta.name === "Atom" && ta.args.length === 0 && tb.tag === "Atom") return;
  if (tb.tag === "Named" && tb.name === "Atom" && tb.args.length === 0 && ta.tag === "Atom") return;

  const prefix = hint ? `${hint} — ` : "";
  err(ctx, span, `${prefix}expected ${typeToString(ta)}, got ${typeToString(tb)}`);
  // Poison all free type variables in both sides so downstream unifications
  // involving these vars silently pass instead of cascading.
  for (const id of freeVars(ta)) ctx.subst.extend(id, { tag: "Unknown" });
  for (const id of freeVars(tb)) ctx.subst.extend(id, { tag: "Unknown" });
}

function isUnit(t: Type): boolean {
  return (t.tag === "Prim" && t.kind === "Unit") ||
         (t.tag === "Named" && (t.name === "()" || t.name === "Unit") && t.args.length === 0);
}

function err(ctx: Ctx, span: Span, message: string): void {
  ctx.diagnostics.push({ kind: "error", span, message });
}

// ── Element prop schemas ────────────────────────────────────────────────────────
// The view-DSL primitives (Column/Text/Button/…) share a global prop vocabulary,
// mirroring `render.ts`'s CSS map. A prop *value* is unified against its declared
// type here, so `gap=#fff` or `color=12` is a compile error. Props NOT in this map
// are left unchecked (pass-through, as today) — so custom attrs and not-yet-typed
// props never produce a false positive. Layout numbers are plain `Number` for now;
// the `Unit` ADT (Fit/Fr/Pct) and refinement-typed scales (Space/TypeScale) layer
// on top of these entries later. Colours are `String` because hex literals lower to
// `Str` (lower.ts).
const ELEMENT_PROP_TYPES: Record<string, Type> = (() => {
  const num: Type = { tag: "Prim", kind: "Number" };
  const str: Type = { tag: "Prim", kind: "String" };
  const len: Type = { tag: "Named", name: "Length", args: [] };
  return {
    // box-model lengths — accept `Length` (Px/Fr/Pct/Fit/Fill) or a bare Number (→Px)
    width: len, height: len, padding: len, margin: len, gap: len, radius: len,
    basis: len,
    // plain numbers (not box-model dimensions)
    size: num, weight: num, opacity: num, grow: num, shrink: num,
    background: str, color: str, font: str, align: str, justify: str,
    alignSelf: str,
  };
})();

// ── Layout context (§9.5 — context-dependent prop validity) ─────────────────────
// Each view-DSL primitive has a layout mode. Two prop classes are only valid in a
// matching context, mirroring CSS's silent no-ops:
//   • CONTAINER props (gap/align/justify) need the element itself to be flex/grid.
//   • FLEX-ITEM props (grow/shrink/basis/alignSelf) need the *parent* to be flex.
// Checks fire only when the relevant mode is KNOWN and non-flex, so custom
// components (which are calls, not Element nodes) never trigger a false positive.
type LayoutMode = "flex" | "block" | "leaf";
const PRIMITIVE_MODE: Record<string, LayoutMode> = {
  Row: "flex", Column: "flex", Stack: "flex", Grid: "flex",
  Box: "block", Card: "block", Scroll: "block", List: "block", Item: "block",
  Text: "leaf", Heading: "leaf", Label: "leaf", Button: "leaf", Link: "leaf",
  Image: "leaf", Canvas: "leaf", Input: "leaf", Slider: "leaf",
  Spacer: "leaf", Divider: "leaf",
};
const CONTAINER_PROPS = new Set(["gap", "align", "justify"]);
const FLEX_ITEM_PROPS = new Set(["grow", "shrink", "basis", "alignSelf"]);

// ── Token scales (§4.2 — opt-in) ────────────────────────────────────────────────
// A prop maps to the refinement-type name that constrains its constant values. The
// scale is enforced ONLY when the project defines that refinement type (registered
// in REFINEMENTS via `type Space = Number where …`); otherwise no check, so nothing
// breaks by default. `raw(n)` / explicit `Px n` wrap the number so `constEval` can't
// fold it → the check is skipped (the escape hatch).
export const PROP_SCALE: Record<string, string> = {
  gap: "Space", padding: "Space", margin: "Space",
  width: "Space", height: "Space", radius: "Space", basis: "Space",
  size: "TypeScale",
};

// ── Prop vocabulary (§3.2 — unknown-prop + required-prop errors) ─────────────────
// Built-in primitives have a CLOSED prop vocabulary, so a prop outside it is almost
// always a typo (`colour=`, or `onClick=` where an `on` handler child was meant).
// Both checks fire ONLY for known primitives (`mode !== undefined`); a capitalized
// *user component* is an opaque call whose props are never second-guessed — keeping
// the zero-false-positive guarantee of the context-validity checks above.
//   • COMMON_PROPS — valid on every primitive: styling (ELEMENT_PROP_TYPES keys) +
//     identity (id/key, used for keyed reconciliation) + a11y labels.
//   • PRIMITIVE_PROP_TYPES — functional props specific to one primitive, value-typed
//     (so `Link to=12` or `Input disabled="yes"` is also a type error).
//   • REQUIRED_PROPS — props a primitive cannot render without.
const COMMON_PROPS = new Set<string>([
  ...Object.keys(ELEMENT_PROP_TYPES),
  "id", "key", "label", "ariaLabel", "title",
]);
const PRIMITIVE_PROP_TYPES: Record<string, Record<string, Type>> = (() => {
  const num: Type = { tag: "Prim", kind: "Number" };
  const str: Type = { tag: "Prim", kind: "String" };
  const bool: Type = { tag: "Prim", kind: "Bool" };
  return {
    Link:   { to: str },
    Image:  { src: str, alt: str },
    Input:  { value: str, placeholder: str, checked: bool, disabled: bool,
              type: str, name: str, min: num, max: num, step: num },
    Slider: { value: num, min: num, max: num, step: num, disabled: bool, name: str },
    Button: { disabled: bool, type: str },
  };
})();
const REQUIRED_PROPS: Record<string, string[]> = {
  Image: ["src"],
  Link:  ["to"],
};

// ── Public API ────────────────────────────────────────────────────────────────

export interface InferResult {
  diagnostics: Diagnostic[];
  types: Map<Expr, Type>;
  nameToTypeString: Map<string, string>;
}

export function infer(mod: Module, resolutions: ResolutionMap): InferResult {
  const ctx: Ctx = { subst: new Subst(), returnType: null, effects: null, inSagaStep: false, diagnostics: [], resolutions };
  const env = buildPrelude();
  const types = new Map<Expr, Type>();
  // Register type aliases / refinements up front so forward references resolve.
  TYPE_ALIASES = new Map();
  REFINEMENTS = new Map();
  FN_PARAMS = new Map();
  FN_SIGS = new Map();
  ALIAS_RESOLVING.clear();
  registerAliases(mod.decls);
  const inferrer = new Inferrer(ctx, types);
  inferrer.collectDecls(mod.decls, env);
  inferrer.inferDecls(mod.decls, env);
  const nameToTypeString = new Map<string, string>();
  for (const [name, scheme] of env.allSchemes()) {
    nameToTypeString.set(name, typeToString(ctx.subst.apply(instantiate(scheme))));
  }
  return { diagnostics: ctx.diagnostics, types, nameToTypeString };
}

// ── Inferrer ──────────────────────────────────────────────────────────────────

// Collect all step-name goto targets from a saga body recursively.
// Only collects targets that exist in `knownSteps` (avoids flagging undefined step refs as reachable).
function collectBodyGotos(body: SagaStmt[], out: Set<string>, knownSteps: Set<string>): void {
  for (const stmt of body) {
    switch (stmt.tag) {
      case "Goto":
        if (knownSteps.has(stmt.target)) out.add(stmt.target);
        break;
      case "SagaIf":
        collectBodyGotos(stmt.then, out, knownSteps);
        collectBodyGotos(stmt.else_, out, knownSteps);
        break;
      case "SagaMatch":
        for (const br of stmt.branches) collectBodyGotos(br.body, out, knownSteps);
        break;
      case "SagaJoin":
      case "SagaRace":
        for (const br of stmt.branches) collectBodyGotos(br.body, out, knownSteps);
        break;
      case "Rollback":
        if (knownSteps.has(stmt.target)) out.add(stmt.target);
        break;
    }
  }
}

class Inferrer {
  constructor(private ctx: Ctx, private types: Map<Expr, Type>) {}

  // Result type of each first-class saga, so `go Checkout(..)` can be typed as a
  // saga handle (`Saga T`) rather than a plain future.
  private sagaRets = new Map<string, Type>();

  // ── Pass 1: collect top-level types so mutual recursion works ───────────────

  collectDecls(decls: Decl[], env: TypeEnv): void {
    for (const decl of decls) {
      switch (decl.tag) {
        case "DModule":
          this.collectDecls(decl.decls, env);
          break;
        case "DFn":
          if (decl.clauses.length > 1) {
            // Multi-clause (ad-hoc polymorphic) functions can't be represented
            // by a single HM type — each clause may have distinct param types
            // (e.g. different atom literals). Type it as Unknown so call sites
            // don't unify against just the first clause's signature.
            env.defineMono(decl.name, { tag: "Unknown" });
          } else if (decl.sig) {
            env.define(decl.name, mono(sigToFnType(decl.sig, new Map())));
          } else {
            env.defineMono(decl.name, freshVar(decl.name));
          }
          break;
        case "DType":
          this.collectType(decl, env);
          break;
        case "DSaga": {
          // A first-class saga is callable (run-to-completion) OR spawnable (`go`)
          // OR resumable (`resume`). The SagaFn type carries the saga's identity so
          // that type-ness survives aliasing: `let mySaga = Checkout; go mySaga(x)`
          // still types as `Saga String` because mySaga's type is SagaFn, not Fn.
          const tp = new Map<string, Type>();
          const paramTypes = decl.params.map(p => p.ascription ? resolveRef(p.ascription, tp) : freshVar());
          const ret = decl.ret ? resolveRef(decl.ret, tp) : freshVar("saga");
          env.defineMono(decl.name, { tag: "SagaFn", name: decl.name, params: paramTypes, ret });
          this.sagaRets.set(decl.name, ret);
          break;
        }
        case "DStore": {
          const fields: Field[] = decl.fields.map(f => ({
            name: f.name,
            type: resolveRef(f.type, new Map()),
            optional: false,
          }));
          // Pub values are readable like state fields; their concrete types are
          // pinned when their bodies are inferred (see inferDecls), so start as
          // fresh vars here.
          for (const p of decl.pubs) fields.push({ name: p.name, type: freshVar(p.name), optional: false });
          env.defineMono(decl.name, { tag: "Record", fields });
          // Message constructors: Add(text: String) → Add : (String) -> Unit
          for (const msg of decl.messages) {
            const paramTypes = msg.params.map(p => p.ascription ? resolveRef(p.ascription, new Map()) : freshVar());
            // Messages are dispatched by calling them — `Increment()`, `Add(n)` —
            // so even no-arg messages are nullary functions, not bare Unit values.
            env.defineMono(msg.name, { tag: "Fn", params: paramTypes, ret: { tag: "Prim", kind: "Unit" }, effects: [] });
          }
          break;
        }
        case "DStream": {
          // Register the stream as a `Stream(T)` value.
          // Push and Done constructors are in the prelude as polymorphic.
          const tp = new Map<string, Type>();
          const inner = resolveRef(decl.inner, tp, this.sagaRets);
          env.defineMono(decl.name, { tag: "Stream", inner });
          break;
        }
        case "DImport": {
          // Named imports: `import { split, join } from "String"` — each name looked
          // up individually so polymorphic schemes are preserved.
          // Bare import: `import math from "std/math"` — bind the alias as a record
          // of all the module's exports (functions monomorphically instantiated).
          const isNamed = decl.names.length > 1 ||
            (decl.names.length === 1 && stdlibLookup(decl.path, decl.names[0]!.name) !== null);
          if (isNamed) {
            for (const { name, alias } of decl.names) {
              const scheme = stdlibLookup(decl.path, name);
              const bindName = alias ?? name;
              if (scheme) env.define(bindName, scheme);
              else env.defineMono(bindName, { tag: "Unknown" });
            }
          } else {
            // Namespace import — bind the module alias as a record of its exports.
            const mod = stdlibModule(decl.path);
            const bindName = decl.names[0]?.alias ?? decl.names[0]?.name ?? decl.path;
            if (mod) {
              const fields: Field[] = Object.entries(mod).map(([fname, scheme]) => ({
                name: fname,
                type: scheme.type, // intentionally not generalized — field access is monomorphic
                optional: false,
              }));
              env.defineMono(bindName, { tag: "Record", fields });
            } else {
              env.defineMono(bindName, { tag: "Unknown" });
            }
          }
          break;
        }
      }
    }
  }

  private collectType(decl: Extract<Decl, { tag: "DType" }>, env: TypeEnv): void {
    const tp = new Map<string, Type>();
    for (const p of decl.params) tp.set(p, freshVar(p));

    switch (decl.body.tag) {
      case "TBAdt":
        for (const v of decl.body.variants) this.collectCtor(v, decl.name, tp, env);
        break;
      case "TBAlias": {
        const base = resolveRef(decl.body.ref, tp);
        if (decl.body.pred) {
          // Refinement type: expose `TypeName.parse : Base -> Result Base String`
          // (the runtime-checked boundary). The type itself stays transparent.
          const parseT: Type = {
            tag: "Fn",
            params: [base],
            ret: { tag: "Named", name: "Result", args: [base, { tag: "Prim", kind: "String" }] },
            effects: [],
          };
          env.define(decl.name, generalize(env, this.ctx.subst,
            { tag: "Record", fields: [{ name: "parse", type: parseT, optional: false }] }));
        } else {
          env.define(decl.name, generalize(env, this.ctx.subst, base));
        }
        break;
      }
      case "TBRecord": {
        const fields: Field[] = decl.body.fields.map(f => ({ name: f.name, type: resolveRef(f.type, tp), optional: f.optional }));
        env.define(decl.name, generalize(env, this.ctx.subst, { tag: "Record", fields }));
        break;
      }
      case "TBExtern": {
        const fields: Field[] = decl.body.fields.map(f => ({ name: f.name, type: resolveRef(f.type, tp), optional: false }));
        env.define(decl.name, generalize(env, this.ctx.subst, { tag: "Record", fields }));
        break;
      }
    }
  }

  private collectCtor(v: { name: string; payload: TypeRef | null; span: Span }, typeName: string, tp: Map<string, Type>, env: TypeEnv): void {
    const resultType: Type = { tag: "Named", name: typeName, args: [...tp.values()] };
    if (v.payload) {
      const pType = resolveRef(v.payload, tp);
      env.define(v.name, generalize(env, this.ctx.subst, { tag: "Fn", params: [pType], ret: resultType, effects: [] }));
    } else {
      env.define(v.name, generalize(env, this.ctx.subst, resultType));
    }
  }

  // ── Pass 2: infer function bodies ───────────────────────────────────────────

  inferDecls(decls: Decl[], env: TypeEnv): void {
    for (const decl of decls) {
      if (decl.tag === "DModule") {
        // Run the module's body with its capabilities as the available effect pool.
        // Individual functions still declare their own effects; the module's
        // capabilities set the ceiling of what's allowed.
        const prevEffects = this.ctx.effects;
        this.ctx.effects = decl.capabilities.length ? decl.capabilities : null;
        this.inferDecls(decl.decls, env);
        this.ctx.effects = prevEffects;
        continue;
      }
      if (decl.tag === "DStore")  { this.inferStore(decl, env); continue; }
      if (decl.tag === "DSaga")   { this.inferSaga(decl, env); continue; }
      if (decl.tag === "DStream") continue; // fully typed by collectDecls; nothing to infer
      if (decl.tag !== "DFn") continue;
      const multiClause = decl.clauses.length > 1;
      for (const clause of decl.clauses) {
        this.inferClause(decl.name, clause, decl.sig, env, multiClause);
      }
    }
  }

  private inferClause(name: string, clause: FnClause, sig: FnSig | null, parent: TypeEnv, multiClause = false): void {
    const env = parent.child();
    const tp = new Map<string, Type>();
    const paramTypes = clause.params.map((p, i) => {
      if (sig?.params[i]) return resolveRef(sig.params[i]!, tp, this.sagaRets);
      if (p.ascription)   return resolveRef(p.ascription, tp, this.sagaRets);
      return freshVar();
    });

    for (let i = 0; i < clause.params.length; i++) {
      this.bindPat(clause.params[i]!.pat, paramTypes[i]!, env);
    }
    for (const { pat, value } of clause.where_) {
      const vt = this.inferExpr(value, env);
      this.bindPat(pat, vt, env);
    }

    const retRef = sig?.ret ?? clause.ret ?? null;
    const retType = retRef ? resolveRef(retRef, tp, this.sagaRets) : freshVar(name + "_ret");
    const prevRet = this.ctx.returnType;
    this.ctx.returnType = retType;

    // Effect context: use the declared effects, or null (unchecked) if none declared.
    const declaredEffects = sig?.effects.length ? sig.effects : clause.effects.length ? clause.effects : null;
    const prevEffects = this.ctx.effects;
    this.ctx.effects = declaredEffects;

    const bodyType = this.inferExpr(clause.body, env);
    unify(bodyType, retType, this.ctx, clause.body.span, `'${name}' return type`);

    this.ctx.returnType = prevRet;
    this.ctx.effects = prevEffects;

    // Unify the fn's declared type in parent env with what we inferred.
    // For multi-clause functions, skip this — each clause has its own param types
    // (e.g. different atom literals per clause), so unifying would produce false errors.
    if (!multiClause) {
      const fnScheme = parent.lookup(name);
      if (fnScheme) {
        const declared = instantiate(fnScheme);
        const inferred: Type = { tag: "Fn", params: paramTypes.map(p => this.ctx.subst.apply(p)), ret: this.ctx.subst.apply(retType), effects: sig?.effects ?? clause.effects };
        unify(declared, inferred, this.ctx, clause.body.span);
      }
    }
  }

  // ── Machine inference ───────────────────────────────────────────────────────

  private inferSagaBody(body: SagaStmt[], env: TypeEnv, result: Type, steps: Map<string, string[]>): void {
    const prevInSagaStep = this.ctx.inSagaStep;
    this.ctx.inSagaStep = true;
    for (let i = 0; i < body.length; i++) {
      const stmt = body[i]!;
      const isLast = i === body.length - 1;
      switch (stmt.tag) {
        case "SBindS": {
          const vt = this.inferExpr(stmt.value, env);
          const next = env.child();
          next.defineMono(stmt.name, this.ctx.subst.apply(vt));
          env = next;
          break;
        }
        case "Goto": {
          stmt.args.forEach((a: Expr) => this.inferExpr(a, env));
          if (!steps.has(stmt.target)) err(this.ctx, stmt.span, `transition to unknown state ':${stmt.target}'`);
          break;
        }
        case "Yield": {
          const t = this.inferExpr(stmt.expr, env);
          // A trailing yield is the step's result; unify it with the machine type.
          if (isLast) unify(t, result, this.ctx, stmt.span, "machine result");
          break;
        }
        case "SagaMatch": {
          const subjT = this.inferExpr(stmt.subject, env);
          for (const br of stmt.branches) {
            const bs = env.child();
            this.checkPat(br.pat, subjT, bs);
            this.inferSagaBody(br.body, bs, result, steps);
          }
          break;
        }
        case "SagaIf": {
          unify(this.inferExpr(stmt.cond, env), { tag: "Prim", kind: "Bool" }, this.ctx, stmt.span, "machine `if` condition");
          this.inferSagaBody(stmt.then, env.child(), result, steps);
          this.inferSagaBody(stmt.else_, env.child(), result, steps);
          break;
        }
        case "SagaGo":
          this.inferExpr(stmt.expr, env);
          break;
        case "Rollback": {
          // `expr ? rollback :step` registers a compensation; `?:` recovers on
          // failure. Either way the subject expr is type-checked and the target
          // must name a real step. The statement yields no value.
          this.inferExpr(stmt.expr, env);
          if (!steps.has(stmt.target)) err(this.ctx, stmt.span, `rollback to unknown state ':${stmt.target}'`);
          break;
        }
        case "SagaJoin": {
          // Join matches a tuple of the tasks' results (or the single result).
          const taskTs = stmt.tasks.map(t => this.ctx.subst.apply(this.inferExpr(t, env)));
          const subjT: Type = taskTs.length === 1 ? taskTs[0]! : { tag: "Tuple", elems: taskTs };
          for (const br of stmt.branches) {
            const bs = env.child();
            this.checkPat(br.pat, subjT, bs);
            this.inferSagaBody(br.body, bs, result, steps);
          }
          break;
        }
        case "SagaRace": {
          // Arms yield heterogeneous results (a value, Timeout, Cancelled), so we
          // don't pin a subject type — just infer arm exprs and branch bodies.
          for (const arm of stmt.arms) if (arm.expr) this.inferExpr(arm.expr, env);
          for (const br of stmt.branches) {
            const bs = env.child();
            this.checkPat(br.pat, { tag: "Unknown" }, bs);
            this.inferSagaBody(br.body, bs, result, steps);
          }
          break;
        }
      }
    }
    this.ctx.inSagaStep = prevInSagaStep;
  }

  // A first-class saga's step bodies are type-checked like a machine's, with the
  // constructor inputs in scope and the trailing yields unified with its result.
  private inferSaga(decl: Extract<Decl, { tag: "DSaga" }>, parent: TypeEnv): void {
    const env = parent.child();
    const tp = new Map<string, Type>();
    for (const p of decl.params) {
      const pt = p.ascription ? resolveRef(p.ascription, tp, this.sagaRets) : freshVar();
      this.bindPat(p.pat, pt, env);
    }
    const result = decl.ret ? resolveRef(decl.ret, tp, this.sagaRets) : freshVar("saga");
    const stepParams = new Map(decl.steps.map(s => [s.name, s.params] as const));
    for (const step of decl.steps) {
      const stepEnv = env.child();
      for (const p of step.params) stepEnv.defineMono(p, freshVar(p));
      this.inferSagaBody(step.body, stepEnv, result, stepParams);
    }
    this.checkSagaExhaustiveness(decl);
  }

  // ── Saga exhaustiveness ─────────────────────────────────────────────────────

  private checkSagaExhaustiveness(decl: Extract<Decl, { tag: "DSaga" }>): void {
    if (decl.steps.length === 0) return;

    const stepNames = new Set(decl.steps.map(s => s.name));
    const entry = decl.steps[0]!.name;

    // Build transition graph: step → steps it can goto.
    const gotos = new Map<string, Set<string>>();
    for (const step of decl.steps) {
      const targets = new Set<string>();
      collectBodyGotos(step.body, targets, stepNames);
      gotos.set(step.name, targets);
    }

    // Terminal steps: steps with NO goto to any defined step (they yield or crash).
    const terminals = new Set<string>();
    for (const [name, targets] of gotos) {
      if (targets.size === 0) terminals.add(name);
    }

    // Forward reachability from entry step.
    const reachable = new Set<string>([entry]);
    const frontier = [entry];
    while (frontier.length) {
      const cur = frontier.pop()!;
      for (const next of gotos.get(cur) ?? []) {
        if (!reachable.has(next)) { reachable.add(next); frontier.push(next); }
      }
    }

    // Backward reachability from terminal steps — which steps can reach a terminal?
    const reverse = new Map<string, Set<string>>();
    for (const name of stepNames) reverse.set(name, new Set());
    for (const [name, targets] of gotos) {
      for (const t of targets) reverse.get(t)?.add(name);
    }
    const canFinish = new Set<string>(terminals);
    const backFrontier = [...terminals];
    while (backFrontier.length) {
      const cur = backFrontier.pop()!;
      for (const pred of reverse.get(cur) ?? []) {
        if (!canFinish.has(pred)) { canFinish.add(pred); backFrontier.push(pred); }
      }
    }

    // Conventional terminal names — always considered reachable (can be jumped to
    // via crash+compensation or other implicit mechanisms, not just step_goto).
    const conventional = new Set(["done", "abort"]);

    for (const step of decl.steps) {
      if (conventional.has(step.name)) continue;
      const span = step.span;
      if (!reachable.has(step.name)) {
        this.ctx.diagnostics.push({ kind: "warning", span, message: `saga '${decl.name}': step ':${step.name}' is unreachable from ':${entry}'` });
      } else if (!canFinish.has(step.name)) {
        this.ctx.diagnostics.push({ kind: "warning", span, message: `saga '${decl.name}': step ':${step.name}' has no path to a terminal step (infinite loop?)` });
      }
    }
  }

  // ── Store inference ─────────────────────────────────────────────────────────

  private inferStore(decl: Extract<Decl, { tag: "DStore" }>, parent: TypeEnv): void {
    // Build a scope where every state field is visible as a local of its type.
    const stateTypes = new Map<string, Type>();
    const stateEnv = parent.child();
    for (const f of decl.fields) {
      const t = resolveRef(f.type, new Map(), this.sagaRets);
      stateTypes.set(f.name, t);
      stateEnv.defineMono(f.name, t);
      if (f.default_) unify(this.inferExpr(f.default_, parent), t, this.ctx, f.default_.span, `store '${decl.name}' field '${f.name}' default`);
    }

    // The store's own record type (with pub field vars) — used to pin pub types.
    const storeScheme = parent.lookup(decl.name);
    const storeRec = storeScheme ? instantiate(storeScheme) : null;
    const pubField = (name: string): Type | null =>
      storeRec?.tag === "Record" ? storeRec.fields.find(f => f.name === name)?.type ?? null : null;

    // Message handlers: params + state in scope; body yields a partial state
    // record whose fields must be a subset of the state with matching types.
    for (const msg of decl.messages) {
      const env = stateEnv.child();
      for (const p of msg.params) {
        const pt = p.ascription ? resolveRef(p.ascription, new Map(), this.sagaRets) : freshVar();
        this.bindPat(p.pat, pt, env);
      }
      const bodyT = this.ctx.subst.apply(this.inferExpr(msg.body, env));
      if (bodyT.tag === "Record") {
        for (const f of bodyT.fields) {
          const st = stateTypes.get(f.name);
          if (!st) err(this.ctx, msg.body.span, `message '${msg.name}' sets unknown state field '${f.name}'`);
          else unify(f.type, st, this.ctx, msg.body.span, `message '${msg.name}' field '${f.name}'`);
        }
      }
    }

    // Pub values: state in scope; pin the pub's record-field type to the body's.
    for (const pub of decl.pubs) {
      const pt = pubField(pub.name);
      if (pub.body) {
        const bt = this.inferExpr(pub.body, stateEnv);
        if (pt) unify(pt, bt, this.ctx, pub.body.span, `store '${decl.name}' pub '${pub.name}'`);
      } else if (pt) {
        // Bare `pub x` re-exports state field `x`.
        const st = stateTypes.get(pub.name);
        if (st) unify(pt, st, this.ctx, decl.span, `store '${decl.name}' pub '${pub.name}'`);
      }
    }
  }

  // ── Expression inference ───────────────────────────────────────────────────

  inferExpr(expr: Expr, env: TypeEnv): Type {
    const t = this.inferInner(expr, env);
    const applied = this.ctx.subst.apply(t);
    this.types.set(expr, applied);
    return applied;
  }

  private inferInner(expr: Expr, env: TypeEnv): Type {
    switch (expr.tag) {

      case "Lit": return this.litType(expr.lit);

      case "Var": {
        const s = env.lookup(expr.name);
        return s ? instantiate(s) : { tag: "Unknown" };
      }

      case "Call": {
        const fnT   = this.inferExpr(expr.fn, env);
        // Resolve named arguments + defaults into a flat positional vector. A
        // pure positional call to a function with no defaults skips this and
        // keeps currying/partial application intact (the common case).
        const sig = expr.fn.tag === "Var" ? FN_SIGS.get(expr.fn.name) : undefined;
        const argExprs = needsResolution(sig, expr.named.length)
          ? resolveNamedCall(sig!, expr.args, expr.named.map(na => ({ name: na.name, value: na.value })),
              d => d, msg => err(this.ctx, expr.span, msg))
          : expr.args;
        const argTs = argExprs.map(a => this.inferExpr(a, env));
        const ret   = freshVar();
        const fnName = expr.fn.tag === "Var" ? `call to '${expr.fn.name}'` : "function call";

        // Capture required effects before unification (unification doesn't touch effects).
        const resolvedFnT = this.ctx.subst.apply(fnT);

        // Compile-time refinement check: any constant argument passed to a parameter
        // of refinement type has its predicate evaluated now, so out-of-range literals
        // (`birthday(200)` for `Age = Number where value <= 150`) fail at check time.
        // DEPENDENT refinements (`InBounds(listLength list)`) additionally bind their
        // value-params from the other call arguments, so `get([1,2,3], 5)` fails too.
        if (resolvedFnT.tag === "Fn") {
          // Fold this call's arguments under their parameter names, so a dependent
          // refinement arg (`listLength list`) can reference sibling parameters.
          const paramNames = expr.fn.tag === "Var" ? (FN_PARAMS.get(expr.fn.name) ?? []) : [];
          const callEnv = new Map<string, ConstVal>();
          for (let j = 0; j < argExprs.length && j < paramNames.length; j++) {
            if (!paramNames[j]) continue;
            const av = constEval(argExprs[j]!, EMPTY_ENV);
            if (av !== undefined) callEnv.set(paramNames[j]!, av);
          }
          for (let i = 0; i < argExprs.length && i < resolvedFnT.params.length; i++) {
            const pt = this.ctx.subst.apply(resolvedFnT.params[i]!);
            if (pt.tag !== "Refinement") continue;
            const refinement = REFINEMENTS.get(pt.pred);
            if (!refinement) continue;
            const v = constEval(argExprs[i]!, callEnv);
            if (v === undefined) continue;                 // not constant → runtime-checked
            // Bind the predicate environment: `value` = this argument, plus any
            // dependent type-params resolved from the call (e.g. `n` = listLength list).
            const penv = new Map<string, ConstVal>([["value", v]]);
            let unresolved = false;
            if (pt.args) {
              for (let k = 0; k < refinement.params.length; k++) {
                const depExpr = pt.args[k];
                if (!depExpr) continue;
                const dv = constEval(depExpr, callEnv);
                if (dv === undefined) { unresolved = true; break; }   // dependent arg not constant → skip
                penv.set(refinement.params[k]!, dv);
              }
            }
            if (unresolved) continue;
            if (constEval(refinement.pred, penv) === false)
              err(this.ctx, argExprs[i]!.span,
                `value ${JSON.stringify(v)} does not satisfy refinement '${pt.pred}'`);
          }
        }

        // SagaFn: calling runs the saga to completion synchronously, yielding its
        // result type directly. This is the `Checkout(args)` = run-to-completion face.
        if (resolvedFnT.tag === "SagaFn") {
          const label = `saga '${resolvedFnT.name}'`;
          if (argTs.length !== resolvedFnT.params.length) {
            err(this.ctx, expr.span, `${label} expects ${resolvedFnT.params.length} arg(s), got ${argTs.length}`);
          } else {
            for (let i = 0; i < argTs.length; i++)
              unify(argTs[i]!, resolvedFnT.params[i]!, this.ctx, expr.span, `${label} arg ${i + 1}`);
          }
          return this.ctx.subst.apply(resolvedFnT.ret);
        }

        // Over-application (currying): `f a b` / `f(a)(b)` where `f`'s declared
        // arity is less than the number of supplied args consumes them
        // left-to-right, each intermediate result being applied to the rest.
        if (resolvedFnT.tag === "Fn" && resolvedFnT.params.length > 0
            && resolvedFnT.params.length < argTs.length) {
          let cur: Type = resolvedFnT;
          let i = 0;
          while (i < argTs.length) {
            cur = this.ctx.subst.apply(cur);
            if (cur.tag !== "Fn" || cur.params.length === 0) {
              // result isn't a function but args remain — let unify report it
              const ret2 = freshVar();
              unify(cur, { tag: "Fn", params: argTs.slice(i), ret: ret2, effects: [] },
                    this.ctx, expr.span, fnName);
              cur = this.ctx.subst.apply(ret2);
              break;
            }
            const n = Math.min(cur.params.length, argTs.length - i);
            for (let k = 0; k < n; k++)
              unify(argTs[i + k]!, cur.params[k]!, this.ctx, expr.span, `${fnName} arg ${i + k + 1}`);
            if (n < cur.params.length) {
              // final step is under-applied → yields a smaller function
              cur = { tag: "Fn", params: cur.params.slice(n), ret: cur.ret, effects: cur.effects };
              break;
            }
            cur = this.ctx.subst.apply(cur.ret);
            i += n;
          }
          return this.ctx.subst.apply(cur);
        }

        // Under-application (partial application): supplying fewer args than the
        // function's arity unifies the leading params and yields a function over
        // the remaining ones.
        if (resolvedFnT.tag === "Fn" && argTs.length > 0
            && argTs.length < resolvedFnT.params.length) {
          for (let i = 0; i < argTs.length; i++)
            unify(argTs[i]!, resolvedFnT.params[i]!, this.ctx, expr.span, `${fnName} arg ${i + 1}`);
          return this.ctx.subst.apply({
            tag: "Fn",
            params: resolvedFnT.params.slice(argTs.length),
            ret: resolvedFnT.ret,
            effects: resolvedFnT.effects,
          });
        }

        const requiredEffects = resolvedFnT.tag === "Fn" ? resolvedFnT.effects : [];

        const prevErrCount = this.ctx.diagnostics.length;
        unify(fnT, { tag: "Fn", params: argTs, ret, effects: [] }, this.ctx, expr.span, fnName);
        // If the call itself failed to type-check, return Unknown so downstream
        // uses of this expression's result don't cascade into follow-on errors.
        if (this.ctx.diagnostics.length > prevErrCount) return { tag: "Unknown" };

        // Effect check — only enforced when the caller has declared its own effects.
        if (this.ctx.effects !== null && requiredEffects.length > 0) {
          const missing = requiredEffects.filter(e => !this.ctx.effects!.includes(e));
          if (missing.length > 0) {
            const callerEffects = this.ctx.effects.length ? `[${this.ctx.effects.join(", ")}]` : "none";
            err(this.ctx, expr.span,
              `effect violation: '${expr.fn.tag === "Var" ? expr.fn.name : "fn"}' requires [${requiredEffects.join(", ")}] but current context declares ${callerEffects}`);
          }
        }

        return this.ctx.subst.apply(ret);
      }

      case "BinOp": return this.inferBinOp(expr, env);

      case "UnOp": {
        const t = this.inferExpr(expr.expr, env);
        if (expr.op === "!" || expr.op === "not") {
          unify(t, { tag: "Prim", kind: "Bool" }, this.ctx, expr.span);
          return { tag: "Prim", kind: "Bool" };
        }
        unify(t, { tag: "Prim", kind: "Number" }, this.ctx, expr.span);
        return { tag: "Prim", kind: "Number" };
      }

      case "Field": {
        const obj = this.ctx.subst.apply(this.inferExpr(expr.obj, env));
        // Saga-handle introspection: `.step`/`.status` are atoms, `.journal` is a
        // list of step atoms, `.result` is the saga's result type.
        if (obj.tag === "Named" && obj.name === "Saga") {
          const atom: Type = { tag: "Named", name: "Atom", args: [] };
          switch (expr.field) {
            case "step":
            case "status":  return atom;
            case "journal": return { tag: "Named", name: "List", args: [atom] };
            case "result":  return obj.args[0] ?? { tag: "Unknown" };
          }
        }
        const fv  = freshVar();
        unify(obj, { tag: "Record", fields: [{ name: expr.field, type: fv, optional: false }] }, this.ctx, expr.span);
        return this.ctx.subst.apply(fv);
      }

      case "Index": {
        const obj = this.ctx.subst.apply(this.inferExpr(expr.obj, env));
        const idx = this.ctx.subst.apply(this.inferExpr(expr.index, env));
        // Slice-extraction (§2.11): `xs[lo..hi]` — a Range index yields a sub-region
        // of the SAME container: List(T)→List(T), String→String, Ptr T→Ptr T. A slice
        // of a pointer carries the parent buffer's lifetime (enforced by §6.1 borrow).
        if (idx.tag === "Named" && idx.name === "Range") {
          if (obj.tag === "Prim" && obj.kind === "String") return obj;
          if (obj.tag === "Named" && (obj.name === "List" || obj.name === "Ptr")) return obj;
          const el = freshVar();
          unify(obj, { tag: "Named", name: "List", args: [el] }, this.ctx, expr.span, "slice requires a List, String, or Ptr");
          return this.ctx.subst.apply(obj);
        }
        // `d[k]` on a Dict(K, V) keys by K, yields V.
        if (obj.tag === "Named" && obj.name === "Dict" && obj.args.length === 2) {
          unify(idx, obj.args[0]!, this.ctx, expr.span, "dict key");
          return this.ctx.subst.apply(obj.args[1]!);
        }
        // `s[i]` on a String yields a one-character String.
        if (obj.tag === "Prim" && obj.kind === "String") {
          unify(idx, { tag: "Prim", kind: "Number" }, this.ctx, expr.span);
          return { tag: "Prim", kind: "String" };
        }
        // Default / unresolved: List(El) indexed by Number.
        const el = freshVar();
        unify(idx, { tag: "Prim", kind: "Number" }, this.ctx, expr.span);
        unify(obj, { tag: "Named", name: "List", args: [el] }, this.ctx, expr.span);
        return this.ctx.subst.apply(el);
      }

      case "AddrOf": {
        // `e.&` borrows e: T  →  Ptr T
        const t = this.inferExpr(expr.expr, env);
        return { tag: "Named", name: "Ptr", args: [t] };
      }

      case "Deref": {
        // `p.*` requires p: Ptr T, yields T
        const t = this.inferExpr(expr.expr, env);
        const inner = freshVar();
        unify(t, { tag: "Named", name: "Ptr", args: [inner] }, this.ctx, expr.span, "dereference requires a Ptr");
        return this.ctx.subst.apply(inner);
      }

      case "Lambda": {
        const pts = expr.params.map(() => freshVar());
        const inner = env.child();
        for (let i = 0; i < expr.params.length; i++) this.bindPat(expr.params[i]!.pat, pts[i]!, inner);
        const ret = this.inferExpr(expr.body, inner);
        return { tag: "Fn", params: pts.map(p => this.ctx.subst.apply(p)), ret, effects: [] };
      }

      case "If": {
        unify(this.inferExpr(expr.cond, env), { tag: "Prim", kind: "Bool" }, this.ctx, expr.span, "if condition");
        const thenT = this.inferExpr(expr.then, env);
        if (expr.else_) unify(thenT, this.inferExpr(expr.else_, env), this.ctx, expr.span, "if/else branches must agree");
        return this.ctx.subst.apply(thenT);
      }

      case "Match": {
        const subjT  = this.inferExpr(expr.subject, env);
        const retVar = freshVar();
        for (const b of expr.branches) {
          const bs = env.child();
          this.checkPat(b.pat, subjT, bs);
          if (b.guard) unify(this.inferExpr(b.guard, bs), { tag: "Prim", kind: "Bool" }, this.ctx, b.span, "match guard");
          unify(this.inferExpr(b.body, bs), retVar, this.ctx, b.span, "match branches must agree");
        }
        return this.ctx.subst.apply(retVar);
      }

      case "Do":   return expr.stmts.length ? this.inferBlock(expr.stmts, env) : { tag: "Prim", kind: "Unit" };
      case "Loop": this.inferBlock(expr.stmts, env); return { tag: "Prim", kind: "Unit" };

      // break/continue diverge — they never produce a value, so they unify with
      // whatever type the surrounding context demands.
      case "Break":    if (expr.value) this.inferExpr(expr.value, env); return freshVar();
      case "Continue": return freshVar();

      case "Machine": {
        // The machine's value is whatever its terminal steps yield. Infer all
        // step bodies for error-checking and unify terminal yields into one
        // result type. Step params are left as fresh vars (their types come from
        // transition arguments, which we don't statically thread through).
        const result = freshVar("machine");
        const stepParams = new Map(expr.steps.map(s => [s.name, s.params] as const));
        for (const step of expr.steps) {
          const stepEnv = env.child();
          for (const p of step.params) stepEnv.defineMono(p, freshVar(p));
          this.inferSagaBody(step.body, stepEnv, result, stepParams);
        }
        return this.ctx.subst.apply(result);
      }

      case "For": {
        // Each generator extends the scope; filters must be Bool. The body is
        // typed in the innermost scope and the comprehension yields a List of it.
        let inner = env;
        for (const clause of expr.clauses) {
          if (clause.tag === "Gen") {
            const iterT = this.inferExpr(clause.iter, inner);
            const el = freshVar();
            const resolvedIter = this.ctx.subst.apply(iterT);
            if (resolvedIter.tag === "Named" && resolvedIter.name === "Range") {
              unify(el, { tag: "Prim", kind: "Number" }, this.ctx, clause.iter.span);
            } else {
              unify(iterT, { tag: "Named", name: "List", args: [el] }, this.ctx, clause.iter.span, "for comprehension requires a List or Range");
            }
            inner = inner.child();
            this.bindPat(clause.binding, this.ctx.subst.apply(el), inner);
          } else {
            unify(this.inferExpr(clause.cond, inner), { tag: "Prim", kind: "Bool" }, this.ctx, clause.cond.span, "for comprehension filter must be Bool");
          }
        }
        const bodyT = this.inferExpr(expr.body, inner);
        return { tag: "Named", name: "List", args: [bodyT] };
      }

      case "Tuple": return { tag: "Tuple", elems: expr.elems.map(e => this.inferExpr(e, env)) };

      case "List": {
        const el = freshVar();
        for (const e of expr.elems) unify(this.inferExpr(e, env), el, this.ctx, expr.span, "list elements must agree");
        return { tag: "Named", name: "List", args: [this.ctx.subst.apply(el)] };
      }

      case "Record": {
        const fields: Field[] = [];
        if (expr.spread) {
          const base = this.ctx.subst.apply(this.inferExpr(expr.spread, env));
          if (base.tag === "Record") {
            for (const f of base.fields) fields.push({ ...f });
          }
        }
        for (const f of expr.fields) {
          const type = this.inferExpr(f.value, env);
          const existing = fields.findIndex(x => x.name === f.name);
          if (existing >= 0) fields[existing] = { name: f.name, type, optional: false };
          else fields.push({ name: f.name, type, optional: false });
        }
        return { tag: "Record", fields };
      }

      case "Propagate": {
        if (this.ctx.inSagaStep)
          err(this.ctx, expr.span, "'?' is not allowed in saga steps — use explicit match and ':abort' to handle failures");
        const t   = this.inferExpr(expr.expr, env);
        const ok  = freshVar(), e = freshVar();
        unify(t, { tag: "Named", name: "Result", args: [ok, e] }, this.ctx, expr.span);
        // Propagate error type to enclosing return type
        if (this.ctx.returnType) {
          unify(this.ctx.returnType, { tag: "Named", name: "Result", args: [freshVar(), e] }, this.ctx, expr.span);
        }
        return this.ctx.subst.apply(ok);
      }

      case "PropWith": {
        if (this.ctx.inSagaStep)
          err(this.ctx, expr.span, "'?:' is not allowed in saga steps — use explicit match and ':abort' to handle failures");
        const t  = this.inferExpr(expr.expr, env);
        const ok = freshVar();
        unify(t, { tag: "Named", name: "Result", args: [ok, freshVar()] }, this.ctx, expr.span);
        const alt = this.inferExpr(expr.alt, env);
        unify(this.ctx.subst.apply(ok), alt, this.ctx, expr.span);
        return this.ctx.subst.apply(ok);
      }

      case "Range":
        this.inferExpr(expr.from, env);
        this.inferExpr(expr.to, env);
        return { tag: "Named", name: "Range", args: [{ tag: "Prim", kind: "Number" }] };

      case "TypeTest":
        this.inferExpr(expr.expr, env);
        return { tag: "Prim", kind: "Bool" };

      case "Send": {
        // `send Store (Msg args)` — dispatch a message. Result is always Unit.
        this.inferExpr(expr.msg, env);
        return { tag: "Prim", kind: "Unit" };
      }

      case "Transaction": {
        // `transaction within { cfg } <body>` — atomic store coordination.
        // Type-check the optional config record and the body for errors, but the
        // OUTCOME is a heterogeneous ADT (`Ok v` / `Timeout {after}` /
        // `Conflict {retries}` / `Cancelled`), so we return `Unknown` and let the
        // downstream `|> match` branches drive the result type leniently.
        if (expr.config) this.inferExpr(expr.config, env);
        let bodyT: Type = { tag: "Prim", kind: "Unit" };
        if (expr.body.length) {
          // `?` inside a transaction ABORTS the transaction (rollback), it does
          // not propagate to the enclosing function — so suppress the
          // return-type propagation while inferring the body.
          const prevRet = this.ctx.returnType;
          this.ctx.returnType = null;
          bodyT = this.inferBlock(expr.body, env);
          this.ctx.returnType = prevRet;
        }
        // Outcome: the distinctly-typed `TxResult(bodyT)` ADT — `Ok v` on commit,
        // `Error e` on a bare-transaction abort, or a concurrency outcome
        // (`Conflict {retries}` / `Timeout {after}` / `Cancelled`). All five
        // constructors are resolved against TxResult at the match site (see
        // checkPat / txResultCtorType), so `c.retries` & `c.after` are typed and
        // the match is exhaustiveness-checked over the closed ctor set.
        return { tag: "Named", name: "TxResult", args: [this.ctx.subst.apply(bodyT)] };
      }

      case "Await": {
        // `await` unwraps an Async/future. We're lenient: awaiting a non-async
        // value is the identity (so `await f(x)` works whether or not f spawned).
        const t = this.ctx.subst.apply(this.inferExpr(expr.expr, env));
        // Unwrap Async, Saga, or Stream to their inner type.
        const inner = t.tag === "Async"  ? t.inner
          : t.tag === "Stream"           ? t.inner
          : (t.tag === "Named" && t.name === "Saga" ? (t.args[0] ?? t) : t);
        if (expr.branches.length === 0) return this.ctx.subst.apply(inner);
        const ret = freshVar();
        for (const b of expr.branches) {
          const bs = env.child();
          this.checkPat(b.pat, this.ctx.subst.apply(inner), bs);
          if (b.guard) unify(this.inferExpr(b.guard, bs), { tag: "Prim", kind: "Bool" }, this.ctx, b.span);
          unify(this.inferExpr(b.body, bs), ret, this.ctx, b.span);
        }
        return this.ctx.subst.apply(ret);
      }

      case "Go": {
        // `go sagaExpr(args)` spawns a live saga instance, yielding a `Saga T`
        // handle (with `.step`, `.status`, `.journal`). Works for any callee whose
        // resolved type is SagaFn — including aliases like `let mySaga = Checkout`.
        // `go expr` for non-saga callees spawns a task and yields `Async T`.
        if (expr.expr.tag === "Call") {
          const fnT = this.ctx.subst.apply(this.inferExpr(expr.expr.fn, env));
          if (fnT.tag === "SagaFn") {
            const argTs = expr.expr.args.map(a => this.inferExpr(a, env));
            const label = `saga '${fnT.name}'`;
            if (argTs.length !== fnT.params.length) {
              err(this.ctx, expr.span, `${label} expects ${fnT.params.length} arg(s), got ${argTs.length}`);
            } else {
              for (let i = 0; i < argTs.length; i++)
                unify(argTs[i]!, fnT.params[i]!, this.ctx, expr.span, `${label} arg ${i + 1}`);
            }
            const handle: Type = { tag: "Named", name: "Saga", args: [this.ctx.subst.apply(fnT.ret)] };
            this.types.set(expr.expr, handle);
            return handle;
          }
        }
        const t = this.inferExpr(expr.expr, env);
        return { tag: "Async", inner: t };
      }

      case "Resume": {
        // `resume sagaExpr(args)` re-hydrates a crashed saga from its journal and
        // runs it to completion, yielding the saga's result type. Like `go`, works
        // for any SagaFn-typed callee — not just literal saga names.
        if (expr.expr.tag === "Call") {
          const fnT = this.ctx.subst.apply(this.inferExpr(expr.expr.fn, env));
          if (fnT.tag === "SagaFn") {
            const argTs = expr.expr.args.map(a => this.inferExpr(a, env));
            for (let i = 0; i < Math.min(argTs.length, fnT.params.length); i++)
              unify(argTs[i]!, fnT.params[i]!, this.ctx, expr.span);
            const ret = this.ctx.subst.apply(fnT.ret);
            this.types.set(expr.expr, ret);
            return ret;
          }
        }
        return this.inferExpr(expr.expr, env);
      }

      case "Drop": {
        // `drop x` releases its operand and evaluates to Unit. Any value may be
        // dropped; the borrow checker (future) tracks the move.
        this.inferExpr(expr.expr, env);
        return { tag: "Prim", kind: "Unit" };
      }

      case "Try": {
        // Design A: the block evaluates to `Result T E`. `?` inside collapses to
        // *this* block, not the enclosing function, so we swap `returnType` to the
        // try's Result while inferring the body. The last line is the success
        // value and must itself be a `Result` (e.g. ends in `Ok …`).
        const ok = freshVar(), e = freshVar();
        const tryType: Type = { tag: "Named", name: "Result", args: [ok, e] };
        const prevRet = this.ctx.returnType;
        this.ctx.returnType = tryType;
        const lastT = this.inferTryBody(expr.stmts, env, e, expr.span);
        this.ctx.returnType = prevRet;
        unify(ok, lastT, this.ctx, expr.span, "try block value");   // Ok payload = last line
        return this.ctx.subst.apply(tryType);
      }

      case "Retry": {
        // Like Try, but the body is re-run on Error. Same Result type; the count,
        // if present, must be a Number.
        // count is either a Number (attempt cap) or a List of delays (schedule);
        // infer it but don't over-constrain. A bare `after D` delay must be Number.
        // count is a Number cap or a list of delays; delay is a Duration/Number.
        // Infer for elaboration but don't over-constrain (Duration evals to ms).
        if (expr.count) this.inferExpr(expr.count, env);
        if (expr.delay) this.inferExpr(expr.delay, env);
        const ok = freshVar(), e = freshVar();
        const tryType: Type = { tag: "Named", name: "Result", args: [ok, e] };
        const prevRet = this.ctx.returnType;
        this.ctx.returnType = tryType;
        const lastT = this.inferTryBody(expr.stmts, env, e, expr.span);
        this.ctx.returnType = prevRet;
        unify(ok, lastT, this.ctx, expr.span, "retry block value");
        return this.ctx.subst.apply(tryType);
      }

      case "Element": {
        if (expr.content) this.inferExpr(expr.content, env);
        const mode = PRIMITIVE_MODE[expr.name];
        const isPrimitive = mode !== undefined;
        for (const p of expr.props) {
          const vt = this.inferExpr(p.value, env);
          const expected = ELEMENT_PROP_TYPES[p.name] ?? PRIMITIVE_PROP_TYPES[expr.name]?.[p.name];
          if (expected) {
            // Bare-number → Px coercion: a `Length` prop accepts a plain Number.
            const isLen = expected.tag === "Named" && expected.name === "Length";
            const got = this.ctx.subst.apply(vt);
            if (!(isLen && got.tag === "Prim" && got.kind === "Number"))
              unify(expected, vt, this.ctx, p.value.span, `prop '${p.name}'`);
          }
          // Unknown-prop: on a known primitive, a prop outside its closed vocabulary
          // (common props ∪ this primitive's functional props) is almost always a typo.
          else if (isPrimitive && !COMMON_PROPS.has(p.name))
            err(this.ctx, p.value.span,
              `unknown prop '${p.name}' on ${expr.name}`);
          // Own-context: container props need this element to be flex/grid.
          if (CONTAINER_PROPS.has(p.name) && mode !== undefined && mode !== "flex")
            err(this.ctx, p.value.span,
              `prop '${p.name}' applies to flex containers (Row/Column/Stack/Grid); ${expr.name} is a ${mode}`);
          // Token scale (opt-in): if the project defined the prop's scale refinement,
          // a constant value must satisfy it. `raw(n)`/`Px n` are opaque to constEval.
          const scaleName = PROP_SCALE[p.name];
          const refinement = scaleName ? REFINEMENTS.get(scaleName) : undefined;
          if (refinement) {
            const cv = constEval(p.value, EMPTY_ENV);
            if (typeof cv === "number" &&
                constEval(refinement.pred, new Map([["value", cv]])) === false)
              err(this.ctx, p.value.span,
                `${cv} is off the '${scaleName}' scale; use a scale value or raw(${cv})`);
          }
        }
        // Required-prop: a primitive that cannot render without a prop (Image needs
        // a source, Link needs a destination) errors when it is missing.
        if (isPrimitive) {
          const present = new Set(expr.props.map(p => p.name));
          for (const req of REQUIRED_PROPS[expr.name] ?? [])
            if (!present.has(req))
              err(this.ctx, expr.span, `${expr.name} requires a '${req}' prop`);
        }
        // Parent-context: a directly-nested child's flex-item props need THIS to be flex.
        for (const c of expr.children) {
          if (c.tag === "Element" && mode !== undefined && mode !== "flex")
            for (const cp of c.props)
              if (FLEX_ITEM_PROPS.has(cp.name))
                err(this.ctx, cp.value.span,
                  `prop '${cp.name}' requires a flex parent (Row/Column/Stack/Grid); parent ${expr.name} is a ${mode}`);
          this.inferExpr(c, env);
        }
        return { tag: "Named", name: "Element", args: [] };
      }

      case "Handler": {
        // An event handler appears as an element child; its body is type-checked for
        // effects/errors but contributes no value. An optional event param (`on
        // onInput e -> …`) is bound to the `Event` record so `e.value`/`e.key`/
        // `e.checked` type-check (String/String/Bool — the fields buildDom marshals).
        let bodyEnv = env;
        if (expr.param) {
          const str: Type = { tag: "Prim", kind: "String" };
          const bool: Type = { tag: "Prim", kind: "Bool" };
          bodyEnv = env.child();
          bodyEnv.defineMono(expr.param, { tag: "Record", fields: [
            { name: "value",   type: str,  optional: false },
            { name: "key",     type: str,  optional: false },
            { name: "checked", type: bool, optional: false },
          ] });
        }
        this.inferExpr(expr.body, bodyEnv);
        return { tag: "Prim", kind: "Unit" };
      }

      case "JSExpr":
        // Raw JS — no type checking; result is opaque.
        return { tag: "Unknown" };

      default: return { tag: "Unknown" };
    }
  }

  // ── BinOp ──────────────────────────────────────────────────────────────────

  private inferBinOp(expr: Extract<Expr, { tag: "BinOp" }>, env: TypeEnv): Type {
    const l = this.inferExpr(expr.left, env);
    const r = this.inferExpr(expr.right, env);
    const num:  Type = { tag: "Prim", kind: "Number" };
    const bool: Type = { tag: "Prim", kind: "Bool" };

    // Duration is a distinct "dimension": it scales by a Number and adds to itself,
    // but `Duration * Duration` (time²) and `Duration + Number` are nonsense.
    const dur: Type = { tag: "Named", name: "Duration", args: [] };
    const isDur = (t: Type) => { const a = this.ctx.subst.apply(t); return a.tag === "Named" && a.name === "Duration"; };

    switch (expr.op) {
      case "+": case "-": {
        // Duration ± Duration → Duration; Number ± Number → Number; mixed → error.
        if (isDur(l) || isDur(r)) {
          unify(l, dur, this.ctx, expr.span, `'${expr.op}' on a Duration needs both operands to be Durations`);
          unify(r, dur, this.ctx, expr.span, `'${expr.op}' on a Duration needs both operands to be Durations`);
          return dur;
        }
        unify(l, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        unify(r, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        return num;
      }
      case "*": {
        // Duration * Number / Number * Duration → Duration (scaling); Duration² → error.
        const ld = isDur(l), rd = isDur(r);
        if (ld && rd) { err(this.ctx, expr.span, "cannot multiply two Durations (the result would be time²)"); return dur; }
        if (ld) { unify(r, num, this.ctx, expr.span, "scaling a Duration requires a Number"); return dur; }
        if (rd) { unify(l, num, this.ctx, expr.span, "scaling a Duration requires a Number"); return dur; }
        unify(l, num, this.ctx, expr.span, "'*' requires Number");
        unify(r, num, this.ctx, expr.span, "'*' requires Number");
        return num;
      }
      case "/": {
        // Duration / Number → Duration; Duration / Duration → Number (ratio).
        const ld = isDur(l), rd = isDur(r);
        if (ld && rd) return num;
        if (ld) { unify(r, num, this.ctx, expr.span, "dividing a Duration requires a Number"); return dur; }
        if (rd) { err(this.ctx, expr.span, "cannot divide a Number by a Duration"); return num; }
        unify(l, num, this.ctx, expr.span, "'/' requires Number");
        unify(r, num, this.ctx, expr.span, "'/' requires Number");
        return num;
      }
      case "%": case "^":
      case "<<": case ">>": case "&": case "xor": case "|":
        unify(l, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        unify(r, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        return num;
      case "++":
        unify(l, r, this.ctx, expr.span, "'++' operands must agree"); return this.ctx.subst.apply(l);
      case "==": case "!=": case "<": case ">": case "<=": case ">=":
        unify(l, r, this.ctx, expr.span, `'${expr.op}' operands must agree`); return bool;
      case "&&": case "||":
        unify(l, bool, this.ctx, expr.span, `'${expr.op}' requires Bool`);
        unify(r, bool, this.ctx, expr.span, `'${expr.op}' requires Bool`);
        return bool;
      default: return { tag: "Unknown" };
    }
  }

  // ── Block (sequential let-scoping) ────────────────────────────────────────

  private inferBlock(stmts: Stmt[], parentEnv: TypeEnv): Type {
    let env = parentEnv;
    let last: Type = { tag: "Prim", kind: "Unit" };

    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          const vt = this.inferExpr(stmt.value, env);
          let bindType = vt;
          if (stmt.ascription) {
            const prevErrCount = this.ctx.diagnostics.length;
            unify(resolveRef(stmt.ascription, new Map(), this.sagaRets), vt, this.ctx, stmt.span);
            // If the ascription check failed, bind the name as Unknown so downstream
            // uses of this variable don't cascade into follow-on type errors.
            if (this.ctx.diagnostics.length > prevErrCount) bindType = { tag: "Unknown" };
          }
          const next = env.child();
          this.bindPat(stmt.pat, bindType, next);
          env = next;
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SExpr":
          last = this.inferExpr(stmt.expr, env);
          break;
        case "SAssign": {
          // The lvalue's slot type must accept the assigned value.
          const tt = this.inferExpr(stmt.target, env);
          const vt = this.inferExpr(stmt.value, env);
          unify(tt, vt, this.ctx, stmt.span, "assignment");
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SBreak": case "SReturn":
          if (stmt.value) last = this.inferExpr(stmt.value, env);
          break;
      }
    }
    return last;
  }

  // Implicit `try` body: like inferBlock, but every line's value is auto-unwrapped
  // — a `Result a b` contributes its error `b` to the block's error type and binds
  // the unwrapped `a`; a non-Result passes through. Returns the (unwrapped) type of
  // the last line, which becomes the block's `Ok` payload.
  private inferTryBody(stmts: Stmt[], parentEnv: TypeEnv, errType: Type, span: Span): Type {
    let env = parentEnv;
    let last: Type = { tag: "Prim", kind: "Unit" };
    const peel = (t: Type): Type => {
      const at = this.ctx.subst.apply(t);
      if (at.tag === "Named" && at.name === "Result" && at.args.length === 2) {
        unify(at.args[1]!, errType, this.ctx, span, "try error type");
        return at.args[0]!;
      }
      return at;
    };
    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          let bindType = peel(this.inferExpr(stmt.value, env));
          if (stmt.ascription) {
            const prevErrCount = this.ctx.diagnostics.length;
            unify(resolveRef(stmt.ascription, new Map(), this.sagaRets), bindType, this.ctx, stmt.span);
            if (this.ctx.diagnostics.length > prevErrCount) bindType = { tag: "Unknown" };
          }
          const next = env.child();
          this.bindPat(stmt.pat, bindType, next);
          env = next;
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SExpr":
          last = peel(this.inferExpr(stmt.expr, env));
          break;
        case "SAssign": {
          const tt = this.inferExpr(stmt.target, env);
          const vt = this.inferExpr(stmt.value, env);
          unify(tt, vt, this.ctx, stmt.span, "assignment");
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SBreak": case "SReturn":
          if (stmt.value) last = peel(this.inferExpr(stmt.value, env));
          break;
      }
    }
    return last;
  }

  // ── Literal types ─────────────────────────────────────────────────────────

  private litType(lit: Lit): Type {
    switch (lit.tag) {
      case "Str":      return { tag: "Prim", kind: "String" };
      case "Num":      return { tag: "Prim", kind: "Number" };
      case "Bool":     return { tag: "Prim", kind: "Bool" };
      case "Unit":     return { tag: "Prim", kind: "Unit" };
      case "Atom":     return { tag: "Atom", name: lit.name };
      case "Duration": return { tag: "Named", name: "Duration", args: [] };   // distinct from Number; dimensional arithmetic in inferBinOp
    }
  }

  // ── Pattern type-checking ─────────────────────────────────────────────────

  private checkPat(pat: Pat, t: Type, env: TypeEnv): void {
    const at = this.ctx.subst.apply(t);
    switch (pat.tag) {
      case "PWild": break;
      case "PVar":  env.defineMono(pat.name, at); break;
      case "PTyped": env.defineMono(pat.name, at); break;

      case "PLit":
        unify(at, this.litType(pat.lit), this.ctx, pat.span);
        break;

      case "PAtom":
        unify(at, { tag: "Atom", name: pat.name }, this.ctx, pat.span);
        break;

      case "PCtor": {
        // Expected-type-directed constructor resolution for TxResult: its ctors
        // (Ok/Error/Conflict/Timeout/Cancelled) share names with Result, so the
        // EXPECTED type disambiguates them and gives Conflict/Timeout their typed
        // record payloads. Falls through to the normal env lookup for any other
        // name matched against a TxResult (so genuinely unknown ctors stay lenient).
        if (at.tag === "Named" && at.name === "TxResult" && TX_RESULT_CTORS.has(pat.name)) {
          const ct = txResultCtorType(pat.name, at.args[0] ?? freshVar());
          if (ct) {
            if (ct.tag === "Fn") {
              unify(at, ct.ret, this.ctx, pat.span);
              if (pat.inner) this.checkPat(pat.inner, ct.params[0] ?? { tag: "Unknown" }, env);
            } else {
              unify(at, ct, this.ctx, pat.span);
            }
            break;
          }
        }
        // Same constructor-sharing dance for Async(a): an `Error`/`After`/etc. arm
        // against an Async scrutinee is resolved against Async, not Result.
        if (at.tag === "Async" && ASYNC_CTORS.has(pat.name)) {
          const ct = asyncCtorType(pat.name, at.inner);
          if (ct) {
            if (ct.tag === "Fn") {
              unify(at, ct.ret, this.ctx, pat.span);
              if (pat.inner) this.checkPat(pat.inner, ct.params[0] ?? { tag: "Unknown" }, env);
            } else {
              unify(at, ct, this.ctx, pat.span);
            }
            break;
          }
        }
        const s = env.lookup(pat.name);
        if (!s) break;
        const ct = instantiate(s);
        if (ct.tag === "Fn") {
          unify(at, ct.ret, this.ctx, pat.span);
          if (pat.inner) this.checkPat(pat.inner, ct.params[0] ?? { tag: "Unknown" }, env);
        } else {
          unify(at, ct, this.ctx, pat.span);
        }
        break;
      }

      case "PTuple": {
        const vars = pat.elems.map(() => freshVar());
        unify(at, { tag: "Tuple", elems: vars }, this.ctx, pat.span);
        for (let i = 0; i < pat.elems.length; i++) this.checkPat(pat.elems[i]!, this.ctx.subst.apply(vars[i]!), env);
        break;
      }

      case "PRecord": {
        const fields = pat.fields.map(f => { const fv = freshVar(); return { f, fv }; });
        unify(at, { tag: "Record", fields: fields.map(({ f, fv }) => ({ name: f.name, type: fv, optional: false })) }, this.ctx, pat.span);
        for (const { f, fv } of fields) this.checkPat(f.pat, this.ctx.subst.apply(fv), env);
        break;
      }
    }
  }

  private bindPat(pat: Pat, t: Type, env: TypeEnv): void { this.checkPat(pat, t, env); }
}
