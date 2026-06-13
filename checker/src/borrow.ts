// Borrow / ownership checker (v1).
//
// A flow-sensitive pass that makes `drop` and `&`/`.*` real compile-time checks.
//
// Drop tracking — per program point, the set of locals that have been dropped:
//   • use-after-drop  — reading a variable after `drop x`
//   • double-drop     — `drop x` when x is already dropped
//   • drop-in-loop    — dropping an outer variable inside a loop body (it would
//                       run again on the next iteration → double free)
//
// Lifetime / borrow tracking — pointers produced by `x.&` (§2.11):
//   • dangling return     — a function whose result is (or transitively names) a
//                           pointer into a local declared in its own body; that
//                           local dies at the closing dedent, so the pointer
//                           would dangle. The canonical borrow-checker error.
//   • drop-while-borrowed — `drop x` while a live pointer still borrows x.
//
// Move tracking — a `mut` binding of an *affine* (non-Copy) type is a single-owner
// resource (§6.1). Rebinding one to a new owner (`let y = x`) MOVES it; the source
// is consumed, so:
//   • use-after-move  — reading `x` after `let y = x`
//   • drop-after-move — `drop x` after it was moved
// What counts as affine is type-driven (see `isCopy`): heap buffers (String,
// List/Dict/ADTs) and live resources (Stream/Async) move; Copy scalars (Number,
// Bool, Unit) and atoms clone. Immutable (`let`/`const`) values are freely
// cloneable too, so they never move regardless of type.
//
// Branches (if / match) merge by union: a variable consumed (dropped OR moved) on
// ANY path is treated as consumed afterwards (conservative but sound). Re-binding a
// name (`let x = …`) brings it back to life. Borrow tracking is conservative within a
// function: `p = x.&` marks x borrowed-by-p for the rest of the body. Full lexical
// region inference is conservative, but `where (~a >= ~b)` outlives constraints are
// now solved (see `buildOutlives`) so a longer-lived pointer may satisfy a result.

import type { Module, Expr, Stmt, Pat, Decl, FnClause, LifetimeRef } from "./ast.js";
import type { Diagnostic } from "./resolve.js";
import type { Span } from "./span.js";
import type { Type } from "./types.js";

// Whether a value of type `t` is freely *copyable* — `let y = x` clones it and
// leaves x usable — versus an *affine* (move-only) resource that a fresh binding
// takes sole ownership of. Scalars (Number/Bool/Unit) and tags (atoms) copy;
// heap-backed buffers (String, List/Dict/ADTs) and live resources (Stream/Async)
// move. Unknown/var/closure types copy — we never invent a move we can't justify,
// keeping the checker false-positive-free. Compounds copy iff every part copies.
function isCopy(t: Type | undefined): boolean {
  if (!t) return true;                       // no type info → don't invent a move
  switch (t.tag) {
    case "Prim":       return t.kind !== "String";   // String is a heap buffer → affine
    case "Atom":       return true;
    case "Var":        return true;                  // unresolved → conservative (no move)
    case "Unknown":    return true;
    case "Fn":         return true;
    case "SagaFn":     return true;
    case "Inputmap":   return true;                  // a callable handle, not a heap buffer — copies like Fn
    case "ErrRow":     return true;                  // check-time-only marker; never a runtime value
    case "Tuple":      return t.elems.every(isCopy);
    case "Record":     return t.fields.every(f => isCopy(f.type));
    case "Tainted":    return isCopy(t.inner);
    case "Refinement": return isCopy(t.base);
    case "United":     return isCopy(t.base);        // a unit is a Number with a dimension tag → copies like its base
    case "Named":      return false;                 // List/Dict/ADTs own their data → affine
    case "Async":      return false;                 // a pending computation is a resource
    case "Stream":     return false;                 // a live stream is a resource
  }
}

// A consumed local can't be used again. `drop` releases it; `move` transfers
// ownership of a `mut` (single-owner) value to a new binding.
type ConsumeKind = "drop" | "move";
type Consumed = Map<string, ConsumeKind>;

