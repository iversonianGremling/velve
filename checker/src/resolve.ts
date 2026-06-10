import type { Span } from "./span.js";
import type { Module, Decl, Expr, Stmt, Pat, FnClause } from "./ast.js";

// ── Public types ──────────────────────────────────────────────────────────────

export type BindingKind = "fn" | "type" | "ctor" | "store" | "saga" | "var" | "param" | "typeParam";

export interface Binding {
  name: string;
  kind: BindingKind;
  span: Span;
}

export interface Diagnostic {
  kind: "error" | "warning";
  span: Span;
  message: string;
}

// Maps each Var expression node (by object identity) to its resolved Binding.
export type ResolutionMap = Map<Expr & { tag: "Var" }, Binding>;

export interface ScopeSnapshot {
  span: Span;
  scope: Scope;
}

export interface ResolutionResult {
  globals: Scope;
  resolutions: ResolutionMap;
  diagnostics: Diagnostic[];
  snapshots: ScopeSnapshot[];
}

export function resolve(mod: Module): ResolutionResult {
  return new Resolver().run(mod);
}

// ── Scope ────────────────────────────────────────────────────────────────────

export class Scope {
  private map = new Map<string, Binding>();
  constructor(public readonly parent: Scope | null = null) {}

  define(name: string, b: Binding): void {
    this.map.set(name, b);
  }

  lookup(name: string): Binding | null {
    return this.map.get(name) ?? this.parent?.lookup(name) ?? null;
  }

  // All bindings directly in this scope (not parent).
  own(): Binding[] { return [...this.map.values()]; }
}

// ── Resolver ──────────────────────────────────────────────────────────────────

class Resolver {
  private resolutions: ResolutionMap = new Map();
  private diagnostics: Diagnostic[]  = [];
  private snapshots: ScopeSnapshot[]  = [];

  run(mod: Module): ResolutionResult {
    const globals = new Scope();
    this.collectDecls(mod.decls, globals);
    for (const decl of mod.decls) this.resolveDecl(decl, globals);
    return { globals, resolutions: this.resolutions, diagnostics: this.diagnostics, snapshots: this.snapshots };
  }

  // ── Pass 1: collect top-level names ─────────────────────────────────────────

  private collectDecls(decls: Decl[], scope: Scope): void {
    for (const decl of decls) {
      switch (decl.tag) {
        case "DFn":
          scope.define(decl.name, { name: decl.name, kind: "fn", span: decl.span });
          break;
        case "DType":
          scope.define(decl.name, { name: decl.name, kind: "type", span: decl.span });
          // ADT constructors are callable names
          if (decl.body.tag === "TBAdt") {
            for (const v of decl.body.variants) {
              scope.define(v.name, { name: v.name, kind: "ctor", span: v.span });
            }
          }
          break;
        case "DStore":
          scope.define(decl.name, { name: decl.name, kind: "store", span: decl.span });
          for (const msg of decl.messages) {
            scope.define(msg.name, { name: msg.name, kind: "fn", span: decl.span });
          }
          break;
        case "DSaga":
          scope.define(decl.name, { name: decl.name, kind: "saga", span: decl.span });
          break;
        case "DStream":
          // A stream is a channel value (read via `await`, written via `send`).
          scope.define(decl.name, { name: decl.name, kind: "store", span: decl.span });
          // Register Push and Done constructors so consumers can pattern-match them.
          scope.define("Push", { name: "Push", kind: "ctor", span: decl.span });
          scope.define("Done", { name: "Done", kind: "ctor", span: decl.span });
          break;
        case "DInputmap":
          // Callable: `Editor()` runs the drain loop to stream completion.
          scope.define(decl.name, { name: decl.name, kind: "fn", span: decl.span });
          break;
        case "DLet":
          scope.define(decl.name, { name: decl.name, kind: "var", span: decl.span });
          break;
        // DImport: names brought in — treat as vars for now
        case "DImport":
          for (const { name, alias } of decl.names) {
            const resolved = alias ?? name;
            scope.define(resolved, { name: resolved, kind: "var", span: decl.span });
          }
          break;
        case "DModule":
          // Flatten module contents into the outer scope for now.
          // Qualified access (particleSystem.fn) is not yet supported.
          this.collectDecls(decl.decls, scope);
          break;
      }
    }
  }

