// `proofs: [nonzero]` — the partial-arithmetic obligation (SPEC §12.7,
// north-star §3.4). Forbids the divisor fault: in a proved scope, every `/`
// and `%` must have a divisor the checker can PROVE nonzero. At runtime the
// fault is silent — `x / 0` is JS division, so it poisons the result with
// Infinity/NaN instead of crashing — which is exactly why it wants a static
// obligation: there is no error to handle.
//
// The discharge engine is the FLOW-SENSITIVE FACT ENVIRONMENT (north-star
// §3.1 catch 1): comparison-to-constant facts about names, collected from the
// branch structure the value already flowed through —
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
// and any reassignment kills them — a fact is a statement about a value, and
// it survives precisely because the binding cannot change under it (which is
// also why a fact established outside a lambda still holds inside it: the
// name is frozen at the test, however late the lambda runs).
//
// Entailment is the no-solver interval floor: a divisor passes iff it is a
// nonzero literal or a name with a fact among {!= 0, == k≠0, > k≥0, ≥ k>0,
// < k≤0, ≤ k<0}. Compound divisors (`a - b` even under `a != b`), facts
// through calls/projections (`nzValue(d)`), and name-vs-name comparisons are
// conservative errors — that residue is exactly Tier 2's Z3 fall-through
// (north-star §3.3), pinned in `proof_nonzero_bad.velve`.
//
// Like `exhaustive` and `handled` — and unlike `total` — this obligation is
// SCOPE-LOCAL: the fault is syntactic to the proved scope, so there is no
// downward call gate. A callee outside the module may still divide unsafely;
// what `nonzero` proves is that THIS module's divisors can't be zero.
import type { Module, Decl, Expr, Stmt, Pat, Branch, FnClause } from "./ast.js";
import type { Diagnostic } from "./resolve.js";

export function checkNonZero(mod: Module): Diagnostic[] {
  const diags: Diagnostic[] = [];
  walkDecls(mod.decls, false, diags);
  return diags;
}

function walkDecls(decls: Decl[], inNonZero: boolean, diags: Diagnostic[]): void {
  for (const d of decls) {
    if (d.tag === "DModule") {
      walkDecls(d.decls, inNonZero || d.proofs.includes("nonzero"), diags);
      continue;
    }
    // v1 scope: function bodies, like `handled` (SPEC §12.7).
    if (inNonZero && d.tag === "DFn")
      for (const [i, c] of d.clauses.entries())
        walkExpr(c.body, clauseEnv(d.clauses, i), diags);
  }
}

// ── The fact environment ──────────────────────────────────────────────────────

type CmpOp = "==" | "!=" | "<" | "<=" | ">" | ">=";
interface Fact { op: CmpOp; k: number }
// name -> facts. Persistent: every extension copies, so sibling branches
// never see each other's facts.
type Env = Map<string, Fact[]>;

function addFact(env: Env, name: string, f: Fact): Env {
  const next = new Map(env);
  next.set(name, [...(env.get(name) ?? []), f]);
  return next;
}

// A (re)binding: whatever was known about the old `name` is gone.
function kill(env: Env, name: string): Env {
  if (!env.has(name)) return env;
  const next = new Map(env);
  next.delete(name);
  return next;
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
const FLIP: Record<CmpOp, CmpOp> =      // k < x  ≡  x > k
  { "==": "==", "!=": "!=", "<": ">", ">": "<", "<=": ">=", ">=": "<=" };

function numLit(e: Expr): number | null {
  if (e.tag === "Lit" && e.lit.tag === "Num") return e.lit.value;
  if (e.tag === "UnOp" && e.op === "-") {
    const inner = numLit(e.expr);
    return inner === null ? null : -inner;
  }
  return null;
}

// Extend `env` with what `cond` being `positive` says about names. Only the
// conjunctive direction is kept: a disjunction tells us nothing usable on its
// true side, so it adds facts only when negated.
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
  if (cond.tag === "BinOp" && cond.op in NEGATE) {
    let name: string | null = null;
    let op = cond.op as CmpOp;
    let k: number | null = null;
    if (cond.left.tag === "Var" && (k = numLit(cond.right)) !== null) {
      name = cond.left.name;
    } else if (cond.right.tag === "Var" && (k = numLit(cond.left)) !== null) {
      name = cond.right.name;
      op = FLIP[op];
    }
    if (name === null || k === null) return env;
    return addFact(env, name, { op: positive ? op : NEGATE[op], k });
  }
  return env;
}