interface Ctx {
  diags: Diagnostic[];
  // Names declared inside the current loop body (so dropping one of *those* is
  // fine — it's fresh each iteration). null when not inside a loop.
  loopLocals: Set<string> | null;
  // pointer-name → the local it borrows. Accumulated across the function body.
  borrows: Map<string, string>;
  // let-bound names declared in *this* function body (not params, not nested
  // lambda scopes). A pointer into one of these may not escape via the result.
  bodyLocals: Set<string>;
  // All parameter names of the enclosing function (their storage lives in *this*
  // frame, so `param.&` is just as frame-bound as `local.&`).
  params: Set<string>;
  // Pointer parameters → their declared lifetime (`~a`) or null when unannotated.
  // A pointer *parameter* itself is caller-owned, so returning it (pass-through)
  // is fine; the lifetime lets us reject region mismatches against the result.
  ptrParams: Map<string, string | null>;
  // The lifetime the signature promises on its result (`: Ptr ~r T`), or null.
  retRegion: string | null;
  // Names bound with `mut` — single-owner affine resources. Rebinding one to a new
  // owner (`let y = x`) moves it; the source is consumed and may not be used again.
  // A rebinding only counts as a move when the resource's *type* is non-Copy.
  mutResources: Set<string>;
  // Inferred type of each expression, so the move check can tell a Copy scalar
  // (`mut n = 0`) from an affine buffer (`mut buf = [1, 2, 3]`).
  types: Map<Expr, Type>;
  // Whether the enclosing function is low-tier (`@low`/`@kernel`). Affine move
  // tracking and the lifetime/region pass only run here; in the default (GC'd)
  // tier `mut` is a plain reassignable binding and pointers/lifetimes are rejected.
  lowLevel: boolean;
}

// What region a returned pointer expression points into.
type Region =
  | { kind: "frameLocal"; name: string }   // `local.&` — dies with the frame
  | { kind: "frameParam"; name: string }   // `param.&` — addr of a by-value param's frame copy
  | { kind: "caller";     region: string | null }   // a pointer parameter (or copy) — caller owns it
  | null;

export function checkBorrows(mod: Module, types: Map<Expr, Type>): Diagnostic[] {
  const diags: Diagnostic[] = [];
  walkDecls(mod.decls, diags, types);
  return diags;
}

function walkDecls(decls: Decl[], diags: Diagnostic[], types: Map<Expr, Type>): void {
  for (const decl of decls) {
    if (decl.tag === "DFn") {
      for (const clause of decl.clauses) analyzeFunction(clause, diags, types, decl.lowLevel ?? false);
    } else if (decl.tag === "DModule") {
      walkDecls(decl.decls, diags, types);
    }
  }
}

// Collect every `e.&` (AddrOf) and `e.*` (Deref) anywhere in an expression tree.
// Used by the default-tier gate to reject pointer syntax outside `@low`.
function findAddrDeref(root: Expr): Expr[] {
  const out: Expr[] = [];
  const visitStmts = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.tag === "SBind") visit(s.value);
      else if (s.tag === "SExpr") visit(s.expr);
      else if (s.tag === "SAssign") { visit(s.target); visit(s.value); }
      else if ((s.tag === "SBreak" || s.tag === "SReturn") && s.value) visit(s.value);
    }
  };
  const visit = (e: Expr): void => {
    switch (e.tag) {
      case "AddrOf": case "Deref": out.push(e); visit(e.expr); break;
      case "Call":   visit(e.fn); for (const a of e.args) visit(a); break;
      case "BinOp":  visit(e.left); visit(e.right); break;
      case "UnOp": case "Propagate": case "TypeTest": case "Go": case "Resume": visit(e.expr); break;
      case "Field":  visit(e.obj); break;
      case "Index":  visit(e.obj); visit(e.index); break;
      case "Lambda": visit(e.body); break;
      case "If":     visit(e.cond); visit(e.then); if (e.else_) visit(e.else_); break;
      case "Match":  visit(e.subject); for (const b of e.branches) { if (b.guard) visit(b.guard); visit(b.body); } break;
      case "Await":  visit(e.expr); for (const b of e.branches) visit(b.body); break;
      case "Range":  visit(e.from); visit(e.to); break;
      case "Tuple": case "List": for (const el of e.elems) visit(el); break;
      case "Record": if (e.spread) visit(e.spread); for (const f of e.fields) visit(f.value); break;
      case "PropWith": visit(e.expr); visit(e.alt); break;
      case "Send":   visit(e.msg); break;
      case "Drop":   visit(e.expr); break;
      case "Element":
        if (e.content) visit(e.content);
        for (const p of e.props) visit(p.value);
        for (const c of e.children) visit(c);
        break;
      case "For":
        for (const c of e.clauses) visit(c.tag === "Gen" ? c.iter : c.cond);
        visit(e.body);
        break;
      case "Do": case "Try": case "Loop": case "Retry": visitStmts(e.stmts); break;
      case "Transaction": if (e.config) visit(e.config); visitStmts(e.body); break;
      default: break; // leaves: Lit, Var, Break, Continue, Machine, JSExpr, …
    }
  };
  visit(root);
  return out;
}

