import type { Module, Decl, Expr, Stmt, Pat, Param } from "./ast.js";
import type { Diagnostic, ResolutionMap } from "./resolve.js";

// ── Tier-1 structural totality (totality-design §3) ───────────────────────────
//
// `@total def f …` is an opt-in, checked promise that `f` terminates. This pass
// holds it to the promise with the cheap, no-solver discipline total languages
// use (Agda/Idris/Lean): every recursive call must pass a structurally smaller
// argument at one fixed position, a base case must exist, and — because totality
// flows DOWN the call graph (north-star §3.4: the opposite direction from
// effects) — a total function may only call other total functions and builtins
// known to terminate.
//
// Conservative-reject is correct here: the only escape hatch is not marking the
// function (totality-design §7), so a false negative annoys only code that asked
// for the guarantee. Out of Tier-1 scope by design: mutual recursion, recursion
// through closures/HOF parameters, non-structural measures like `n / 2` — those
// are Tier 2's job (`proof.terminates`).
//
// Known caveat (documented in SPEC, not silently "fixed"): Number is not Nat —
// `fact(-1)` passes the literal-base rule yet diverges at runtime. The decrease
// rule is the one totality-design §3 blesses (`factorial(n - 1)` under an `n == 0`
// base); the honest fix is the `Natural` refined type (north-star §3.3).

// Builtins that terminate on every input — safe inside a total body. Cross-check
// resolve.ts BUILTINS and the effect-typed prelude (infer.ts) when adding names;
// anything that waits, spawns, or reaches the host stays out (sleep, pmap,
// parallel, stream*, externSource, setTheme/setViewport, ui surface, sagas).
const TOTAL_BUILTINS = new Set([
  // Constructors (values, not computation)
  "Ok", "Error", "Some", "None", "ParseError",
  "Before", "During", "After",
  "Conflict", "Timeout", "Cancelled", "Committed", "Aborted",
  "Px", "Fr", "Pct", "Fit", "Fill", "raw", "Clamp",
  "Mobile", "Tablet", "Desktop", "Wide",
  "Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled",
  "Empty", "Loading", "Partial", "Failed", "Ideal",
  "Off", "On", "Mixed", "Valid", "Invalid", "Pending",
  // Output (decided-ambient observation channel; terminates)
  "print", "println", "toString",
  // Math / compute
  "abs", "floor", "ceil", "round", "sqrt", "max", "min", "int", "not",
  "parseNumber", "parseInt", "parseFloat",
  // List (head/tail terminate as CALLS — they just don't count as a decrease measure)
  "length", "isEmpty", "head", "tail", "append", "prepend", "concat",
  "reverse", "slice", "zip", "range", "identity", "listHead",
  // String
  "trim", "split", "join", "contains", "matches", "startsWith", "endsWith",
  "toUpperCase", "toLowerCase",
]);

// Fn-taking builtins that terminate IFF the function they're given does: bounded
// iteration over a finite collection, so the residual obligation is the argument.
// The fn sits at position 0 for all of these (`map(f, xs)`, `foldl(f, init, xs)`).
const TOTAL_HOF_BUILTINS = new Set([
  "map", "filter", "foldl", "foldr", "flatMap", "any", "all", "sortBy", "forEach",
]);

// Ambient stdlib namespaces whose members are all terminating compute.
const TOTAL_NAMESPACES = new Set(["Math"]);

type DFn = Decl & { tag: "DFn" };

// Per-clause walk environment. `aliases` maps a binding name to the param
// position it EQUALS (the param binder itself, or a `match n | n ->` rebinding);
// `smaller` maps a name to the position it is STRICTLY SMALLER than (bound
// inside a ctor/tuple/record destructuring of that param). Copied at every
// branch/scope so shadowing stays local.
interface Env {
  aliases: Map<string, number>;
  smaller: Map<string, number>;
  localLambdas: Set<string>;   // `let g = fn x -> …` — bodies already walked, callable
  lambdaDepth: number;
}