  // ── Pass 2: resolve bodies ───────────────────────────────────────────────────

  private resolveDecl(decl: Decl, scope: Scope): void {
    if (decl.tag === "DModule") {
      for (const inner of decl.decls) this.resolveDecl(inner, scope);
      return;
    }
    if (decl.tag === "DSaga") {
      // The saga's constructor inputs are in scope across every step body.
      const sagaScope = new Scope(scope);
      for (const p of decl.params) this.bindPat(p.pat, sagaScope);
      if (decl.store) {
        const b = scope.lookup(decl.store);
        if (!b) this.error(decl.span, `saga backs unknown store '${decl.store}' — declare it with \`store ${decl.store}\``);
        else if (b.kind !== "store") this.error(decl.span, `saga store '${decl.store}' is not a store (it is a ${b.kind})`);
      }
      this.resolveSteps(decl.steps, sagaScope);
      return;
    }
    if (decl.tag === "DLet") {
      // A module-level constant: resolve its RHS against the global scope (the name
      // itself is already registered by collectDecls, so siblings can forward-ref it).
      this.resolveExpr(decl.value, scope);
      return;
    }
    if (decl.tag === "DInputmap") {
      // The `over` target must be a declared stream; each row's action resolves
      // with the row pattern's bindings in scope (like a match branch).
      const src = scope.lookup(decl.stream);
      if (!src) this.error(decl.span, decl.form === "keymap"
        ? `keymap '${decl.name}' needs a \`Key\` stream in scope — declare \`stream Key : Chord\` (a keymap is sugar for \`inputmap ${decl.name} over Key\`)`
        : `inputmap '${decl.name}' is over unknown stream '${decl.stream}' — declare it with \`stream ${decl.stream} : T\``);
      for (const row of decl.rows) {
        const rs = new Scope(scope);
        this.bindPat(row.pat, rs);
        if (row.guard) this.resolveExpr(row.guard, rs);
        this.resolveExpr(row.action, rs);
      }
      return;
    }
    if (decl.tag !== "DFn") return;
    for (const clause of decl.clauses) this.resolveClause(clause, scope);
  }

  // Resolve the bodies of machine/saga steps. Each step's params are bound for
  // the duration of its body; transition targets are atoms and need no lookup.
  private resolveSteps(steps: import("./ast.js").MachineStep[], parent: Scope): void {
    for (const step of steps) {
      const scope = new Scope(parent);
      for (const p of step.params) scope.define(p, { name: p, kind: "param", span: step.span });
      this.resolveSagaBody(step.body, scope);
    }
  }

