// `proofs: [nonzero]` — the partial-arithmetic obligation (SPEC §12.7,
// north-star §3.4). Forbids the divisor fault: in a proved scope, every `/`
// and `%` must have a divisor the checker can PROVE nonzero. At runtime the
// fault is silent — `x / 0` is JS division, so it poisons the result with
// Infinity/NaN instead of crashing — which is exactly why it wants a static
// obligation: there is no error to handle.
//
// The discharge engine is the FLOW-SENSITIVE FACT ENVIRONMENT (north-star
// §3.1 catch 1): comparison facts collected from the branch structure the
// value already flowed through —
//
//   • `if d == 0 then … else <here d != 0>` (negated facts on the else arm,
//     and dually for !=/</<=/>/>=; `&&` adds both on then, `||` both-negated
//     on else, `not` flips);
//   • `match d | 0 -> … | m -> <here m != 0>` (a literal branch adds ==, the
//     fall-through binder inherits the != of every literal branch above it —
//     and so does a wildcard/same-name rebind);
//   • a branch guard, in force inside its own body;
//   • a `for` Filter clause, in force in the comprehension body;
//   • an earlier multi-clause literal head: `def recip(0) -> …` means the
//     `n` of `def recip(n) -> 1 / n` cannot be 0 (counted only when the
//     earlier clause's OTHER params are irrefutable, else it may not have
//     matched on this value).
//
// Facts attach to IMMUTABLE names only. A `mut` binding never carries facts,
// and any reassignment kills every fact mentioning the name — a fact is a
// statement about a value, and it survives precisely because the binding
// cannot change under it (which is also why a fact established outside a
// lambda still holds inside it: the name is frozen at the test, however late
// the lambda runs).
//
// Discharge is TWO-TIER:
//
//   1. The no-solver INTERVAL FLOOR, inline and sync: a divisor passes iff it
//      is a nonzero literal or a name with a constant fact among {!= 0,
//      == k≠0, > k≥0, ≥ k>0, < k≤0, ≤ k<0}.
//   2. What the floor can't settle but CAN translate (terms over names with
//      +, -, *, unary minus) becomes a RESIDUE OBLIGATION — `checkNonZero`
//      returns it alongside its diagnostics, and the CLI hands the batch to
//      Z3 (smt.ts): facts ∧ divisor == 0 unsat over the reals ⟹ proved.
//      This is exactly north-star §3.3's Tier-2 fall-through: `if a != b
//      then n / (a - b)` is provable there and only there. Untranslatable
//      divisors (calls, projections — uninterpreted to any solver, §3.1
//      catch 2) stay conservative floor errors; the no-fact alternative is
//      the `NonZero` witness type (SPEC §7.1).
//
// The LSP surfaces the residue as conservative floor errors (its pipeline is
// sync); the CLI verdict is authoritative. Z3 reasons over the reals, not
// IEEE floats — for these queries the gap is benign (with gradual underflow,
// `a - b == 0` iff `a == b` holds for doubles too), and the conservative
// direction is preserved: the solver only ever REMOVES errors the floor
// would have raised, never accepts what it can refute.
//
// Like `exhaustive` and `handled` — and unlike `total` — this obligation is
// SCOPE-LOCAL: the fault is syntactic to the proved scope, so there is no
// downward call gate. A callee outside the module may still divide unsafely;
// what `nonzero` proves is that THIS module's divisors can't be zero.
import type { Module, Decl, Expr, Stmt, Pat, Branch, FnClause } from "./ast.js";
import type { Span } from "./span.js";
import type { Diagnostic, ResolutionMap } from "./resolve.js";
import type { Type } from "./types.js";
import { WITNESS_DEMANDS, WITNESS_RETURNS, boundsWitnessOf, type WitnessDemand } from "./infer.js";

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

// A comparison between two TRANSLATABLE terms (see `translatable`). `names`
// caches every name mentioned, for mutation kills.
export interface Fact { lhs: Expr; op: CmpOp; rhs: Expr; names: Set<string> }

