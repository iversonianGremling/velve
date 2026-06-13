import type { Span } from "./span.js";
import { freshVar, typeToString, mkDims, dimsEqual, dimsMul, dimsDiv, isDimensionless } from "./types.js";
import type { Dims } from "./types.js";
import { stdlibLookup, stdlibModule, STDLIB_MODULE_NAMES } from "./stdlib.js";
import { PRIMITIVE_MODE } from "./elements.js";
import type { Type, Field, RowEntry } from "./types.js";
import type {
  Module, Decl, Expr, Stmt, Pat, FnClause, FnSig, SagaStmt,
  TypeRef, Lit, Param,
} from "./ast.js";
import { patKey } from "./ast.js";
import type { ResolutionMap, Diagnostic } from "./resolve.js";
import { resolveNamedCall, needsResolution, type ParamSlot } from "./callresolve.js";
import { type Edition, atLeast } from "./edition.js";
import {
  type LCH, lch, hexToOklch3, oklchToHex, apcaTriple, DEFAULT_THEME,
  cGray, cLighten, cDarken, cSaturate, cDesaturate, cRotate, cComplement, cCusp, cMix, cLegibleOn, cShades, cTints, cRamp,
} from "./color.js";

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

// A stdlib module as a Record type — shared by namespace imports and the
// ambient qualified form (`Math.sqrt` with no import, SPEC §5.5).
function moduleRecordType(mod: Record<string, Scheme>): Type {
  return { tag: "Record", fields: Object.entries(mod).map(([name, scheme]) => ({
    name,
    type: scheme.type, // intentionally not generalized — field access is monomorphic
    optional: false,
  })) };
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
      // ErrRow is identity-shared per def (entries mutate in place) — never rebuild.
      case "Prim": case "Atom": case "Unknown": case "Inputmap": case "ErrRow": return t;
      case "Named":      return { ...t, args: t.args.map(a => this.apply(a)) };
      case "Fn":         return { ...t, params: t.params.map(p => this.apply(p)), ret: this.apply(t.ret) };
      case "SagaFn":     return { ...t, params: t.params.map(p => this.apply(p)), ret: this.apply(t.ret) };
      case "Tuple":      return { ...t, elems: t.elems.map(e => this.apply(e)) };
      case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: this.apply(f.type) })) };
      case "Tainted":    return { ...t, inner: this.apply(t.inner) };
      case "Async":      return { ...t, inner: this.apply(t.inner) };
      case "Stream":     return { ...t, inner: this.apply(t.inner) };
      case "Refinement": return { ...t, base: this.apply(t.base) };
      case "United":     return { ...t, base: this.apply(t.base) };
    }
  }
}

function applyOne(t: Type, id: number, rep: Type): Type {
  switch (t.tag) {
    case "Var":        return t.id === id ? rep : t;
    case "Prim": case "Atom": case "Unknown": case "Inputmap": case "ErrRow": return t;
    case "Named":      return { ...t, args: t.args.map(a => applyOne(a, id, rep)) };
    case "Fn":         return { ...t, params: t.params.map(p => applyOne(p, id, rep)), ret: applyOne(t.ret, id, rep) };
    case "SagaFn":     return { ...t, params: t.params.map(p => applyOne(p, id, rep)), ret: applyOne(t.ret, id, rep) };
    case "Tuple":      return { ...t, elems: t.elems.map(e => applyOne(e, id, rep)) };
    case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: applyOne(f.type, id, rep) })) };
    case "Tainted":    return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Async":      return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Stream":     return { ...t, inner: applyOne(t.inner, id, rep) };
    case "Refinement": return { ...t, base: applyOne(t.base, id, rep) };
    case "United":     return { ...t, base: applyOne(t.base, id, rep) };
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
    case "United": collectFree(t.base, acc); break;
  }
}

function substVars(t: Type, sub: Map<number, Type>): Type {
  switch (t.tag) {
    case "Var":        return sub.get(t.id) ?? t;
    case "Named":      return { ...t, args: t.args.map(a => substVars(a, sub)) };
    case "Fn": {
      const f: Type & { tag: "Fn" } = { ...t, params: t.params.map(p => substVars(p, sub)), ret: substVars(t.ret, sub) };
      // An effect tail (S4c) is a quantified id too: remap it so each
      // instantiation judges its own per-call-site binding.
      if (t.effectTail !== undefined) {
        const m = sub.get(t.effectTail);
        if (m?.tag === "Var") f.effectTail = m.id;
      }
      return f;
    }
    case "SagaFn":     return { ...t, params: t.params.map(p => substVars(p, sub)), ret: substVars(t.ret, sub) };
    case "Tuple":      return { ...t, elems: t.elems.map(e => substVars(e, sub)) };
    case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: substVars(f.type, sub) })) };
    case "Tainted":    return { ...t, inner: substVars(t.inner, sub) };
    case "Async":      return { ...t, inner: substVars(t.inner, sub) };
    case "Stream":     return { ...t, inner: substVars(t.inner, sub) };
    case "Refinement": return { ...t, base: substVars(t.base, sub) };
    case "United":     return { ...t, base: substVars(t.base, sub) };
    default:           return t;
  }
}

// Row tails (S4b): instantiation of a generic row def swaps the def's BASE
// row for a per-call-site clone. These mirror substVars' traversal; ErrRow
// identity is otherwise sacred (Subst.apply never rebuilds a row) —
// instantiateAtUse is the ONE place a row is ever rebuilt.
function findRow(t: Type): (Type & { tag: "ErrRow" }) | null {
  switch (t.tag) {
    case "ErrRow":     return t;
    case "Named":      for (const a of t.args) { const r = findRow(a); if (r) return r; } return null;
    case "Fn": case "SagaFn":
                       for (const p of t.params) { const r = findRow(p); if (r) return r; } return findRow(t.ret);
    case "Tuple":      for (const e of t.elems) { const r = findRow(e); if (r) return r; } return null;
    case "Record":     for (const f of t.fields) { const r = findRow(f.type); if (r) return r; } return null;
    case "Tainted": case "Async": case "Stream": return findRow(t.inner);
    case "Refinement": return findRow(t.base);
    case "United":     return findRow(t.base);
    default:           return null;
  }
}