  private resolveSagaBody(body: import("./ast.js").SagaStmt[], parent: Scope): void {
    let scope = parent;
    for (const stmt of body) {
      switch (stmt.tag) {
        case "Goto":     for (const a of stmt.args) this.resolveExpr(a, scope); break;
        case "Yield":    this.resolveExpr(stmt.expr, scope); break;
        case "SagaGo":   this.resolveExpr(stmt.expr, scope); break;
        case "Rollback": this.resolveExpr(stmt.expr, scope); break;
        case "SBindS": {
          this.resolveExpr(stmt.value, scope);
          const next = new Scope(scope);
          next.define(stmt.name, { name: stmt.name, kind: "var", span: stmt.span });
          scope = next;
          break;
        }
        case "SagaMatch": {
          this.resolveExpr(stmt.subject, scope);
          for (const br of stmt.branches) {
            const bs = new Scope(scope);
            this.bindPat(br.pat, bs);
            this.resolveSagaBody(br.body, bs);
          }
          break;
        }
        case "SagaIf": {
          this.resolveExpr(stmt.cond, scope);
          this.resolveSagaBody(stmt.then, new Scope(scope));
          this.resolveSagaBody(stmt.else_, new Scope(scope));
          break;
        }
        case "SagaJoin": {
          for (const t of stmt.tasks) this.resolveExpr(t, scope);
          for (const br of stmt.branches) {
            const bs = new Scope(scope);
            this.bindPat(br.pat, bs);
            this.resolveSagaBody(br.body, bs);
          }
          break;
        }
        case "SagaRace": {
          for (const arm of stmt.arms) if (arm.expr) this.resolveExpr(arm.expr, scope);
          for (const br of stmt.branches) {
            const bs = new Scope(scope);
            this.bindPat(br.pat, bs);
            this.resolveSagaBody(br.body, bs);
          }
          break;
        }
      }
    }
  }

  private resolveClause(clause: FnClause, parent: Scope): void {
    const scope = new Scope(parent);
    for (const p of clause.params) this.bindPat(p.pat, scope);
    for (const { pat, value } of clause.where_) {
      this.resolveExpr(value, scope);
      this.bindPat(pat, scope);
    }
    // `using S` (named) references an outer role — must resolve, else a typo
    // silently no-ops the ambient surface. `using surface = <expr>` (inline)
    // declares the name into the body scope after resolving its value.
    if (clause.surface) {
      if (clause.surface.value) {
        this.resolveExpr(clause.surface.value, scope);
        scope.define(clause.surface.name, { name: clause.surface.name, kind: "var", span: clause.span });
      } else if (!scope.lookup(clause.surface.name)) {
        this.error(clause.span, `unresolved surface role: ${clause.surface.name}`);
      }
    }
    this.snapshots.push({ span: clause.body.span, scope });
    this.resolveExpr(clause.body, scope);
  }

  // ── Expression resolution ────────────────────────────────────────────────────