// A divisor the floor couldn't prove but a solver might: every fact in scope
// plus the divisor term itself, all translatable.
export interface Obligation { facts: Fact[]; divisor: Expr; span: Span }

export interface NonZeroResult { diagnostics: Diagnostic[]; residue: Obligation[] }

export function checkNonZero(mod: Module, resolutions: ResolutionMap): NonZeroResult {
  const out: NonZeroResult = { diagnostics: [], residue: [] };
  walkDecls(mod.decls, false, resolutions, out);
  return out;
}

// The sync fallback for the residue (used by the LSP, and by the CLI when
// z3-solver is missing): each obligation as the conservative floor error.
export function residueFloorDiags(residue: Obligation[]): Diagnostic[] {
  return residue.map(o => floorError(o.divisor));
}

function walkDecls(decls: Decl[], inNonZero: boolean, resolutions: ResolutionMap, out: NonZeroResult): void {
  for (const d of decls) {
    if (d.tag === "DModule") {
      walkDecls(d.decls, inNonZero || d.proofs.includes("nonzero"), resolutions, out);
      continue;
    }
    // v1 scope: function bodies, like `handled` (SPEC §12.7).
    if (inNonZero && d.tag === "DFn")
      for (const [i, c] of d.clauses.entries())
        walkFacts(c.body, clauseEnv(d.clauses, i), (e, env) => {
          if (e.tag === "BinOp" && (e.op === "/" || e.op === "%"))
            proveDivisor(e.right, env, out);
        }, resolutions);
  }
}

// ── `proofs: [bounds]` — the out-of-range-index obligation ───────────────────
//
// Same engine, next fault: in a proved scope every LIST index read must be
// proved `0 <= i < length(xs)` (eval faults with "index out of bounds"; the
// runtime floors fractional indices, and over the reals 0 ≤ i ∧ i < len ⟹
// 0 ≤ ⌊i⌋ < len for integer len, so the real-valued proof is sound for the
// floored read). Strings are excluded (an out-of-range string index pads with
// "" — no fault to prove away) and so are dicts (a missing key is a presence
// fault, not an arithmetic one — its answer is `handled`, not `bounds`).
//
// What makes this obligation different from `nonzero` is the LENGTH SYMBOL:
// `length(xs)` on an immutable name enters the translatable fragment as an
// uninterpreted-but-congruent term — Z3 sees an Int-sorted constant `len$xs`
// with `len$xs >= 0` asserted (the builtin's actual range), so
// `xs[length(xs) - 1]` under `if length(xs) > 0` proves (Int-sortedness turns
// `> 0` into `>= 1`). Congruence is exactly why the name must be immutable
// and the callee must be THE BUILTIN (a user fn shadowing `length` is opaque
// — the resolutions map distinguishes them); a `mut` list never carries
// length facts, because a push under the fact would falsify it.
// `witness` marks a Tier-1.5 relational-witness DEMAND (infer.ts): the
// "index" is a call argument at a `Index(length(xs))`-shaped param, proved
// against the CALLER's list — the same query, different error prose.
export interface BoundsObligation { facts: Fact[]; index: Expr; obj: string; span: Span; witness?: string }

export interface BoundsResult { diagnostics: Diagnostic[]; residue: BoundsObligation[] }

export function checkBounds(mod: Module, types: Map<Expr, Type>, resolutions: ResolutionMap): BoundsResult {
  const out: BoundsResult = { diagnostics: [], residue: [] };
  walkBoundsDecls(mod.decls, false, types, resolutions, out);
  return out;
}

export function boundsFloorDiags(residue: BoundsObligation[]): Diagnostic[] {
  return residue.map(o => boundsError(o.span, o.witness
    ? `no fact proves the argument within '${o.obj}' on this path — witness '${o.witness}' demands 0 <= value < length(${o.obj})`
    : `no fact proves the index within '${o.obj}' on this path — guard it (\`if i >= 0 && i < length(${o.obj})\`)`));
}

