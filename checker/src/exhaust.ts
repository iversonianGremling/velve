import type { Span } from "./span.js";
import type { Module, Expr, Stmt, Pat, Branch } from "./ast.js";
import type { Type } from "./types.js";
import type { Diagnostic } from "./resolve.js";
import { type Edition, atLeast } from "./edition.js";

// ── Type definition map ───────────────────────────────────────────────────────

interface CtorInfo {
  name: string;
  hasPayload: boolean;
}

type TypeDefMap = Map<string, CtorInfo[]>;

function buildTypeDefs(mod: Module): TypeDefMap {
  const map: TypeDefMap = new Map();
  map.set("Result", [{ name: "Ok", hasPayload: true }, { name: "Error", hasPayload: true }]);
  // The closed transaction-outcome ADT (commit/abort + concurrency). Renamed in
  // edition 2026.6: `TxResult`/`Ok`/`Error` → `Outcome`/`Committed`/`Aborted`. Both
  // type names are registered so a match is exhaustiveness-checked under whichever
  // edition produced the scrutinee type (transaction inference picks the name).
  map.set("TxResult", [
    { name: "Ok", hasPayload: true }, { name: "Error", hasPayload: true },
    { name: "Conflict", hasPayload: true }, { name: "Timeout", hasPayload: true },
    { name: "Cancelled", hasPayload: false },
  ]);
  map.set("Outcome", [
    { name: "Committed", hasPayload: true }, { name: "Aborted", hasPayload: true },
    { name: "Conflict", hasPayload: true }, { name: "Timeout", hasPayload: true },
    { name: "Cancelled", hasPayload: false },
  ]);
  // Layout `Length` — closed unit ADT.
  map.set("Length", [
    { name: "Px", hasPayload: true }, { name: "Fr", hasPayload: true },
    { name: "Pct", hasPayload: true }, { name: "Fit", hasPayload: false },
    { name: "Fill", hasPayload: false }, { name: "Clamp", hasPayload: true },
  ]);
  // Layout `Breakpoint` — closed responsive variant (§9.2).
  map.set("Breakpoint", [
    { name: "Mobile", hasPayload: false }, { name: "Tablet", hasPayload: false },
    { name: "Desktop", hasPayload: false }, { name: "Wide", hasPayload: false },
  ]);
  // State taxonomy (§12) — closed interaction + content-state variants.
  map.set("Interaction", [
    { name: "Idle", hasPayload: false }, { name: "Hovered", hasPayload: false },
    { name: "Focused", hasPayload: false }, { name: "Pressed", hasPayload: false },
    { name: "Dragged", hasPayload: false }, { name: "Disabled", hasPayload: false },
  ]);
  map.set("UIState", [
    { name: "Empty", hasPayload: false }, { name: "Loading", hasPayload: false },
    { name: "Partial", hasPayload: false }, { name: "Failed", hasPayload: false },
    { name: "Ideal", hasPayload: false },
  ]);
  map.set("Toggle", [
    { name: "Off", hasPayload: false }, { name: "On", hasPayload: false },
    { name: "Mixed", hasPayload: false },
  ]);
  map.set("Validity", [
    { name: "Valid", hasPayload: false }, { name: "Invalid", hasPayload: false },
    { name: "Pending", hasPayload: false },
  ]);
  buildTypeDefs2(mod.decls, map);
  return map;
}

function buildTypeDefs2(decls: import("./ast.js").Decl[], map: TypeDefMap): void {
  for (const decl of decls) {
    if (decl.tag === "DType" && decl.body.tag === "TBAdt") {
      map.set(decl.name, decl.body.variants.map(v => ({ name: v.name, hasPayload: v.payload !== null })));
    }
    if (decl.tag === "DModule") buildTypeDefs2(decl.decls, map);
  }
}

// ── Public API ────────────────────────────────────────────────────────────────

export function checkExhaustiveness(
  mod: Module,
  types: Map<Expr, Type>,
): Diagnostic[] {
  const typedefs = buildTypeDefs(mod);
  const diags: Diagnostic[] = [];

  walkDecls(mod.decls, types, typedefs, diags);
  checkClauseHeads(mod.decls, typedefs, diags, mod.edition);
  return diags;
}

