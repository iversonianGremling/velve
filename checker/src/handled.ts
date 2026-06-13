// `proofs: [handled]` — the unpropagated-error obligation (SPEC §12.7,
// north-star §3.4). Forbids the silent fault the error-rows work made
// *visible*: a `Result` value that is neither matched, nor `?`-propagated,
// nor bound, nor returned — just dropped on the floor, taking its error with
// it. Two discard shapes are checked:
//
//   • a `Result`-typed expression in DISCARD position — a non-final statement
//     of a do/try/retry/transaction block, or ANY statement of a `loop` body
//     (the iteration value is never consumed);
//   • an explicit wildcard bind `let _ = <Result>` — under `handled` the
//     declaration says errors are dealt with, so even deliberate discards are
//     rejected (the escape hatch, as everywhere in the gradient, is not
//     declaring the obligation).
//
// Like `exhaustive` — and unlike `total` — this obligation is SCOPE-LOCAL: its
// fault is syntactic to the proved scope, so there is no downward call gate. A
// callee outside the module may still discard internally; what `handled`
// proves is that THIS module's code drops no error. Conservative by
// construction: a type still unresolved when the statement was inferred (a
// bare `Var`) is skipped, never guessed.
import type { Module, Decl, Expr, Stmt } from "./ast.js";
import type { Type } from "./types.js";
import type { Diagnostic } from "./resolve.js";

export function checkHandled(mod: Module, types: Map<Expr, Type>): Diagnostic[] {
  const diags: Diagnostic[] = [];
  walkDecls(mod.decls, false, types, diags);
  return diags;
}

function walkDecls(decls: Decl[], inHandled: boolean, types: Map<Expr, Type>, diags: Diagnostic[]): void {
  for (const d of decls) {
    if (d.tag === "DModule") {
      walkDecls(d.decls, inHandled || d.proofs.includes("handled"), types, diags);
      continue;
    }
    // v1 scope: function bodies. Store messages / machines / sagas are
    // documented out of scope in SPEC §12.7 (their bodies are message
    // handlers, not the compute the obligation targets).
    // A per-function `proofs: [handled]` clause (A4) scopes the obligation to
    // THIS def without the enclosing module declaring it.
    if (d.tag === "DFn" && (inHandled || d.proofs?.includes("handled")))
      for (const c of d.clauses) walkExpr(c.body, types, diags);
  }
}

function isResult(t: Type | undefined): boolean {
  return t !== undefined && t.tag === "Named" && t.name === "Result";
}

function err(diags: Diagnostic[], span: Stmt["span"], what: string): void {
  diags.push({ kind: "error", span,
    message: `proof obligation 'handled': ${what} — match it, propagate it with '?', or return it (declared via proofs: [handled])` });
}

// A statement whose value is dropped: non-final in do/try/retry/transaction,
// any position in a loop body.
function checkDiscard(s: Stmt, types: Map<Expr, Type>, diags: Diagnostic[]): void {
  if (s.tag === "SExpr" && isResult(types.get(s.expr)))
    err(diags, s.span, "this Result is silently discarded");
}

function walkStmts(stmts: Stmt[], allDiscard: boolean, types: Map<Expr, Type>, diags: Diagnostic[]): void {
  stmts.forEach((s, i) => {
    if (allDiscard || i < stmts.length - 1) checkDiscard(s, types, diags);
    walkStmt(s, types, diags);
  });
}

function walkStmt(s: Stmt, types: Map<Expr, Type>, diags: Diagnostic[]): void {
  switch (s.tag) {
    case "SBind":
      // `let _ = <Result>` discards by name; the wildcard makes it explicit,
      // and the declared obligation makes explicit discards errors too.
      if (s.pat.tag === "PWild" && isResult(types.get(s.value)))
        err(diags, s.span, "this Result is discarded by a wildcard bind");
      walkExpr(s.value, types, diags);
      return;
    case "SExpr":   walkExpr(s.expr, types, diags); return;
    case "SAssign": walkExpr(s.target, types, diags); walkExpr(s.value, types, diags); return;
    case "SBreak":  if (s.value) walkExpr(s.value, types, diags); return;
    case "SReturn": if (s.value) walkExpr(s.value, types, diags); return;
  }
}

function walkExpr(e: Expr, types: Map<Expr, Type>, diags: Diagnostic[]): void {
  switch (e.tag) {
    case "Do":          walkStmts(e.stmts, false, types, diags); return;
    case "Try":         walkStmts(e.stmts, false, types, diags); return;
    case "Loop":        walkStmts(e.stmts, true,  types, diags); return;
    case "Retry":
      if (e.count) walkExpr(e.count, types, diags);
      if (e.delay) walkExpr(e.delay, types, diags);
      walkStmts(e.stmts, false, types, diags);
      return;
    case "Transaction":
      if (e.config) walkExpr(e.config, types, diags);
      walkStmts(e.body, false, types, diags);
      return;
    case "Call":
      walkExpr(e.fn, types, diags);
      for (const a of e.args) walkExpr(a, types, diags);
      for (const na of e.named) walkExpr(na.value, types, diags);
      return;
    case "BinOp":     walkExpr(e.left, types, diags); walkExpr(e.right, types, diags); return;
    case "UnOp":      walkExpr(e.expr, types, diags); return;
    case "Field":     walkExpr(e.obj, types, diags); return;
    case "Index":     walkExpr(e.obj, types, diags); walkExpr(e.index, types, diags); return;
    case "Lambda":    walkExpr(e.body, types, diags); return;
    case "Match":
      walkExpr(e.subject, types, diags);
      for (const b of e.branches) { if (b.guard) walkExpr(b.guard, types, diags); walkExpr(b.body, types, diags); }
      return;
    case "If":
      walkExpr(e.cond, types, diags); walkExpr(e.then, types, diags);
      if (e.else_) walkExpr(e.else_, types, diags);
      return;
    case "For":
      for (const c of e.clauses) walkExpr(c.tag === "Gen" ? c.iter : c.cond, types, diags);
      walkExpr(e.body, types, diags);
      return;
    case "Range":     walkExpr(e.from, types, diags); walkExpr(e.to, types, diags); return;
    case "Tuple":
    case "List":      for (const el of e.elems) walkExpr(el, types, diags); return;
    case "Record":
      if (e.spread) walkExpr(e.spread, types, diags);
      for (const f of e.fields) walkExpr(f.value, types, diags);
      return;
    case "Propagate": walkExpr(e.expr, types, diags); return;
    case "PropWith":  walkExpr(e.expr, types, diags); walkExpr(e.alt, types, diags); return;
    case "Await":
      walkExpr(e.expr, types, diags);
      for (const b of e.branches) { if (b.guard) walkExpr(b.guard, types, diags); walkExpr(b.body, types, diags); }
      return;
    case "TypeTest":  walkExpr(e.expr, types, diags); return;
    case "Element":
      if (e.content) walkExpr(e.content, types, diags);
      for (const p of e.props) walkExpr(p.value, types, diags);
      for (const c of e.children) walkExpr(c, types, diags);
      return;
    case "Handler":   walkExpr(e.body, types, diags); return;
    case "Break":     if (e.value) walkExpr(e.value, types, diags); return;
    case "Go":
    case "Resume":
    case "Drop":
    case "AddrOf":
    case "Deref":     walkExpr(e.expr, types, diags); return;
    case "Send":      walkExpr(e.msg, types, diags); return;
    default: return;   // Lit, Var, JSExpr, Continue, Machine (out of v1 scope)
  }
}