function analyzeFunction(clause: FnClause, diags: Diagnostic[], types: Map<Expr, Type>, lowLevel: boolean): void {
  const body = clause.body;
  // Default (high-level) tier: pointers and lifetimes belong to `@low` only.
  // Reject them up front so application code can never reach the systems-tier
  // machinery — `.&`/`.*`, `Ptr` parameters, and `where (~a >= ~b)` constraints.
  if (!lowLevel) {
    for (const p of clause.params)
      if (p.ascription && p.ascription.tag === "TRPtr")
        diags.push({ kind: "error", span: p.span, message: `pointer parameter requires an \`@low\` function (pointers are a low-level feature)` });
    if (clause.lifetimeConstraints.length > 0)
      diags.push({ kind: "error", span: clause.span, message: `lifetime constraints (\`where ~a >= ~b\`) require an \`@low\` function` });
    for (const e of findAddrDeref(body))
      diags.push({ kind: "error", span: e.span, message: `\`${e.tag === "AddrOf" ? ".&" : ".*"}\` requires an \`@low\` function (pointers are a low-level feature)` });
  }
  const bodyLocals = new Set<string>();
  collectLocals(body, bodyLocals);

  const params = new Set<string>();
  const ptrParams = new Map<string, string | null>();
  for (const p of clause.params) {
    if (p.pat.tag !== "PVar") { for (const n of patNames(p.pat, [])) params.add(n); continue; }
    params.add(p.pat.name);
    if (p.ascription && p.ascription.tag === "TRPtr") ptrParams.set(p.pat.name, p.ascription.lifetime);
  }
  const retRegion = clause.ret && clause.ret.tag === "TRPtr" ? clause.ret.lifetime : null;

  const ctx: Ctx = { diags, loopLocals: null, borrows: new Map(), bodyLocals, params, ptrParams, retRegion, mutResources: new Set(), types, lowLevel };
  // Flow pass: drop/move checks + populate ctx.borrows.
  analyzeExpr(body, new Map(), ctx);

  // The lifetime/region pass only applies to the low-level tier; the default tier
  // has already rejected any pointers, so there is nothing that could dangle.
  if (!lowLevel) return;

  // Solve the `where (~a >= ~b)` outlives relation declared on this clause, so the
  // return-lifetime check can accept a pointer whose region is *known* to outlive
  // the declared result lifetime.
  const outlives = buildOutlives(clause, ptrParams);

  // Lifetime pass: classify each thing that can leave through the result.
  for (const e of exitExprs(body)) {
    const region = regionOf(e, ctx);
    if (!region) continue;
    if (region.kind === "frameLocal")
      err(ctx, e.span, `returns a pointer to local '${region.name}', which does not live past the function`);
    else if (region.kind === "frameParam")
      err(ctx, e.span, `returns a pointer into the frame via '${region.name}.&'; the borrow does not live past the function`);
    else if (ctx.retRegion && region.region && !outlives(region.region, ctx.retRegion))
      err(ctx, e.span, `lifetime mismatch: result is declared '${ctx.retRegion}' but the returned pointer has lifetime '${region.region}', which is not known to outlive it`);
  }
}