interface RecCall {
  span: import("./span.js").Span;
  // verdict per param position: how the argument at that position relates
  verdicts: ("none" | "struct" | "num")[];
}

interface FnReport {
  recCalls: RecCall[];
  // positions with a numeric floor witness (literal clause head / literal match
  // branch / comparison over an alias in an if-cond or guard)
  floorWitness: Set<number>;
  calledFns: Set<string>;      // user fns called (for the mutual-recursion pass)
  decreaseErrored: boolean;    // a decrease-family error was already emitted
}

export function checkTotality(mod: Module, resolutions: ResolutionMap): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const fns = new Map<string, DFn>();
  collectFns(mod.decls, fns);

  const totalNames = new Set([...fns.values()].filter(d => d.total).map(d => d.name));
  if (totalNames.size === 0) return diags;

  const reports = new Map<string, FnReport>();
  for (const name of totalNames) {
    reports.set(name, checkFn(fns.get(name)!, totalNames, resolutions, diags));
  }

  // Mutual recursion: the per-fn gate lets total→total calls through, so two
  // @total fns calling each other would silently loop. Edges restricted to
  // total fns (calls out to non-total fns already errored at the gate).
  for (const name of totalNames) {
    if (reachesSelfThroughOthers(name, reports, totalNames)) {
      const d = fns.get(name)!;
      diags.push({ kind: "error", span: d.span,
        message: `@total function '${name}' may not terminate — mutual recursion is not supported by the Tier-1 structural check (restructure as one function or drop @total)` });
    }
  }
  return diags;
}

function collectFns(decls: Decl[], out: Map<string, DFn>): void {
  for (const d of decls) {
    if (d.tag === "DFn") out.set(d.name, d);
    if (d.tag === "DModule") collectFns(d.decls, out);
  }
}

function reachesSelfThroughOthers(start: string, reports: Map<string, FnReport>, total: Set<string>): boolean {
  const seen = new Set<string>();
  const stack = [...(reports.get(start)?.calledFns ?? [])].filter(n => n !== start && total.has(n));
  while (stack.length > 0) {
    const cur = stack.pop()!;
    if (cur === start) return true;
    if (seen.has(cur)) continue;
    seen.add(cur);
    for (const next of reports.get(cur)?.calledFns ?? []) {
      if (next === start) return true;
      if (total.has(next) && !seen.has(next)) stack.push(next);
    }
  }
  return false;
}

// ── Per-function check ────────────────────────────────────────────────────────

function checkFn(decl: DFn, totalNames: Set<string>, resolutions: ResolutionMap, diags: Diagnostic[]): FnReport {
  const report: FnReport = {
    recCalls: [], floorWitness: new Set(),
    calledFns: new Set(), decreaseErrored: false,
  };
  if (decl.clauses.length === 0) return report;

  const arity = decl.clauses[0]!.params.length;
  if (!decl.clauses.every(c => c.params.length === arity)) {
    diags.push({ kind: "error", span: decl.span,
      message: `@total function '${decl.name}' may not terminate — clauses disagree on arity, so no decrease position lines up` });
    report.decreaseErrored = true;
  }

  const w = new Walker(decl.name, totalNames, resolutions, diags, report);
  for (const clause of decl.clauses) {
    const env: Env = { aliases: new Map(), smaller: new Map(), localLambdas: new Set(), lambdaDepth: 0 };
    clause.params.forEach((p, i) => seedParam(p, i, env));
    // A literal clause head (`def fib(0)`) is both a base clause and a numeric floor.
    clause.params.forEach((p, i) => {
      if (p.pat.tag === "PLit" && p.pat.lit.tag === "Num") report.floorWitness.add(i);
    });
    w.expr(clause.body, env);
  }

  if (report.decreaseErrored || report.recCalls.length === 0) return report;

  // One fixed position where EVERY recursive call shrinks.
  let measurePos = -1;
  let numeric = false;
  for (let i = 0; i < arity; i++) {
    if (report.recCalls.every(c => c.verdicts[i] !== "none")) {
      measurePos = i;
      numeric = report.recCalls.some(c => c.verdicts[i] === "num");
      break;
    }
  }
  if (measurePos === -1) {
    const bad = report.recCalls[0]!;
    diags.push({ kind: "error", span: bad.span,
      message: `@total function '${decl.name}' may not terminate — no argument position structurally decreases across every recursive call` });
    report.decreaseErrored = true;
    return report;
  }
  // Base case: some path through some clause must end without recursing. A
  // clause whose body NECESSARILY executes a recursive call has no such path.
  if (decl.clauses.every(c => alwaysRecurses(c.body, decl.name, resolutions))) {
    diags.push({ kind: "error", span: decl.span,
      message: `@total function '${decl.name}' may not terminate — every path recurses (no base case)` });
    report.decreaseErrored = true;
    return report;
  }
  if (numeric && !report.floorWitness.has(measurePos)) {
    diags.push({ kind: "error", span: decl.span,
      message: `@total function '${decl.name}' may not terminate — the numeric measure at parameter ${measurePos + 1} has no floor (add a literal base clause/branch or a comparison guard)` });
    report.decreaseErrored = true;
  }
  return report;
}