function entailsNonZero(facts: Fact[] | undefined): boolean {
  if (!facts) return false;
  return facts.some(f =>
    (f.op === "!=" && f.k === 0) ||
    (f.op === "==" && f.k !== 0) ||
    (f.op === ">"  && f.k >= 0) ||
    (f.op === ">=" && f.k > 0)  ||
    (f.op === "<"  && f.k <= 0) ||
    (f.op === "<=" && f.k < 0));
}

// ── Clause-head facts ─────────────────────────────────────────────────────────

// Params of clause `i`, plus the negative facts earlier literal clauses leave
// behind: if every other param of an earlier clause is irrefutable, that
// clause WOULD have matched whenever position p held its literal — so by
// clause `i`, position p's binder can't be that value.
function clauseEnv(clauses: FnClause[], i: number): Env {
  let env: Env = new Map();
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
        env = addFact(env, pat.name, { op: "!=", k: lit.lit.value });
    }
  }
  return env;
}

// ── The walk ──────────────────────────────────────────────────────────────────

function proveDivisor(d: Expr, env: Env, diags: Diagnostic[]): void {
  const lit = numLit(d);
  if (lit !== null) {
    if (lit === 0)
      diags.push({ kind: "error", span: d.span,
        message: "proof obligation 'nonzero': division by the literal 0 (the module declares proofs: [nonzero])" });
    return;
  }
  if (d.tag === "Var" && entailsNonZero(env.get(d.name))) return;
  const hint = d.tag === "Var"
    ? `no fact proves '${d.name}' nonzero on this path — guard it (\`if ${d.name} == 0\`, or match on 0)`
    : "the divisor is not a guarded name — bind it to a name and guard that (compound divisors are Tier 2's Z3 fall-through, north-star §3.3)";
  diags.push({ kind: "error", span: d.span,
    message: `proof obligation 'nonzero': cannot prove the divisor nonzero — ${hint} (the module declares proofs: [nonzero])` });
}

function walkBranch(subject: Expr, b: Branch, negatives: Fact[], env: Env, diags: Diagnostic[]): void {
  let inner = env;
  const subjName = subject.tag === "Var" ? subject.name : null;
  const pat = b.pat;
  if (pat.tag === "PLit" && pat.lit.tag === "Num" && subjName !== null) {
    inner = addFact(inner, subjName, { op: "==", k: pat.lit.value });
  } else if (pat.tag === "PVar" || pat.tag === "PTyped") {
    // Fall-through rebind: the new name holds the subject's value, which by
    // now is none of the literals matched above (a rebind of the same name
    // composes — kill first, then the accumulated negatives).
    inner = kill(inner, pat.name);
    for (const f of negatives) inner = addFact(inner, pat.name, f);
  } else if (pat.tag === "PWild") {
    if (subjName !== null) for (const f of negatives) inner = addFact(inner, subjName, f);
  } else {
    inner = killPat(inner, pat);  // ctor/tuple/record binders carry no facts
  }
  if (b.guard) {
    walkExpr(b.guard, inner, diags);
    inner = factsFromCond(b.guard, true, inner);
  }
  walkExpr(b.body, inner, diags);
}