// ── 1c. Multi-clause head exhaustiveness (edition-gated) ──────────────────────
//
// A multi-clause function `def f(High) … / def f(Medium) …` dispatches on a
// parameter by constructor. If the clause heads at a constructor-dispatch position
// don't cover every constructor of that position's ADT — and no clause has a
// catch-all (binder/wildcard) there — then calling `f` with the missing
// constructor has no matching clause: a runtime "no clause" failure the type
// system should catch. Warning in baseline 2026.1, error in 2026.6 (SPEC §17).
//
// SAFE SUBSET (zero corpus false positives by construction):
//   • only positions where every head is a `PCtor` or a catch-all are considered —
//     atom / literal / record / tuple dispatch is skipped (no atom-union modelling);
//   • the dispatch ADT is recovered from the head constructor names, and only when
//     they belong to *exactly one* known ADT (shared ctors like `Ok`/`Error`, which
//     sit in both `Result` and `TxResult`, are ambiguous → skipped);
//   • a missing constructor at any position with no catch-all there is *always* a
//     genuine gap (independent of the other positions), so per-position checking
//     never over-reports — it can only under-report correlated multi-axis dispatch.
function checkClauseHeads(
  decls: import("./ast.js").Decl[],
  td: TypeDefMap,
  diags: Diagnostic[],
  edition: Edition,
): void {
  for (const decl of decls) {
    if (decl.tag === "DModule") { checkClauseHeads(decl.decls, td, diags, edition); continue; }
    if (decl.tag !== "DFn" || decl.clauses.length < 2) continue;

    const arity = decl.clauses[0]!.params.length;
    if (arity === 0) continue;
    // All clauses must share arity to line params up positionally.
    if (!decl.clauses.every(c => c.params.length === arity)) continue;

    for (let i = 0; i < arity; i++) {
      const pats = decl.clauses.map(c => c.params[i]!.pat);
      const ctorNames = pats.flatMap(p => (p.tag === "PCtor" ? [p.name] : []));
      if (ctorNames.length === 0) continue;                       // not a ctor dispatch
      // Every head here must be a PCtor or a catch-all; anything else (atom/literal/
      // record/tuple) is outside the safe subset.
      if (pats.some(p => p.tag !== "PCtor" && !isWildcard(p))) continue;
      // A catch-all binder/wildcard at this position covers every constructor.
      if (pats.some(isWildcard)) continue;

      const adt = adtForCtors(ctorNames, td);
      if (!adt) continue;                                          // unknown / ambiguous
      const covered = new Set(pats.flatMap(topLevelCtors));
      const missing = td.get(adt)!.filter(c => !covered.has(c.name)).map(c => c.name);
      if (missing.length === 0) continue;

      const deprecated = atLeast(edition, "2026.6");
      const where = arity > 1 ? `parameter ${i + 1} (${adt})` : `the ${adt} argument`;
      const base = `non-exhaustive clause heads for '${decl.name}' — ${where} missing: ${missing.join(", ")}`;
      diags.push({
        kind: deprecated ? "error" : "warning",
        span: decl.span,
        message: deprecated ? base : `${base} (rejected from edition 2026.6)`,
      });
    }
  }
}

// The single ADT whose constructor set contains every given head name. Returns null
// when no ADT fits, or when the names fit more than one (ambiguous) — either way we
// stay silent so the check never produces a false positive.
function adtForCtors(names: string[], td: TypeDefMap): string | null {
  let found: string | null = null;
  for (const [adt, ctors] of td) {
    const set = new Set(ctors.map(c => c.name));
    if (names.every(n => set.has(n))) {
      if (found) return null;     // names fit >1 ADT — ambiguous
      found = adt;
    }
  }
  return found;
}

function walkDecls(decls: import("./ast.js").Decl[], types: Map<Expr, Type>, td: TypeDefMap, diags: Diagnostic[]): void {
  for (const decl of decls) {
    if (decl.tag === "DFn") {
      for (const clause of decl.clauses) walkExpr(clause.body, types, td, diags);
    } else if (decl.tag === "DModule") {
      buildTypeDefs2(decl.decls, td);
      walkDecls(decl.decls, types, td, diags);
    }
  }
}

// ── AST walker ────────────────────────────────────────────────────────────────