function seedParam(p: Param, i: number, env: Env): void {
  if (p.pat.tag === "PVar" || p.pat.tag === "PTyped") env.aliases.set(p.pat.name, i);
  else for (const b of innerBinders(p.pat)) env.smaller.set(b, i);
}

// All binder names inside a pattern (any depth).
function innerBinders(p: Pat): string[] {
  switch (p.tag) {
    case "PVar": case "PTyped": return [p.name];
    case "PCtor":   return p.inner ? innerBinders(p.inner) : [];
    case "PTuple":  return p.elems.flatMap(innerBinders);
    case "PRecord": return p.fields.flatMap(f => innerBinders(f.pat));
    default:        return [];
  }
}

// Does evaluating `e` NECESSARILY execute a recursive call to `fnName`? Used for
// the base-case check: if every clause body always recurses, no path ends. The
// predicate under-approximates "always" (short-circuit right operands, guards,
// for-bodies, and lambda bodies are treated as may-not-run), which errs toward
// accepting — the decrease check is the load-bearing guarantee; this catches the
// every-path-recurses shape (`hang(n) -> hang(n)` with a decreasing measure
// would still need a floor or a recursion-free path).
function alwaysRecurses(e: Expr, fnName: string, res: ResolutionMap): boolean {
  const go = (x: Expr): boolean => {
    switch (x.tag) {
      case "Call": {
        if (x.fn.tag === "Var" && x.fn.name === fnName && res.get(x.fn)?.kind === "fn") return true;
        return go(x.fn) || x.args.some(go) || x.named.some(n => go(n.value));
      }
      case "Var": return x.name === fnName && res.get(x)?.kind === "fn";  // escapes already error; treat as recursing
      case "BinOp":
        // && / || short-circuit: only the left side is guaranteed to run.
        return ["&&", "||"].includes(x.op) ? go(x.left) : go(x.left) || go(x.right);
      case "UnOp": case "Propagate": case "Drop": case "AddrOf": case "Deref": return go(x.expr);
      case "PropWith": return go(x.expr);
      case "Field": return go(x.obj);
      case "Index": return go(x.obj) || go(x.index);
      case "TypeTest": return go(x.expr);
      case "If": return go(x.cond) || (go(x.then) && (x.else_ ? go(x.else_) : false));
      case "Match": return go(x.subject) || (x.branches.length > 0 && x.branches.every(b => go(b.body)));
      case "Do": case "Try": return x.stmts.some(s => stmtGo(s));
      case "For": return x.clauses.some(c => (c.tag === "Gen" ? go(c.iter) : false));  // body may run 0 times
      case "Range": return go(x.from) || go(x.to);
      case "Tuple": case "List": return x.elems.some(go);
      case "Record": return x.fields.some(f => go(f.value)) || (x.spread ? go(x.spread) : false);
      default: return false;  // Lit, Lambda (not called here), Element, …
    }
  };
  const stmtGo = (s: Stmt): boolean => {
    switch (s.tag) {
      case "SBind": return go(s.value);
      case "SExpr": return go(s.expr);
      case "SAssign": return go(s.target) || go(s.value);
      case "SBreak": case "SReturn": return s.value ? go(s.value) : false;
    }
  };
  return go(e);
}