function walkExpr(e: Expr, env: Env, diags: Diagnostic[]): void {
  switch (e.tag) {
    case "Lit": case "Var": case "JSExpr": case "Continue": case "Machine":
      return;
    case "BinOp":
      walkExpr(e.left, env, diags);
      walkExpr(e.right, env, diags);
      if (e.op === "/" || e.op === "%") proveDivisor(e.right, env, diags);
      return;
    case "If": {
      walkExpr(e.cond, env, diags);
      walkExpr(e.then, factsFromCond(e.cond, true, env), diags);
      if (e.else_) walkExpr(e.else_, factsFromCond(e.cond, false, env), diags);
      return;
    }
    case "Match": case "Await": {
      const subject = e.tag === "Match" ? e.subject : e.expr;
      walkExpr(subject, env, diags);
      const negatives: Fact[] = [];
      for (const b of e.branches) {
        walkBranch(subject, b, negatives, env, diags);
        if (b.pat.tag === "PLit" && b.pat.lit.tag === "Num" && !b.guard)
          negatives.push({ op: "!=", k: b.pat.lit.value });
      }
      return;
    }
    case "Do": case "Loop": case "Try": case "Transaction": case "Retry": {
      if (e.tag === "Retry") { if (e.count) walkExpr(e.count, env, diags); if (e.delay) walkExpr(e.delay, env, diags); }
      if (e.tag === "Transaction" && e.config) walkExpr(e.config, env, diags);
      const stmts = e.tag === "Transaction" || e.tag === "Retry" ? (e.tag === "Transaction" ? e.body : e.stmts) : e.stmts;
      let cur = env;
      for (const s of stmts) cur = walkStmt(s, cur, diags);
      return;
    }
    case "For": {
      let cur = env;
      for (const c of e.clauses) {
        if (c.tag === "Gen") { walkExpr(c.iter, cur, diags); cur = killPat(cur, c.binding); }
        else { walkExpr(c.cond, cur, diags); cur = factsFromCond(c.cond, true, cur); }
      }
      walkExpr(e.body, cur, diags);
      return;
    }
    case "Lambda": {
      // Facts on enclosing immutable names survive into the body (the name
      // can't change between the test and any later call); the lambda's own
      // params shadow.
      walkExpr(e.body, e.params.reduce((env2, p) => killPat(env2, p.pat), env), diags);
      return;
    }
    case "Call":
      walkExpr(e.fn, env, diags);
      for (const a of e.args) walkExpr(a, env, diags);
      for (const n of e.named) walkExpr(n.value, env, diags);
      return;
    case "UnOp": case "Propagate": case "Go": case "Resume": case "Drop":
    case "AddrOf": case "Deref":
      return walkExpr(e.expr, env, diags);
    case "PropWith":
      walkExpr(e.expr, env, diags); walkExpr(e.alt, env, diags); return;
    case "Field": return walkExpr(e.obj, env, diags);
    case "Index":
      walkExpr(e.obj, env, diags); walkExpr(e.index, env, diags); return;
    case "Range":
      walkExpr(e.from, env, diags); walkExpr(e.to, env, diags); return;
    case "Tuple": case "List":
      for (const el of e.elems) walkExpr(el, env, diags); return;
    case "Record":
      for (const f of e.fields) walkExpr(f.value, env, diags);
      if (e.spread) walkExpr(e.spread, env, diags);
      return;
    case "TypeTest": return walkExpr(e.expr, env, diags);
    case "Element": {
      if (e.content) walkExpr(e.content, env, diags);
      for (const p of e.props) walkExpr(p.value, env, diags);
      for (const c of e.children) walkExpr(c, env, diags);
      return;
    }
    case "Handler":
      return walkExpr(e.body, e.param ? kill(env, e.param) : env, diags);
    case "Break":
      if (e.value) walkExpr(e.value, env, diags);
      return;
    case "Send": return walkExpr(e.msg, env, diags);
  }
}

// Returns the env the NEXT statement sees: a bind adds alias/literal facts
// for plain `let`, kills for `mut`/reassignment.
function walkStmt(s: Stmt, env: Env, diags: Diagnostic[]): Env {
  switch (s.tag) {
    case "SBind": {
      walkExpr(s.value, env, diags);
      let next = killPat(env, s.pat);
      if (s.pat.tag === "PVar" || s.pat.tag === "PTyped") {
        if (!s.mutable && s.declares) {
          const k = numLit(s.value);
          if (k !== null) next = addFact(next, s.pat.name, { op: "==", k });
          else if (s.value.tag === "Var" && env.has(s.value.name))
            next = new Map(next).set(s.pat.name, env.get(s.value.name)!);  // alias copies facts
        }
      }
      return next;
    }
    case "SExpr": walkExpr(s.expr, env, diags); return env;
    case "SAssign": {
      walkExpr(s.value, env, diags);
      // A write through `xs[i] =` / `p.* =` can't invalidate name facts;
      // a bare-name target would be SBind. Still: be safe on Var targets.
      return s.target.tag === "Var" ? kill(env, s.target.name) : env;
    }
    case "SBreak": case "SReturn":
      if (s.value) walkExpr(s.value, env, diags);
      return env;
  }
}