// Build the outlives relation from a clause's `where` lifetime constraints.
// Returns `outlives(a, b)` = "lifetime a is known to live at least as long as b".
// Reflexive (every lifetime outlives itself), and transitively closed over the
// declared edges: `~a >= ~b` adds a→b; `~a = ~b` adds both directions. A returned
// pointer of region a is sound for a result declared b exactly when a outlives b.
function buildOutlives(clause: FnClause, ptrParams: Map<string, string | null>): (a: string, b: string) => boolean {
  // `buf.~` resolves to buf's declared pointer lifetime, or a frame-bound label
  // (`buf.~`) that only relates through explicitly-written constraints.
  const resolve = (ref: LifetimeRef): string =>
    ref.tag === "LVar" ? ref.name : (ptrParams.get(ref.binding) ?? `${ref.binding}.~`);

  const edges = new Map<string, Set<string>>();
  const edge = (from: string, to: string) => {
    if (!edges.has(from)) edges.set(from, new Set());
    edges.get(from)!.add(to);
  };
  for (const c of clause.lifetimeConstraints) {
    const l = resolve(c.lhs), r = resolve(c.rhs);
    edge(l, r);                          // l >= r  (l outlives r)
    if (c.op === "eq") edge(r, l);       // = is symmetric
  }

  return (a: string, b: string): boolean => {
    if (a === b) return true;            // reflexive
    const seen = new Set<string>([a]);
    const stack = [a];
    while (stack.length) {
      const cur = stack.pop()!;
      for (const nxt of edges.get(cur) ?? []) {
        if (nxt === b) return true;
        if (!seen.has(nxt)) { seen.add(nxt); stack.push(nxt); }
      }
    }
    return false;
  };
}

// Names bound by `let`/`mut` in this function body. Skips nested lambda bodies
// (their locals are a separate scope) and pattern-match branch bindings.
function collectLocals(expr: Expr, acc: Set<string>): void {
  const visitStmts = (stmts: Stmt[]) => {
    for (const s of stmts) {
      if (s.tag === "SBind" && s.declares) for (const n of patNames(s.pat, [])) acc.add(n);
      if (s.tag === "SBind") collectLocals(s.value, acc);
      else if (s.tag === "SExpr") collectLocals(s.expr, acc);
      else if (s.tag === "SAssign") { collectLocals(s.target, acc); collectLocals(s.value, acc); }
      else if ((s.tag === "SBreak" || s.tag === "SReturn") && s.value) collectLocals(s.value, acc);
    }
  };
  switch (expr.tag) {
    case "Do": case "Try": case "Loop": visitStmts(expr.stmts); break;
    case "Retry": visitStmts(expr.stmts); break;
    case "Transaction": visitStmts(expr.body); break;
    case "If":
      collectLocals(expr.then, acc);
      if (expr.else_) collectLocals(expr.else_, acc);
      break;
    case "Match": for (const b of expr.branches) collectLocals(b.body, acc); break;
    case "Await": for (const b of expr.branches) collectLocals(b.body, acc); break;
    default: break; // a non-block body has no let-locals of its own
  }
}

// Expressions that can be the function's result (tail position) or an early
// `?`-return value — the places a pointer could escape from.
function exitExprs(body: Expr): Expr[] {
  const out: Expr[] = [];
  const tail = (e: Expr): void => {
    switch (e.tag) {
      case "If":
        tail(e.then);
        if (e.else_) tail(e.else_);
        break;
      case "Match": for (const b of e.branches) tail(b.body); break;
      case "Do": case "Try": {
        const last = e.stmts.at(-1);
        if (last?.tag === "SExpr") tail(last.expr);
        break;
      }
      default: out.push(e);
    }
  };
  tail(body);
  // Also collect every `return`/`break` value anywhere in the body.
  const walkReturns = (e: Expr): void => {
    const stmts = (ss: Stmt[]) => {
      for (const s of ss) {
        if ((s.tag === "SReturn" || s.tag === "SBreak") && s.value) out.push(s.value);
        if (s.tag === "SBind") walkReturns(s.value);
        else if (s.tag === "SExpr") walkReturns(s.expr);
        else if (s.tag === "SAssign") { walkReturns(s.target); walkReturns(s.value); }
        else if ((s.tag === "SReturn" || s.tag === "SBreak") && s.value) walkReturns(s.value);
      }
    };
    switch (e.tag) {
      case "Do": case "Try": case "Loop": case "Retry": stmts(e.stmts); break;
      case "Transaction": stmts(e.body); break;
      case "If": walkReturns(e.then); if (e.else_) walkReturns(e.else_); break;
      case "Match": case "Await": for (const b of e.branches) walkReturns(b.body); break;
      default: break;
    }
  };
  walkReturns(body);
  return out;
}

