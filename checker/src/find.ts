import type { Module, Decl, Expr, Stmt, Branch } from "./ast.js";
import type { Span } from "./span.js";

// ── Position containment ──────────────────────────────────────────────────────

function contains(span: Span, line: number, char: number): boolean {
  const { start, end } = span;
  if (line < start.line || line > end.line) return false;
  if (line === start.line && char < start.col) return false;
  if (line === end.line && char >= end.col) return false;
  return true;
}

function spanSize(span: Span): number {
  return span.end.offset - span.start.offset;
}

// ── Generic expression visitor ────────────────────────────────────────────────

export function visitAllExprs(mod: Module, fn: (e: Expr) => void): void {
  for (const decl of mod.decls) visitDeclExprs(decl, fn);
}

function visitDeclExprs(decl: Decl, fn: (e: Expr) => void): void {
  switch (decl.tag) {
    case "DFn":
      for (const clause of decl.clauses) visitExpr(clause.body, fn);
      break;
    case "DModule":
      for (const inner of decl.decls) visitDeclExprs(inner, fn);
      break;
    case "DSaga":
      for (const step of decl.steps)
        for (const st of step.body) visitSagaStmt(st, fn);
      break;
  }
}

export function visitExpr(expr: Expr, fn: (e: Expr) => void): void {
  fn(expr);
  switch (expr.tag) {
    case "Lit": break;
    case "Var": break;
    case "Call":
      visitExpr(expr.fn, fn);
      for (const a of expr.args) visitExpr(a, fn);
      break;
    case "BinOp":
      visitExpr(expr.left, fn);
      visitExpr(expr.right, fn);
      break;
    case "UnOp":
    case "Propagate":
    case "TypeTest":
    case "Go":
    case "Resume":
    case "Await":
      visitExpr(expr.expr, fn);
      if (expr.tag === "Await") for (const b of expr.branches) visitBranch(b, fn);
      break;
    case "JSExpr": break; // no sub-expressions to visit
    case "Send":  visitExpr(expr.msg, fn); break;
    case "Transaction":
      if (expr.config) visitExpr(expr.config, fn);
      for (const s of expr.body) visitStmt(s, fn);
      break;
    case "PropWith":
      visitExpr(expr.expr, fn);
      visitExpr(expr.alt, fn);
      break;
    case "Field":
      visitExpr(expr.obj, fn);
      break;
    case "Index":
      visitExpr(expr.obj, fn);
      visitExpr(expr.index, fn);
      break;
    case "Lambda":
      visitExpr(expr.body, fn);
      break;
    case "If":
      visitExpr(expr.cond, fn);
      visitExpr(expr.then, fn);
      if (expr.else_) visitExpr(expr.else_, fn);
      break;
    case "Match":
      visitExpr(expr.subject, fn);
      for (const b of expr.branches) visitBranch(b, fn);
      break;
    case "Do":
    case "Loop":
      for (const s of expr.stmts) visitStmt(s, fn);
      break;
    case "For":
      for (const c of expr.clauses) visitExpr(c.tag === "Gen" ? c.iter : c.cond, fn);
      visitExpr(expr.body, fn);
      break;
    case "Tuple":
    case "List":
      for (const e of expr.elems) visitExpr(e, fn);
      break;
    case "Record":
      for (const f of expr.fields) visitExpr(f.value, fn);
      break;
    case "Range":
      visitExpr(expr.from, fn);
      visitExpr(expr.to, fn);
      break;
    case "Element":
      if (expr.content) visitExpr(expr.content, fn);
      for (const p of expr.props)    visitExpr(p.value, fn);
      for (const c of expr.children) visitExpr(c, fn);
      break;
    case "Handler":
      visitExpr(expr.body, fn);
      break;
    case "Machine":
      for (const step of expr.steps)
        for (const st of step.body) visitSagaStmt(st, fn);
      break;
  }
}

function visitSagaStmt(s: import("./ast.js").SagaStmt, fn: (e: Expr) => void): void {
  switch (s.tag) {
    case "Goto":     for (const a of s.args) visitExpr(a, fn); break;
    case "Yield":    visitExpr(s.expr, fn); break;
    case "SBindS":   visitExpr(s.value, fn); break;
    case "SagaGo":   visitExpr(s.expr, fn); break;
    case "Rollback": visitExpr(s.expr, fn); break;
    case "SagaMatch":
      visitExpr(s.subject, fn);
      for (const b of s.branches) for (const st of b.body) visitSagaStmt(st, fn);
      break;
    case "SagaIf":
      visitExpr(s.cond, fn);
      for (const st of s.then)  visitSagaStmt(st, fn);
      for (const st of s.else_) visitSagaStmt(st, fn);
      break;
    case "SagaJoin":
      for (const t of s.tasks) visitExpr(t, fn);
      for (const b of s.branches) for (const st of b.body) visitSagaStmt(st, fn);
      break;
    case "SagaRace":
      for (const arm of s.arms) if (arm.expr) visitExpr(arm.expr, fn);
      for (const b of s.branches) for (const st of b.body) visitSagaStmt(st, fn);
      break;
  }
}

function visitBranch(b: Branch, fn: (e: Expr) => void): void {
  if (b.guard) visitExpr(b.guard, fn);
  visitExpr(b.body, fn);
}

function visitStmt(s: Stmt, fn: (e: Expr) => void): void {
  switch (s.tag) {
    case "SBind":   visitExpr(s.value, fn); break;
    case "SExpr":   visitExpr(s.expr, fn);  break;
    case "SAssign": visitExpr(s.target, fn); visitExpr(s.value, fn); break;
    case "SBreak":
    case "SReturn": if (s.value) visitExpr(s.value, fn); break;
  }
}

// ── Position lookup ───────────────────────────────────────────────────────────

// Returns the innermost (smallest-span) expression containing the position.
export function findExprAt(mod: Module, line: number, char: number): Expr | null {
  let best: Expr | null = null;
  let bestSize = Infinity;

  visitAllExprs(mod, expr => {
    if (!contains(expr.span, line, char)) return;
    const size = spanSize(expr.span);
    if (size < bestSize) {
      best  = expr;
      bestSize = size;
    }
  });

  return best;
}