function copyEnv(env: Env): Env {
  return {
    aliases: new Map(env.aliases), smaller: new Map(env.smaller),
    localLambdas: new Set(env.localLambdas), lambdaDepth: env.lambdaDepth,
  };
}

function shadow(env: Env, name: string): void {
  env.aliases.delete(name);
  env.smaller.delete(name);
  env.localLambdas.delete(name);
}

// ── The walk ──────────────────────────────────────────────────────────────────

class Walker {
  constructor(
    private fnName: string,
    private totalNames: Set<string>,
    private resolutions: ResolutionMap,
    private diags: Diagnostic[],
    private report: FnReport,
  ) {}

  private err(span: import("./span.js").Span, message: string): void {
    this.diags.push({ kind: "error", span, message });
  }

  expr(e: Expr, env: Env): void {
    switch (e.tag) {
      case "Lit": case "Continue": case "JSExpr": case "Machine":
      case "Element": case "Handler": case "Loop": case "Await": case "Go":
      case "Send": case "Resume": case "Transaction": case "Retry": {
        const forbidden: Partial<Record<Expr["tag"], string>> = {
          Loop: "a bare `loop` is unbounded (use `for` over a finite collection)",
          Await: "`await` can block forever — totality is a promise about compute, not IO",
          Go: "`go` spawns a concurrent task",
          Send: "`send` reaches a live store/stream",
          Resume: "`resume` re-enters a saga",
          Transaction: "`transaction` coordinates live stores",
          Retry: "`retry` re-runs on failure without a bound the checker can see",
          JSExpr: "raw `@js{}` is opaque to the structural check",
          Machine: "a `machine` runs until its input ends",
          Element: "@total is for compute helpers — element trees pull in handlers and convergence",
          Handler: "event handlers run on live input",
        };
        const why = forbidden[e.tag];
        if (why) this.err(e.span, `@total function '${this.fnName}' may not terminate — ${why}`);
        return;
      }
      case "Var": {
        // The fn's own name reached OUTSIDE call position — it escapes as a
        // value, and the structural check cannot follow where it gets called.
        const b = this.resolutions.get(e);
        if (b?.kind === "fn" && e.name === this.fnName) {
          this.err(e.span, `@total function '${this.fnName}' may not terminate — '${this.fnName}' escapes as a value inside its own body`);
        }
        return;
      }
      case "Call": this.call(e, env); return;
      case "BinOp": this.expr(e.left, env); this.expr(e.right, env); return;
      case "UnOp": case "Propagate": case "Drop": case "AddrOf": case "Deref":
        this.expr(e.expr, env); return;
      case "PropWith": this.expr(e.expr, env); this.expr(e.alt, env); return;
      case "Field": this.expr(e.obj, env); return;
      case "Index": this.expr(e.obj, env); this.expr(e.index, env); return;
      case "TypeTest": this.expr(e.expr, env); return;
      case "Lambda": {
        const inner = copyEnv(env);
        inner.lambdaDepth++;
        for (const p of e.params) for (const b of innerBinders(p.pat)) shadow(inner, b);
        this.expr(e.body, inner);
        return;
      }
      case "Match": this.match(e, env); return;
      case "If": {
        this.scanFloor(e.cond, env);
        this.expr(e.cond, env);
        this.expr(e.then, copyEnv(env));
        if (e.else_) this.expr(e.else_, copyEnv(env));
        return;
      }
      case "Do": case "Try": this.block(e.stmts, env); return;
      case "For": {
        const inner = copyEnv(env);
        for (const c of e.clauses) {
          if (c.tag === "Gen") {
            this.expr(c.iter, inner);
            for (const b of innerBinders(c.binding)) shadow(inner, b);
          } else {
            this.scanFloor(c.cond, inner);
            this.expr(c.cond, inner);
          }
        }
        this.expr(e.body, inner);
        return;
      }
      case "Range": this.expr(e.from, env); this.expr(e.to, env); return;
      case "Tuple": case "List": for (const el of e.elems) this.expr(el, env); return;
      case "Record":
        for (const f of e.fields) this.expr(f.value, env);
        if (e.spread) this.expr(e.spread, env);
        return;
      case "Break": if (e.value) this.expr(e.value, env); return;
      default: return;
    }
  }