function walkBoundsDecls(decls: Decl[], inBounds: boolean, types: Map<Expr, Type>, resolutions: ResolutionMap, out: BoundsResult): void {
  for (const d of decls) {
    if (d.tag === "DModule") {
      walkBoundsDecls(d.decls, inBounds || d.proofs.includes("bounds"), types, resolutions, out);
      continue;
    }
    if (inBounds && d.tag === "DFn")
      for (const [i, c] of d.clauses.entries())
        walkFacts(c.body, [...clauseEnv(d.clauses, i), ...witnessSeeds(c)], (e, env) => {
          const demand = WITNESS_DEMANDS.get(e);
          if (demand) proveWitnessArg(e, demand, env, out);
          if (e.tag === "Index" && e.index.tag !== "Range")
            proveIndex(e, env, types, out);
        }, resolutions);
  }
}

// ── The Tier-1.5 relational witness (north-star §3.3) ────────────────────────
//
// SEED side: a param ascribed a bounds-witness refinement — `Index(length(xs))`
// with the `0 <= value && value < n` predicate shape (infer.boundsWitnessOf) —
// ASSUMES its facts in the clause body: `i >= 0` and `i < length(xs)`. The
// callee's read then discharges with no guard. Sound within the proved region
// by assume/guarantee: every caller in a `proofs: [bounds]` scope is forced to
// DISCHARGE the same facts at the call (the demand below); a caller outside
// any proved scope keeps today's skip and can still fault the callee — the
// same standing as any unproved code, and the runtime read faults loudly.
function witnessSeeds(c: FnClause): Fact[] {
  const seeds: Fact[] = [];
  for (const param of c.params) {
    const pat = param.pat;
    if (pat.tag !== "PVar" && pat.tag !== "PTyped") continue;
    const w = boundsWitnessOf(param.ascription);
    if (!w) continue;
    const lenE: Expr = { tag: "Call", fn: varE("length", param.span),
                         args: [varE(w.listParam, param.span)], named: [], span: param.span };
    seeds.push(mkFact(varE(pat.name, param.span), ">=", numE(0, param.span)));
    seeds.push(mkFact(varE(pat.name, param.span), "<", lenE));
  }
  return seeds;
}

// DEMAND side: infer recorded this argument as flowing into a witness param
// with the caller's list substituted in (`d.obj` is null when that argument
// wasn't a bare name). Same two-sided query as a direct index read — floor,
// then Z3 — because the read it licenses happens inside the callee.
function proveWitnessArg(e: Expr, d: WitnessDemand, env: Env, out: BoundsResult): void {
  if (d.list === null) {
    out.diagnostics.push(boundsError(e.span,
      `the argument is demanded as witness '${d.ref}' but the list it indexes is not a name — bind it (\`let xs = …\`) so length facts can attach`));
    return;
  }
  const lit = numLit(e);
  if (lit !== null && lit < 0) {
    out.diagnostics.push(boundsError(e.span,
      `the literal argument ${lit} is negative — witness '${d.ref}' demands 0 <= value < length(${d.list})`));
    return;
  }
  if (entailsInBounds(env, e, d.list, lit)) return;
  if (translatable(e)) out.residue.push({ facts: env, index: e, obj: d.list, span: e.span, witness: d.ref });
  else out.diagnostics.push(boundsError(e.span,
    `the argument is demanded as witness '${d.ref}' but is not a provable term — bind it to a name and guard that`));
}

function boundsError(span: Span, detail: string): Diagnostic {
  return { kind: "error", span,
    message: `proof obligation 'bounds': cannot prove the index in range — ${detail} (the module declares proofs: [bounds])` };
}