  private resolveExpr(expr: Expr, scope: Scope): void {
    switch (expr.tag) {
      case "Lit": break;

      case "Var": {
        const b = scope.lookup(expr.name);
        if (b) {
          this.resolutions.set(expr, b);
        } else if (!isBuiltin(expr.name)) {
          this.error(expr.span, `unresolved name: ${expr.name}`);
        }
        break;
      }

      case "Call":
        this.resolveExpr(expr.fn, scope);
        for (const a of expr.args) this.resolveExpr(a, scope);
        break;

      case "BinOp":
        this.resolveExpr(expr.left, scope);
        this.resolveExpr(expr.right, scope);
        break;

      case "UnOp":
        this.resolveExpr(expr.expr, scope);
        break;

      case "Field":
        this.resolveExpr(expr.obj, scope);
        break;

      case "Index":
        this.resolveExpr(expr.obj, scope);
        this.resolveExpr(expr.index, scope);
        break;

      case "Lambda": {
        const inner = new Scope(scope);
        for (const p of expr.params) this.bindPat(p.pat, inner);
        this.snapshots.push({ span: expr.body.span, scope: inner });
        this.resolveExpr(expr.body, inner);
        break;
      }

      case "Match": {
        this.resolveExpr(expr.subject, scope);
        for (const b of expr.branches) {
          const bs = new Scope(scope);
          this.bindPat(b.pat, bs);
          if (b.guard) this.resolveExpr(b.guard, bs);
          this.snapshots.push({ span: b.body.span, scope: bs });
          this.resolveExpr(b.body, bs);
        }
        break;
      }

      case "If":
        this.resolveExpr(expr.cond, scope);
        this.resolveExpr(expr.then, scope);
        if (expr.else_) this.resolveExpr(expr.else_, scope);
        break;

      case "Do": {
        const finalScope = this.resolveBlock(expr.stmts, scope);
        this.snapshots.push({ span: expr.span, scope: finalScope });
        break;
      }
      case "Loop": {
        const finalScope = this.resolveBlock(expr.stmts, scope);
        this.snapshots.push({ span: expr.span, scope: finalScope });
        break;
      }

      case "For": {
        let inner = scope;
        for (const clause of expr.clauses) {
          if (clause.tag === "Gen") {
            this.resolveExpr(clause.iter, inner);
            inner = new Scope(inner);
            this.bindPat(clause.binding, inner);
          } else {
            this.resolveExpr(clause.cond, inner);
          }
        }
        this.snapshots.push({ span: expr.body.span, scope: inner });
        this.resolveExpr(expr.body, inner);
        break;
      }

      case "Await":
        this.resolveExpr(expr.expr, scope);
        for (const b of expr.branches) {
          const bs = new Scope(scope);
          this.bindPat(b.pat, bs);
          if (b.guard) this.resolveExpr(b.guard, bs);
          this.snapshots.push({ span: b.body.span, scope: bs });
          this.resolveExpr(b.body, bs);
        }
        break;

      case "Tuple": for (const e of expr.elems)  this.resolveExpr(e, scope); break;
      case "List":  for (const e of expr.elems)  this.resolveExpr(e, scope); break;
      case "Record": for (const f of expr.fields) this.resolveExpr(f.value, scope); break;

      case "Go":        this.resolveExpr(expr.expr, scope); break;
      case "Resume":    this.resolveExpr(expr.expr, scope); break;
      case "Propagate": this.resolveExpr(expr.expr, scope); break;
      case "PropWith":
        this.resolveExpr(expr.expr, scope);
        this.resolveExpr(expr.alt, scope);
        break;

      case "Range":
        this.resolveExpr(expr.from, scope);
        this.resolveExpr(expr.to, scope);
        break;

      case "TypeTest": this.resolveExpr(expr.expr, scope); break;

      case "Element":
        if (expr.content) this.resolveExpr(expr.content, scope);
        for (const p of expr.props)    this.resolveExpr(p.value, scope);
        for (const c of expr.children) this.resolveExpr(c, scope);
        break;

      case "Handler": {
        // The optional event param is in scope only inside the handler body.
        const hScope = expr.param ? new Scope(scope) : scope;
        if (expr.param) hScope.define(expr.param, { name: expr.param, kind: "param", span: expr.span });
        this.resolveExpr(expr.body, hScope);
        break;
      }

      case "Machine": {
        // `saga StoreName` backs the machine to a declared store (SPEC §4.2).
        // A bare `machine` has no store and needs no check.
        if (expr.store) {
          const b = scope.lookup(expr.store);
          if (!b) {
            this.error(expr.span, `saga backs unknown store '${expr.store}' — declare it with \`store ${expr.store}\``);
          } else if (b.kind !== "store") {
            this.error(expr.span, `saga store '${expr.store}' is not a store (it is a ${b.kind})`);
          }
        }
        this.resolveSteps(expr.steps, scope);
        break;
      }

      case "Transaction": {
        if (expr.config) this.resolveExpr(expr.config, scope);
        const finalScope = this.resolveBlock(expr.body, scope);
        this.snapshots.push({ span: expr.span, scope: finalScope });
        break;
      }
    }
  }