  private block(stmts: Stmt[], outer: Env): void {
    const env = copyEnv(outer);
    for (const s of stmts) {
      switch (s.tag) {
        case "SBind": {
          this.expr(s.value, env);
          const binders = innerBinders(s.pat);
          for (const b of binders) shadow(env, b);
          // `let g = fn … -> …`: the lambda body was walked above under the same
          // rules, so calling g later in this body is safe.
          if (s.pat.tag === "PVar" && s.value.tag === "Lambda") env.localLambdas.add(s.pat.name);
          break;
        }
        case "SExpr": this.expr(s.expr, env); break;
        case "SAssign": this.expr(s.target, env); this.expr(s.value, env); break;
        case "SBreak": if (s.value) this.expr(s.value, env); break;
        case "SReturn": if (s.value) this.expr(s.value, env); break;
      }
    }
  }

  private match(e: Expr & { tag: "Match" }, env: Env): void {
    this.expr(e.subject, env);
    // Destructuring an alias (or something already smaller) yields smaller parts;
    // a bare binder branch is a rebinding at the same size (the factorial idiom).
    let pos = -1, mode: "alias" | "smaller" = "alias";
    if (e.subject.tag === "Var") {
      const a = env.aliases.get(e.subject.name);
      const s = env.smaller.get(e.subject.name);
      if (a !== undefined) { pos = a; mode = "alias"; }
      else if (s !== undefined) { pos = s; mode = "smaller"; }
    }
    for (const br of e.branches) {
      const inner = copyEnv(env);
      if (pos >= 0) {
        if (br.pat.tag === "PVar" || br.pat.tag === "PTyped") {
          (mode === "alias" ? inner.aliases : inner.smaller).set(br.pat.name, pos);
        } else {
          for (const b of innerBinders(br.pat)) inner.smaller.set(b, pos);
          if (br.pat.tag === "PLit" && br.pat.lit.tag === "Num") this.report.floorWitness.add(pos);
        }
      } else {
        for (const b of innerBinders(br.pat)) shadow(inner, b);
      }
      if (br.guard) { this.scanFloor(br.guard, inner); this.expr(br.guard, inner); }
      this.expr(br.body, inner);
    }
  }

  // A comparison over a param alias in an if-cond or guard counts as a numeric
  // floor witness (`if n <= 0 then base else f(n - 1)`).
  private scanFloor(cond: Expr, env: Env): void {
    if (cond.tag === "BinOp") {
      if (["<", "<=", ">", ">=", "==", "!="].includes(cond.op)) {
        for (const side of [cond.left, cond.right]) {
          if (side.tag === "Var") {
            const p = env.aliases.get(side.name) ?? env.smaller.get(side.name);
            if (p !== undefined) this.report.floorWitness.add(p);
          }
        }
      }
      this.scanFloor(cond.left, env);
      this.scanFloor(cond.right, env);
    } else if (cond.tag === "UnOp") {
      this.scanFloor(cond.expr, env);
    }
  }

  // ── Calls: recursion sites + the downward gate ──────────────────────────────