function replaceRow(t: Type, from: Type, to: Type): Type {
  switch (t.tag) {
    case "ErrRow":     return t === from ? to : t;
    case "Named":      return { ...t, args: t.args.map(a => replaceRow(a, from, to)) };
    case "Fn":         return { ...t, params: t.params.map(p => replaceRow(p, from, to)), ret: replaceRow(t.ret, from, to) };
    case "SagaFn":     return { ...t, params: t.params.map(p => replaceRow(p, from, to)), ret: replaceRow(t.ret, from, to) };
    case "Tuple":      return { ...t, elems: t.elems.map(e => replaceRow(e, from, to)) };
    case "Record":     return { ...t, fields: t.fields.map(f => ({ ...f, type: replaceRow(f.type, from, to) })) };
    case "Tainted":    return { ...t, inner: replaceRow(t.inner, from, to) };
    case "Async":      return { ...t, inner: replaceRow(t.inner, from, to) };
    case "Stream":     return { ...t, inner: replaceRow(t.inner, from, to) };
    case "Refinement": return { ...t, base: replaceRow(t.base, from, to) };
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

// ── Error rows (error-rows-design v1, S1) ─────────────────────────────────────
// A `Result T _` def owns ONE ErrRow instance; `?` inside it accumulates the
// ctor contributions of what it propagates. Rows never unify — generic unify
// treats them as accumulate-or-skip — and are inclusion-checked at pins after
// the whole module is inferred (rows referencing other rows close by fixpoint).
type ErrRowT = Type & { tag: "ErrRow" };
// type name → its constructors (for contributions and pin coverage). Cleared per module.
let ADT_CTORS = new Map<string, RowEntry[]>();
// target ⊇ source edges between rows (a `_` def consuming a `_` def).
let ROW_DEPS: [ErrRowT, ErrRowT][] = [];
// ctor name → every ADT that declares it (constructor sharing). For a name with
// ≥2 owners, expression-position uses are EXPECTED-TYPE-driven (deferred and
// judged in finalizeRows once the substitution shows what the context demanded)
// instead of last-declaration-wins. Cleared per module.
let CTOR_OWNERS = new Map<string, { typeName: string; scheme: Scheme }[]>();
// Row tails (row-variables-design S4b): a row def's declared type params
// (name → quantified var id), so a body skolem reaching the row is recorded
// as a TAIL instead of fabricating a bogus pseudo-ctor named after the type
// variable. TAIL_INFO carries the diagnostic labels per quantified id.
// Cleared per module.
let ROW_TAIL_PARAMS = new Map<ErrRowT, Map<string, number>>();
let TAIL_INFO = new Map<number, { owner: string; param: string; tv: string }>();
// Effect tails (row-variables-design S4c/E1): tail var id → the effect names
// that flowed into it. A tailed Fn's full effect row is `effects` ∪ its tail's
// binding. Tails appear only on builtin HOF prelude signatures (E2 user-spelled
// tails deferred); their ids are quantified, so instantiation remaps them
// (substVars) and each call site judges its own binding. Bindings ACCUMULATE
// (effect sets only grow) — the row discipline: accumulate, never unify.
// Cleared per module.
let EFFECT_TAILS = new Map<number, string[]>();

// The full effect row of a fn type: its declared names plus whatever its
// effect tail has absorbed so far.
function fnEffectRow(f: Type & { tag: "Fn" }): string[] {
  const tail = f.effectTail !== undefined ? EFFECT_TAILS.get(f.effectTail) : undefined;
  if (!tail || tail.length === 0) return f.effects;
  const out = [...f.effects];
  for (const e of tail) if (!out.includes(e)) out.push(e);
  return out;
}

// Fn-unify's only effect rule (S4c): a side that declared a tail absorbs the
// other side's full row. Effects themselves still never unify — a plain
// `effects: []` (e.g. a call shape or an ascription) constrains nothing.
function bindEffectTails(ta: Type & { tag: "Fn" }, tb: Type & { tag: "Fn" }): void {
  for (const [tailed, other] of [[ta, tb], [tb, ta]] as const) {
    if (tailed.effectTail === undefined || tailed.effectTail === other.effectTail) continue;
    const fx = fnEffectRow(other);
    if (fx.length === 0) continue;
    const cur = EFFECT_TAILS.get(tailed.effectTail) ?? [];
    for (const e of fx) if (!cur.includes(e)) cur.push(e);
    EFFECT_TAILS.set(tailed.effectTail, cur);
  }
}

// What a callee's error type contributes to a row. Null = no contribution
// possible from this type. A Var at the `?` site is DEFERRED and re-judged in
// finalizeRows once the module is complete (S3 polish — the try-soundness
// sweep shape); a type that never resolves to something contributable is
// rejected there, not silently dropped.
function rowContribution(t: Type): RowEntry[] | null {
  if (t.tag === "Refinement") return rowContribution(t.base);
  if (t.tag === "Named") {
    const ctors = ADT_CTORS.get(t.name);
    if (ctors) return ctors;
    // opaque named error with no known ctor list — treat the type name as the
    // ctor (the single-ctor `ParseError` pattern: ctor and type share a name)
    if (t.args.length === 0) return [{ name: t.name, payload: null }];
    return null;
  }
  if (t.tag === "Prim" && t.kind === "String")
    return [{ name: "String", payload: null, prose: true }];
  if (t.tag === "Atom")
    return [{ name: `:${t.name}`, payload: null, prose: true }];
  return null;
}

// S4b: a zero-arg Named matching one of the row def's OWN type params is a
// TAIL — the quantified error var of (typically) a callback parameter — not
// an opaque single-ctor error type. Record its quantified id on the row;
// per-call-site clones judge what each tail became once the module is
// complete (finalizeRows steps 0.4/0.5). Returns false for any name that is
// not a type param of this row's def, so the opaque fallback above is
// untouched for genuinely foreign names.
function tailContribution(row: ErrRowT, t: Type): boolean {
  if (t.tag !== "Named" || t.args.length !== 0) return false;
  const id = ROW_TAIL_PARAMS.get(row)?.get(t.name);
  if (id === undefined) return false;
  if (!row.tails.includes(id)) row.tails.push(id);
  return true;
}

function addRowEntries(row: ErrRowT, entries: RowEntry[]): boolean {
  let added = false;
  for (const e of entries) {
    if (!row.entries.some(x => x.name === e.name)) { row.entries.push(e); added = true; }
  }
  return added;
}

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
// Unit-of-measure types (`type Meters = Number unit m`, B2). Kept separately like
// REFINEMENTS: they resolve to a `United` type carrying the normalized dimension
// vector. UNLIKE refinements, a unit is NOT transparent to its base — the algebra
// (inferBinOp) enforces dimensional consistency; the solver never sees `dims`.
let UNITS = new Map<string, { baseRef: TypeRef; dims: Dims }>();
// Function parameter names (first clause), so a dependent refinement argument like
// `listLength list` can be resolved against the actual call arguments.
let FN_PARAMS = new Map<string, string[]>();
// Full parameter slots (first clause) for named-argument / default resolution.
let FN_SIGS = new Map<string, ParamSlot[]>();
// Clauses of every `@total` function (decorator or module `proofs: [total]` —
// DFn.total is set at lower time for both). `constEval` may apply these at
// compile time (totality-design §5.1): the totality promise is what makes
// running user code inside the type checker safe. Fuel-bounded anyway, because
// `Number` ≠ `Nat` (`fact(-1)` passes the literal-floor rule yet diverges) —
// out of fuel folds to undefined (conservative skip), never a hung compiler.
let TOTAL_FNS = new Map<string, FnClause[]>();
const ALIAS_RESOLVING = new Set<string>();   // cycle guard

// ── The Tier-1.5 relational witness (north-star §3.3, SPEC §12.7) ────────────
// A dependent refinement is a BOUNDS WITNESS when its predicate is exactly the
// in-range shape — `0 <= value && value < n` (either operand order, either
// conjunct order) with `n` the refinement's single value-param — and the use
// site instantiates `n` with `length(p)` over a sibling param. Unlike the
// InBounds ADT (SPEC §7.1), the witness is RELATIONAL: it ties the index to
// THAT list, through two fact-env bridges in facts.ts:
//   • DEMAND (caller side): a call argument at a witness param that constEval
//     can't settle is recorded here, keyed by the argument's AST node; inside
//     a `proofs: [bounds]` scope facts.ts must PROVE it from path facts
//     (interval floor → Z3), else it errors. Outside a proved scope the
//     demand stays today's skip — the proof gradient, unchanged.
//   • SEED (callee side): a proved-scope fn ASSUMES its own witness params'
//     facts (facts.ts `witnessSeeds`), so the body's read discharges with no
//     guard. Sound within the proved region by assume/guarantee at the
//     signature: every proved caller discharged the demand. An unproved
//     caller can still fault the callee — the same standing as any call out
//     of an unproved scope, and the runtime read still faults loudly.
// The witness also travels in RETURN position through the Result gate
// `gate(xs, i): Result(Index(length(xs)), e)` — a checked constructor for the
// witness. Two more bridges, both still under `proofs: [bounds]`:
//   • GUARANTEE (callee): inside such a fn, every `Ok(payload)` is itself a
//     witness DEMAND on `payload` (recorded below, enforced by the same
//     facts.ts machinery) — the success path must PROVE its index in range
//     from the body's guard, so the gate cannot lie.
//   • SEED (caller): a call to such a gate is recorded in WITNESS_RETURNS with
//     the caller's list substituted in; facts.ts seeds the witness facts onto
//     the `Ok`-binder of a `match gate(xs, i) | Ok(j) -> …`, so the licensed
//     read needs no guard.
// v1 honest bounds: the demand attaches to direct full-arity calls (a
// witness-param fn passed as a value or partially applied escapes it); the
// return witness rides the Result GATE only — a bare `Index(length(xs))`
// return would need a tail-position guarantee check, a named follow-on.
export interface WitnessDemand { list: string | null; ref: string }
export let WITNESS_DEMANDS = new Map<Expr, WitnessDemand>();
// Caller-side seed table: a gate call → the witness it returns, with the
// caller's actual list name substituted for the callee's param. `null` list
// means the list argument wasn't a bare name (no facts can attach).
export interface WitnessReturn { list: string | null; ref: string }
export let WITNESS_RETURNS = new Map<Expr, WitnessReturn>();

// `length(p)` over a bare name — the only bound spelling v1 accepts.
function lenOverVar(e: Expr): string | null {
  if (e.tag !== "Call" || e.fn.tag !== "Var" || e.fn.name !== "length") return null;
  if (e.args.length !== 1 || e.named.length > 0) return null;
  const a = e.args[0];
  return a && a.tag === "Var" ? a.name : null;
}

// The predicate shape test: `0 <= value && value < n` with `n` the single
// value-param. Returns `n` or null.
function boundsWitnessParam(refName: string): string | null {
  const r = REFINEMENTS.get(refName);
  if (!r || r.params.length !== 1) return null;
  const n = r.params[0]!;
  const p = r.pred;
  if (p.tag !== "BinOp" || p.op !== "&&") return null;
  const isValue = (e: Expr) => e.tag === "Var" && e.name === "value";
  const isZero  = (e: Expr) => e.tag === "Lit" && e.lit.tag === "Num" && e.lit.value === 0;
  const isN     = (e: Expr) => e.tag === "Var" && e.name === n;
  const lower = (a: Expr) => a.tag === "BinOp" &&
    ((a.op === ">=" && isValue(a.left) && isZero(a.right)) ||
     (a.op === "<=" && isZero(a.left) && isValue(a.right)));
  const upper = (a: Expr) => a.tag === "BinOp" &&
    ((a.op === "<" && isValue(a.left) && isN(a.right)) ||
     (a.op === ">" && isN(a.left) && isValue(a.right)));
  return (lower(p.left) && upper(p.right)) || (lower(p.right) && upper(p.left)) ? n : null;
}

// Demand-side view: from a use-site Refinement TYPE (pred name + dependent
// arg exprs from the signature), the callee param the bound measures.
function witnessUseOf(pt: Type & { tag: "Refinement" }): { ref: string; listParam: string } | null {
  if (!pt.args) return null;
  const n = boundsWitnessParam(pt.pred);
  if (n === null) return null;
  const r = REFINEMENTS.get(pt.pred)!;
  const dep = pt.args[r.params.indexOf(n)];
  if (!dep) return null;
  const listParam = lenOverVar(dep);
  return listParam === null ? null : { ref: pt.pred, listParam };
}

// Return-gate view: the success payload of `Result(Index(length(p)), e)` is a
// witness for `p` — the gate proves its own payload on the Ok path.
function resultWitnessRet(t: Type): { ref: string; listParam: string } | null {
  if (t.tag !== "Named" || t.name !== "Result" || t.args.length < 1) return null;
  const ok = t.args[0];
  return ok && ok.tag === "Refinement" ? witnessUseOf(ok) : null;
}

// Bare-return view: a def returning `Index(length(p))` UNWRAPPED is itself a
// gate — every tail position of its body is a witness DEMAND (the GUARANTEE,
// recorded in inferClause over tailExprs), and a call to it seeds a `let`
// binder in the caller (the SEED, the same WITNESS_RETURNS table the Result
// gate uses). The total path: no Error escape hatch, so the body must prove an
// in-range index on EVERY branch.
function bareWitnessRet(t: Type): { ref: string; listParam: string } | null {
  return t.tag === "Refinement" ? witnessUseOf(t) : null;
}

// Tail positions of a function body — the leaf expressions that become the
// return value. A bare-witness return demands the witness on each of them
// (every path must hand back an in-range index); intermediate `let`s and
// guards are not tails. Conservative: shapes it doesn't recognize (the body
// IS the tail) fall through to the leaf case, and a block not ending in an
// expression yields nothing (the type checker already errors on that).
function tailExprs(e: Expr): Expr[] {
  switch (e.tag) {
    case "If":    return [...tailExprs(e.then), ...(e.else_ ? tailExprs(e.else_) : [])];
    case "Match": case "Await": return e.branches.flatMap(b => tailExprs(b.body));
    case "Do": {
      const last = e.stmts[e.stmts.length - 1];
      return last && last.tag === "SExpr" ? tailExprs(last.expr) : [];
    }
    default: return [e];
  }
}

// Seed-side view (facts.ts entry): from a param's ASCRIPTION, the witness
// info — refinement name + the sibling param the index is tied to.
export function boundsWitnessOf(ref: TypeRef | null): { refName: string; listParam: string } | null {
  if (!ref || ref.tag !== "TRNamed") return null;
  const r = REFINEMENTS.get(ref.name);
  if (!r) return null;
  const n = boundsWitnessParam(ref.name);
  if (n === null) return null;
  const arg = ref.args[r.params.indexOf(n)];
  if (!arg || arg.tag !== "TRExpr") return null;
  const listParam = lenOverVar(arg.expr);
  return listParam === null ? null : { refName: ref.name, listParam };
}

// The canonical sized-integer names carry an IR width tag (B3, numeric-dimension
// -design §3.1): `U8` → 8-bit unsigned, `I32` → 32-bit signed. Name-derived, so
// the stdlib family declares them as ordinary `Number where 0 <= value && …`
// refinements (gates / closed ops / faulting ops, exactly the refined-types
// pattern) and the tag rides along for free. The tag is what Phase D's emitter
// lowers to a machine width and what the `overflow` obligation (B3(ii)) reads;
// it trusts the canonical name — predicate/width consistency is the library
// author's discipline, the same trust refined-types places in its gate predicates.
// Type names are `upper_id` in the grammar, so the family ships as `U8`…`I32`
// (the gate fns are the lowercase `u8`…`i32`, exactly the Natural/natural split).
export function widthOf(name: string): { bits: number; signed: boolean } | undefined {
  const m = /^([UI])(8|16|32)$/.exec(name);
  return m ? { bits: Number(m[2]), signed: m[1] === "I" } : undefined;
}

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
        const width = widthOf(ref.name);
        return {
          tag: "Refinement", base, pred: ref.name,
          ...(depArgs.some(Boolean) ? { args: depArgs } : {}),
          ...(width ? { width } : {}),
        };
      }
      const unit = UNITS.get(ref.name);
      if (unit) {
        // A unit type is opaque to its base: resolve to `United` carrying the
        // dimension vector and the declared name (for friendly printing). Not put
        // through ALIAS_RESOLVING — a unit base is a plain `Number`, never cyclic.
        const base = resolveRef(unit.baseRef, tp, sagas);
        return { tag: "United", base, dims: unit.dims, name: ref.name };
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
    case "TRFn": {
      const f: Type & { tag: "Fn" } = { tag: "Fn", params: ref.params.map(p => resolveRef(p, tp, sagas)), ret: resolveRef(ref.ret, tp, sagas), effects: ref.effects };
      // A user-spelled effect tail (`..e`, E2) resolves through tp under the
      // key "..e" — namespaced so a tail named `e` and a type var `e` coexist.
      // Outside a generalized signature (no tp entry) the tail is dropped: the
      // clause body sees the param without a live tail, which charges nothing
      // (EFFECT_TAILS for an unregistered id is empty anyway).
      if (ref.effectTail !== undefined) {
        const v = tp.get(".." + ref.effectTail);
        if (v?.tag === "Var") f.effectTail = v.id;
      }
      return f;
    }
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
      if (decl.body.unit) {
        // A unit type resolves to `United`, NOT to a transparent alias — so it is
        // registered in UNITS only (not TYPE_ALIASES, which would erase the unit
        // back to `Number` before the algebra ever sees it).
        UNITS.set(decl.name, { baseRef: decl.body.ref, dims: mkDims(decl.body.unit) });
      } else {
        TYPE_ALIASES.set(decl.name, { params: decl.params, body: decl.body.ref });
        if (decl.body.pred)
          REFINEMENTS.set(decl.name, { params: decl.params, baseRef: decl.body.ref, pred: decl.body.pred });
      }
    }
    else if (decl.tag === "DFn") {
      if (decl.total) TOTAL_FNS.set(decl.name, decl.clauses);
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

// A compile-time constant value: a JS primitive, a (possibly nested) list, or a
// record (a theme groups roles into one — theme-design §2a/Slice 3). A folded
// `Color` is carried as its OKLCH triple `[L,C,H]` (a 3-number list); `toHex`
// bridges it back to the hex string that props and the §4.3 contrast proof consume.
export type ConstRec = { [k: string]: ConstVal };
export type ConstVal = number | string | boolean | ConstVal[] | ConstRec;
export const EMPTY_ENV: Map<string, ConstVal> = new Map();

// A folded value is a Color iff it's a 3-number list (the OKLCH triple form).
function asLCH(v: ConstVal | undefined): LCH | undefined {
  return Array.isArray(v) && v.length === 3 && v.every(x => typeof x === "number")
    ? (v as LCH) : undefined;
}

// Constant-fold an expression against a binding environment (`value` for the
// refinement subject, plus any in-scope names — fn params at a call site, dependent
// refinement params). Returns `undefined` when the expression isn't a compile-time
// constant (an unbound name, an unsupported call, etc.) — callers treat that as
// "skip, rely on the runtime `.parse` check instead". Deliberately a small subset:
// literals, list literals, arithmetic/comparison/logical operators, `!`/unary-minus,
// `matches(value, "regex")`, and `listLength`/`length` of a constant list (so
// dependent bounds like `InBounds(listLength xs)` can be folded).
// APCA Lc — perceptual contrast (WCAG-3 / SACAM 0.0.98G-4g), the metric the colour
// system and `OnSurface` refinements use (styles-design §4.3, §14.1). Returns the
// *magnitude* |Lc| (≈0–108) so a `contrast(fg, bg) >= 60` threshold is polarity-
// independent. `null` when either colour isn't a parseable hex string.
function hexToRgb(h: string): [number, number, number] | null {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(h.trim());
  if (!m) return null;
  let s = m[1]!;
  if (s.length === 3) s = s.split("").map(c => c + c).join("");
  return [0, 2, 4].map(i => parseInt(s.slice(i, i + 2), 16)) as [number, number, number];
}
function apcaLc(fg: string, bg: string): number | null {
  const txt = hexToRgb(fg), back = hexToRgb(bg);
  if (!txt || !back) return null;
  const TRC = 2.4, Rc = 0.2126729, Gc = 0.7151522, Bc = 0.0721750;
  const blkThrs = 0.022, blkClmp = 1.414;
  const normBG = 0.56, normTXT = 0.57, revTXT = 0.62, revBG = 0.65;
  const scale = 1.14, loClip = 0.1, offset = 0.027, deltaYmin = 0.0005;
  const lum = ([r, g, b]: [number, number, number]) =>
    Rc * Math.pow(r / 255, TRC) + Gc * Math.pow(g / 255, TRC) + Bc * Math.pow(b / 255, TRC);
  let txtY = lum(txt), bgY = lum(back);
  if (txtY < blkThrs) txtY += Math.pow(blkThrs - txtY, blkClmp);
  if (bgY  < blkThrs) bgY  += Math.pow(blkThrs - bgY,  blkClmp);
  if (Math.abs(bgY - txtY) < deltaYmin) return 0;
  let sapc: number, out: number;
  if (bgY > txtY) { sapc = (Math.pow(bgY, normBG) - Math.pow(txtY, normTXT)) * scale; out = sapc < loClip ? 0 : sapc - offset; }
  else            { sapc = (Math.pow(bgY, revBG) - Math.pow(txtY, revTXT)) * scale; out = sapc > -loClip ? 0 : sapc + offset; }
  return Math.abs(out * 100);
}

// Fuel for `@total` function application during folding (totality-design §5.1).
// Each application costs 1; exhaustion folds to undefined — a conservative skip,
// identical to "not constant". This is the checker's own termination guarantee:
// `Number` ≠ `Nat`, so a marker the structural pass accepts (`fact`) can still
// diverge on a negative constant — out of fuel must never mean a hung compiler.
const FOLD_FUEL = 100_000;
let foldFuel = 0;

// Public entry: every checker call site is a fresh top-level fold, so the
// wrapper resets fuel; recursion inside the engine stays on `ceval`.
export function constEval(e: Expr, env: Map<string, ConstVal>): ConstVal | undefined {
  foldFuel = FOLD_FUEL;
  return ceval(e, env);
}

function ceval(e: Expr, env: Map<string, ConstVal>): ConstVal | undefined {
  switch (e.tag) {
    case "Lit":
      if (e.lit.tag === "Num" || e.lit.tag === "Str" || e.lit.tag === "Bool") return e.lit.value;
      return undefined;
    case "Var":
      return env.has(e.name) ? env.get(e.name)! : undefined;
    case "List":
    case "Tuple": {
      const out: ConstVal[] = [];
      for (const el of e.elems) {
        const v = ceval(el, env);
        if (v === undefined) return undefined;
        out.push(v);
      }
      return out;
    }
    case "UnOp": {
      const x = ceval(e.expr, env);
      if (x === undefined) return undefined;
      if (e.op === "!" && typeof x === "boolean") return !x;
      if (e.op === "-" && typeof x === "number")  return -x;
      return undefined;
    }
    case "BinOp": {
      // Short-circuit logical operators so a non-constant operand on the dead side
      // doesn't sink the whole fold.
      if (e.op === "&&" || e.op === "||") {
        const l = ceval(e.left, env);
        if (typeof l !== "boolean") return undefined;
        if (e.op === "&&" && !l) return false;
        if (e.op === "||" && l)  return true;
        const r = ceval(e.right, env);
        return typeof r === "boolean" ? r : undefined;
      }
      const l = ceval(e.left, env);
      const r = ceval(e.right, env);
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
        const xs = ceval(e.args[0]!, env);
        if (Array.isArray(xs)) return xs.length;
        return undefined;
      }
      // matches(value, "regex") — the canonical String-refinement predicate.
      if (e.fn.tag === "Var" && e.fn.name === "matches" && e.args.length === 2) {
        const subj = ceval(e.args[0]!, env);
        const pat  = ceval(e.args[1]!, env);
        if (typeof subj === "string" && typeof pat === "string") {
          try { return new RegExp(pat).test(subj); } catch { return undefined; }
        }
      }
      // contrast(fg, bg) — APCA Lc magnitude, the colour-accessibility predicate
      // (`OnSurface = Color where contrast(value, surface) >= 60`). Folds only when
      // both colours are constant hex strings; a non-literal background (resolved by
      // convergence, themed) stays unfolded → runtime/linter, per styles-design §14.1.
      if (e.fn.tag === "Var" && e.fn.name === "contrast" && e.args.length === 2) {
        const fg = ceval(e.args[0]!, env);
        const bg = ceval(e.args[1]!, env);
        if (typeof fg === "string" && typeof bg === "string") {
          const lc = apcaLc(fg, bg);
          return lc === null ? undefined : lc;
        }
        const ft = asLCH(fg), bt = asLCH(bg);   // themed colours fold as OKLCH triples
        if (ft && bt) return apcaTriple(ft, bt);
      }
      // std/color builtins fold over constant colours — the theme is computed, not
      // hand-picked (theme-design §2a/Slice 3): a derived role like
      // `toHex(legibleOn(accent))` resolves to the exact hex the runtime renders, so
      // the §4.3 proof checks the colour the program actually shows. A Color folds to
      // its OKLCH triple `[L,C,H]`; only `toHex` re-stringifies for props.
      if (e.fn.tag === "Var") {
        const c = foldColorCall(e.fn.name, e.args, env);
        if (c !== undefined) return c;
      }
      // A user function that PROMISED termination folds by running its clauses
      // (totality-design §5.1 — the payoff the @total slice deferred). Builtin
      // folds above keep priority over a same-named user fn (least change).
      // Positional calls only; every argument must itself fold.
      if (e.fn.tag === "Var" && e.named.length === 0 && TOTAL_FNS.has(e.fn.name)) {
        const argVals: ConstVal[] = [];
        for (const a of e.args) {
          const v = ceval(a, env);
          if (v === undefined) return undefined;
          argVals.push(v);
        }
        return applyTotalFn(TOTAL_FNS.get(e.fn.name)!, argVals);
      }
      return undefined;
    }
    // If/Match/Do fold so @total BODIES fold — these forms are the bread and
    // butter of total functions (base case + decrease). They fold anywhere
    // constEval runs, which is strictly more constants, never fewer.
    case "If": {
      const c = ceval(e.cond, env);
      if (typeof c !== "boolean") return undefined;
      if (c) return ceval(e.then, env);
      return e.else_ ? ceval(e.else_, env) : undefined;   // no else → Unit, not a ConstVal
    }
    case "Match": {
      const subj = ceval(e.subject, env);
      if (subj === undefined) return undefined;
      for (const br of e.branches) {
        const benv = new Map(env);
        const m = tryMatchConst(br.pat, subj, benv);
        if (m === "unknown") return undefined;   // can't DECIDE the branch → can't skip it either
        if (m === "no") continue;
        if (br.guard) {
          const g = ceval(br.guard, benv);
          if (typeof g !== "boolean") return undefined;
          if (!g) continue;
        }
        return ceval(br.body, benv);
      }
      return undefined;
    }
    case "Do": {
      // The pure straight-line subset: immutable `let` bindings, value last.
      // Anything else (mut, reassignment, control statements) sinks the fold.
      const denv = new Map(env);
      for (let i = 0; i < e.stmts.length; i++) {
        const s = e.stmts[i]!;
        const last = i === e.stmts.length - 1;
        if (s.tag === "SExpr" && last) return ceval(s.expr, denv);
        if (s.tag === "SBind" && s.declares && !s.mutable && s.pat.tag === "PVar" && !last) {
          const v = ceval(s.value, denv);
          if (v === undefined) return undefined;
          denv.set(s.pat.name, v);
          continue;
        }
        return undefined;
      }
      return undefined;
    }
    case "Record": {
      // A constant record (a grouped theme of roles) folds field-by-field; spread
      // first, then explicit fields override. Any non-constant field sinks the fold.
      const out: ConstRec = {};
      if (e.spread) {
        const base = ceval(e.spread, env);
        if (!base || typeof base !== "object" || Array.isArray(base)) return undefined;
        for (const k in base) out[k] = base[k]!;
      }
      for (const f of e.fields) {
        const v = ceval(f.value, env);
        if (v === undefined) return undefined;
        out[f.name] = v;
      }
      return out;
    }
    case "Field": {
      // `theme.panel` over a constant record; `color.l` over a folded OKLCH triple.
      const obj = ceval(e.obj, env);
      if (obj && typeof obj === "object" && !Array.isArray(obj)) return obj[e.field];
      const t = asLCH(obj);
      if (t) { const i = { l: 0, c: 1, h: 2 }[e.field]; if (i !== undefined) return t[i]; }
      return undefined;
    }
    default: return undefined;
  }
}

// Fold a `std/color` builtin call over constant args, or `undefined` if it isn't
// one / an arg isn't constant. A Color is an OKLCH triple `[L,C,H]`; `toHex` maps a
// triple → hex string. Shares ./color.ts with the runtime so the fold can't diverge.
function foldColorCall(name: string, args: Expr[], env: Map<string, ConstVal>): ConstVal | undefined {
  const v = (i: number) => ceval(args[i]!, env);
  const col = (i: number) => asLCH(v(i));
  const n   = (i: number) => { const x = v(i); return typeof x === "number" ? x : undefined; };
  switch (name) {
    case "oklch": { const a = n(0), b = n(1), c = n(2); return a !== undefined && b !== undefined && c !== undefined ? lch(a, b, c) : undefined; }
    case "hex":   { const s = v(0); return typeof s === "string" ? hexToOklch3(s) : undefined; }
    case "gray":  { const l = n(0); return l !== undefined ? cGray(l) : undefined; }
    case "toHex": { const c = col(0); return c ? oklchToHex(c[0], c[1], c[2]) : undefined; }
    case "lighten":    { const c = col(0), m = n(1); return c && m !== undefined ? cLighten(c, m) : undefined; }
    case "darken":     { const c = col(0), m = n(1); return c && m !== undefined ? cDarken(c, m) : undefined; }
    case "saturate":   { const c = col(0), m = n(1); return c && m !== undefined ? cSaturate(c, m) : undefined; }
    case "desaturate": { const c = col(0), m = n(1); return c && m !== undefined ? cDesaturate(c, m) : undefined; }
    case "rotate":     { const c = col(0), m = n(1); return c && m !== undefined ? cRotate(c, m) : undefined; }
    case "complement": { const c = col(0); return c ? cComplement(c) : undefined; }
    case "cusp":       { const c = col(0); return c ? cCusp(c) : undefined; }
    case "legibleOn":  { const c = col(0); return c ? cLegibleOn(c) : undefined; }
    case "mix":        { const a = col(0), b = col(1), t = n(2); return a && b && t !== undefined ? cMix(a, b, t) : undefined; }
    case "shades":     { const c = col(0), m = n(1); return c && m !== undefined ? cShades(c, m) : undefined; }
    case "tints":      { const c = col(0), m = n(1); return c && m !== undefined ? cTints(c, m) : undefined; }
    case "ramp":       { const c = col(0), m = n(1); return c && m !== undefined ? cRamp(c, m) : undefined; }
    default: return undefined;
  }
}

// Apply a `@total` function to constant arguments at compile time (§5.1).
// Clause dispatch mirrors the runtime: first clause whose params all match.
// The fold is CONSERVATIVE three ways — an undecidable pattern (ctor/atom: no
// ConstVal representation) bails rather than skips; `where` bindings beyond
// plain names bail; and a body form ceval can't fold (lambda, for, effects)
// returns undefined, sinking the fold. Bail = "not constant" = runtime check,
// exactly the pre-§5.1 behaviour, so widening can only ADD caught errors.
function applyTotalFn(clauses: FnClause[], argVals: ConstVal[]): ConstVal | undefined {
  if (--foldFuel <= 0) return undefined;
  for (const clause of clauses) {
    if (clause.params.length !== argVals.length) continue;
    if (clause.params.some(p => p.default_ !== undefined || p.keywordOnly)) return undefined;
    const env = new Map<string, ConstVal>();
    let matched = true;
    for (let i = 0; i < argVals.length; i++) {
      const m = tryMatchConst(clause.params[i]!.pat, argVals[i]!, env);
      if (m === "unknown") return undefined;
      if (m === "no") { matched = false; break; }
    }
    if (!matched) continue;
    for (const w of clause.where_) {
      if (w.pat.tag !== "PVar") return undefined;
      const v = ceval(w.value, env);
      if (v === undefined) return undefined;
      env.set(w.pat.name, v);
    }
    return ceval(clause.body, env);
  }
  return undefined;   // no clause matched — the runtime's error, not the folder's
}

// Decidable pattern match over a constant value. Three-valued on purpose:
// "no" may skip a clause/branch; "unknown" (a pattern whose match status a
// ConstVal can't witness — ctors, atoms, unit/duration literals) must sink the
// WHOLE fold, because skipping an undecidable branch could select the wrong arm.
function tryMatchConst(p: Pat, v: ConstVal, env: Map<string, ConstVal>): "yes" | "no" | "unknown" {
  switch (p.tag) {
    case "PWild":  return "yes";
    case "PVar":   env.set(p.name, v); return "yes";
    case "PTyped": env.set(p.name, v); return "yes";   // ascription already checked statically
    case "PLit":
      if (p.lit.tag === "Num" || p.lit.tag === "Str" || p.lit.tag === "Bool")
        return v === p.lit.value ? "yes" : "no";
      return "unknown";
    case "PTuple": {
      if (!Array.isArray(v)) return "unknown";
      if (v.length !== p.elems.length) return "no";
      for (let i = 0; i < p.elems.length; i++) {
        const m = tryMatchConst(p.elems[i]!, v[i]!, env);
        if (m !== "yes") return m;
      }
      return "yes";
    }
    case "PRecord": {
      if (!v || typeof v !== "object" || Array.isArray(v)) return "unknown";
      for (const f of p.fields) {
        if (!(f.name in v)) return "unknown";
        const m = tryMatchConst(f.pat, (v as ConstRec)[f.name]!, env);
        if (m !== "yes") return m;
      }
      return "yes";
    }
    default: return "unknown";   // PCtor / PAtom — ConstVal carries no tag
  }
}

function sigToFnType(sig: FnSig, tp: Map<string, Type>): Type {
  return { tag: "Fn", params: sig.params.map(p => resolveRef(p, tp)), ret: resolveRef(sig.ret, tp), effects: sig.effects };
}

// USER GENERICS: a lowercase nullary name in a def's type ascriptions
// (`def idy(x: a): a`) is an implicit type variable. There is no explicit
// binder on `def`, so the set is collected from the refs themselves. NOTE:
// ordinary defs carry their types on the CLAUSE (param ascriptions +
// clause.ret), not on decl.sig — collect from whichever is present.
// Lowercase aliases/refinements can't collide — type decls are upper_id in
// the grammar — but guard anyway.
function refTypeVars(refs: (TypeRef | null)[]): string[] {
  const out: string[] = [];
  const walk = (r: TypeRef): void => {
    switch (r.tag) {
      case "TRNamed":
        if (r.args.length === 0 && /^[a-z]/.test(r.name) && r.name !== "_"
            && !TYPE_ALIASES.has(r.name) && !REFINEMENTS.has(r.name)
            && !out.includes(r.name)) out.push(r.name);
        r.args.forEach(walk);
        break;
      case "TRFn":     r.params.forEach(walk); walk(r.ret); break;
      case "TRTuple":  r.elems.forEach(walk); break;
      case "TRRecord": r.fields.forEach(f => walk(f.type)); break;
      case "TRPtr":    walk(r.inner); break;
      case "TRAtom": case "TRExpr": break;
    }
  };
  for (const r of refs) if (r) walk(r);
  return out;
}

// User-spelled effect tails (`..e`, E2) mentioned on fn-type ascriptions in the
// given refs — collected so generalizeSig can quantify them alongside type vars.
function refEffectTails(refs: (TypeRef | null)[]): string[] {
  const out: string[] = [];
  const walk = (r: TypeRef): void => {
    switch (r.tag) {
      case "TRNamed":  r.args.forEach(walk); break;
      case "TRFn":
        if (r.effectTail !== undefined && !out.includes(r.effectTail)) out.push(r.effectTail);
        r.params.forEach(walk); walk(r.ret);
        break;
      case "TRTuple":  r.elems.forEach(walk); break;
      case "TRRecord": r.fields.forEach(f => walk(f.type)); break;
      case "TRPtr":    walk(r.inner); break;
      case "TRAtom": case "TRExpr": break;
    }
  };
  for (const r of refs) if (r) walk(r);
  return out;
}

// `_` — the inferred-error-row marker (error-rows-design S1). The grammar
// admits it only in a Result error slot; these helpers enforce the v1 rule
// that the slot must be the TOP-LEVEL error of a def's RETURN ascription.
function isRowMarker(r: TypeRef): boolean {
  return r.tag === "TRNamed" && r.name === "_" && r.args.length === 0;
}
function refHasMarker(r: TypeRef | null): boolean {
  if (!r) return false;
  switch (r.tag) {
    case "TRNamed":  return isRowMarker(r) || r.args.some(refHasMarker);
    case "TRFn":     return r.params.some(refHasMarker) || refHasMarker(r.ret);
    case "TRTuple":  return r.elems.some(refHasMarker);
    case "TRRecord": return r.fields.some(f => refHasMarker(f.type));
    case "TRPtr":    return refHasMarker(r.inner);
    case "TRAtom": case "TRExpr": return false;
  }
}
// The one legal shape: `Result T _` at the top of a return ascription, with
// no further marker anywhere (not in T, not nested deeper).
function isRowRet(ret: TypeRef): boolean {
  return ret.tag === "TRNamed" && ret.name === "Result" && ret.args.length === 2
    && isRowMarker(ret.args[1]!) && !refHasMarker(ret.args[0]!);
}

// ── Outcome(T) / TxResult(T) — the transaction-outcome ADT ────────────────────
// A `transaction` yields a distinctly-typed outcome ADT, NOT a plain Result.
// **Renamed in edition 2026.6:** the type `TxResult`→`Outcome` and its commit/abort
// constructors `Ok`/`Error`→`Committed`/`Aborted` (the concurrency ctors
// `Conflict`/`Timeout`/`Cancelled` are unchanged across editions).
//   • Under 2026.1 the commit/abort names SHARE with Result (constructor sharing):
//     which ADT a `| Ok v ->` arm belongs to is decided by the EXPECTED type at the
//     match site, not the name alone.
//   • Under 2026.6 `Committed`/`Aborted` are UNIQUE — the same expected-type path
//     runs but resolves no collision; it only assigns the typed payloads.
// `Conflict`/`Timeout` carry typed records so `c.retries` / `t.after` are real
// Numbers; `Cancelled` is nullary.
interface OutcomeAdt { typeName: string; commit: string; abort: string; ctors: Set<string>; }
function outcomeAdt(edition: Edition): OutcomeAdt {
  return atLeast(edition, "2026.6")
    ? { typeName: "Outcome",  commit: "Committed", abort: "Aborted",
        ctors: new Set(["Committed", "Aborted", "Conflict", "Timeout", "Cancelled"]) }
    : { typeName: "TxResult", commit: "Ok",        abort: "Error",
        ctors: new Set(["Ok", "Error", "Conflict", "Timeout", "Cancelled"]) };
}
// The ctor's type given the result element `t`, or null if `name` is not a
// constructor of this edition's outcome ADT (→ caller falls back to lenient lookup).
function outcomeCtorType(adt: OutcomeAdt, name: string, t: Type): Type | null {
  const num: Type = { tag: "Prim", kind: "Number" };
  const tx: Type = { tag: "Named", name: adt.typeName, args: [t] };
  const rec = (field: string): Type =>
    ({ tag: "Record", fields: [{ name: field, type: num, optional: false }] });
  const fn = (param: Type): Type => ({ tag: "Fn", params: [param], ret: tx, effects: [] });
  if (name === adt.commit) return fn(t);
  if (name === adt.abort)  return fn(freshVar("e"));   // abort payload — polymorphic
  switch (name) {
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
  // Effect-typed builtins (TODO §3.6 — the runtime surface must not lie by
  // omission): host-state writes charge [ui]; the network/input-FFI names
  // charge [io]. DECIDED ambient (2026-06): `print`/`println` charge nothing —
  // stdout is the language's observation channel (charging [io] would put
  // `Effect [io]` on every main while guarding nothing host-mutable) — and
  // `sleep` charges nothing: it is virtual time on the deterministic
  // scheduler, not a clock capability.
  const fnFx = (params: Type[], ret: Type, effects: string[]): Type => ({ tag: "Fn", params, ret, effects });

  // Result constructors
  env.define("Ok",    { forall: [a.id, e.id], type: fn([a], resultA) });
  env.define("Error", { forall: [a.id, e.id], type: fn([e], resultA) });

  // Named error ADT for boundary parses (SPEC §2.7): the stdlib's parse builtins
  // and refinement `T.parse` fail with a *structured* error, not a String —
  // `expected` (the type/format name), `got` (the offending input, rendered),
  // `detail` (human prose). Single-ctor ADT; the ctor and type share the name.
  const parseErrorT: Type = { tag: "Named", name: "ParseError", args: [] };
  const parseErrorPayload: Type = { tag: "Record", fields: [
    { name: "expected", type: str, optional: false },
    { name: "got",      type: str, optional: false },
    { name: "detail",   type: str, optional: false },
  ] };
  env.define("ParseError", { forall: [], type: fn([parseErrorPayload], parseErrorT) });

  // I/O — typed (`forall a. a -> Unit`) so a print line inside `try` has a
  // concrete type instead of a leniency var (see inferTryBody / the §12 sweep).
  // Deliberately effect-FREE (the ambient decision above): observation, not
  // capability.
  env.define("print",   { forall: [a.id], type: fn([a], { tag: "Prim", kind: "Unit" }) });
  env.define("println", { forall: [a.id], type: fn([a], { tag: "Prim", kind: "Unit" }) });

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
  const viewportT: Type = { tag: "Record", fields: [
    { name: "width",      type: num,        optional: false },
    { name: "height",     type: num,        optional: false },
    { name: "breakpoint", type: breakpoint, optional: false },
  ] };
  env.define("viewport", { forall: [], type: viewportT });
  // `setViewport` — the host swap channel for the read-only viewport root, the exact
  // parallel of `setTheme`. A resize / orientation change overwrites this global slot
  // and the next `view()` re-collapses every `Responsive(Length)` prop (§9.3) against
  // the new `viewport.breakpoint`. Source-only otherwise (no view writes back).
  env.define("setViewport", { forall: [], type: fnFx([viewportT], { tag: "Prim", kind: "Unit" }, ["ui"]) });
  // `theme` — the second read-only reactive root (§9.1, theme-design Slice 4).
  // Like `viewport`, anything may read `theme.*`; nothing writes back from a view,
  // so a theme-driven layout is acyclic by construction. Roles are hex `String`s in
  // prop form (the §4.2 `Color` form). The default roles are seeded into
  // `moduleConsts` (Inferrer ctor) so `theme.panel`/`theme.text` FOLD at check time
  // and the §4.3 APCA proof fires against the active theme's surfaces. `setTheme`
  // is the single host write channel (a store-action-style swap, not a field write).
  const themeT: Type = { tag: "Record", fields:
    Object.keys(DEFAULT_THEME).map(name => ({ name, type: str, optional: false })) };
  env.define("theme", { forall: [], type: themeT });
  env.define("setTheme", { forall: [], type: fnFx([themeT], { tag: "Prim", kind: "Unit" }, ["ui"]) });
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
  // Concrete String error (its runtime failure IS the string "empty list") — a
  // free error var here would be the same unsound leniency parseNumber had.
  env.define("listHead",    { forall: [a.id],         type: fn([listA], { tag: "Named", name: "Result", args: [a, str] }) });
  // Effect tails (S4c/E1, SPEC §12.4): these HOFs carry an effect tail `eff` —
  // "my effects are exactly my fn argument's". The tail sits on the fn PARAM
  // (Fn-unify binds it from the argument's row at each call) and on the
  // builtin's OWN row (so the call is charged with that binding, precisely,
  // instead of via the conservative latent rule). `identity` (below) carries
  // the tail on its own row ONLY: it returns its argument without invoking it,
  // so handing it an effectful fn charges nothing — the case the conservative
  // rule over-approximated. Other fn-taking builtins (sortBy, listReduce, …)
  // keep the conservative charge until they're tailed too.
  const eff = freshVar("eff");
  const fnE = (params: Type[], ret: Type): Type => ({ tag: "Fn", params, ret, effects: [], effectTail: eff.id });
  env.define("listFilter",  { forall: [a.id, eff.id],      type: fnE([listA, fnE([a], { tag: "Prim", kind: "Bool" })], listA) });
  env.define("listMap",     { forall: [a.id, b.id, eff.id], type: fnE([listA, fnE([a], b)], listB) });

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
  env.define("externSource", { forall: [a.id], type: fnFx([fn([fn([a], unitT), fn([], unitT)], unitT)], streamA, ["io"]) });
  // help(map) — the inputmap's labelled rows as derived data (SPEC §10.5): the
  // substrate of the auto-generated help overlay. Only labelled rows appear —
  // a label is the row's opt-in to user-facing help.
  const strT: Type = { tag: "Prim", kind: "String" };
  const helpRow: Type = { tag: "Record", fields: [
    { name: "pattern", type: strT, optional: false },
    { name: "label",   type: strT, optional: false },
  ] };
  env.define("help", mono(fn([{ tag: "Inputmap", name: "", stream: "" }], { tag: "Named", name: "List", args: [helpRow] })));
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
  env.define("pmap",        { forall: [a.id, b.id, eff.id], type: fnE([listA, fnE([a], b)], listB) });
  env.define("pfilter",     { forall: [a.id, eff.id],       type: fnE([listA, fnE([a], { tag: "Prim", kind: "Bool" })], listA) });
  env.define("identity",    { forall: [a.id, eff.id],       type: fnE([a], a) });

  // String ops
  env.define("splitCsv",    { forall: [],             type: fn([str], { tag: "Named", name: "List", args: [str] }) });
  env.define("splitLines",  { forall: [],             type: fn([str], { tag: "Named", name: "List", args: [str] }) });
  env.define("splitOn",     { forall: [],             type: fn([str, str], { tag: "Named", name: "List", args: [str] }) });
  env.define("strTrim",     { forall: [],             type: fn([str], str) });
  env.define("strLength",   { forall: [],             type: fn([str], num) });
  env.define("strContains", { forall: [],             type: fn([str, str], { tag: "Prim", kind: "Bool" }) });
  env.define("strToUpper",  { forall: [],             type: fn([str], str) });
  env.define("strToLower",  { forall: [],             type: fn([str], str) });
  env.define("parseNumber", { forall: [],             type: fn([str], { tag: "Named", name: "Result", args: [num, { tag: "Named", name: "ParseError", args: [] }] }) });
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

  // Network — now genuinely effect-typed ([io]); these names are not yet in
  // resolve's BUILTINS (no runtime implementation — fixtures shadow them with
  // user defs), but the signatures stop lying the day they land.
  const asyncResultStr: Type = { tag: "Named", name: "Async", args: [{ tag: "Named", name: "Result", args: [str, str] }] };
  for (const name of ["netGet", "netPost", "netDelete", "httpGet", "httpPost", "httpPut", "httpPatch"]) {
    env.defineMono(name, fnFx([str], asyncResultStr, ["io"]));
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
  // The module's resolved edition (SPEC §17) — gates edition-specific semantics.
  edition: Edition;
}

// ── Unification ───────────────────────────────────────────────────────────────

function unify(a: Type, b: Type, ctx: Ctx, span: Span, hint?: string): void {
  const ta = ctx.subst.apply(a);
  const tb = ctx.subst.apply(b);

  if (ta.tag === "Var") { ctx.subst.extend(ta.id, tb); return; }
  if (tb.tag === "Var") { ctx.subst.extend(tb.id, ta); return; }
  if (ta.tag === "Unknown" || tb.tag === "Unknown") return;

  // Error rows never unify — they accumulate. Row-vs-named-error means a `_`
  // def raises that error (e.g. a direct `Error(NotFound(x))` return unifying
  // body type against the row-carrying return type): add the ctors to the row.
  // Row-vs-row records a ⊇-edge each way (closed by fixpoint at finalize).
  // Over-approximation is sound for error sets; anything unrecognized is a
  // no-op (Unknown discipline). The directional pin check lives in Propagate.
  if (ta.tag === "ErrRow" || tb.tag === "ErrRow") {
    if (ta.tag === "ErrRow" && tb.tag === "ErrRow") {
      if (ta !== tb) ROW_DEPS.push([ta, tb], [tb, ta]);
      return;
    }
    const row = (ta.tag === "ErrRow" ? ta : tb) as ErrRowT;
    const other = ta.tag === "ErrRow" ? tb : ta;
    if (tailContribution(row, other)) return;  // S4b: a body skolem is a tail, not an opaque error
    const entries = rowContribution(other);
    if (entries) addRowEntries(row, entries);
    return;
  }

  // Sized types (B3): a refinement carrying an IR width tag is NOT silently
  // interchangeable with a DIFFERENT width — crossing a width boundary needs an
  // explicit gate/cast (`u16(x)`, numeric-dimension-design §4). Fires only when
  // BOTH sides carry a width, so bare `Number` ↔ sized stays transparent (a `u8`
  // IS a `Number`, and the gate guards the Number → u8 direction at construction)
  // and same-width unifies normally. No corpus file declares sized types, so this
  // branch never fires there.
  if (ta.tag === "Refinement" && tb.tag === "Refinement" && ta.width && tb.width
      && (ta.width.bits !== tb.width.bits || ta.width.signed !== tb.width.signed)) {
    err(ctx, span, `${hint ? hint + ": " : ""}width mismatch — ${typeToString(ta)} vs ${typeToString(tb)} (crossing a width boundary needs an explicit cast)`);
    return;
  }

  // Refinement types are transparent to their base: `type Age = Number where …`
  // unifies with `Number` (and with other refinements over `Number`). The
  // predicate is enforced separately — at runtime via `.parse`, and at compile
  // time for literal arguments (see checkRefinementLits).
  if (ta.tag === "Refinement") { unify(ta.base, tb, ctx, span, hint); return; }
  if (tb.tag === "Refinement") { unify(ta, tb.base, ctx, span, hint); return; }

  // Unit types are NOT transparent (unlike refinements): two `United` types
  // unify iff their dimensions match — and a `United` vs a bare base (or a
  // differing unit) falls through to the mismatch error below, which is the
  // explicit-casts-only rule (`5` is not a `Meters` without a constructor).
  if (ta.tag === "United" && tb.tag === "United") {
    unify(ta.base, tb.base, ctx, span);
    if (!dimsEqual(ta.dims, tb.dims))
      err(ctx, span, `${hint ? hint + ": " : ""}unit mismatch — ${typeToString(ta)} vs ${typeToString(tb)}`);
    return;
  }

  if (ta.tag === "Prim" && tb.tag === "Prim" && ta.kind === tb.kind) return;
  if (ta.tag === "Atom" && tb.tag === "Atom" && ta.name === tb.name) return;

  if (ta.tag === "Named" && tb.tag === "Named" && ta.name === tb.name && ta.args.length === tb.args.length) {
    for (let i = 0; i < ta.args.length; i++) unify(ta.args[i]!, tb.args[i]!, ctx, span);
    return;
  }

  if (ta.tag === "Fn" && tb.tag === "Fn" && ta.params.length === tb.params.length) {
    for (let i = 0; i < ta.params.length; i++) unify(ta.params[i]!, tb.params[i]!, ctx, span);
    unify(ta.ret, tb.ret, ctx, span);
    bindEffectTails(ta, tb);  // S4c: a declared effect tail absorbs the other side's row
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

  // Inputmap (SPEC §10.5): the name is provenance, not structure — `help` takes
  // *any* inputmap, so two inputmap types always unify.
  if (ta.tag === "Inputmap" && tb.tag === "Inputmap") return;

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

function warn(ctx: Ctx, span: Span, message: string): void {
  ctx.diagnostics.push({ kind: "warning", span, message });
}

// patKey (the canonical structural key for conflict analysis) lives in ast.ts —
// shared with eval.ts, where `++` layering uses the same key to decide which
// base rows an override replaces.

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
    // Canvas free positioning (svg-legibility-design S0): `at=(x, y)` places a
    // child absolutely inside a Canvas; paint order = child order. Legal only
    // under a Canvas parent (context-checked in case "Element").
    at: { tag: "Tuple", elems: [num, num] },
  };
})();

// ── Layout context (§9.5 — context-dependent prop validity) ─────────────────────
// Each view-DSL primitive has a layout mode. Two prop classes are only valid in a
// matching context, mirroring CSS's silent no-ops:
//   • CONTAINER props (gap/align/justify) need the element itself to be flex/grid.
//   • FLEX-ITEM props (grow/shrink/basis/alignSelf) need the *parent* to be flex.
// Checks fire only when the relevant mode is KNOWN and non-flex, so custom
// components (which are calls, not Element nodes) never trigger a false positive.
// PRIMITIVE_MODE / LayoutMode now live in elements.ts (single source of truth,
// shared with the lowerer's paren-form element recognition). Imported above.
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

// ── Accessibility-as-proof (§4.3, §14.1 — opt-in) ────────────────────────────────
// A colour prop is checked for contrast against the element's resolved background —
// but ONLY when the project defines the named contrast refinement (e.g.
// `type OnSurface = Color where contrast(value, surface) >= 60`). The predicate's
// `surface` is bound to the **ambient background**: the nearest ancestor's literal
// `background`, threaded down the element tree exactly as the renderer threads it.
// The check fires only when BOTH the colour and that background are constant hex —
// a convergence-resolved or themed background stays unfolded (runtime/linter), per
// the §14.1 conservative scope. Undefined refinement ⇒ no check, nothing breaks.
const PROP_SURFACE: Record<string, string> = { color: "OnSurface" };

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
  const ctx: Ctx = { subst: new Subst(), returnType: null, effects: null, inSagaStep: false, diagnostics: [], resolutions, edition: mod.edition };
  const env = buildPrelude();
  const types = new Map<Expr, Type>();
  // Register type aliases / refinements up front so forward references resolve.
  TYPE_ALIASES = new Map();
  REFINEMENTS = new Map();
  UNITS = new Map();
  FN_PARAMS = new Map();
  FN_SIGS = new Map();
  TOTAL_FNS = new Map();
  WITNESS_DEMANDS = new Map();
  WITNESS_RETURNS = new Map();
  ALIAS_RESOLVING.clear();
  ADT_CTORS = new Map();
  ROW_DEPS = [];
  CTOR_OWNERS = new Map();
  ROW_TAIL_PARAMS = new Map();
  TAIL_INFO = new Map();
  EFFECT_TAILS = new Map();
  // Prelude error ADT: the single-ctor pattern (ctor and type share the name).
  ADT_CTORS.set("ParseError", [{ name: "ParseError", payload: null }]);
  registerAliases(mod.decls);
  const inferrer = new Inferrer(ctx, types);
  inferrer.collectDecls(mod.decls, env);
  inferrer.inferDecls(mod.decls, env);
  inferrer.checkPendingTryVars();
  inferrer.finalizeRows();
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

  // Ambient background (nearest-ancestor literal `background`) threaded down the
  // element tree for the `OnSurface` contrast check. Null = unknown (root, or a
  // non-literal/convergence-resolved background) → the check stays silent.
  private surfaceBg: string | null = null;

  // Module-level constant bindings (`let panel: Surface = #0d1117`), folded once in
  // declaration order. Threaded into the element-prop `constEval` calls so a semantic
  // colour token referenced in a prop (`background=panel`) resolves to its hex and
  // participates in the §4.3 contrast proof — the theme-system substrate (theme-design
  // Slice 1). Only immutable, constant RHSs land here; anything dynamic stays absent.
  // Pre-seeded with the read-only `theme` root (Slice 4): its default roles fold so
  // `theme.panel`/`theme.text` resolve at check time and the §4.3 proof runs against
  // the active theme — the statically-known case the design proves at compile time.
  private moduleConsts = new Map<string, ConstVal>([["theme", { ...DEFAULT_THEME }]]);

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
        case "DFn": {
          // Inferred error rows (S1): `_` is legal only as the top-level error
          // of a single-clause def's return Result. Reject every other spelling
          // here, where the decl span is at hand.
          const markerMisuse = decl.clauses.some(c =>
            c.params.some(p => refHasMarker(p.ascription)) ||
            (c.ret && refHasMarker(c.ret) && !isRowRet(c.ret)));
          if (markerMisuse)
            err(this.ctx, decl.span, "the inferred-row `_` is only legal as the error of a def's return `Result` (e.g. `Result Number _`)");
          // E2 validation: a tail spelled in the def's OWN Effect clause, or on
          // its top-level return fn-type, must be bound by some fn parameter
          // carrying the same `..e` — otherwise nothing ever flows into it and
          // the spelling is a misleading no-op. Params BIND (at any depth — a
          // `List((A -> Effect [..e] B))` param binds elementwise through
          // unify); the clause row and the returned fn USE. A param tail
          // absent from the clause is the identity pattern ("takes it, never
          // calls it") and is legal. Tails nested deeper in the return type
          // (a returned HOF whose own params bind them) are out of scope here.
          {
            const clause0 = decl.clauses[0];
            const tails = decl.sig?.effectTails.length ? decl.sig.effectTails : clause0?.effectTails ?? [];
            const retRef = decl.sig ? decl.sig.ret : clause0?.ret ?? null;
            const retTail = retRef?.tag === "TRFn" && retRef.effectTail !== undefined ? [retRef.effectTail] : [];
            const paramRefs: (TypeRef | null)[] = decl.sig ? decl.sig.params : (clause0?.params.map(p => p.ascription) ?? []);
            for (const t of new Set([...tails, ...retTail]))
              if (!paramRefs.some(r => r !== null && refEffectTails([r]).includes(t)))
                err(this.ctx, decl.span,
                  `effect tail '..${t}' is not bound by any fn parameter — spell it on the fn param whose effects it names (e.g. \`f: (A -> Effect [..${t}] B)\`)`);
          }
          if (decl.clauses.length > 1) {
            if (decl.clauses.some(c => c.ret && isRowRet(c.ret)))
              err(this.ctx, decl.span, "an inferred error row needs a single-clause def — multi-clause heads are typed per-clause");
            // Multi-clause (ad-hoc polymorphic) functions can't be represented
            // by a single HM type — each clause may have distinct param types
            // (e.g. different atom literals). Type it as Unknown so call sites
            // don't unify against just the first clause's signature.
            env.defineMono(decl.name, { tag: "Unknown" });
          } else if (decl.sig) {
            env.define(decl.name, this.generalizeSig(
              decl.sig.params, decl.sig.ret, decl.sig.effects, decl.sig.effectTails)
              ?? mono(sigToFnType(decl.sig, new Map())));
          } else {
            // Ordinary defs carry their types on the clause, not decl.sig.
            const clause = decl.clauses[0];
            if (clause && clause.ret && isRowRet(clause.ret) && !markerMisuse
                && clause.params.every(p => p.ascription)) {
              // `Result T _`: this def owns an error row. One shared instance —
              // `?` in the body accumulates into it; callers see it through
              // the return type and pin-check it at their own `?` sites.
              const row: ErrRowT = { tag: "ErrRow", entries: [], owner: decl.name, tails: [] };
              this.rowByDef.set(decl.name, row);
              this.rowSpans.set(decl.name, decl.span);
              // S4b: compose with user generics — generalizeSig's rule, with
              // `_` additionally bound to the row. Type params quantify here;
              // the clause body still resolves them as rigid skolems, and a
              // skolem reaching the row is recorded as a TAIL (its id, via
              // ROW_TAIL_PARAMS) rather than a pseudo-ctor.
              const tp = new Map<string, Type>([["_", row]]);
              const ids: number[] = [];
              const byName = new Map<string, number>();
              for (const n of refTypeVars([...clause.params.map(p => p.ascription!), clause.ret])) {
                const v = freshVar(n);
                tp.set(n, v);
                ids.push(v.id);
                byName.set(n, v.id);
                const carrier = clause.params.find(p => refTypeVars([p.ascription!]).includes(n));
                TAIL_INFO.set(v.id, { owner: decl.name, param: carrier ? paramName(carrier) || "_" : "_", tv: n });
              }
              if (byName.size) ROW_TAIL_PARAMS.set(row, byName);
              const fnT: Type = { tag: "Fn",
                params: clause.params.map(p => resolveRef(p.ascription!, tp, this.sagaRets)),
                ret: resolveRef(clause.ret, tp, this.sagaRets),
                effects: clause.effects };
              env.define(decl.name, { forall: ids, type: fnT });
              break;
            }
            // If the ascriptions mention type variables, register the
            // generalized scheme now; otherwise keep the existing shape (a
            // fresh var pinned by the post-clause unify in inferClause).
            const scheme = clause && clause.ret && clause.params.every(p => p.ascription)
              ? this.generalizeSig(clause.params.map(p => p.ascription!), clause.ret, clause.effects, clause.effectTails)
              : null;
            if (scheme) env.define(decl.name, scheme);
            else env.defineMono(decl.name, freshVar(decl.name));
          }
          break;
        }
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
        case "DInputmap": {
          // A dedicated Inputmap type (the SagaFn precedent — type-ness survives
          // aliasing): nullary-callable (drain loop → Unit) and accepted by
          // `help`, which a plain `Fn` could not distinguish.
          env.defineMono(decl.name, { tag: "Inputmap", name: decl.name, stream: decl.stream });
          break;
        }
        case "DLet": {
          // Register the binding's type so siblings/functions can reference it. An
          // ascription pins it; otherwise a fresh var reconciled when the body is
          // inferred (inferDecls). Mono — module constants are not generalized.
          env.defineMono(decl.name, decl.ascription ? resolveRef(decl.ascription, new Map(), this.sagaRets) : freshVar(decl.name));
          break;
        }
        case "DImport": {
          // File-local import (loader.ts merged the imported file's decls) — the
          // real declarations bind the names with their true schemes; skip so we
          // don't shadow them with an `Unknown` placeholder.
          if (decl.local) break;
          // `import js "pkg" as x` — a foreign JS value with no Velve module to
          // resolve against. Bind opaquely (Unknown) by DESIGN; not an error.
          if (decl.foreign) {
            for (const { name, alias } of decl.names) env.defineMono(alias ?? name, { tag: "Unknown" });
            break;
          }
          // The path must name a stdlib module (file-relative paths are `local`,
          // handled above; foreign ones are flagged). If it resolves to nothing,
          // that is a hard error — an unresolved import must NOT bind `Unknown`
          // silently, or every later use of the name type-checks against a name
          // that doesn't exist. `Unknown` is the post-diagnostic recovery type;
          // we still bind it so a single import error doesn't cascade.
          const mod = stdlibModule(decl.path);
          if (!mod) {
            this.ctx.diagnostics.push({ kind: "error", span: decl.span,
              message: `cannot resolve import '${decl.path}' — not a known stdlib module, a file-relative path ('./' or '../'), or a foreign \`import js\` — check the spelling, or the module hasn't shipped yet` });
            for (const { name, alias } of decl.names) env.defineMono(alias ?? name, { tag: "Unknown" });
            break;
          }
          // Named imports: `import { split, join } from "String"` — each name looked
          // up individually so polymorphic schemes are preserved.
          // Bare import: `import math from "std/math"` — bind the alias as a record
          // of all the module's exports (functions monomorphically instantiated).
          // Braces (`decl.named`) are an unambiguous named import; the bare form
          // is a namespace alias UNLESS its single name is itself a member.
          const isNamed = decl.named === true || decl.names.length > 1 ||
            (decl.names.length === 1 && stdlibLookup(decl.path, decl.names[0]!.name) !== null);
          if (isNamed) {
            for (const { name, alias } of decl.names) {
              const scheme = stdlibLookup(decl.path, name);
              const bindName = alias ?? name;
              if (scheme) env.define(bindName, scheme);
              else {
                this.ctx.diagnostics.push({ kind: "error", span: decl.span,
                  message: `module '${decl.path}' has no export '${name}'` });
                env.defineMono(bindName, { tag: "Unknown" });
              }
            }
          } else {
            // Namespace import — bind the module alias as a record of its exports.
            const bindName = decl.names[0]?.alias ?? decl.names[0]?.name ?? decl.path;
            env.defineMono(bindName, moduleRecordType(mod));
          }
          break;
        }
      }
    }
  }

  // User generics: if the given refs mention implicit type variables, build the
  // generalized scheme — quantified HERE so call sites instantiate fresh vars
  // (`idy(5)` and `idy("s")` both work). Returns null when there are none (the
  // caller keeps its existing mono path). The clause BODY is unaffected: it
  // resolves the same refs with an empty tp map, i.e. as RIGID `Named "a"`
  // skolems, so an implementation that pins `a` (e.g. `-> x + 1`) still errors;
  // the post-clause declared-vs-inferred unify just binds fresh vars to those
  // skolems.
  private generalizeSig(params: TypeRef[], ret: TypeRef, effects: string[], effectTails: string[] = []): Scheme | null {
    const tvNames = refTypeVars([...params, ret]);
    // Effect tails (E2): clause-spelled (`Effect [..e] T` — charges the def's
    // own row) and param-spelled (`f: (A -> Effect [..e] B)` — binds at the
    // call) quantify alongside type vars, namespaced "..e" in tp so a tail
    // and a type var may share a letter. The resulting Fn rides the SAME S4c
    // machinery as tailed builtins: substVars clones the tail per call site,
    // Fn-unify's bindEffectTails absorbs the argument's row, fnEffectRow
    // charges it — no new rules.
    const tailNames = [...new Set([...effectTails, ...refEffectTails([...params, ret])])];
    if (tvNames.length === 0 && tailNames.length === 0) return null;
    const tp = new Map<string, Type>();
    const ids: number[] = [];
    for (const n of tvNames) {
      const v = freshVar(n);
      tp.set(n, v);
      ids.push(v.id);
    }
    for (const n of tailNames) {
      const v = freshVar(".." + n);
      tp.set(".." + n, v);
      ids.push(v.id);
    }
    const fnT: Type & { tag: "Fn" } = { tag: "Fn",
      params: params.map(p => resolveRef(p, tp, this.sagaRets)),
      ret: resolveRef(ret, tp, this.sagaRets), effects };
    const ownTail = effectTails[0] !== undefined ? tp.get(".." + effectTails[0]) : undefined;
    if (ownTail?.tag === "Var") fnT.effectTail = ownTail.id;
    return { forall: ids, type: fnT };
  }

  // Ascription effect-coverage (the E2 dig's residual, closed): effects never
  // participate in unification (accumulate-never-unify), so unifying a
  // concrete fn-type ASCRIPTION against an effectful value silently erased
  // its row — `def grab(): (String -> String)` over `netGet` laundered [io].
  // The rule is directional: the DECLARED row must cover the ACTUAL row
  // (over-approximating is fine — declaring [io] over a pure fn is merely
  // conservative). Walks covariant structure (fn returns, type args, tuple
  // elems, record fields, Stream/Async inners) where both sides are concrete
  // and congruent; a declared tail covers by construction (bound at calls).
  // Fn PARAMS are contravariant — erasure flips direction there — and are
  // out of scope here (the §12.4 conservative latent rule guards that side).
  private checkEffectErasure(declared: Type, actual: Type, span: Span, what: string): void {
    const d = this.ctx.subst.apply(declared);
    const a = this.ctx.subst.apply(actual);
    if (d.tag === "Fn" && a.tag === "Fn") {
      if (d.effectTail === undefined) {
        const row = fnEffectRow(a);
        const missing = row.filter(e => !d.effects.includes(e));
        if (missing.length > 0)
          err(this.ctx, span,
            `${what} erases effects: the value's row is [${row.join(", ")}] but the ascribed fn type declares ${d.effects.length ? `[${d.effects.join(", ")}]` : "none"} — spell the row (\`Effect [${row.join(", ")}]\` in the return slot) or bind it with a tail (\`..e\`)`);
      }
      this.checkEffectErasure(d.ret, a.ret, span, what);
      return;
    }
    if (d.tag === "Named" && a.tag === "Named" && d.name === a.name && d.args.length === a.args.length)
      d.args.forEach((x, i) => this.checkEffectErasure(x, a.args[i]!, span, what));
    else if (d.tag === "Tuple" && a.tag === "Tuple" && d.elems.length === a.elems.length)
      d.elems.forEach((x, i) => this.checkEffectErasure(x, a.elems[i]!, span, what));
    else if (d.tag === "Record" && a.tag === "Record")
      for (const f of d.fields) {
        const g = a.fields.find(x => x.name === f.name);
        if (g) this.checkEffectErasure(f.type, g.type, span, what);
      }
    else if ((d.tag === "Stream" && a.tag === "Stream") || (d.tag === "Async" && a.tag === "Async"))
      this.checkEffectErasure(d.inner, a.inner, span, what);
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
          // Refinement type: expose `TypeName.parse : Base -> Result Base ParseError`
          // (the runtime-checked boundary). The type itself stays transparent.
          // The error is the named prelude ADT, not a String (TODO §3.5).
          const parseT: Type = {
            tag: "Fn",
            params: [base],
            ret: { tag: "Named", name: "Result", args: [base, { tag: "Named", name: "ParseError", args: [] }] },
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
    const ctorList = ADT_CTORS.get(typeName) ?? [];
    let scheme: Scheme;
    if (v.payload) {
      const pType = resolveRef(v.payload, tp);
      scheme = generalize(env, this.ctx.subst, { tag: "Fn", params: [pType], ret: resultType, effects: [] });
      ctorList.push({ name: v.name, payload: pType });
    } else {
      scheme = generalize(env, this.ctx.subst, resultType);
      ctorList.push({ name: v.name, payload: null });
    }
    env.define(v.name, scheme);
    ADT_CTORS.set(typeName, ctorList);
    const owners = CTOR_OWNERS.get(v.name) ?? [];
    owners.push({ typeName, scheme });
    CTOR_OWNERS.set(v.name, owners);
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
      if (decl.tag === "DInputmap") { this.inferInputmap(decl, env); continue; }
      if (decl.tag === "DLet")    { this.inferLet(decl, env); continue; }
      if (decl.tag !== "DFn") continue;
      const multiClause = decl.clauses.length > 1;
      for (const clause of decl.clauses) {
        this.inferClause(decl.name, clause, decl.sig, env, multiClause);
      }
    }
  }

  // A module-level `let`. Infer the RHS, reconcile it with the type registered in
  // pass 1 (an ascription is checked; a bare binding's fresh var is resolved), then —
  // if the RHS folds to a constant and the binding is immutable — record it so a
  // later prop reference (`background=panel`) can resolve and prove contrast.
  // Literal defaulting (numeric-dimension-design §5): a compile-time-CONSTANT
  // number takes the unit its annotation names — `let d: Meters = 5`. This is the
  // ONE Number→unit crossing without a constructor, and the keystone the whole
  // `std/units` library stands on (`let oneMeter: Meters = 1`, then the `*`/`/`
  // algebra mints every other constructor). It is sound *because* the value is
  // constant: `constEval` returns a number only when no runtime name is read, so
  // nothing is silently coerced — a non-constant `Number` still falls through to
  // `unify` and the explicit-casts-only mismatch error (§4). Units carry no range,
  // so (unlike a sized type) the fold needs no bound check — any number defaults.
  // Returns true iff the default applied (the caller then skips the unify).
  private literalDefaultsToUnit(declT: Type, vt: Type, value: Expr): boolean {
    const dt = this.ctx.subst.apply(declT);
    const v  = this.ctx.subst.apply(vt);
    return dt.tag === "United"
        && v.tag === "Prim" && v.kind === "Number"
        && typeof constEval(value, this.moduleConsts) === "number";
  }

  private inferLet(decl: Extract<Decl, { tag: "DLet" }>, env: TypeEnv): void {
    const vt = this.inferExpr(decl.value, env);
    const declared = env.lookup(decl.name);
    if (declared && !this.literalDefaultsToUnit(declared.type, vt, decl.value))
      unify(declared.type, vt, this.ctx, decl.span, `let ${decl.name}`);
    if (!decl.mutable) {
      const cv = constEval(decl.value, this.moduleConsts);
      if (cv !== undefined) this.moduleConsts.set(decl.name, cv);
    }
  }

  private inferClause(name: string, clause: FnClause, sig: FnSig | null, parent: TypeEnv, multiClause = false): void {
    const env = parent.child();
    const tp = new Map<string, Type>();
    // A `Result T _` def resolves `_` to its OWN row instance (registered at
    // collect), so ctx.returnType carries the row and `?` accumulates into it.
    const ownRow = this.rowByDef.get(name);
    if (ownRow) tp.set("_", ownRow);
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
    // A clause spelling only a tail (`Effect [..e] T`) HAS declared a contract:
    // its pool is the named effects (here: empty) — the tail is a promise about
    // what flows through fn params at call sites, never a license for the body.
    const declaredEffects =
      sig && (sig.effects.length || sig.effectTails.length) ? sig.effects :
      clause.effects.length || clause.effectTails.length ? clause.effects :
      null;
    const prevEffects = this.ctx.effects;
    this.ctx.effects = declaredEffects;

    // `using S` / `using surface = <expr>` (theme-design §2b): establish the ambient
    // surface for this body explicitly, instead of inferring it from a `background=`
    // prop-walk. This feeds the SAME `surfaceBg` threading the §4.3 APCA proof reads,
    // so the contrast guarantee fires against the declared surface with no new logic.
    const prevSurface = this.surfaceBg;
    let inlineSurfaceKey: string | null = null;
    if (clause.surface) {
      if (clause.surface.value) {
        // inline declare-and-apply: bind the name in this body's env + fold its const
        const vt = this.inferExpr(clause.surface.value, env);
        env.defineMono(clause.surface.name, vt);
        const cv = constEval(clause.surface.value, this.moduleConsts);
        if (cv !== undefined) {
          this.moduleConsts.set(clause.surface.name, cv);
          inlineSurfaceKey = clause.surface.name;
        }
        if (typeof cv === "string") this.surfaceBg = cv;
      } else {
        // named role: resolve its already-folded hex from the module constants
        const cv = this.moduleConsts.get(clause.surface.name);
        if (typeof cv === "string") this.surfaceBg = cv;
      }
    }

    const bodyType = this.inferExpr(clause.body, env);
    unify(bodyType, retType, this.ctx, clause.body.span, `'${name}' return type`);

    // Bare-witness return GUARANTEE: a def returning `Index(length(p))` UNWRAPPED
    // (no Result escape hatch) must hand back an in-range index on every path —
    // so each tail position of the body is a witness demand, proved from that
    // branch's facts by facts.ts (`proofs: [bounds]`). The dual of the Result
    // gate's `Ok(payload)` demand; the caller seeds it onto a `let` (below).
    {
      const w = bareWitnessRet(this.ctx.subst.apply(retType));
      if (w) for (const tail of tailExprs(clause.body))
        WITNESS_DEMANDS.set(tail, { list: w.listParam, ref: w.ref });
    }
    // Ascription effect-coverage: a return ascription must not ERASE the
    // body value's effect row (effects don't participate in unification, so
    // the unify above would silently retype `netGet` as `(String -> String)`).
    // A tail-spelled return ref is exempt at top level — the tail owns that
    // row (bound at call sites; an unbound tail already errored at collect).
    if (retRef && !(retRef.tag === "TRFn" && retRef.effectTail !== undefined))
      this.checkEffectErasure(retType, bodyType, clause.body.span, `'${name}' return ascription`);

    this.surfaceBg = prevSurface;
    if (inlineSurfaceKey) this.moduleConsts.delete(inlineSurfaceKey);

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
  // `inputmap Name over Stream` (multitarget-design §4.0). Three checks per
  // table: (1) every row pattern matches the stream's event type and the action
  // type-checks with the pattern's bindings; (2) a bare function-valued action
  // is rejected with a fix-it (rows call actions explicitly, per the §2.1 call
  // unification — the design sketch's bare `-> save` predates it); (3) conflict
  // analysis — a row structurally equal to an earlier one is "bound twice", a
  // row after an earlier catch-all is "shadowed" (guarded rows are exempt:
  // a guard may fail, so they neither conflict nor shadow).
  private inferInputmap(decl: Extract<Decl, { tag: "DInputmap" }>, env: TypeEnv): void {
    const srcScheme = env.lookup(decl.stream);
    const srcT = srcScheme ? this.ctx.subst.apply(instantiate(srcScheme)) : null;
    if (!srcT || srcT.tag !== "Stream") {
      if (srcT) err(this.ctx, decl.span, `${decl.form} '${decl.name}' is over '${decl.stream}', which is not a stream (it is ${typeToString(srcT)})`);
      return; // unknown stream already reported by resolution
    }
    const inner = srcT.inner;
    const seen: { key: string; span: Span }[] = [];
    let catchAll: Span | null = null;
    for (const row of decl.rows) {
      const rowEnv = env.child();
      this.checkPat(row.pat, this.ctx.subst.apply(inner), rowEnv);
      if (row.guard) unify(this.inferExpr(row.guard, rowEnv), { tag: "Prim", kind: "Bool" }, this.ctx, row.span);
      const actionT = this.ctx.subst.apply(this.inferExpr(row.action, rowEnv));
      if (row.action.tag === "Var" && (actionT.tag === "Fn" || actionT.tag === "SagaFn" || actionT.tag === "Inputmap")) {
        err(this.ctx, row.span, `inputmap '${decl.name}': action \`${row.action.name}\` is a function value — call it: \`${row.action.name}()\``);
      }
      if (row.guard) continue; // guarded rows are exempt from conflict analysis
      const key = patKey(row.pat);
      const dup = seen.find(s => s.key === key);
      if (dup) {
        err(this.ctx, row.span, `inputmap '${decl.name}': this pattern is already bound (row at line ${dup.span.start.line + 1}) — two rows matching the same event is a conflict`);
      } else if (catchAll) {
        err(this.ctx, row.span, `inputmap '${decl.name}': row is unreachable — shadowed by the catch-all row at line ${catchAll.start.line + 1}`);
      }
      seen.push({ key, span: row.span });
      if (row.pat.tag === "PWild" || row.pat.tag === "PVar") catchAll ??= row.span;
    }
  }

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
        // Expected-type-driven constructor resolution for SHARED ctor names
        // (error rows S3): a name declared by ≥2 ADTs must not resolve to the
        // last declaration — defer behind fresh vars and judge in finalizeRows
        // once unification has revealed which ADT the context demands.
        const owners = CTOR_OWNERS.get(expr.name);
        if (s && owners && owners.length >= 2) {
          const allFn  = owners.every(o => o.scheme.type.tag === "Fn");
          const allVal = owners.every(o => o.scheme.type.tag !== "Fn");
          // Mixed arity across owners stays last-declaration-wins (residual).
          if (allFn || allVal) {
            const ret = freshVar();
            const payload = allFn ? freshVar() : null;
            this.pendingCtorUses.push({ name: expr.name, span: expr.span, ret, payload });
            return allFn ? { tag: "Fn", params: [payload!], ret, effects: [] } : ret;
          }
        }
        if (s) return this.instantiateAtUse(s, expr.span);
        // Ambient stdlib namespace — `Math.sqrt(x)` with no import (SPEC §5.5).
        // Fires only when the name is unbound, so user bindings shadow modules.
        const mod = STDLIB_MODULE_NAMES.has(expr.name) ? stdlibModule(expr.name) : null;
        if (mod) return moduleRecordType(mod);
        return { tag: "Unknown" };
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

        // Units of measure ∩ Math (B2(ii)): `sqrt`/`cbrt` scale exponents, the
        // abs/round family preserves the dimension, transcendentals demand a
        // dimensionless argument. Fires ONLY when an argument is actually United,
        // so every plain-Number Math call (the whole corpus) takes the generic
        // signature path below unchanged.
        const mathName =
          expr.fn.tag === "Field" && expr.fn.obj.tag === "Var" && expr.fn.obj.name === "Math" ? expr.fn.field
          : expr.fn.tag === "Var" ? expr.fn.name : null;
        if (mathName) {
          const margs = argTs.map(t => this.ctx.subst.apply(t));
          if (margs.some(t => t.tag === "United")) {
            const um = this.unitMathCall(mathName, margs, expr.span);
            if (um) return um;
          }
        }

        // Return-gate GUARANTEE: inside a fn returning `Result(Index(length(p)), e)`,
        // an `Ok(payload)` success must itself prove `payload` in range for `p` —
        // recorded as a witness demand on the payload (facts.ts enforces it under
        // `proofs: [bounds]`), so the gate cannot hand back an out-of-range index.
        if (expr.fn.tag === "Var" && expr.fn.name === "Ok"
            && argExprs.length === 1 && this.ctx.returnType) {
          const w = resultWitnessRet(this.ctx.subst.apply(this.ctx.returnType));
          if (w) WITNESS_DEMANDS.set(argExprs[0]!, { list: w.listParam, ref: w.ref });
        }

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
            // A bounds-witness param whose check constEval can't settle is
            // recorded as a DEMAND on the argument node; facts.ts enforces it
            // inside `proofs: [bounds]` scopes (skip elsewhere — the gradient).
            const recordDemand = () => {
              const w = witnessUseOf(pt);
              if (!w) return;
              const j = paramNames.indexOf(w.listParam);
              const listE = j >= 0 ? argExprs[j] : undefined;
              WITNESS_DEMANDS.set(argExprs[i]!,
                { list: listE?.tag === "Var" ? listE.name : null, ref: pt.pred });
            };
            const v = constEval(argExprs[i]!, callEnv);
            if (v === undefined) { recordDemand(); continue; }   // not constant → runtime-checked
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
            if (unresolved) { recordDemand(); continue; }
            if (constEval(refinement.pred, penv) === false)
              err(this.ctx, argExprs[i]!.span,
                `value ${JSON.stringify(v)} does not satisfy refinement '${pt.pred}'`);
          }
        }

        // Inputmap: nullary call runs the drain loop to the stream's Done (§10.5).
        if (resolvedFnT.tag === "Inputmap") {
          if (argTs.length !== 0)
            err(this.ctx, expr.span, `inputmap '${resolvedFnT.name}' takes no arguments (calling it runs the drain loop), got ${argTs.length}`);
          return { tag: "Prim", kind: "Unit" };
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
              cur = { tag: "Fn", params: cur.params.slice(n), ret: cur.ret, effects: cur.effects,
                      ...(cur.effectTail !== undefined ? { effectTail: cur.effectTail } : {}) };
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
            ...(resolvedFnT.effectTail !== undefined ? { effectTail: resolvedFnT.effectTail } : {}),
          });
        }

        // Effect polymorphism for HOFs (SPEC §12.4): a function value carries its
        // latent effects, and SUPPLYING it as an argument makes the call require
        // them — the callee may invoke it, and without effect rows we cannot see
        // that it doesn't (conservative rule; map/filter/pmap all do). This is
        // what stops `map(netGet, urls)` laundering [io] through a pure function:
        // `netGet` is never *called* by name here, only handed over.
        const checkLatentArgEffects = (calleeName: string) => {
          const latent: string[] = [];
          const sources: string[] = [];
          for (let i = 0; i < argTs.length; i++) {
            const at = this.ctx.subst.apply(argTs[i]!);
            if (at.tag !== "Fn") continue;
            const row = fnEffectRow(at);   // full row: declared ∪ tail binding (S4c)
            if (row.length === 0) continue;
            for (const e of row) if (!latent.includes(e)) latent.push(e);
            const ae = argExprs[i];
            const src = ae && ae.tag === "Var" ? `'${ae.name}'` : "a function argument";
            if (!sources.includes(src)) sources.push(src);
          }
          if (latent.length === 0) return;
          const list = latent.join(", ");
          if (this.ctx.effects !== null) {
            const missing = latent.filter(e => !this.ctx.effects!.includes(e));
            if (missing.length > 0) {
              const callerEffects = this.ctx.effects.length ? `[${this.ctx.effects.join(", ")}]` : "none";
              err(this.ctx, expr.span,
                `effect violation: '${calleeName}' is given ${sources.join(", ")} whose effects are [${list}], but current context declares ${callerEffects} — the callee may call its argument, so its effects count here`);
            }
          } else {
            const msg = `effect violation: pure function passes ${sources.join(", ")} (effects [${list}]) to '${calleeName}' — the callee may call it; declare 'Effect [${list}]' on this function or pass a pure function`;
            if (atLeast(this.ctx.edition, "2026.6")) err(this.ctx, expr.span, msg);
            else warn(this.ctx, expr.span, msg);
          }
        };

        // Unknown callee (an unresolved or not-yet-typed builtin): the call's
        // result is Unknown too — same discipline as a failed call below. Letting
        // the fresh `ret` var escape instead would leak a leniency var that the
        // try-soundness sweep (§12) cannot tell from a genuine polymorphic line.
        // An Unknown callee is exactly the case where we can't see whether it
        // calls its function arguments — so the latent-effect rule still applies
        // (this is the path `map`/`filter` take: typed in resolve, not in infer).
        if (resolvedFnT.tag === "Unknown") {
          checkLatentArgEffects(expr.fn.tag === "Var" ? expr.fn.name : "fn");
          return { tag: "Unknown" };
        }

        const prevErrCount = this.ctx.diagnostics.length;
        unify(fnT, { tag: "Fn", params: argTs, ret, effects: [] }, this.ctx, expr.span, fnName);
        // If the call itself failed to type-check, return Unknown so downstream
        // uses of this expression's result don't cascade into follow-on errors.
        if (this.ctx.diagnostics.length > prevErrCount) return { tag: "Unknown" };

        // The callee's full effect row: its declared names plus its effect
        // tail's binding (S4c) — computed AFTER the unify above, which is what
        // binds the tail from this call's fn arguments. A tailed HOF given an
        // [io] mapper requires [io] HERE, at this call site only.
        const requiredEffects = resolvedFnT.tag === "Fn" ? fnEffectRow(resolvedFnT) : [];

        // Effect check. Two cases:
        //  (a) the caller declared effects → the callee's effects must be a subset.
        //  (b) the caller declared NONE (a pure function) → calling anything effectful
        //      is a violation. This used to be silently "unchecked" (SPEC §12.3 hole);
        //      it is now enforced — as an error in edition 2026.6+, and a warning in
        //      the baseline edition (deprecation lifecycle, SPEC §17) so existing code
        //      keeps compiling while the hole is closed.
        if (requiredEffects.length > 0) {
          const calleeName = expr.fn.tag === "Var" ? expr.fn.name : "fn";
          if (this.ctx.effects !== null) {
            const missing = requiredEffects.filter(e => !this.ctx.effects!.includes(e));
            if (missing.length > 0) {
              const callerEffects = this.ctx.effects.length ? `[${this.ctx.effects.join(", ")}]` : "none";
              err(this.ctx, expr.span,
                `effect violation: '${calleeName}' requires [${requiredEffects.join(", ")}] but current context declares ${callerEffects}`);
            }
          } else {
            const msg = `effect violation: pure function calls '${calleeName}' which requires [${requiredEffects.join(", ")}] — declare 'Effect [${requiredEffects.join(", ")}]' on this function or remove the call`;
            if (atLeast(this.ctx.edition, "2026.6")) err(this.ctx, expr.span, msg);
            else warn(this.ctx, expr.span, msg);
          }
        }

        // Typed callee: latent effects of fn-valued arguments count exactly as
        // they do for Unknown callees above — UNLESS the callee's signature is
        // TAIL-AWARE: an effect tail on its own row (S4c builtins; user defs
        // spelling `Effect [..e]` — charged through requiredEffects above) or
        // on a fn PARAM only (the user identity pattern, `f: (A -> Effect
        // [..e] B)` with no `..e` in the own clause: "takes it, never calls
        // it" — deliberately uncharged, no laundering since the value keeps
        // its row). A tail-aware signature accounts for its fn arguments
        // explicitly, so the conservative §12.4 rule defers to it; untailed
        // signatures keep the conservative charge.
        const tailAware = resolvedFnT.tag === "Fn" &&
          (resolvedFnT.effectTail !== undefined ||
           resolvedFnT.params.some(p => { const rp = this.ctx.subst.apply(p); return rp.tag === "Fn" && rp.effectTail !== undefined; }));
        if (!tailAware)
          checkLatentArgEffects(expr.fn.tag === "Var" ? expr.fn.name : "fn");

        // Return-gate SEED (caller side): a full-arity call to a gate returning
        // a witness — `Result(Index(length(p)), e)` (seeds a `match`'s Ok-binder)
        // or a bare `Index(length(p))` (seeds a `let` binder) — records it with
        // the caller's actual list substituted for the callee param `p`.
        if (resolvedFnT.tag === "Fn") {
          const retT = this.ctx.subst.apply(resolvedFnT.ret);
          const w = resultWitnessRet(retT) ?? bareWitnessRet(retT);
          if (w) {
            const paramNames = expr.fn.tag === "Var" ? (FN_PARAMS.get(expr.fn.name) ?? []) : [];
            const j = paramNames.indexOf(w.listParam);
            const listE = j >= 0 ? argExprs[j] : undefined;
            WITNESS_RETURNS.set(expr, { list: listE?.tag === "Var" ? listE.name : null, ref: w.ref });
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
        // Flow narrowing: `if x is Ok(a)` binds the payload in the then-branch.
        // Reconstruct the constructor pattern `Ok(a)` and check it against the
        // scrutinee's type, reusing checkPat's full ctor-payload resolution
        // (Result/Async/outcome/ADT). The binder lives in a child scope so it
        // can't leak into the else-branch or beyond.
        let thenEnv = env;
        if (expr.cond.tag === "TypeTest" && expr.cond.binder && expr.cond.against.tag === "TRNamed") {
          thenEnv = env.child();
          const subjT = this.ctx.subst.apply(this.inferExpr(expr.cond.expr, env));
          const ctorPat: Pat = { tag: "PCtor", name: expr.cond.against.name, inner: expr.cond.binder, span: expr.cond.span };
          this.checkPat(ctorPat, subjT, thenEnv);
        }
        const thenT = this.inferExpr(expr.then, thenEnv);
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
        // Error rows S2 — exhaustiveness over the ACTUAL raised set. A match
        // whose subject carries a row (Result(T, row) or the bare row) has its
        // arms recorded here and judged in finalizeRows, after the row closes:
        // missing ctors and can-never-match ctors are both errors; prose
        // entries need a catch-all. (exhaust.ts checks the Result level only —
        // it never descends into the error payload, so no double report.)
        const subjApplied = this.ctx.subst.apply(subjT);
        const wrapped = subjApplied.tag === "Named" && subjApplied.name === "Result"
          && subjApplied.args[1]?.tag === "ErrRow";
        const rowErr = wrapped ? subjApplied.args[1] as ErrRowT
          : subjApplied.tag === "ErrRow" ? subjApplied as ErrRowT : null;
        if (rowErr) {
          const matched: { name: string; span: Span }[] = [];
          let catchall = false;
          for (const b of expr.branches) {
            if (b.guard) continue;  // a guarded arm covers nothing for sure
            const p = b.pat;
            if (p.tag === "PWild" || p.tag === "PVar") { catchall = true; continue; }
            const inner = wrapped
              ? (p.tag === "PCtor" && p.name === "Error" ? (p.inner ?? { tag: "PWild" as const, span: p.span }) : null)
              : p;
            if (!inner) continue;  // Ok arms etc. — not about the error side
            if (inner.tag === "PWild" || inner.tag === "PVar") catchall = true;
            else if (inner.tag === "PCtor") matched.push({ name: inner.name, span: inner.span });
            // other payload shapes (literals, records) are conservatively
            // treated as covering nothing — a catch-all is still required
          }
          this.pendingRowMatches.push({ row: rowErr, matched, catchall, span: expr.span });
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
        // Error rows (S1): three regimes for the error side.
        const eRes = this.ctx.subst.apply(e);
        const rt = this.ctx.returnType ? this.ctx.subst.apply(this.ctx.returnType) : null;
        const ownRow = rt && rt.tag === "Named" && rt.name === "Result"
          && rt.args[1]?.tag === "ErrRow" ? rt.args[1] as ErrRowT : null;
        if (ownRow) {
          // (a) inside a `Result T _` def: accumulate the callee's contribution
          //     into this def's row instead of unifying error types.
          if (eRes.tag === "ErrRow") {
            if (eRes !== ownRow) ROW_DEPS.push([ownRow, eRes]);  // row ⊇ callee row
          } else if (tailContribution(ownRow, eRes)) {
            // (S4b) the callee's error is one of this def's own type params —
            // a TAIL, resolved per call site (finalizeRows steps 0.4/0.5),
            // not an opaque error name.
          } else {
            const entries = rowContribution(eRes);
            if (entries) addRowEntries(ownRow, entries);
            // A late-resolving error type (a Var — e.g. a forward call to an
            // unannotated def) is deferred and re-judged in finalizeRows;
            // S1 silently dropped it and the row under-approximated.
            else if (eRes.tag === "Var")
              this.pendingRowContribs.push({ row: ownRow, errType: eRes, span: expr.span });
            // Unknown stays lenient — it is the checker's explicit give-up type.
          }
          return this.ctx.subst.apply(ok);
        }
        if (eRes.tag === "ErrRow") {
          // (b) a PINNED def consuming a row-typed callee: defer the inclusion
          //     check to finalizeRows (the row may still be filling), and skip
          //     the error-side unify — unifying would pour the declared ADT's
          //     ctors into the callee's row and pollute its other consumers.
          const declared = rt && rt.tag === "Named" && rt.name === "Result" && rt.args[1]
            ? rt.args[1] : { tag: "Unknown" as const };
          this.pendingPins.push({ row: eRes, declared, span: expr.span });
          return this.ctx.subst.apply(ok);
        }
        // (c) today's behavior: propagate the error type to the enclosing return.
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
        // Outcome: the distinctly-typed outcome ADT `Outcome(bodyT)` (2026.6) /
        // `TxResult(bodyT)` (2026.1) — commit value, abort payload, or a concurrency
        // outcome (`Conflict {retries}` / `Timeout {after}` / `Cancelled`). All five
        // constructors are resolved against it at the match site (see checkPat /
        // outcomeCtorType), so `c.retries` & `t.after` are typed and the match is
        // exhaustiveness-checked over the closed ctor set.
        const adt = outcomeAdt(this.ctx.edition);
        return { tag: "Named", name: adt.typeName, args: [this.ctx.subst.apply(bodyT)] };
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
        // Resolve THIS element's background: its own constant `background` prop wins,
        // else it inherits the ambient one from its ancestors (the §14.1 surface).
        const ownBg = expr.props.find(p => p.name === "background");
        const ownBgLit = ownBg ? constEval(ownBg.value, this.moduleConsts) : undefined;
        const myBg = typeof ownBgLit === "string" ? ownBgLit : this.surfaceBg;
        for (const p of expr.props) {
          const vt = this.inferExpr(p.value, env);
          const expected = ELEMENT_PROP_TYPES[p.name] ?? PRIMITIVE_PROP_TYPES[expr.name]?.[p.name];
          if (expected) {
            // Bare-number → Px coercion: a `Length` prop accepts a plain Number.
            const isLen = expected.tag === "Named" && expected.name === "Length";
            const got = this.ctx.subst.apply(vt);
            const isPxCoerce = isLen && got.tag === "Prim" && got.kind === "Number";
            // Responsive(Length) auto-collapse (§9.3): a Length prop also accepts a
            // `Breakpoint -> Length` value (a `Responsive(Length)`). The prop site
            // collapses it against the live `viewport.breakpoint` before emit (eval);
            // here we only gate WHICH functions are accepted — its RETURN must be a
            // Length (a Number return Px-coerces, exactly like the bare case above).
            if (isLen && got.tag === "Fn" && got.params.length === 1
                && got.params[0]!.tag === "Named" && got.params[0]!.name === "Breakpoint") {
              const ret = this.ctx.subst.apply(got.ret);
              if (!(ret.tag === "Prim" && ret.kind === "Number"))
                unify(expected, ret, this.ctx, p.value.span, `responsive prop '${p.name}'`);
            } else if (!isPxCoerce)
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
            const cv = constEval(p.value, this.moduleConsts);
            if (typeof cv === "number" &&
                constEval(refinement.pred, new Map([["value", cv]])) === false)
              err(this.ctx, p.value.span,
                `${cv} is off the '${scaleName}' scale; use a scale value or raw(${cv})`);
          }
          // Accessibility-as-proof: a colour prop must contrast with the resolved
          // background. Opt-in (only if the project defines `OnSurface`), and only
          // when both the colour and the ambient background are constant hex (§14.1).
          const surfName = PROP_SURFACE[p.name];
          const surfRef = surfName ? REFINEMENTS.get(surfName) : undefined;
          if (surfRef && typeof myBg === "string") {
            const cc = constEval(p.value, this.moduleConsts);
            if (typeof cc === "string") {
              // `value` = this colour (the refinement subject, as everywhere);
              // `surface` = the resolved ambient background.
              const penv = new Map<string, ConstVal>([["value", cc], ["surface", myBg]]);
              if (constEval(surfRef.pred, penv) === false) {
                const lc = apcaLc(cc, myBg);
                err(this.ctx, p.value.span,
                  `colour ${cc} fails '${surfName}'${lc === null ? "" : ` — APCA Lc ${Math.round(lc)}`} against background ${myBg}`);
              }
            }
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
        // Children are checked with THIS element's resolved background as their ambient
        // surface (the §14.1 top-down threading, mirroring the renderer's `myBg`).
        const prevSurface = this.surfaceBg;
        this.surfaceBg = typeof myBg === "string" ? myBg : null;
        for (const c of expr.children) {
          if (c.tag === "Element" && mode !== undefined && mode !== "flex")
            for (const cp of c.props)
              if (FLEX_ITEM_PROPS.has(cp.name))
                err(this.ctx, cp.value.span,
                  `prop '${cp.name}' requires a flex parent (Row/Column/Stack/Grid); parent ${expr.name} is a ${mode}`);
          // Free positioning lives only inside Canvas (svg-legibility-design S0):
          // `at` on a flow child would silently absolute-position it out of flow.
          if (c.tag === "Element" && expr.name !== "Canvas")
            for (const cp of c.props)
              if (cp.name === "at")
                err(this.ctx, cp.value.span,
                  `prop 'at' requires a Canvas parent — free positioning lives only inside Canvas; parent ${expr.name} is flow-layouted`);
          this.inferExpr(c, env);
        }
        this.surfaceBg = prevSurface;
        // Canvas legibility proof (svg-legibility-design S1): free positioning is
        // the door unreadability walks through, so Canvas ships WITH its proof
        // obligation — opt-in like OnSurface, activated by declaring `Legible`.
        if (expr.name === "Canvas") this.checkCanvasLegibility(expr, typeof myBg === "string" ? myBg : null);
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

  // ── Canvas legibility proof (svg-legibility-design S0+S1) ───────────────────
  // Two obligations over a Canvas's direct children, both checked statically on
  // all-constant scenes (no solver, no font metrics — S1):
  //   (A) disjointness — no two texts intersect; no fill painted ABOVE a text
  //       (paint order = child order) intersects it;
  //   (B) geometric contrast — for every region a text sits over, the topmost
  //       solid fill beneath it (else the canvas background) must satisfy the
  //       `Legible` refinement; the text box is decomposed exactly on the
  //       covering fills' edges, so the binding constraint is the minimum.
  // Opt-in, never forced (the decided constraint): the proof activates only
  // when the project declares `Legible` (e.g. `type Legible = Color where
  // contrast(value, surface) >= 60`) — the refinement-style stand-in until the
  // §3.4 `Proof [legible]` syntax lands. When it IS active, every child needs
  // foldable geometry: "impossible by construction" must not be a lie, so what
  // doesn't fold is a precise could-not-prove error, not a silent skip.
  private checkCanvasLegibility(expr: Extract<Expr, { tag: "Element" }>, canvasBg: string | null): void {
    const ref = REFINEMENTS.get("Legible");
    if (!ref) return;
    interface CBox { x: number; y: number; w: number; h: number; idx: number; span: Span; }
    interface CText extends CBox { label: string; color: string | null; }
    interface CFill extends CBox { color: string; name: string; }
    const TEXTY = new Set(["Text", "Label", "Heading"]);
    const FILLY = new Set(["Box", "Card"]);
    const texts: CText[] = [];
    const fills: CFill[] = [];
    let idx = 0;
    for (const c of expr.children) {
      if (c.tag !== "Element") continue;
      const i = idx++;
      const fold = (n: string) => {
        const p = c.props.find(pp => pp.name === n);
        return p ? constEval(p.value, this.moduleConsts) : undefined;
      };
      const at = fold("at"), w = fold("width"), h = fold("height");
      const box = Array.isArray(at) && at.length === 2
        && typeof at[0] === "number" && typeof at[1] === "number"
        && typeof w === "number" && typeof h === "number"
        ? { x: at[0], y: at[1], w, h, idx: i, span: c.span } : null;
      if (TEXTY.has(c.name)) {
        if (!box) {
          err(this.ctx, c.span,
            `could not prove legibility: Canvas text needs constant 'at', 'width' and 'height' — a declared extent is the S1 bound (dynamic text on Canvas is unprovable)`);
          continue;
        }
        const label = c.content ? constEval(c.content, this.moduleConsts) : undefined;
        const colorV = fold("color");
        texts.push({ ...box, label: typeof label === "string" ? label : c.name,
                     color: typeof colorV === "string" ? colorV : null });
      } else if (FILLY.has(c.name)) {
        const bg = fold("background");
        if (!box || typeof bg !== "string") {
          err(this.ctx, c.span,
            `could not prove legibility: Canvas ${c.name} needs constant 'at', 'width', 'height' and 'background' — an unprovable fill could hide or recolour the scene behind a text`);
          continue;
        }
        fills.push({ ...box, color: bg, name: c.name });
      } else {
        err(this.ctx, c.span,
          `could not prove legibility: S1 proves direct Text/Label/Heading and Box/Card children only; ${c.name} is unsupported on a checked Canvas`);
      }
    }
    const overlap = (a: CBox, b: CBox) =>
      a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
    // (A) disjointness: text pairs, then fills painted above a text.
    for (let i = 0; i < texts.length; i++)
      for (let j = i + 1; j < texts.length; j++)
        if (overlap(texts[i]!, texts[j]!))
          err(this.ctx, texts[j]!.span,
            `Canvas text "${texts[j]!.label}" overlaps text "${texts[i]!.label}" — free-positioned labels must be disjoint`);
    for (const t of texts)
      for (const f of fills)
        if (f.idx > t.idx && overlap(t, f))
          err(this.ctx, t.span,
            `Canvas text "${t.label}" is covered by a ${f.name} painted above it (paint order is child order) — paint the text later or move it aside`);
    // (B) per-region composited contrast. Cut the text box on every covering
    // fill edge; each cell's background is the topmost fill containing it
    // (fills iterate in paint order, so the last hit wins), else the canvas
    // background. An unknown canvas background stays silent, the same law as
    // OnSurface's unknown-surface case; identical failing colours report once.
    for (const t of texts) {
      if (!t.color) continue;   // non-constant colour: the OnSurface skip
      const under = fills.filter(f => f.idx < t.idx && overlap(t, f));
      const xs = [t.x, t.x + t.w], ys = [t.y, t.y + t.h];
      for (const f of under) {
        for (const v of [f.x, f.x + f.w]) if (v > t.x && v < t.x + t.w) xs.push(v);
        for (const v of [f.y, f.y + f.h]) if (v > t.y && v < t.y + t.h) ys.push(v);
      }
      xs.sort((a, b) => a - b); ys.sort((a, b) => a - b);
      const reported = new Set<string>();
      for (let xi = 0; xi + 1 < xs.length; xi++) {
        for (let yi = 0; yi + 1 < ys.length; yi++) {
          const cx = (xs[xi]! + xs[xi + 1]!) / 2, cy = (ys[yi]! + ys[yi + 1]!) / 2;
          let bg = canvasBg;
          for (const f of under)
            if (cx > f.x && cx < f.x + f.w && cy > f.y && cy < f.y + f.h) bg = f.color;
          if (bg === null || reported.has(bg)) continue;
          const penv = new Map<string, ConstVal>([["value", t.color], ["surface", bg]]);
          if (constEval(ref.pred, penv) === false) {
            reported.add(bg);
            const lc = apcaLc(t.color, bg);
            err(this.ctx, t.span,
              `Canvas text "${t.label}" colour ${t.color} fails 'Legible'${lc === null ? "" : ` — APCA Lc ${Math.round(lc)}`} against the composited region ${bg} beneath it`);
          }
        }
      }
    }
  }

  // ── Math ∩ units ─────────────────────────────────────────────────────────
  // How the standard Math builtins act on a united argument (B2(ii)). Returns
  // null when the name is not a unit-aware Math function — the caller then takes
  // the ordinary `fn([Number], Number)` signature path. Only ever called with a
  // United present, so it never perturbs plain-Number arithmetic.

  private unitMathCall(name: string, args: Type[], span: Span): Type | null {
    const num: Type = { tag: "Prim", kind: "Number" };
    const united = (dims: Dims): Type => isDimensionless(dims) ? num : { tag: "United", base: num, dims };
    const us = args.filter((t): t is Extract<Type, { tag: "United" }> => t.tag === "United");

    // Dimension-preserving: abs/round/sign keep the unit; min/max/clamp require
    // every operand to share ONE dimension (no bare-Number ∼ unit mixing).
    if (["abs", "floor", "ceil", "round", "trunc", "sign", "min", "max", "clamp"].includes(name)) {
      const base = us[0]!;
      for (const u of us)
        if (!dimsEqual(u.dims, base.dims))
          err(this.ctx, span, `'${name}' across mixed units — ${typeToString(base)} vs ${typeToString(u)}`);
      if (args.some(t => t.tag !== "United"))
        err(this.ctx, span, `'${name}' mixes a united value with a bare Number`);
      return base;
    }

    // Roots scale every exponent: sqrt halves, cbrt thirds. A non-divisible
    // exponent (sqrt of a Length, m^1) is the error units exist to catch.
    if (name === "sqrt" || name === "cbrt") {
      const u = us[0];
      if (!u) return null;
      const root = name === "sqrt" ? 2 : 3;
      const scaled: { atom: string; exp: number }[] = [];
      for (const [atom, exp] of Object.entries(u.dims)) {
        if (exp % root !== 0) {
          err(this.ctx, span, `'${name}' of ${typeToString(u)} — exponent of ${atom} (${exp}) is not divisible by ${root}`);
          return num;
        }
        scaled.push({ atom, exp: exp / root });
      }
      return united(mkDims(scaled));
    }

    // Transcendentals (and log/exp) are only defined on a pure ratio: the
    // argument must be dimensionless. `sin(m)` is a category error.
    if (["sin", "cos", "tan", "asin", "acos", "atan", "log", "log2", "log10", "exp"].includes(name)) {
      const u = us[0];
      if (u) err(this.ctx, span, `'${name}' requires a dimensionless Number — got ${typeToString(u)}`);
      return num;
    }

    return null; // pow, atan2, … — fall through to the ordinary signature.
  }

  // ── BinOp ──────────────────────────────────────────────────────────────────

  private inferBinOp(expr: Extract<Expr, { tag: "BinOp" }>, env: TypeEnv): Type {
    const l = this.inferExpr(expr.left, env);
    const r = this.inferExpr(expr.right, env);
    const num:  Type = { tag: "Prim", kind: "Number" };
    const bool: Type = { tag: "Prim", kind: "Bool" };

    // Units of measure (B2, numeric-dimension-design.md §2.2). `*`/`/` add/subtract
    // exponent vectors (collapsing a cancelled dimension back to `Number`); `+`/`-`
    // require matching dimensions. The solver never sees this — it is a shape
    // algebra. Duration is just the time-dimensioned unit (B2(ii)), so it rides
    // these same branches — no special-case.
    const asUnit = (t: Type) => { const a = this.ctx.subst.apply(t); return a.tag === "United" ? a : null; };
    const lu = asUnit(l), ru = asUnit(r);
    const united = (dims: Dims): Type => isDimensionless(dims) ? num : { tag: "United", base: num, dims };

    switch (expr.op) {
      case "+": case "-": {
        if (lu || ru) {
          // Both must be the SAME dimension — `m + m`, not `m + s` and not `m + Number`.
          if (lu && ru && dimsEqual(lu.dims, ru.dims)) return lu;
          err(this.ctx, expr.span, `'${expr.op}' needs matching units — got ${typeToString(this.ctx.subst.apply(l))} and ${typeToString(this.ctx.subst.apply(r))}`);
          return lu ?? ru!;
        }
        unify(l, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        unify(r, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        return num;
      }
      case "*": {
        if (lu || ru) {
          // m * s → m·s (exponents add); m * Number → m (scaling). A cancelled
          // result (e.g. (m/s) * s) collapses to bare Number via `united`.
          if (lu && ru) return united(dimsMul(lu.dims, ru.dims));
          const u = (lu ?? ru)!;
          unify(lu ? r : l, num, this.ctx, expr.span, "scaling a united value requires a Number");
          return u;
        }
        unify(l, num, this.ctx, expr.span, "'*' requires Number");
        unify(r, num, this.ctx, expr.span, "'*' requires Number");
        return num;
      }
      case "/": {
        if (lu || ru) {
          // m / s → m/s; m / m → Number (dimensionless collapse — the `400ms /
          // 100ms : Number` win, generalized); Number / s → s^-1 (e.g. frequency).
          if (lu && ru) return united(dimsDiv(lu.dims, ru.dims));
          if (lu) { unify(r, num, this.ctx, expr.span, "dividing a united value requires a Number"); return lu; }
          unify(l, num, this.ctx, expr.span, "'/' requires Number");
          return united(dimsDiv({}, ru!.dims));
        }
        unify(l, num, this.ctx, expr.span, "'/' requires Number");
        unify(r, num, this.ctx, expr.span, "'/' requires Number");
        return num;
      }
      case "%": case "^":
      case "<<": case ">>": case "&": case "xor": case "|":
        unify(l, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        unify(r, num, this.ctx, expr.span, `'${expr.op}' requires Number`);
        return num;
      case "++": {
        // Inputmap layering (SPEC §10.5): `base ++ overrides` merges two maps
        // over the SAME stream into a new one (override rows win on the same
        // pattern). The stream lives in the type, so a cross-stream layer is a
        // check-time error — at runtime the merged loop could only drain one.
        const lA = this.ctx.subst.apply(l), rA = this.ctx.subst.apply(r);
        if (lA.tag === "Inputmap" || rA.tag === "Inputmap") {
          if (lA.tag !== "Inputmap" || rA.tag !== "Inputmap") {
            err(this.ctx, expr.span, `'++' layering needs inputmaps on both sides — got ${typeToString(lA)} and ${typeToString(rA)}`);
            return lA.tag === "Inputmap" ? lA : rA;
          }
          if (lA.stream !== rA.stream)
            err(this.ctx, expr.span, `cannot layer inputmaps over different streams — '${lA.name}' is over '${lA.stream}', '${rA.name}' over '${rA.stream}'`);
          return { tag: "Inputmap", name: `${lA.name}++${rA.name}`, stream: lA.stream };
        }
        unify(l, r, this.ctx, expr.span, "'++' operands must agree"); return this.ctx.subst.apply(l);
      }
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
            const declT = resolveRef(stmt.ascription, new Map(), this.sagaRets);
            if (this.literalDefaultsToUnit(declT, vt, stmt.value)) {
              bindType = declT;   // the constant literal takes the unit (§5)
            } else {
              unify(declT, vt, this.ctx, stmt.span);
              // If the ascription check failed, bind the name as Unknown so downstream
              // uses of this variable don't cascade into follow-on type errors.
              if (this.ctx.diagnostics.length > prevErrCount) bindType = { tag: "Unknown" };
              else this.checkEffectErasure(declT, vt, stmt.span, "binding ascription");
            }
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
    // Lines whose type is still an unresolved Var when peeled. Eval unwraps by
    // RUNTIME value, so a line passed through unpeeled here that later turns out
    // to be a Result is a soundness hole (blocks-design §12) — each one is judged
    // again once the whole module is inferred (deferred monomorphize-then-decide;
    // see the sweep in `infer`).
    const peel = (t: Type, sp: Span): Type => {
      const at = this.ctx.subst.apply(t);
      if (at.tag === "Named" && at.name === "Result" && at.args.length === 2) {
        unify(at.args[1]!, errType, this.ctx, span, "try error type");
        return at.args[0]!;
      }
      if (at.tag === "Var") this.pendingTryVars.push({ t: at, span: sp });
      return at;
    };
    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          let bindType = peel(this.inferExpr(stmt.value, env), stmt.span);
          if (stmt.ascription) {
            const prevErrCount = this.ctx.diagnostics.length;
            const declT = resolveRef(stmt.ascription, new Map(), this.sagaRets);
            if (this.literalDefaultsToUnit(declT, bindType, stmt.value)) {
              bindType = declT;   // the constant literal takes the unit (§5)
            } else {
              unify(declT, bindType, this.ctx, stmt.span);
              if (this.ctx.diagnostics.length > prevErrCount) bindType = { tag: "Unknown" };
              else this.checkEffectErasure(declT, bindType, stmt.span, "binding ascription");
            }
          }
          const next = env.child();
          this.bindPat(stmt.pat, bindType, next);
          env = next;
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SExpr":
          last = peel(this.inferExpr(stmt.expr, env), stmt.span);
          break;
        case "SAssign": {
          const tt = this.inferExpr(stmt.target, env);
          const vt = this.inferExpr(stmt.value, env);
          unify(tt, vt, this.ctx, stmt.span, "assignment");
          last = { tag: "Prim", kind: "Unit" };
          break;
        }
        case "SBreak": case "SReturn":
          if (stmt.value) last = peel(this.inferExpr(stmt.value, env), stmt.span);
          break;
      }
    }
    return last;
  }

  // Deferred try-soundness sweep (blocks-design §12), run once after the whole
  // module is inferred: a Var-typed try line was not unwrapped at its peel. If
  // later constraints resolved it to a Result, the static type and the runtime
  // unwrap disagree; if it stayed polymorphic, whether it unwraps depends on
  // the value that arrives. Both are rejected — only a line that resolved to a
  // concrete non-Result type was soundly passed through.
  readonly pendingTryVars: { t: Type; span: Span }[] = [];
  checkPendingTryVars(): void {
    for (const p of this.pendingTryVars) {
      const rt = this.ctx.subst.apply(p.t);
      if (rt.tag === "Named" && rt.name === "Result") {
        err(this.ctx, p.span, `this try line's type resolved to '${typeToString(rt)}' only after the line was checked, so it was not unwrapped — give the expression a concrete Result type at this line (e.g. annotate the value it comes from), or match on it outside the try`);
      } else if (rt.tag === "Var") {
        err(this.ctx, p.span, "a try line cannot stay polymorphic — whether it unwraps depends on the value that arrives at runtime; give it a concrete type or match on it outside the try");
      }
    }
  }

  // ── Error rows (error-rows-design v1, S1) ───────────────────────────────────
  // rowByDef: each `Result T _` def's owned row. pendingPins: a pinned def
  // consumed a row-typed callee at `?` — checked after rows close. Both are
  // evaluated in finalizeRows(), after the whole module is inferred, because a
  // consumed row may still be filling (defs check in module order).
  readonly rowByDef = new Map<string, ErrRowT>();
  readonly rowSpans = new Map<string, Span>();
  readonly pendingPins: { row: ErrRowT; declared: Type; span: Span }[] = [];
  // S2: matches over row-typed subjects, judged after rows close.
  readonly pendingRowMatches: { row: ErrRowT; matched: { name: string; span: Span }[]; catchall: boolean; span: Span }[] = [];
  // S3: expression-position uses of SHARED ctor names, resolved by what the
  // substitution shows the context demanded (see the Var case).
  readonly pendingCtorUses: { name: string; span: Span; ret: Type; payload: Type | null }[] = [];
  // S3 polish: `?` sites in a `_` def whose callee error type was still a Var
  // when the line was checked (forward call to an unannotated def). Re-judged
  // after the module completes; a type that never becomes contributable is an
  // error — a silently under-approximated row would let escapees through pins.
  // S4b: a clone-tail entry carries `tail` (diagnostic labels) and gets the
  // call-sited wording; an unresolvable tail also marks its row OPEN.
  readonly pendingRowContribs: { row: ErrRowT; errType: Type; span: Span; tail?: { owner: string; param: string; tv: string } }[] = [];
  // S4b: per-call-site clones of generic row defs. Which quantified ids are
  // tails only settles once the def's BODY has been inferred (tails fill
  // during inference, and a caller may be checked first), so each use records
  // its forall-id → fresh-var map and the tails are expanded in step 0.4.
  readonly pendingCloneTails: { clone: ErrRowT; base: ErrRowT; sub: Map<number, Type>; span: Span }[] = [];

  // S4b: scheme instantiation at a USE site. For a generic row def the row in
  // the scheme is the def's BASE row (identity-shared, never substituted);
  // each use gets a CLONE — empty, ⊇ base via ROW_DEPS — so pins and matches
  // judge the row of THIS call (base entries ∪ what the tails became here),
  // not the union over every call. Schemes without a row take the plain path.
  private instantiateAtUse(s: Scheme, span: Span): Type {
    if (s.forall.length === 0) return s.type;
    const base = findRow(s.type) as ErrRowT | null;
    if (!base) return instantiate(s);
    const sub = new Map<number, Type>();
    for (const id of s.forall) sub.set(id, freshVar());
    const clone: ErrRowT = { tag: "ErrRow", entries: [], owner: base.owner, tails: [] };
    ROW_DEPS.push([clone, base]);
    this.pendingCloneTails.push({ clone, base, sub, span });
    return replaceRow(substVars(s.type, sub), base, clone);
  }

  finalizeRows(): void {
    // 0. Resolve deferred shared-ctor uses (S3). Must run BEFORE row closure:
    //    a use whose ret var bound to an ErrRow contributes entries via the
    //    generic accumulate rule in unify, and closure must then propagate them.
    for (const u of this.pendingCtorUses) {
      const rt = this.ctx.subst.apply(u.ret);
      const owners = CTOR_OWNERS.get(u.name)!;
      // Pick the owner the expected type names; an ErrRow (or unresolved)
      // context cannot disambiguate — keep the last declaration (the pre-S3
      // rule) so unconstrained code behaves as before.
      const pick = (rt.tag === "Named" ? owners.find(o => o.typeName === rt.name) : undefined)
        ?? owners[owners.length - 1]!;
      const ct = instantiate(pick.scheme);
      const label = `constructor '${u.name}' (of ${pick.typeName})`;
      if (ct.tag === "Fn") {
        // declared payload first: "expected <declared>, got <argument>"
        if (u.payload) unify(ct.params[0] ?? { tag: "Unknown" }, u.payload, this.ctx, u.span, label);
        unify(u.ret, ct.ret, this.ctx, u.span, label);
      } else {
        unify(u.ret, ct, this.ctx, u.span, label);
      }
    }
    // 0.4 Expand clone tails (S4b): every use of a tailed row def registered
    //     its forall-id → fresh-var map; the fresh var for each BASE tail was
    //     bound by that call's ordinary argument unification, so it now shows
    //     what the tail became there. Each becomes a step-0.5 entry — judged
    //     by the machinery below, verbatim. Runs after all bodies (tails fill
    //     during inference) and before closure (a tail that resolved to a row
    //     must add its ⊇-edge first). A row whose tail never resolves to an
    //     enumerable error set is OPEN: its entry set is only a lower bound.
    const openRows = new Set<ErrRowT>();
    for (const c of this.pendingCloneTails) {
      for (const tid of c.base.tails) {
        const tv = c.sub.get(tid);
        if (!tv) continue;
        if (tv.tag === "Var") c.clone.tails.push(tv.id);
        const tail = TAIL_INFO.get(tid);
        this.pendingRowContribs.push({ row: c.clone, errType: tv, span: c.span, ...(tail ? { tail } : {}) });
      }
    }
    // 0.5 Re-judge deferred row contributions (S3 polish): the substitution now
    //     shows what each late callee error type became. Runs before the cycle
    //     check and closure so a Var that resolved to another row adds a real
    //     ⊇-edge, and resolved entries propagate. Still-polymorphic or non-ADT
    //     types are rejected, not dropped.
    for (const c of this.pendingRowContribs) {
      const resolved = this.ctx.subst.apply(c.errType);
      if (resolved.tag === "ErrRow") {
        if (resolved !== c.row) ROW_DEPS.push([c.row, resolved]);
        continue;
      }
      // S4b: a deferred Var that resolved to one of the def's own type params
      // is a tail recorded late, not a contribution.
      if (tailContribution(c.row, resolved)) continue;
      const entries = rowContribution(resolved);
      if (entries) { addRowEntries(c.row, entries); continue; }
      if (resolved.tag === "Unknown") {           // the explicit give-up type stays lenient
        if (c.tail) openRows.add(c.row);          // …but an unknowable tail leaves the row open
        continue;
      }
      if (c.tail) {
        openRows.add(c.row);
        if (resolved.tag === "Var")
          err(this.ctx, c.span, `the inferred error row of '${c.tail.owner}' is open at this call — the error type '${c.tail.tv}' of parameter '${c.tail.param}' never resolved; annotate the argument's error type`);
        else
          err(this.ctx, c.span, `the error type '${c.tail.tv}' of parameter '${c.tail.param}' resolved to '${typeToString(resolved)}' at this call, which has no named constructors; use a named error ADT`);
      } else if (resolved.tag === "Var")
        err(this.ctx, c.span, `the inferred error row of '${c.row.owner}' cannot include this '?' — the callee's error type never resolved; annotate the callee's return type, or pin '${c.row.owner}' with a named error ADT`);
      else
        err(this.ctx, c.span, `the inferred error row of '${c.row.owner}' cannot include this '?' — the callee's error type resolved to '${typeToString(resolved)}', which has no named constructors; use a named error ADT, or pin '${c.row.owner}'`);
    }
    // 1. Cycle check — recursion among `_` defs is rejected in v1 (Zig's rule).
    //    DFS over the ⊇-edges; report each row that can reach itself.
    const adj = new Map<ErrRowT, ErrRowT[]>();
    for (const [target, source] of ROW_DEPS) {
      if (!adj.has(target)) adj.set(target, []);
      adj.get(target)!.push(source);
    }
    const reported = new Set<string>();
    const reaches = (from: ErrRowT, goal: ErrRowT, seen: Set<ErrRowT>): boolean => {
      if (seen.has(from)) return false;
      seen.add(from);
      return (adj.get(from) ?? []).some(s => s === goal || reaches(s, goal, seen));
    };
    for (const row of this.rowByDef.values()) {
      if (!reported.has(row.owner) && reaches(row, row, new Set())) {
        reported.add(row.owner);
        const span = this.rowSpans.get(row.owner);
        if (span) err(this.ctx, span, `recursive inferred error set: '${row.owner}' is in a cycle of 'Result _' defs — pin one def in the cycle with a named error ADT`);
      }
    }
    // 2. Close rows over the ⊇-edges (fixpoint union). Openness propagates
    //    with the entries (S4b): a row ⊇ an open row is itself open.
    let changed = true;
    while (changed) {
      changed = false;
      for (const [target, source] of ROW_DEPS) {
        if (addRowEntries(target, source.entries)) changed = true;
        if (openRows.has(source) && !openRows.has(target)) { openRows.add(target); changed = true; }
      }
    }
    // 3. Pin checks: every entry of the consumed row must be a constructor of
    //    the declared (pinned) error ADT. Prose entries are never coverable.
    for (const pin of this.pendingPins) {
      const declared = this.ctx.subst.apply(pin.declared);
      const rowStr = typeToString(pin.row);
      if (declared.tag !== "Named" || !ADT_CTORS.has(declared.name)) {
        err(this.ctx, pin.span, `cannot pin the inferred error row ${rowStr} to '${typeToString(declared)}' — the pin must be a named error ADT`);
        continue;
      }
      const ctors = ADT_CTORS.get(declared.name)!;
      const escapees = pin.row.entries.filter(e => e.prose || !ctors.some(c => c.name === e.name));
      if (escapees.length > 0) {
        const prose = escapees.filter(e => e.prose).map(e => e.name);
        const named = escapees.filter(e => !e.prose);
        const parts: string[] = [];
        if (named.length) parts.push(`missing: ${named.map(e => e.name).join(", ")}`);
        if (prose.length) parts.push(`${prose.join(", ")} is prose — match it out or use a structured error`);
        // Fix-it (S3): name the smallest edit that makes the pin hold. An
        // already-declared ADT covering the whole row beats editing the pinned
        // one; otherwise spell out the missing variant declarations. Prose
        // entries have no covering edit — the existing message is the fix.
        const fixes: string[] = [];
        if (prose.length === 0) {
          let best: { name: string; size: number } | null = null;
          for (const [adtName, adtCtors] of ADT_CTORS) {
            if (adtName === declared.name) continue;
            if (pin.row.entries.every(e => adtCtors.some(c => c.name === e.name))
                && (!best || adtCtors.length < best.size))
              best = { name: adtName, size: adtCtors.length };
          }
          if (best) fixes.push(`pin with '${best.name}' (it covers this row)`);
        }
        if (named.length) {
          const adds = named.map(e => e.payload ? `${e.name} ${typeToString(e.payload)}` : e.name);
          fixes.push(`add ${adds.join(", ")} to '${declared.name}'`);
        }
        const fixStr = fixes.length ? `; fix: ${fixes.join(", or ")}` : "";
        err(this.ctx, pin.span, `error row ${rowStr} is not covered by '${declared.name}' — ${parts.join("; ")}${fixStr}`);
      }
    }
    // 4. Row-match exhaustiveness (S2): over the ACTUAL raised set. An arm
    //    naming a ctor outside the row can never match; a row entry no arm
    //    names (and no catch-all) is a missing case; prose entries can only
    //    ever be covered by a catch-all.
    for (const m of this.pendingRowMatches) {
      const rowStr = typeToString(m.row);
      // S4b: an OPEN row's entry set is only a lower bound — no arm can be
      // called unreachable, and exhaustiveness requires a catch-all arm.
      if (openRows.has(m.row)) {
        if (!m.catchall)
          err(this.ctx, m.span, `match on inferred error row ${rowStr} cannot be exhaustive — the row is open (an error tail never resolved at this call); add a catch-all arm`);
        continue;
      }
      for (const arm of m.matched) {
        if (!m.row.entries.some(e => e.name === arm.name))
          err(this.ctx, arm.span, `'${arm.name}' is not in the inferred error row ${rowStr} — this branch can never match`);
      }
      if (!m.catchall) {
        const missing = m.row.entries.filter(e => !m.matched.some(a => a.name === e.name));
        const named = missing.filter(e => !e.prose).map(e => e.name);
        const prose = missing.filter(e => e.prose).map(e => e.name);
        if (named.length || prose.length) {
          const parts: string[] = [];
          if (named.length) parts.push(`missing: ${named.join(", ")}`);
          if (prose.length) parts.push(`${prose.join(", ")} is prose and needs a catch-all arm`);
          err(this.ctx, m.span, `match on inferred error row ${rowStr} is not exhaustive — ${parts.join("; ")}`);
        }
      }
    }
  }

  // ── Literal types ─────────────────────────────────────────────────────────

  private litType(lit: Lit): Type {
    switch (lit.tag) {
      case "Str":      return { tag: "Prim", kind: "String" };
      case "Num":      return { tag: "Prim", kind: "Number" };
      case "Bool":     return { tag: "Prim", kind: "Bool" };
      case "Unit":     return { tag: "Prim", kind: "Unit" };
      case "Atom":     return { tag: "Atom", name: lit.name };
      // A duration is a Number carrying the time dimension (atom `s`). Folded into
      // the unit algebra (B2(ii)): `100ms * 100ms : s^2`, `400ms / 100ms : Number`,
      // `1 / 30s : s^-1` (frequency) all fall out of inferBinOp's United branches.
      case "Duration": return { tag: "United", base: { tag: "Prim", kind: "Number" }, dims: { s: 1 }, name: "Duration" };
    }
  }

  // ── Pattern type-checking ─────────────────────────────────────────────────

  private checkPat(pat: Pat, t: Type, env: TypeEnv): void {
    const at = this.ctx.subst.apply(t);
    switch (pat.tag) {
      case "PWild": break;
      case "PVar":  env.defineMono(pat.name, at); break;
      case "PTyped": env.defineMono(pat.name, at); break;

      case "PLit": {
        // A literal pattern against a refined type folds the refinement with
        // the literal — a literal that fails the predicate can NEVER match, so
        // it's a check-time error, not a dead branch. This is multitarget
        // §4.0's chord story (`type Chord = String where matches(value, …)`
        // makes `Push("Ctl+S")` a caught typo) but holds at every match site.
        // Non-folding predicates skip (conservative-skip discipline), as do
        // dependent refinements — their value-args aren't resolvable here.
        if (at.tag === "Refinement") {
          const refinement = REFINEMENTS.get(at.pred);
          const lv = pat.lit.tag === "Num" || pat.lit.tag === "Str" || pat.lit.tag === "Bool"
            ? pat.lit.value : undefined;
          if (refinement && refinement.params.length === 0 && lv !== undefined) {
            const penv = new Map<string, ConstVal>([["value", lv]]);
            if (constEval(refinement.pred, penv) === false)
              err(this.ctx, pat.span,
                `literal pattern ${JSON.stringify(lv)} can never match — it fails refinement '${at.pred}'`);
          }
        }
        unify(at, this.litType(pat.lit), this.ctx, pat.span);
        break;
      }

      case "PAtom":
        unify(at, { tag: "Atom", name: pat.name }, this.ctx, pat.span);
        break;

      case "PCtor": {
        // Matching a ROW-typed error (error rows S2): the arm's ctor is judged
        // for row MEMBERSHIP after rows close (the Match case records the arm,
        // finalizeRows judges it) — never unified with the row, because a
        // match must not widen what a def is recorded as raising. The payload
        // is typed from the ctor's own scheme.
        if (at.tag === "ErrRow") {
          // Prefer the row's own recorded payload for this entry (S3): under
          // ctor sharing the env's last declaration may be the wrong ADT; the
          // row entry carries the payload of the ADT that actually contributed.
          // Falls back to the env scheme if the entry hasn't filled in yet
          // (rows close at end of module; arms can check before contributors).
          const entry = at.entries.find(e => e.name === pat.name);
          if (entry && entry.payload && pat.inner) {
            this.checkPat(pat.inner, entry.payload, env);
            break;
          }
          const rs = env.lookup(pat.name);
          const rct = rs ? instantiate(rs) : null;
          if (rct && rct.tag === "Fn" && pat.inner)
            this.checkPat(pat.inner, rct.params[0] ?? { tag: "Unknown" }, env);
          break;
        }
        // Expected-type-directed constructor resolution for the outcome ADT
        // (`Outcome` 2026.6 / `TxResult` 2026.1). Under 2026.1 its commit/abort ctors
        // share names with Result, so the EXPECTED type disambiguates them; under
        // 2026.6 the names are unique and this just assigns the typed record payloads.
        // Falls through to normal env lookup for any other name (genuinely unknown
        // ctors stay lenient).
        const oadt = outcomeAdt(this.ctx.edition);
        if (at.tag === "Named" && at.name === oadt.typeName && oadt.ctors.has(pat.name)) {
          const ct = outcomeCtorType(oadt, pat.name, at.args[0] ?? freshVar());
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
        // Shared ctor names in patterns (S3): the scrutinee type picks the
        // owner, exactly as the outcome/Async pre-cases above already do for
        // the prelude's shared names.
        const ownersP = CTOR_OWNERS.get(pat.name);
        if (ownersP && ownersP.length >= 2 && at.tag === "Named") {
          const own = ownersP.find(o => o.typeName === at.name);
          if (own) {
            const ct = instantiate(own.scheme);
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
        if (!s) {
          // Stream events: `Push(p)` matched against a stream's element type T
          // checks p against T itself — awaiting yields Push-wrapped elements
          // (`Done` is nullary), and Push has no env entry to instantiate. This
          // is what carries a refined element type (Chord) into the payload
          // literal, and types the binder in `Push(e) -> … e …`.
          if (pat.name === "Push" && pat.inner) this.checkPat(pat.inner, at, env);
          break;
        }
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