  // Statements share a growing scope: each SBind extends the scope for everything after it.
  private resolveBlock(stmts: Stmt[], parentScope: Scope): Scope {
    let scope = parentScope;
    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          this.resolveExpr(stmt.value, scope);
          const next = new Scope(scope);
          this.bindPat(stmt.pat, next);
          scope = next;
          break;
        }
        case "SExpr":
          this.resolveExpr(stmt.expr, scope);
          break;
        case "SAssign":
          this.resolveExpr(stmt.target, scope);
          this.resolveExpr(stmt.value, scope);
          break;
        case "SBreak":
        case "SReturn":
          if (stmt.value) this.resolveExpr(stmt.value, scope);
          break;
      }
    }
    return scope;
  }

  // ── Pattern binding ───────────────────────────────────────────────────────────

  private bindPat(pat: Pat, scope: Scope): void {
    switch (pat.tag) {
      case "PVar":
        scope.define(pat.name, { name: pat.name, kind: "var", span: pat.span });
        break;
      case "PTuple":
        for (const e of pat.elems) this.bindPat(e, scope);
        break;
      case "PRecord":
        for (const f of pat.fields) this.bindPat(f.pat, scope);
        break;
      case "PCtor":
        if (pat.inner) this.bindPat(pat.inner, scope);
        break;
      case "PTyped":
        scope.define(pat.name, { name: pat.name, kind: "var", span: pat.span });
        break;
      // PWild, PLit, PAtom bind nothing
    }
  }

  // ── Diagnostics ───────────────────────────────────────────────────────────────

  private error(span: Span, message: string): void {
    this.diagnostics.push({ kind: "error", span, message });
  }
}

// Names that are language builtins and don't need a definition in scope.
// Kept minimal — the type checker will handle actual primitive types.
const BUILTINS = new Set([
  "__arg",
  // Result / Option constructors
  "Ok", "Error", "Some", "None",
  // Named parse-error ADT (single ctor, shared name) + the canonical boundary parser
  "ParseError", "parseNumber",
  // Async(a) loading-state constructors (§2.10) — `Error` shared with Result above
  "Before", "During", "After",
  // Transaction-outcome constructors. `Conflict`/`Timeout`/`Cancelled` are stable;
  // `Committed`/`Aborted` are the 2026.6 commit/abort ctors (2026.1 reuses Ok/Error
  // from Result above). All registered unconditionally — they only resolve as names.
  "Conflict", "Timeout", "Cancelled", "Committed", "Aborted",
  // Layout `Length` constructors + off-scale escape + fluid band
  "Px", "Fr", "Pct", "Fit", "Fill", "raw", "Clamp",
  // Layout `Breakpoint` (closed responsive variant) + read-only viewport/theme roots
  "Mobile", "Tablet", "Desktop", "Wide", "viewport", "setViewport", "theme", "setTheme",
  // Convergence vocabulary (§6): cross-element prop references + aggregates
  "self", "parent", "prev", "next", "children", "sum", "avg",
  // State taxonomy (§12): Interaction + UIState constructors, resolver, enums
  "Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled",
  "Empty", "Loading", "Partial", "Failed", "Ideal",
  "Off", "On", "Mixed", "Valid", "Invalid", "Pending",
  "interactionOf", "Interaction", "UIState", "Toggle", "Validity",
  // I/O
  "print", "println", "toString",
  // Math
  "abs", "floor", "ceil", "round", "sqrt", "max", "min", "int", "not",
  // List
  "length", "isEmpty", "head", "tail", "append", "prepend", "concat",
  "reverse", "slice", "zip", "range", "map", "filter", "foldl", "foldr",
  "forEach", "flatMap", "any", "all", "sortBy",
  // String
  "trim", "split", "join", "contains", "matches", "startsWith", "endsWith",
  "toUpperCase", "toLowerCase", "parseInt", "parseFloat",
  // Streams
  "streamMap", "streamFilter", "streamTake", "streamFold",
  "streamMerge", "streamDebounce", "streamThrottle", "externSource", "help",
  // Concurrency
  "sleep", "pmap", "pfilter", "parallel",
  // UI
  "html", "uiModel", "sandbox", "analyze", "interactive", "uiJson", "domHost",
  // Saga introspection
  "journalOf", "crash",
]);

function isBuiltin(name: string): boolean {
  if (BUILTINS.has(name)) return true;
  // send_X / ask_X are synthesized names from the lowerer
  if (name.startsWith("send_") || name.startsWith("ask_")) return true;
  return false;
}