function walkExpr(expr: Expr, types: Map<Expr, Type>, td: TypeDefMap, diags: Diagnostic[]): void {
  switch (expr.tag) {

    case "Match":
      checkMatch(expr, types, td, diags);
      walkExpr(expr.subject, types, td, diags);
      for (const b of expr.branches) walkBranch(b, types, td, diags);
      break;

    case "Await":
      walkExpr(expr.expr, types, td, diags);
      if (expr.branches.length > 0) {
        checkBranchSet(expr.branches, types.get(expr.expr), expr.span, types, td, diags);
      }
      break;

    case "Call":
      walkExpr(expr.fn, types, td, diags);
      for (const a of expr.args) walkExpr(a, types, td, diags);
      break;

    case "BinOp":   walkExpr(expr.left, types, td, diags); walkExpr(expr.right, types, td, diags); break;
    case "UnOp":    walkExpr(expr.expr, types, td, diags); break;
    case "Field":   walkExpr(expr.obj, types, td, diags); break;
    case "Index":   walkExpr(expr.obj, types, td, diags); walkExpr(expr.index, types, td, diags); break;
    case "If":      walkExpr(expr.cond, types, td, diags); walkExpr(expr.then, types, td, diags); if (expr.else_) walkExpr(expr.else_, types, td, diags); break;
    case "Lambda":  walkExpr(expr.body, types, td, diags); break;
    case "Propagate": walkExpr(expr.expr, types, td, diags); break;
    case "PropWith":  walkExpr(expr.expr, types, td, diags); walkExpr(expr.alt, types, td, diags); break;
    case "Tuple":   for (const e of expr.elems)   walkExpr(e, types, td, diags); break;
    case "List":    for (const e of expr.elems)   walkExpr(e, types, td, diags); break;
    case "Record":  for (const f of expr.fields)  walkExpr(f.value, types, td, diags); break;
    case "Element":
      if (expr.content) walkExpr(expr.content, types, td, diags);
      for (const p of expr.props)    walkExpr(p.value, types, td, diags);
      for (const c of expr.children) walkExpr(c, types, td, diags);
      break;
    case "Range":   walkExpr(expr.from, types, td, diags); walkExpr(expr.to, types, td, diags); break;
    case "TypeTest": walkExpr(expr.expr, types, td, diags); break;
    case "Do":      walkBlock(expr.stmts, types, td, diags); break;
    case "Loop":    walkBlock(expr.stmts, types, td, diags); break;
    case "For":     for (const c of expr.clauses) walkExpr(c.tag === "Gen" ? c.iter : c.cond, types, td, diags); walkExpr(expr.body, types, td, diags); break;
  }
}

function walkBranch(b: Branch, types: Map<Expr, Type>, td: TypeDefMap, diags: Diagnostic[]): void {
  if (b.guard) walkExpr(b.guard, types, td, diags);
  walkExpr(b.body, types, td, diags);
}

function walkBlock(stmts: Stmt[], types: Map<Expr, Type>, td: TypeDefMap, diags: Diagnostic[]): void {
  for (const s of stmts) {
    if (s.tag === "SAssign") {
      walkExpr(s.target, types, td, diags);
      walkExpr(s.value, types, td, diags);
    } else if (s.tag === "SBind" || s.tag === "SExpr" || s.tag === "SReturn" || s.tag === "SBreak") {
      const e = s.tag === "SBind" ? s.value : s.tag === "SExpr" ? s.expr : s.value;
      if (e) walkExpr(e, types, td, diags);
    }
  }
}

// ── Core exhaustiveness check ─────────────────────────────────────────────────

function checkMatch(
  expr: Extract<Expr, { tag: "Match" }>,
  types: Map<Expr, Type>,
  td: TypeDefMap,
  diags: Diagnostic[],
): void {
  const subjType = types.get(expr.subject);
  checkBranchSet(expr.branches, subjType, expr.span, types, td, diags);
}

function checkBranchSet(
  branches: Branch[],
  subjType: Type | undefined,
  span: Span,
  _types: Map<Expr, Type>,
  td: TypeDefMap,
  diags: Diagnostic[],
): void {
  if (!subjType || subjType.tag === "Unknown") return;

  // Unconditional branches are the only ones that guarantee coverage.
  // A guarded branch might not fire, so it contributes nothing to exhaustiveness.
  const unconditional = branches.filter(b => b.guard === null);

  // A wildcard anywhere in the unconditional branches covers everything.
  if (unconditional.some(b => isWildcard(b.pat))) return;

  const missing = missingCases(subjType, unconditional.map(b => b.pat), td);
  if (missing.length === 0) return;

  diags.push({
    kind: "error",
    span,
    message: `non-exhaustive match — missing: ${missing.join(", ")}`,
  });
}

