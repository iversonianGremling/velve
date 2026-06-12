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
import type { Diagnostic } from "./resolve.js";

export type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";

// A comparison between two TRANSLATABLE terms (see `translatable`). `names`
// caches every name mentioned, for mutation kills.
export interface Fact { lhs: Expr; op: CmpOp; rhs: Expr; names: Set<string> }

// A divisor the floor couldn't prove but a solver might: every fact in scope
// plus the divisor term itself, all translatable.
export interface Obligation { facts: Fact[]; divisor: Expr; span: Span }

export interface NonZeroResult { diagnostics: Diagnostic[]; residue: Obligation[] }

export function checkNonZero(mod: Module): NonZeroResult {
  const out: NonZeroResult = { diagnostics: [], residue: [] };
  walkDecls(mod.decls, false, out);
  return out;
}

// The sync fallback for the residue (used by the LSP, and by the CLI when
// z3-solver is missing): each obligation as the conservative floor error.
export function residueFloorDiags(residue: Obligation[]): Diagnostic[] {
  return residue.map(o => floorError(o.divisor));
}

function walkDecls(decls: Decl[], inNonZero: boolean, out: NonZeroResult): void {
  for (const d of decls) {
    if (d.tag === "DModule") {
      walkDecls(d.decls, inNonZero || d.proofs.includes("nonzero"), out);
      continue;
    }
    // v1 scope: function bodies, like `handled` (SPEC §12.7).
    if (inNonZero && d.tag === "DFn")
      for (const [i, c] of d.clauses.entries())
        walkFacts(c.body, clauseEnv(d.clauses, i), (e, env) => {
          if (e.tag === "BinOp" && (e.op === "/" || e.op === "%"))
            proveDivisor(e.right, env, out);
        });
  }
}

// The reusable fact-env walk: visits EVERY expression with the fact env in
// force at that point. `proofs: [nonzero]` visits divisors; the @total Tier-2
// measure check (terminates.ts) visits recursive calls. Handles the mutation
// prepass itself, so callers just provide the seed env and a visitor.
export function walkFacts(body: Expr, env0: Env, visit: FactVisitor): void {
  const saved = currentVisit, savedMut = currentMutated;
  currentVisit = visit;
  currentMutated = new Set();
  collectMutatedDeep(body, currentMutated);
  try { walkExpr(body, env0); } finally { currentVisit = saved; currentMutated = savedMut; }
}

export type FactVisitor = (e: Expr, env: Env) => void;

// ── Terms ─────────────────────────────────────────────────────────────────────

// The solver-translatable fragment: names, numeric literals, + - *, unary
// minus, and division by a NONZERO literal. General division is excluded
// (its own obligation); calls/fields are uninterpreted functions — opaque to
// any solver (north-star §3.1 catch 2).
export function translatable(e: Expr): boolean {
  switch (e.tag) {
    case "Var": return true;
    case "Lit": return e.lit.tag === "Num";
    case "BinOp":
      if (e.op === "/" && (numLit(e.right) ?? 0) === 0) return false;
      return ["+", "-", "*", "/"].includes(e.op) && translatable(e.left) && translatable(e.right);
    case "UnOp": return e.op === "-" && translatable(e.expr);
    default: return false;
  }
}

function termNames(e: Expr, into: Set<string>): Set<string> {
  switch (e.tag) {
    case "Var": into.add(e.name); break;
    case "BinOp": termNames(e.left, into); termNames(e.right, into); break;
    case "UnOp": termNames(e.expr, into); break;
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