function proveIndex(e: Extract<Expr, { tag: "Index" }>, env: Env, types: Map<Expr, Type>, out: BoundsResult): void {
  const t = types.get(e.obj);
  if (t?.tag === "Prim" && t.kind === "String") return;          // pads, never faults
  if (t?.tag === "Named" && t.name === "Dict") return;           // key presence ≠ bounds
  if (e.obj.tag !== "Var") {
    out.diagnostics.push(boundsError(e.span,
      "the list is not a name — bind it (`let xs = …`) so length facts can attach"));
    return;
  }
  const lit = numLit(e.index);
  if (lit !== null && lit < 0) {
    out.diagnostics.push(boundsError(e.index.span, `the literal index ${lit} is negative`));
    return;
  }
  if (entailsInBounds(env, e.index, e.obj.name, lit)) return;
  // The floor failed. Translatable indices go to the solver with every fact
  // in scope; the rest is a conservative error here and now.
  if (translatable(e.index)) out.residue.push({ facts: env, index: e.index, obj: e.obj.name, span: e.span });
  else out.diagnostics.push(boundsError(e.index.span,
    "the index is not a provable term — bind it to a name and guard that, or use the InBounds witness type (SPEC §7.1)"));
}

// The sync bounds floor (LSP-clean for the guarded idioms): lower side needs
// a constant fact pinning the index >= 0; upper side a direct comparison
// against length(obj) — variable `i` via `i < length(xs)`, literal `k` via a
// length fact that exceeds it. Everything subtler is Z3's job.
function entailsInBounds(env: Env, index: Expr, obj: string, lit: number | null): boolean {
  const lower = lit !== null ? lit >= 0 : index.tag === "Var" && entailsGE0(env, index.name);
  if (!lower) return false;
  for (const f of env) {
    let cmpE: Expr | null = null;
    let op = f.op;
    if (lenArg(f.lhs) === obj) { cmpE = f.rhs; op = FLIP[op]; }
    else if (lenArg(f.rhs) === obj) cmpE = f.lhs;
    if (cmpE === null) continue;
    // Normalized: cmpE `op` length(obj).
    if (index.tag === "Var" && cmpE.tag === "Var" && cmpE.name === index.name && op === "<") return true;
    const k = numLit(cmpE);
    if (lit !== null && k !== null
        && ((op === "<" && k >= lit) || (op === "<=" && k > lit) || (op === "==" && k > lit)))
      return true;  // over ℝ: length(obj) > k >= lit, or >= k > lit — either way lit < length(obj)
  }
  return false;
}