// ── Missing case analysis ─────────────────────────────────────────────────────

function missingCases(type: Type, pats: Pat[], td: TypeDefMap): string[] {
  switch (type.tag) {

    case "Named": {
      const ctors = td.get(type.name);
      if (!ctors) return []; // unknown type — can't verify, stay silent

      const covered = new Set(pats.flatMap(topLevelCtors));
      const missing = ctors.filter(c => !covered.has(c.name));

      // For constructors that ARE covered, check their payloads recursively.
      // (e.g. Ok _ is fine, but Ok (:foo) might miss Ok (:bar))
      const nestedMissing: string[] = [];
      for (const ctor of ctors.filter(c => covered.has(c.name) && c.hasPayload)) {
          const innerPats = pats
          .filter(p => p.tag === "PCtor" && p.name === ctor.name && p.inner !== null)
          .map(p => (p as Extract<Pat, { tag: "PCtor" }>).inner!);
        if (innerPats.some(isWildcard)) continue; // inner wildcard covers all payloads
        // We don't have the payload type here — skip deep nested checking for now
      }

      return [
        ...missing.map(c => c.name),
        ...nestedMissing,
      ];
    }

    case "Prim": {
      if (type.kind === "Bool") {
        const hasTrue  = pats.some(p => p.tag === "PLit" && p.lit.tag === "Bool" && p.lit.value === true);
        const hasFalse = pats.some(p => p.tag === "PLit" && p.lit.tag === "Bool" && p.lit.value === false);
        return [...(!hasTrue ? ["true"] : []), ...(!hasFalse ? ["false"] : [])];
      }
      // Number/String have infinite values — can't be exhaustive without a wildcard.
      // We already checked for wildcards above, so if we're here, it's incomplete.
      return [`_ (${type.kind} has infinite values)`];
    }

    case "Atom": {
      // An Atom type has exactly one value. Exhaustive if that atom is matched.
      const covered = pats.some(p =>
        (p.tag === "PAtom" && p.name === type.name) ||
        (p.tag === "PLit"  && p.lit.tag === "Atom" && p.lit.name === type.name),
      );
      return covered ? [] : [`:${type.name}`];
    }

    case "Tuple": {
      // Tuple is always a single shape — exhaustive iff all positions are covered.
      // We already handled wildcards above. If we're here, no branch is a wildcard,
      // meaning every branch is a PTuple — check each element.
      const tuplePats = pats.filter(p => p.tag === "PTuple") as Extract<Pat, { tag: "PTuple" }>[];
      if (tuplePats.length === 0) return ["(_,_,...)"];
      // Recursively check each element position
      const elemMissing: string[] = [];
      for (let i = 0; i < type.elems.length; i++) {
        const elemPats = tuplePats.flatMap(p => p.elems[i] ? [p.elems[i]!] : []);
        const m = missingCases(type.elems[i]!, elemPats, td);
        if (m.length > 0) elemMissing.push(`element ${i}: ${m.join(", ")}`);
      }
      return elemMissing;
    }

    case "Record":
      // Record matching is always structural — if we got here without a wildcard,
      // the user likely forgot a field. But we can't tell which without more info.
      return [];

    default:
      return []; // Fn, Async, Stream, etc. — silently skip
  }
}

// Returns the top-level constructor names a pattern covers (not recursive).
function topLevelCtors(pat: Pat): string[] {
  switch (pat.tag) {
    case "PCtor": return [pat.name];
    case "PLit":
      if (pat.lit.tag === "Bool") return [pat.lit.value ? "true" : "false"];
      if (pat.lit.tag === "Atom") return [`:${pat.lit.name}`];
      return [];
    case "PAtom": return [`:${pat.name}`];
    default: return [];
  }
}

function isWildcard(pat: Pat): boolean {
  if (pat.tag === "PWild" || pat.tag === "PVar" || pat.tag === "PTyped") return true;
  // A tuple is a catch-all when every element is a catch-all, e.g. `(x, y)`.
  if (pat.tag === "PTuple") return pat.elems.every(isWildcard);
  return false;
}