// Classify the region a pointer-valued expression points into. Returns null when
// `e` is not (known to be) a pointer that could dangle.
//
//   x.&            where x is a body-local  → frameLocal   (dangling if returned)
//   p.&            where p is a parameter    → frameParam   (dangling if returned)
//   buf            where buf: Ptr ~a T param → caller(~a)   (pass-through, fine)
//   p              where `p = local.&`        → frameLocal  (traced via `borrows`)
// Peel a place expression down to the binding it ultimately refers to. Pointers
// into aggregates borrow their container: `xs[i]` and `rec.f` both root at the
// base variable, so `xs[i].&` borrows `xs`'s frame storage just like `xs.&` does.
function rootVar(e: Expr): string | null {
  let cur = e;
  while (true) {
    if (cur.tag === "AddrOf" || cur.tag === "Deref") cur = cur.expr;
    else if (cur.tag === "Index" || cur.tag === "Field") cur = cur.obj;
    else break;
  }
  return cur.tag === "Var" ? cur.name : null;
}

function regionOf(e: Expr, ctx: Ctx): Region {
  // Address-of always points into the *current* frame: a local or a by-value
  // parameter's copy. Either way the storage dies when the function returns.
  if (e.tag === "AddrOf") {
    const name = rootVar(e.expr);
    if (name !== null) {
      if (ctx.bodyLocals.has(name)) return { kind: "frameLocal", name };
      if (ctx.params.has(name))     return { kind: "frameParam", name };
    }
    return null; // addr of a free/captured var — outside this analysis
  }
  // Slice-extraction: `buf[lo..hi]` of a POINTER borrows the same storage the pointer
  // does, so the slice carries the pointer's region (§2.11) — a slice of a pointer
  // parameter lives in the caller (returnable under `where (buf.~ = result.~)`); a
  // slice of a pointer into a local dangles if returned. A slice of a plain List or
  // String roots at a non-pointer and falls through to `null` — it's a value copy.
  if (e.tag === "Index" && e.index.tag === "Range") {
    const name = rootVar(e.obj);
    if (name !== null) {
      if (ctx.ptrParams.has(name)) return { kind: "caller", region: ctx.ptrParams.get(name)! };
      const src = ctx.borrows.get(name);
      if (src !== undefined) {
        if (ctx.bodyLocals.has(src)) return { kind: "frameLocal", name: src };
        if (ctx.params.has(src) && !ctx.ptrParams.has(src)) return { kind: "frameParam", name: src };
        if (ctx.ptrParams.has(src)) return { kind: "caller", region: ctx.ptrParams.get(src)! };
      }
    }
    return null;
  }
  if (e.tag === "Var") {
    // A pointer parameter (or a copy of one) — the referent lives in the caller.
    if (ctx.ptrParams.has(e.name)) return { kind: "caller", region: ctx.ptrParams.get(e.name)! };
    // A binding that borrowed something: resolve to the original source's region.
    const src = ctx.borrows.get(e.name);
    if (src !== undefined) {
      if (ctx.bodyLocals.has(src)) return { kind: "frameLocal", name: src };
      if (ctx.params.has(src) && !ctx.ptrParams.has(src)) return { kind: "frameParam", name: src };
      if (ctx.ptrParams.has(src)) return { kind: "caller", region: ctx.ptrParams.get(src)! };
    }
  }
  return null;
}

// The local name a binding's value borrows, if any: `x.&` → "x", or `p` where p
// already borrows something → its source. Returns null for non-borrowing values.
function borrowSource(value: Expr, ctx: Ctx): string | null {
  if (value.tag === "AddrOf") return rootVar(value.expr);
  if (value.tag === "Var") return ctx.borrows.get(value.name) ?? null;
  return null;
}

function err(ctx: Ctx, span: Span, message: string): void {
  ctx.diags.push({ kind: "error", span, message });
}

function union(a: Consumed, b: Consumed): Consumed {
  const out = new Map(a);
  for (const [k, v] of b) if (!out.has(k)) out.set(k, v);  // consumed on either path
  return out;
}

// Names a pattern binds (so they become live / shadow any prior drop).
function patNames(pat: Pat, acc: string[]): string[] {
  switch (pat.tag) {
    case "PVar":    acc.push(pat.name); break;
    case "PTuple":  for (const p of pat.elems) patNames(p, acc); break;
    case "PRecord": for (const f of pat.fields) patNames(f.pat, acc); break;
    default:        break; // PWild, literals, ctor patterns with no fresh binding
  }
  return acc;
}