const FLIP: Record<CmpOp, CmpOp> =
  { "==": "==", "!=": "!=", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

function entailsGE0(env: Env, name: string): boolean {
  for (const f of env) {
    let op = f.op;
    let k: number | null = null;
    if (f.lhs.tag === "Var" && f.lhs.name === name) k = numLit(f.rhs);
    else if (f.rhs.tag === "Var" && f.rhs.name === name) { k = numLit(f.lhs); op = FLIP[op]; }
    if (k === null) continue;
    // Over ℝ, `i > -1` admits -0.5 (which floors to -1 and faults) — only
    // bounds at or above 0 entail the floored read's lower side.
    if ((op === ">=" && k >= 0) || (op === ">" && k >= 0) || (op === "==" && k >= 0)) return true;
  }
  return false;
}

// The reusable fact-env walk: visits EVERY expression with the fact env in
// force at that point. `proofs: [nonzero]` visits divisors; the @total Tier-2
// measure check (terminates.ts) visits recursive calls. Handles the mutation
// prepass itself, so callers just provide the seed env and a visitor.
export function walkFacts(body: Expr, env0: Env, visit: FactVisitor, resolutions?: ResolutionMap): void {
  const saved = currentVisit, savedMut = currentMutated, savedRes = currentResolutions;
  currentVisit = visit;
  currentMutated = new Set();
  currentResolutions = resolutions ?? null;
  collectMutatedDeep(body, currentMutated);
  try { walkExpr(body, env0); }
  finally { currentVisit = saved; currentMutated = savedMut; currentResolutions = savedRes; }
}

export type FactVisitor = (e: Expr, env: Env) => void;

// ── Terms ─────────────────────────────────────────────────────────────────────

// The solver-translatable fragment: names, numeric literals, + - *, unary
// minus, division by a NONZERO literal, and the length symbol `length(x)`
// on a plain name. General division is excluded (its own obligation); every
// OTHER call/field is an uninterpreted function — opaque to any solver
// (north-star §3.1 catch 2).
export function translatable(e: Expr): boolean {
  switch (e.tag) {
    case "Var": return true;
    case "Lit": return e.lit.tag === "Num";
    case "BinOp":
      if (e.op === "/" && (numLit(e.right) ?? 0) === 0) return false;
      return ["+", "-", "*", "/"].includes(e.op) && translatable(e.left) && translatable(e.right);
    case "UnOp": return e.op === "-" && translatable(e.expr);
    case "Call": return lenArg(e) !== null;
    default: return false;
  }
}

// The one interpreted call: `length(x)` where `x` is a bare name and the
// callee is THE BUILTIN — builtins resolve to no entry in the resolutions
// map (user bindings shadow first and DO get entries), so any resolution at
// all means a user `length`, which has no congruence guarantee and stays
// opaque. The argument must be a name so two occurrences denote the same
// list (and so mutation kills, via termNames).
export function lenArg(e: Expr): string | null {
  if (e.tag !== "Call" || e.fn.tag !== "Var" || e.fn.name !== "length") return null;
  if (e.args.length !== 1 || e.named.length > 0) return null;
  const a = e.args[0];
  if (!a || a.tag !== "Var") return null;
  if (currentResolutions?.get(e.fn) !== undefined) return null;
  return a.name;
}

function termNames(e: Expr, into: Set<string>): Set<string> {
  switch (e.tag) {
    case "Var": into.add(e.name); break;
    case "BinOp": termNames(e.left, into); termNames(e.right, into); break;
    case "UnOp": termNames(e.expr, into); break;
    case "Call": for (const a of e.args) termNames(a, into); break;
  }
  return into;
}

function numLit(e: Expr): number | null {
  if (e.tag === "Lit" && e.lit.tag === "Num") return e.lit.value;
  if (e.tag === "UnOp" && e.op === "-") {
    const inner = numLit(e.expr);
    return inner === null ? null : -inner;
  }
  return null;
}

// Synthesized AST nodes for facts that have no source expression (match
// literals, clause heads, bind constants).
export function varE(name: string, span: Span): Expr { return { tag: "Var", name, span }; }
export function numE(value: number, span: Span): Expr { return { tag: "Lit", lit: { tag: "Num", value }, span }; }

// ── The fact environment ──────────────────────────────────────────────────────

// Persistent: every extension copies, so sibling branches never see each
// other's facts.
export type Env = Fact[];

export function mkFact(lhs: Expr, op: CmpOp, rhs: Expr): Fact {
  return { lhs, op, rhs, names: termNames(rhs, termNames(lhs, new Set())) };
}

let currentMutated: Set<string> = new Set();
let currentVisit: FactVisitor = () => {};
let currentResolutions: ResolutionMap | null = null;

// A syntax-only sweep for mutation targets, run once per clause. Generic
// deep walk: the AST is plain data, and this only needs the two binding
// shapes, so it doesn't track scopes — over-killing a shadowed name is
// sound, just conservative.
function collectMutatedDeep(node: unknown, into: Set<string>): void {
  if (Array.isArray(node)) { for (const n of node) collectMutatedDeep(n, into); return; }
  if (node === null || typeof node !== "object") return;
  const o = node as Record<string, unknown> & { tag?: string };
  if (o.tag === "SBind") {
    const s = o as unknown as Extract<Stmt, { tag: "SBind" }>;
    if ((s.mutable || !s.declares) && (s.pat.tag === "PVar" || s.pat.tag === "PTyped"))
      into.add(s.pat.name);
  } else if (o.tag === "SAssign") {
    const s = o as unknown as Extract<Stmt, { tag: "SAssign" }>;
    if (s.target.tag === "Var") into.add(s.target.name);
  }
  for (const k of Object.keys(o)) if (k !== "span") collectMutatedDeep(o[k], into);
}

function addFact(env: Env, f: Fact): Env {
  for (const n of f.names) if (currentMutated.has(n)) return env;
  return [...env, f];
}

// A (re)binding: every fact mentioning the old `name` is about a value that
// name no longer holds.
function kill(env: Env, name: string): Env {
  return env.some(f => f.names.has(name)) ? env.filter(f => !f.names.has(name)) : env;
}

function killPat(env: Env, p: Pat): Env {
  switch (p.tag) {
    case "PVar": case "PTyped": return kill(env, p.name);
    case "PCtor": return p.inner ? killPat(env, p.inner) : env;
    case "PTuple": return p.elems.reduce(killPat, env);
    case "PRecord": return p.fields.reduce((e, f) => killPat(e, f.pat), env);
    default: return env;
  }
}

const NEGATE: Record<CmpOp, CmpOp> =
  { "==": "!=", "!=": "==", "<": ">=", ">=": "<", ">": "<=", "<=": ">" };

// Extend `env` with what `cond` being `positive` says. Only the conjunctive
// direction is kept: a disjunction tells us nothing usable on its true side,
// so it adds facts only when negated.
function factsFromCond(cond: Expr, positive: boolean, env: Env): Env {
  if (cond.tag === "UnOp" && (cond.op === "!" || cond.op === "not"))
    return factsFromCond(cond.expr, !positive, env);
  if (cond.tag === "BinOp" && cond.op === "&&")
    return positive
      ? factsFromCond(cond.right, true, factsFromCond(cond.left, true, env))
      : env;
  if (cond.tag === "BinOp" && cond.op === "||")
    return positive
      ? env
      : factsFromCond(cond.right, false, factsFromCond(cond.left, false, env));
  if (cond.tag === "BinOp" && cond.op in NEGATE
      && translatable(cond.left) && translatable(cond.right)) {
    const op = cond.op as CmpOp;
    return addFact(env, mkFact(cond.left, positive ? op : NEGATE[op], cond.right));
  }
  return env;
}

// The interval floor: does some constant fact about `name` rule out zero?
function entailsNonZero(env: Env, name: string): boolean {
  for (const f of env) {
    let op = f.op;
    let k: number | null = null;
    if (f.lhs.tag === "Var" && f.lhs.name === name) k = numLit(f.rhs);
    else if (f.rhs.tag === "Var" && f.rhs.name === name) {
      k = numLit(f.lhs);
      op = ({ "==": "==", "!=": "!=", "<": ">", ">": "<", "<=": ">=", ">=": "<=" } as const)[op];
    }
    if (k === null) continue;
    if ((op === "!=" && k === 0) || (op === "==" && k !== 0) ||
        (op === ">"  && k >= 0)  || (op === ">=" && k > 0)  ||
        (op === "<"  && k <= 0)  || (op === "<=" && k < 0)) return true;
  }
  return false;
}

// ── Clause-head facts ─────────────────────────────────────────────────────────

// Params of clause `i`, plus the negative facts earlier literal clauses leave
// behind: if every other param of an earlier clause is irrefutable, that
// clause WOULD have matched whenever position p held its literal — so by
// clause `i`, position p's binder can't be that value.
export function clauseEnv(clauses: FnClause[], i: number): Env {
  let env: Env = [];
  const params = clauses[i]?.params ?? [];
  for (const [p, param] of params.entries()) {
    const pat = param.pat;
    if (pat.tag !== "PVar" && pat.tag !== "PTyped") continue;
    for (const prior of clauses.slice(0, i).map(c => c.params)) {
      if (prior.length !== params.length) continue;
      const lit = prior[p]?.pat;
      if (!(lit?.tag === "PLit" && lit.lit.tag === "Num")) continue;
      const othersIrrefutable = prior.every((q, qi) =>
        qi === p || q.pat.tag === "PVar" || q.pat.tag === "PTyped" || q.pat.tag === "PWild");
      if (othersIrrefutable)
        env = addFact(env, mkFact(varE(pat.name, pat.span), "!=", numE(lit.lit.value, pat.span)));
    }
  }
  return env;
}

// ── The walk ──────────────────────────────────────────────────────────────────

function floorError(d: Expr): Diagnostic {
  const hint = d.tag === "Var"
    ? `no fact proves '${d.name}' nonzero on this path — guard it (\`if ${d.name} == 0\`, or match on 0)`
    : "the divisor is not a provable term — bind it to a name and guard that, or use the NonZero witness type (SPEC §7.1)";
  return { kind: "error", span: d.span,
    message: `proof obligation 'nonzero': cannot prove the divisor nonzero — ${hint} (the module declares proofs: [nonzero])` };
}

function proveDivisor(d: Expr, env: Env, out: NonZeroResult): void {
  const lit = numLit(d);
  if (lit !== null) {
    if (lit === 0)
      out.diagnostics.push({ kind: "error", span: d.span,
        message: "proof obligation 'nonzero': division by the literal 0 (the module declares proofs: [nonzero])" });
    return;
  }
  if (d.tag === "Var" && entailsNonZero(env, d.name)) return;
  // The floor failed. Translatable divisors go to the solver with every fact
  // in scope; the rest is a conservative error here and now.
  if (translatable(d)) out.residue.push({ facts: env, divisor: d, span: d.span });
  else out.diagnostics.push(floorError(d));
}

function walkBranch(subject: Expr, b: Branch, negatives: Fact[], env: Env): void {
  let inner = env;
  const subjName = subject.tag === "Var" ? subject.name : null;
  const pat = b.pat;
  if (pat.tag === "PLit" && pat.lit.tag === "Num" && subjName !== null) {
    inner = addFact(inner, mkFact(varE(subjName, pat.span), "==", numE(pat.lit.value, pat.span)));
  } else if (pat.tag === "PVar" || pat.tag === "PTyped") {
    // Fall-through rebind: the new name holds the subject's value, which by
    // now is none of the literals matched above (a rebind of the same name
    // composes — kill first, then re-spell the negatives on the binder).
    inner = kill(inner, pat.name);
    for (const f of negatives)
      inner = addFact(inner, mkFact(varE(pat.name, pat.span), f.op, f.rhs));
    if (subjName !== null && subjName !== pat.name && translatable(subject))
      inner = addFact(inner, mkFact(varE(pat.name, pat.span), "==", subject));
  } else if (pat.tag === "PWild") {
    if (subjName !== null) for (const f of negatives) inner = addFact(inner, f);
  } else {
    inner = killPat(inner, pat);  // ctor/tuple/record binders carry no facts
    // Return-gate SEED: `match gate(xs, i) | Ok(j) -> …` — the gate's signature
    // `Result(Index(length(xs)), e)` proved `0 <= j < length(xs)` on its Ok
    // path (the callee guarantee), so the binder carries those facts and the
    // licensed read `xs[j]` needs no guard in the caller.
    const ret = WITNESS_RETURNS.get(subject);
    if (ret && ret.list !== null && pat.tag === "PCtor" && pat.name === "Ok"
        && pat.inner && (pat.inner.tag === "PVar" || pat.inner.tag === "PTyped")) {
      const lenE: Expr = { tag: "Call", fn: varE("length", pat.span),
                           args: [varE(ret.list, pat.span)], named: [], span: pat.span };
      inner = addFact(inner, mkFact(varE(pat.inner.name, pat.span), ">=", numE(0, pat.span)));
      inner = addFact(inner, mkFact(varE(pat.inner.name, pat.span), "<", lenE));
    }
  }
  if (b.guard) {
    walkExpr(b.guard, inner);
    inner = factsFromCond(b.guard, true, inner);
  }
  walkExpr(b.body, inner);
}

function walkExpr(e: Expr, env: Env): void {
  currentVisit(e, env);
  switch (e.tag) {
    case "Lit": case "Var": case "JSExpr": case "Continue": case "Machine":
      return;
    case "BinOp":
      walkExpr(e.left, env);
      walkExpr(e.right, env);
      return;
    case "If": {
      walkExpr(e.cond, env);
      walkExpr(e.then, factsFromCond(e.cond, true, env));
      if (e.else_) walkExpr(e.else_, factsFromCond(e.cond, false, env));
      return;
    }
    case "Match": case "Await": {
      const subject = e.tag === "Match" ? e.subject : e.expr;
      walkExpr(subject, env);
      const subjName = subject.tag === "Var" ? subject.name : null;
      const negatives: Fact[] = [];
      for (const b of e.branches) {
        walkBranch(subject, b, negatives, env);
        if (b.pat.tag === "PLit" && b.pat.lit.tag === "Num" && !b.guard && subjName !== null)
          negatives.push(mkFact(varE(subjName, b.pat.span), "!=", numE(b.pat.lit.value, b.pat.span)));
      }
      return;
    }
    case "Do": case "Loop": case "Try": case "Transaction": case "Retry": {
      if (e.tag === "Retry") { if (e.count) walkExpr(e.count, env); if (e.delay) walkExpr(e.delay, env); }
      if (e.tag === "Transaction" && e.config) walkExpr(e.config, env);
      const stmts = e.tag === "Transaction" ? e.body : e.stmts;
      let cur = env;
      for (const s of stmts) cur = walkStmt(s, cur);
      return;
    }
    case "For": {
      let cur = env;
      for (const c of e.clauses) {
        if (c.tag === "Gen") { walkExpr(c.iter, cur); cur = killPat(cur, c.binding); }
        else { walkExpr(c.cond, cur); cur = factsFromCond(c.cond, true, cur); }
      }
      walkExpr(e.body, cur);
      return;
    }
    case "Lambda": {
      // Facts on enclosing immutable names survive into the body (the name
      // can't change between the test and any later call); the lambda's own
      // params shadow.
      walkExpr(e.body, e.params.reduce((env2, p) => killPat(env2, p.pat), env));
      return;
    }
    case "Call":
      walkExpr(e.fn, env);
      for (const a of e.args) walkExpr(a, env);
      for (const n of e.named) walkExpr(n.value, env);
      return;
    case "UnOp": case "Propagate": case "Go": case "Resume": case "Drop":
    case "AddrOf": case "Deref":
      return walkExpr(e.expr, env);
    case "PropWith":
      walkExpr(e.expr, env); walkExpr(e.alt, env); return;
    case "Field": return walkExpr(e.obj, env);
    case "Index":
      walkExpr(e.obj, env); walkExpr(e.index, env); return;
    case "Range":
      walkExpr(e.from, env); walkExpr(e.to, env); return;
    case "Tuple": case "List":
      for (const el of e.elems) walkExpr(el, env); return;
    case "Record":
      for (const f of e.fields) walkExpr(f.value, env);
      if (e.spread) walkExpr(e.spread, env);
      return;
    case "TypeTest": return walkExpr(e.expr, env);
    case "Element": {
      if (e.content) walkExpr(e.content, env);
      for (const p of e.props) walkExpr(p.value, env);
      for (const c of e.children) walkExpr(c, env);
      return;
    }
    case "Handler":
      return walkExpr(e.body, e.param ? kill(env, e.param) : env);
    case "Break":
      if (e.value) walkExpr(e.value, env);
      return;
    case "Send": return walkExpr(e.msg, env);
  }
}

// Returns the env the NEXT statement sees: a plain `let` adds an equality
// fact when the value is translatable; `mut`/reassignment kills.
function walkStmt(s: Stmt, env: Env): Env {
  switch (s.tag) {
    case "SBind": {
      walkExpr(s.value, env);
      let next = killPat(env, s.pat);
      if ((s.pat.tag === "PVar" || s.pat.tag === "PTyped")
          && !s.mutable && s.declares && translatable(s.value)
          && !termNames(s.value, new Set()).has(s.pat.name))
        next = addFact(next, mkFact(varE(s.pat.name, s.pat.span), "==", s.value));
      return next;
    }
    case "SExpr": walkExpr(s.expr, env); return env;
    case "SAssign": {
      walkExpr(s.value, env);
      // A write through `xs[i] =` / `p.* =` can't invalidate name facts;
      // a bare-name target would be SBind. Still: be safe on Var targets.
      return s.target.tag === "Var" ? kill(env, s.target.name) : env;
    }
    case "SBreak": case "SReturn":
      if (s.value) walkExpr(s.value, env);
      return env;
  }
}