  private call(e: Expr & { tag: "Call" }, env: Env): void {
    for (const a of e.args) this.expr(a, env);
    for (const na of e.named) this.expr(na.value, env);

    const callee = e.fn;
    if (callee.tag === "Var") {
      const b = this.resolutions.get(callee);
      if (b) {
        switch (b.kind) {
          case "fn": {
            if (callee.name === this.fnName) {
              if (env.lambdaDepth > 0) {
                this.err(e.span, `@total function '${this.fnName}' may not terminate — recursive call inside a lambda (the structural check cannot bound closure calls)`);
              } else {
                this.report.recCalls.push({ span: e.span, verdicts: e.args.map((a, i) => this.verdict(a, i, env)) });
              }
            } else {
              this.report.calledFns.add(callee.name);
              if (!this.totalNames.has(callee.name)) {
                this.err(e.span, `@total function '${this.fnName}' calls '${callee.name}', which is not @total — totality flows down the call graph`);
              }
            }
            return;
          }
          case "ctor": case "type": return;
          case "param":
            this.err(e.span, `@total function '${this.fnName}' calls its function parameter '${callee.name}' — argument totality is unknown (@total HOFs need Tier 2)`);
            return;
          case "var":
            if (!env.localLambdas.has(callee.name)) {
              this.err(e.span, `@total function '${this.fnName}' calls '${callee.name}', a local binding whose totality the structural check cannot see`);
            }
            return;
          default:
            this.err(e.span, `@total function '${this.fnName}' calls '${callee.name}' (${b.kind}), which the structural check cannot bound`);
            return;
        }
      }
      // No resolution entry: a builtin.
      if (TOTAL_HOF_BUILTINS.has(callee.name)) {
        this.checkHofArg(e, env);
        return;
      }
      if (!TOTAL_BUILTINS.has(callee.name)) {
        this.err(e.span, `@total function '${this.fnName}' calls builtin '${callee.name}', which is not in the terminating set`);
      }
      return;
    }
    if (callee.tag === "Field" && callee.obj.tag === "Var" && TOTAL_NAMESPACES.has(callee.obj.name)) {
      return;  // Math.* is terminating compute
    }
    if (callee.tag === "Lambda") {
      this.expr(callee, env);  // IIFE — body checked under the same rules
      return;
    }
    this.err(e.span, `@total function '${this.fnName}' calls a computed expression — the structural check cannot bound it`);
    this.expr(callee, env);
  }

  // HOF builtins iterate a finite collection; the residual obligation is the fn
  // argument at position 0 (inverse of the latent-effect rule, SPEC §12.4).
  private checkHofArg(e: Expr & { tag: "Call" }, env: Env): void {
    const hof = (e.fn as Expr & { tag: "Var" }).name;
    const f = e.args[0];
    if (!f) return;  // curried/underapplied — the gate fires where it's applied
    if (f.tag === "Lambda") return;  // body already walked by the args loop above
    if (f.tag === "Var") {
      const b = this.resolutions.get(f);
      if (b?.kind === "fn" && this.totalNames.has(f.name)) return;
      if (b?.kind === "ctor") return;
      if (b?.kind === "var" && env.localLambdas.has(f.name)) return;
      if (!b && TOTAL_BUILTINS.has(f.name)) return;
      this.err(e.span, `@total function '${this.fnName}' passes '${f.tag === "Var" ? f.name : "?"}' (not @total) to '${hof}' — the callee may call it`);
      return;
    }
    this.err(e.span, `@total function '${this.fnName}' passes a computed function to '${hof}' — the structural check cannot bound it`);
  }

  // Is the argument sitting at position `i` strictly smaller than param `i`?
  // The measure compares like-for-like positions, so a part of param 0 passed
  // at position 1 does NOT count.
  private verdict(arg: Expr, i: number, env: Env): "none" | "struct" | "num" {
    if (arg.tag === "Var" && env.smaller.get(arg.name) === i) return "struct";
    if (arg.tag === "BinOp" && arg.op === "-" &&
        arg.left.tag === "Var" &&
        arg.right.tag === "Lit" && arg.right.lit.tag === "Num" && arg.right.lit.value > 0) {
      if (env.aliases.get(arg.left.name) === i || env.smaller.get(arg.left.name) === i) return "num";
    }
    return "none";
  }
}