// Analyze an expression in `dropped` state; returns the state afterward.
function analyzeExpr(expr: Expr, dropped: Consumed, ctx: Ctx): Consumed {
  switch (expr.tag) {
    case "Var": {
      const how = dropped.get(expr.name);
      if (how)
        err(ctx, expr.span, `use of '${expr.name}' after it was ${how === "move" ? "moved" : "dropped"}`);
      return dropped;
    }

    case "Drop": {
      // `drop x` for a plain variable kills it; anything else just evaluates.
      if (expr.expr.tag === "Var") {
        const name = expr.expr.name;
        const how = dropped.get(name);
        if (how) {
          err(ctx, expr.span, how === "move"
            ? `cannot drop '${name}': it was already moved`
            : `'${name}' is dropped more than once`);
        } else if (ctx.loopLocals && !ctx.loopLocals.has(name)) {
          err(ctx, expr.span, `'${name}' is dropped inside a loop — it would be dropped again on the next iteration`);
        } else {
          // Dropping a value while a live pointer still borrows it leaves that
          // pointer dangling.
          for (const [ptr, src] of ctx.borrows)
            if (src === name) err(ctx, expr.span, `cannot drop '${name}': it is still borrowed by '${ptr}'`);
        }
        const next = new Map(dropped);
        next.set(name, "drop");
        return next;
      }
      return analyzeExpr(expr.expr, dropped, ctx);
    }

    case "AddrOf": case "Deref":
      return analyzeExpr(expr.expr, dropped, ctx);

    case "If": {
      const s = analyzeExpr(expr.cond, dropped, ctx);
      const sThen = analyzeExpr(expr.then, new Map(s), ctx);
      const sElse = expr.else_ ? analyzeExpr(expr.else_, new Map(s), ctx) : new Map(s);
      return union(sThen, sElse);
    }

    case "Match": {
      let s = analyzeExpr(expr.subject, dropped, ctx);
      const states: Consumed[] = [];
      for (const b of expr.branches) {
        let bs = new Map(s);
        if (b.guard) bs = analyzeExpr(b.guard, bs, ctx);
        states.push(analyzeExpr(b.body, bs, ctx));
      }
      return states.length ? states.reduce(union) : s;
    }

    case "Await": {
      let s = analyzeExpr(expr.expr, dropped, ctx);
      const states: Consumed[] = [];
      for (const b of expr.branches) states.push(analyzeExpr(b.body, new Map(s), ctx));
      return states.length ? states.reduce(union) : s;
    }

    case "Do":  return analyzeBlock(expr.stmts, dropped, ctx);
    case "Try": return analyzeBlock(expr.stmts, dropped, ctx);

    case "Loop": return analyzeLoopBlock(expr.stmts, dropped, ctx);

    case "Retry": {
      let s = dropped;
      if (expr.count) s = analyzeExpr(expr.count, s, ctx);
      if (expr.delay) s = analyzeExpr(expr.delay, s, ctx);
      return analyzeLoopBlock(expr.stmts, s, ctx);
    }

    case "For": {
      let s = dropped;
      for (const c of expr.clauses) s = analyzeExpr(c.tag === "Gen" ? c.iter : c.cond, s, ctx);
      // Body runs once per element — treat like a loop, drops don't escape.
      const loopCtx: Ctx = { ...ctx, loopLocals: new Set() };
      analyzeExpr(expr.body, new Map(s), loopCtx);
      return s;
    }

    case "Lambda": {
      // The body runs later; analyze it for use-after-drop against captures, but
      // its own drops don't affect the surrounding flow.
      analyzeExpr(expr.body, new Map(dropped), { ...ctx, loopLocals: null });
      return dropped;
    }

    // ── plain compound expressions: thread state left-to-right ────────────────
    case "Call": {
      let s = analyzeExpr(expr.fn, dropped, ctx);
      for (const a of expr.args) s = analyzeExpr(a, s, ctx);
      return s;
    }
    case "BinOp":
      return analyzeExpr(expr.right, analyzeExpr(expr.left, dropped, ctx), ctx);
    case "Index":
      return analyzeExpr(expr.index, analyzeExpr(expr.obj, dropped, ctx), ctx);
    case "Range":
      return analyzeExpr(expr.to, analyzeExpr(expr.from, dropped, ctx), ctx);
    case "PropWith":
      return analyzeExpr(expr.alt, analyzeExpr(expr.expr, dropped, ctx), ctx);
    case "Tuple": case "List": {
      let s = dropped;
      for (const e of expr.elems) s = analyzeExpr(e, s, ctx);
      return s;
    }
    case "Record": {
      let s = dropped;
      if (expr.spread) s = analyzeExpr(expr.spread, s, ctx);
      for (const f of expr.fields) s = analyzeExpr(f.value, s, ctx);
      return s;
    }
    case "Element": {
      let s = dropped;
      if (expr.content) s = analyzeExpr(expr.content, s, ctx);
      for (const p of expr.props)    s = analyzeExpr(p.value, s, ctx);
      for (const c of expr.children) s = analyzeExpr(c, s, ctx);
      return s;
    }
    case "UnOp": case "Propagate": case "TypeTest": case "Go": case "Resume":
      return analyzeExpr(expr.expr, dropped, ctx);
    case "Field":
      return analyzeExpr(expr.obj, dropped, ctx);
    case "Send":
      return analyzeExpr(expr.msg, dropped, ctx);
    case "Transaction":
      return analyzeBlock(expr.body, expr.config ? analyzeExpr(expr.config, dropped, ctx) : dropped, ctx);

    default:
      return dropped; // leaves: Lit, Break, Continue, Ask, Machine, etc.
  }
}

function analyzeBlock(stmts: Stmt[], dropped: Consumed, ctx: Ctx): Consumed {
  let s = dropped;
  for (const stmt of stmts) s = analyzeStmt(stmt, s, ctx);
  return s;
}

// A loop body: drops of outer locals are flagged; names bound inside are loop-local.
function analyzeLoopBlock(stmts: Stmt[], dropped: Consumed, ctx: Ctx): Consumed {
  const loopCtx: Ctx = { ...ctx, loopLocals: new Set() };
  // Drops inside a loop don't escape to the surrounding flow (a loop may run zero
  // times); we only report inner errors, then return the entry state unchanged.
  analyzeBlock(stmts, new Map(dropped), loopCtx);
  return dropped;
}

function analyzeStmt(stmt: Stmt, dropped: Consumed, ctx: Ctx): Consumed {
  switch (stmt.tag) {
    case "SBind": {
      const s = analyzeExpr(stmt.value, dropped, ctx);
      const names = patNames(stmt.pat, []);
      if (names.length === 0) return s;
      const next = new Map(s);
      for (const n of names) {
        next.delete(n);                          // rebinding revives the name
        if (ctx.loopLocals) ctx.loopLocals.add(n);
        ctx.borrows.delete(n);                   // rebinding clears any old borrow
        // Track / untrack this name as a `mut` single-owner resource. Only the
        // low-level tier has affine `mut`; in the default tier `mut` is a plain
        // reassignable binding, so we never record it as a movable resource.
        if (stmt.mutable && ctx.lowLevel) ctx.mutResources.add(n);
        else ctx.mutResources.delete(n);
      }
      if (stmt.pat.tag === "PVar") {
        // Record a borrow when binding a single name to `src.&` or to another
        // pointer (`p2 = p`), so the lifetime pass can trace escapes.
        const borrowed = borrowSource(stmt.value, ctx);
        if (borrowed) ctx.borrows.set(stmt.pat.name, borrowed);
        // Move: rebinding a `mut` resource to a new owner (`let y = x`) transfers
        // ownership — but only when the value is an affine (non-Copy) type. A Copy
        // scalar like `mut n = 0` is cloned, leaving the source usable.
        if (stmt.declares && stmt.value.tag === "Var") {
          const src = stmt.value.name;
          if (src !== stmt.pat.name && ctx.mutResources.has(src) && !s.has(src)
              && !isCopy(ctx.types.get(stmt.value))) {
            next.set(src, "move");
            ctx.mutResources.delete(src);        // the source no longer owns anything
            ctx.mutResources.add(stmt.pat.name); // the new binding becomes the owner
          }
        }
      }
      return next;
    }
    case "SExpr":
      return analyzeExpr(stmt.expr, dropped, ctx);
    case "SAssign": {
      // `xs[i] = v` / `p.* = v`: evaluate the value, then the target place — both
      // read their operands, so a moved/dropped operand is caught here.
      const s = analyzeExpr(stmt.value, dropped, ctx);
      return analyzeExpr(stmt.target, s, ctx);
    }
    case "SBreak": case "SReturn":
      return stmt.value ? analyzeExpr(stmt.value, dropped, ctx) : dropped;
    default:
      return dropped;
  }
}
