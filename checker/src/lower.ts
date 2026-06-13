import type { SyntaxNode, Tree } from "tree-sitter";
import { spanFrom } from "./span.js";
import type { Span } from "./span.js";
import type { Diagnostic } from "./resolve.js";
import type {
  Expr, Stmt, Pat, TypeRef, Decl, Module, FnClause, FnSig,
  Param, Branch, Prop, NamedArg, Lit, TypeBody, AdtVariant, StreamPolicy, InputmapRow,
} from "./ast.js";
import { type Edition, DEFAULT_EDITION, EDITIONS, parseEdition, atLeast } from "./edition.js";
import { PRIMITIVE_ELEMENTS } from "./elements.js";

type N = SyntaxNode;

// ── Node category sets ────────────────────────────────────────────────────────

const TYPE_KINDS = new Set([
  "simple_type", "type_var", "unit_type", "parameterized_type",
  "record_type", "tuple_type", "function_type", "tainted_type", "effect_type",
  "async_type", "array_type", "result_type", "pointer_type", "atomic_type",
]);

const PAT_KINDS = new Set([
  "pattern", "simple_pattern", "guard_pattern", "binding_pattern",
  "wildcard", "record_pattern", "literal", "qualified_pattern", "tuple_pattern",
]);

const STMT_KINDS = new Set([
  "binding", "block_binding", "index_assign", "deref_assign", "destructure",
  "on_handler", "pipe_block", "try_block", "retry_block", "brace_binding", "loop_expr", "await_stmt", "go_stmt",
  "machine_expr", "saga_expr", "where_stmt", "if_expr", "if_pattern_expr",
  "match_expr", "responsive_expr", "transaction_expr", "comptime_block", "unsafe_block",
  "pipe_match_stmt", "pipe_lambda_stmt", "element",
]);

const EXPR_KINDS = new Set([
  "literal", "identifier_expr", "unary_expr", "binary_expr", "pipe_expr",
  "ternary_expr", "if_then_expr", "field_access", "optional_chain", "array_index",
  "deref_expr", "addr_of_expr", "propagate_expr", "range_expr",
  "if_pattern_expr", "type_test", "record_literal", "record_spread",
  "list_literal", "for_expr", "for_child", "match_expr", "responsive_expr", "if_expr", "call", "call_child",
  "lambda", "lambda_simple", "lambda_block", "send_expr",
  "ask_expr", "transaction_expr", "js_block", "unsafe_block", "comptime_block",
  "lazy_expr", "go_expr", "resume_expr", "drop_expr", "break_expr", "continue_expr", "grouped", "tuple_literal", "js_block", "send_expr",
  "await_expr", "pipe_block", "try_block", "retry_block", "brace_block", "loop_expr", "machine_expr", "saga_expr", "element", "element_leaf",
  "lower_id", "upper_id", "number", "bool", "string", "multiline_string",
  "unit", "atom_lit", "duration_lit", "hex_color", "sigil_string", "regex_sigil",
]);

function isTypeKind(n: N): boolean { return TYPE_KINDS.has(n.type); }
function isPatKind(t: string): boolean { return PAT_KINDS.has(t); }
function isStmtKind(t: string): boolean { return STMT_KINDS.has(t); }
function isExprKind(t: string): boolean { return EXPR_KINDS.has(t); }

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseNumber(text: string): number {
  const s = text.replace(/_/g, "");
  if (s.startsWith("0b")) return parseInt(s.slice(2), 2);
  if (s.startsWith("0x")) return parseInt(s.slice(2), 16);
  return parseFloat(s);
}

// Resolve backslash escapes in string literal text. `\{` / `\}` produce literal
// braces (so JSON-shaped text can be written without triggering interpolation);
// `\n \t \r \" \\` are the usual C-style escapes; an unknown `\x` drops the
// backslash and keeps `x`.
function unescapeStr(s: string): string {
  return s.replace(/\\(.)/g, (_, c: string) => {
    switch (c) {
      case "n":  return "\n";
      case "t":  return "\t";
      case "r":  return "\r";
      case '"':  return '"';
      case "\\": return "\\";
      case "{":  return "{";
      case "}":  return "}";
      default:   return c;
    }
  });
}

function parseDuration(text: string): number {
  if (text.endsWith("ms")) return parseInt(text) ;
  if (text.endsWith("s"))  return parseInt(text) * 1000;
  if (text.endsWith("m"))  return parseInt(text) * 60_000;
  if (text.endsWith("h"))  return parseInt(text) * 3_600_000;
  return 0;
}

// ── Lowerer ───────────────────────────────────────────────────────────────────

export class Lowerer {
  // Diagnostics raised during lowering (CST→AST), e.g. empty string interpolation.
  // The CLI (`check`/`run`) and the LSP read this after `lower()` and merge it with
  // the resolve/infer/exhaust/borrow diagnostics.
  readonly diagnostics: Diagnostic[] = [];

  // The module's resolved edition, set at the top of `lower()`. Edition-gated
  // surface deprecations (e.g. the ternary → if/then/else migration) read it.
  private edition: Edition = DEFAULT_EDITION;

  constructor(private readonly file: string) {}

  private sp(n: N): Span { return spanFrom(n, this.file); }

  private err(span: Span): Expr {
    return { tag: "Lit", lit: { tag: "Unit" }, span };
  }

  // ── Module ──────────────────────────────────────────────────────────────────

  lower(tree: Tree): Module {
    const named = tree.rootNode.namedChildren.filter(c => c.type !== "comment");
    const edition = this.lowerEdition(named.find(c => c.type === "edition_pragma") ?? null);
    this.edition = edition;
    const decls = this.lowerDeclList(named.filter(c => c.type !== "edition_pragma"));
    return { source: this.file, decls, edition };
  }

  // Resolve the module's `@edition` pragma (or DEFAULT_EDITION when absent). An
  // unrecognized edition name is a diagnostic; we fall back to the default so the
  // rest of the pipeline still runs.
  private lowerEdition(n: N | null): Edition {
    if (!n) return DEFAULT_EDITION;
    const raw = (n.childForFieldName("name")?.text ?? "").replace(/^"|"$/g, "");
    const ed = parseEdition(raw);
    if (ed) return ed;
    this.diagnostics.push({
      kind: "error",
      message: `unknown edition "${raw}" — known editions: ${EDITIONS.join(", ")}`,
      span: this.sp(n),
    });
    return DEFAULT_EDITION;
  }

  // Shared logic for lowering any list of declaration nodes — used by both
  // the top-level program and module bodies.
  private lowerDeclList(nodes: N[]): Decl[] {
    const named = nodes.filter(c => c.type !== "comment");
    const fnGroups = new Map<string, N[]>();
    const fnSigs   = new Map<string, N>();
    // Function names opted into the low-level tier via `@low`/`@kernel def …`.
    const lowLevelFns = new Set<string>();
    // Function names that promised totality via `@total def …` (totality-design §3).
    const totalFns = new Set<string>();
    type Item = { kind: "fn"; name: string } | { kind: "other"; node: N };
    const order: Item[] = [];
    const seen = new Set<string>();

    for (const node of named) {
      const isDecorated = node.type === "decorator_def";
      const inner = isDecorated
        ? (node.namedChildren.find(c => c.type === "function_def" || c.type === "type_def") ?? node)
        : node;
      // A `@low`/`@kernel` decorator on a function marks it low-tier.
      const decoNames = isDecorated
        ? node.namedChildren.filter(c => c.type === "decorator").map(d => d.namedChild(0)?.text ?? "")
        : [];
      const isLow = decoNames.some(d => d === "low" || d === "kernel");
      const isTotal = decoNames.includes("total");
      // The marker set is closed (SPEC §3.20): two axes only — `@low`/`@kernel`
      // (low-level tier) and `@private` (ADT constructors), plus `@total`
      // (function totality, the function-scope shorthand for `proofs: [total]`).
      // The formerly-inert annotations (`@deprecated`/`@idempotent`/
      // `@audioKernel`) are pruned — an unknown decorator is an error, never a
      // silent no-op (the same "declared = enforced" discipline as `proofs:`).
      for (const dn of decoNames) {
        if (!Lowerer.KNOWN_DECORATORS.has(dn)) {
          this.diagnostics.push({ kind: "error", span: this.sp(node),
            message: `unknown decorator '@${dn}' — the markers are @low/@kernel (low-level tier), @total (function totality), @private (ADT constructors)` });
        }
      }
      // `@total` promises termination of a FUNCTION — on a type def it's meaningless.
      if (isTotal && inner.type !== "function_def") {
        this.diagnostics.push({ kind: "error", span: this.sp(node), message: "`@total` marks a function definition" });
      }
      // `@private` hides CONSTRUCTORS — on a function it's a different feature
      // (not in v1); the type-def path applies it in lowerTopDecl's
      // decorator_def case.
      if (decoNames.includes("private") && inner.type !== "type_def") {
        this.diagnostics.push({ kind: "error", span: this.sp(node), message: "`@private` marks a type definition — it hides the type's constructors inside the declaring module (function privacy is not part of v1)" });
      }

      if (inner.type === "function_def") {
        const name = inner.namedChild(0)?.text ?? "?";
        if (!seen.has(name)) { seen.add(name); fnGroups.set(name, []); order.push({ kind: "fn", name }); }
        if (isLow) lowLevelFns.add(name);
        if (isTotal) totalFns.add(name);
        fnGroups.get(name)!.push(inner);
      } else if (inner.type === "function_sig") {
        const name = inner.namedChild(0)?.text ?? "?";
        fnSigs.set(name, inner);
        if (!seen.has(name)) { seen.add(name); fnGroups.set(name, []); order.push({ kind: "fn", name }); }
      } else {
        order.push({ kind: "other", node });
      }
    }

    const decls: Decl[] = [];
    for (const item of order) {
      if (item.kind === "fn") {
        decls.push(this.lowerFnGroup(item.name, fnGroups.get(item.name)!, fnSigs.get(item.name) ?? null, lowLevelFns.has(item.name), totalFns.has(item.name)));
      } else {
        const d = this.lowerTopDecl(item.node);
        if (d) decls.push(d);
      }
    }
    return decls;
  }

  // ── Declarations ────────────────────────────────────────────────────────────

  private lowerTopDecl(n: N): Decl | null {
    switch (n.type) {
      case "import_stmt":   return this.lowerImport(n);
      case "type_def":      return this.lowerTypeDef(n);
      case "store_def":     return this.lowerStoreDef(n);
      case "saga_def":      return this.lowerSagaDef(n);
      case "machine_def":   return this.lowerMachineDef(n);
      case "stream_def": {
        const name  = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
        const typeNode = n.namedChildren.find(isTypeKind);
        const inner = typeNode ? this.lowerTypeRef(typeNode) : { tag: "TRNamed" as const, name: "Unknown", args: [] };
        // Optional backpressure policy (SPEC §10.1): `drop | buffer N | block`.
        // `drop` is a keyword; `buffer`/`block` are CONTEXTUAL (a lower_id in
        // the grammar, validated here) so neither is reserved as an identifier.
        const polNode = n.namedChildren.find(c => c.type === "stream_policy");
        let policy: StreamPolicy | null = null;
        if (polNode) {
          const word = polNode.namedChildren.find(c => c.type === "lower_id")?.text ?? "drop";
          const numNode = polNode.namedChildren.find(c => c.type === "number");
          const polErr = (message: string) =>
            this.diagnostics.push({ kind: "error", span: this.sp(polNode), message });
          if (word === "drop") {
            policy = { kind: "drop" };
          } else if (word === "block") {
            if (numNode) polErr("`block` takes no capacity — it is a rendezvous (`send` suspends until a consumer takes the value).");
            policy = { kind: "block" };
          } else if (word === "buffer") {
            const cap = numNode ? Number(numNode.text) : NaN;
            if (!numNode) polErr("`buffer` needs a capacity: `buffer N`.");
            else if (!Number.isInteger(cap) || cap < 1) polErr(`\`buffer ${numNode.text}\` — stream buffer capacity must be a positive integer.`);
            policy = { kind: "buffer", n: cap };
          } else {
            polErr(`unknown stream policy \`${word}\` — expected \`drop\`, \`buffer N\`, or \`block\`.`);
          }
        }
        return { tag: "DStream", name, inner, policy, span: this.sp(n) };
      }
      case "inputmap_def": {
        // `inputmap Name over Stream` + indented `pattern -> action ["label"]`
        // rows (multitarget-design §4.0). The CST gives [name, stream, rows…].
        const ids = n.namedChildren.filter(c => c.type === "upper_id");
        const name = ids[0]?.text ?? "?";
        const stream = ids[1]?.text ?? "?";
        return { tag: "DInputmap", name, stream, form: "inputmap", rows: this.lowerInputmapRows(n), span: this.sp(n) };
      }
      case "keymap_def": {
        // `keymap Name` — sugar for `inputmap Name over Key` (multitarget
        // §4.0: "a keymap = inputmap over the keyboard"). Same decl; the form
        // tailors the missing-stream diagnostic to a keymap-shaped fix-it.
        const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
        return { tag: "DInputmap", name, stream: "Key", form: "keymap", rows: this.lowerInputmapRows(n), span: this.sp(n) };
      }
      case "module_def":    return this.lowerModuleDef(n);
      case "binding": {
        // A top-level `let name [: Type] = expr` — a module-level constant/token
        // (styles-design §4.2). Mirrors the `binding` case in lowerStmt, but lands
        // as a DLet decl rather than an SBind statement.
        const named = n.namedChildren;
        const nameId  = named.find(c => c.type === "lower_id");
        const typeNode = named.find(isTypeKind);
        const valNode  = named.find(c => c !== nameId && !isTypeKind(c) && isExprKind(c.type));
        const mutable = n.children.some(c => c.type === "mut");
        return {
          tag: "DLet",
          name: nameId?.text ?? "?",
          ascription: typeNode ? this.lowerTypeRef(typeNode) : null,
          value: valNode ? this.lowerExpr(valNode) : this.err(this.sp(n)),
          mutable,
          span: this.sp(n),
        };
      }
      case "decorator_def": {
        const inner = n.namedChildren.find(c => c.type !== "decorator");
        const d = inner ? this.lowerTopDecl(inner) : null;
        const decoNames = n.namedChildren.filter(c => c.type === "decorator").map(dd => dd.namedChild(0)?.text ?? "");
        if (decoNames.includes("private") && d?.tag === "DType") {
          // Constructors are what `@private` hides; an alias/refinement has
          // none (its gate is already `.parse`), so the marker would promise
          // an opacity transparency immediately breaks.
          if (d.body.tag === "TBAdt") d.private_ = true;
          else this.diagnostics.push({ kind: "error", span: this.sp(n), message: "`@private` marks an ADT type definition — constructors are what it hides (aliases and refinements are transparent to their base; their boundary is `.parse`)" });
        }
        return d;
      }
      default: return null;
    }
  }

  private lowerModuleDef(n: N): Decl {
    const name = n.namedChildren.find(c => c.type === "lower_id")?.text ?? "?";
    const capsNode = n.namedChildren.find(c => c.type === "capabilities_decl");
    const capabilities = capsNode?.namedChildren.filter(c => c.type === "lower_id").map(c => c.text) ?? [];
    const proofsNode = n.namedChildren.find(c => c.type === "proofs_decl");
    const proofs = this.lowerProofs(proofsNode);
    // Everything that's not the name, capabilities, proofs, or comments is a declaration.
    const bodyNodes = n.namedChildren.filter(c =>
      c.type !== "lower_id" &&
      c.type !== "capabilities_decl" &&
      c.type !== "proofs_decl" &&
      c.type !== "comment"
    );
    const decls = this.lowerDeclList(bodyNodes);
    // `proofs: [total]` means every def in the module is implicitly @total —
    // declared = enforced, top-down. Marking here keeps the engine (total.ts)
    // untouched: the decrease check and the downward call gate fire as if each
    // def carried the marker itself.
    if (proofs.includes("total")) {
      for (const d of decls) if (d.tag === "DFn") d.total = true;
    }
    return { tag: "DModule", name, capabilities, proofs, decls, span: this.sp(n) };
  }

  // The proof-obligation vocabulary is CLOSED (SPEC §12.7): six fault classes,
  // fixed up front so a declaration is portable across checker versions. All
  // seven are checkable as of B3(ii) (2026-06) — the vocabulary is now closed
  // AND complete; declaring one is an error only if it's outside the set, never
  // a skip — under `proofs:`, declared means enforced (the unchecked-mode hole
  // the effect work closed must not reappear here).
  private static readonly PROOF_VOCAB = new Set(["total", "bounds", "nonzero", "arith", "overflow", "exhaustive", "handled"]);
  private static readonly PROOF_CHECKABLE = new Set(["total", "exhaustive", "handled", "nonzero", "bounds", "arith", "overflow"]);
  // The closed marker set (SPEC §3.20). Two axes — `@low`/`@kernel` (tier) and
  // `@private` (ADT constructors) — plus `@total` (function totality). Anything
  // else is rejected; the old inert annotations are gone.
  private static readonly KNOWN_DECORATORS = new Set(["low", "kernel", "total", "private"]);

  private lowerProofs(node: N | undefined): string[] {
    if (!node) return [];
    const out: string[] = [];
    for (const id of node.namedChildren.filter(c => c.type === "lower_id")) {
      const ob = id.text;
      if (!Lowerer.PROOF_VOCAB.has(ob)) {
        this.diagnostics.push({ kind: "error", span: this.sp(id),
          message: `unknown proof obligation '${ob}' — the vocabulary is closed: total, bounds, nonzero, arith, overflow, exhaustive, handled` });
        continue;
      }
      if (!Lowerer.PROOF_CHECKABLE.has(ob)) {
        this.diagnostics.push({ kind: "error", span: this.sp(id),
          message: `proof obligation '${ob}' is not checkable yet — declaring it would promise an unenforced guarantee (checkable today: total, exhaustive, handled, nonzero, bounds, arith, overflow)` });
        continue;
      }
      out.push(ob);
    }
    return out;
  }

  private lowerImport(n: N): Decl {
    const stringNode = n.namedChildren.find(c => c.type === "string");
    const path = stringNode ? stringNode.text.slice(1, -1) : "";
    const names: { name: string; alias: string | null }[] = [];

    const importNames = n.namedChildren.filter(c => c.type === "import_name");
    const named = importNames.length > 0;  // the braced `{ … }` form
    if (named) {
      for (const imp of importNames) {
        const ids = imp.namedChildren;
        names.push(ids.length === 2
          ? { name: ids[0]!.text, alias: ids[1]!.text }
          : { name: imp.text, alias: null });
      }
    } else {
      // import foo from "path"  OR  import Foo from "path"  — bare name (lower or upper)
      for (const id of n.namedChildren.filter(c => c.type === "lower_id" || c.type === "upper_id")) {
        names.push({ name: id.text, alias: null });
      }
    }

    // `import js "pkg" as x` lowers to the same path+single-name shape as
    // `import x from "pkg"`; the `js` literal (an anonymous token) is the only
    // thing that distinguishes them, so flag it for infer's resolve check.
    const foreign = n.children.some(c => c.type === "js");
    return { tag: "DImport", path, names, ...(foreign ? { foreign: true } : {}), ...(named ? { named: true } : {}), span: this.sp(n) };
  }

  // ── Functions ───────────────────────────────────────────────────────────────

  private lowerFnGroup(name: string, nodes: N[], sigNode: N | null, lowLevel = false, total = false): Decl {
    const sig = sigNode ? this.lowerFnSig(sigNode) : null;
    const clauses = nodes.map(n => this.lowerFnClause(n));
    const span = (nodes[0] ?? sigNode)!;
    // Union the per-clause `proofs: [...]` clauses (SPEC §12.7 A4) into a single
    // function-level promise. `total` routes through the existing totality
    // engine — set the marker so total.ts sees it exactly as a `@total def`.
    const proofs = [...new Set(clauses.flatMap(c => c.proofs ?? []))];
    if (proofs.includes("total")) total = true;
    return { tag: "DFn", name, sig, clauses, lowLevel, total,
             ...(proofs.length ? { proofs } : {}), span: this.sp(span) };
  }

  private lowerFnSig(n: N): FnSig {
    // def lower_id ( _type* ) : _type
    // All named children after lower_id are types; last is return type.
    const types = n.namedChildren.filter(isTypeKind);
    const retNode = types.at(-1);
    const paramNodes = types.slice(0, -1);
    const { effects, effectTails, retRef } = this.unpackEffectType(retNode ?? null);
    return {
      params: paramNodes.map(t => this.lowerTypeRef(t)),
      ret: retRef,
      effects,
      effectTails,
      span: this.sp(n),
    };
  }

  private lowerFnClause(n: N): FnClause {
    // named children: lower_id (name), param*, _type (ret), body...
    const named = n.namedChildren;
    // Skip the first child (function name)
    const rest = named.slice(1);
    const plNode = rest.find(c => c.type === "param_list");
    const params = plNode ? this.lowerParamList(plNode) : [];
    const typeIdx = rest.findIndex(isTypeKind);
    const bodyNodes = typeIdx >= 0 ? rest.slice(typeIdx + 1) : rest;

    const whereNodes = bodyNodes.filter(c => c.type === "where_stmt");
    const usingNode = bodyNodes.find(c => c.type === "using_clause");
    // Per-function `proofs: [...]` clause (SPEC §12.7 A4): same production as
    // the module scope, validated by the same closed-vocabulary check.
    const proofsNode = bodyNodes.find(c => c.type === "proofs_decl");
    const proofs = proofsNode ? this.lowerProofs(proofsNode) : [];
    // Per-function `effects: [...]` clause (SPEC §12.4): sugar for the inline
    // `Effect [...] T` return wrapper — its capability names join the row.
    const effectsNode = bodyNodes.find(c => c.type === "effects_decl");
    const clauseEffects = effectsNode
      ? effectsNode.namedChildren.filter(c => c.type === "lower_id").map(c => c.text)
      : [];
    const bodyContent = bodyNodes.filter(c =>
      c.type !== "where_stmt" && c.type !== "using_clause" &&
      c.type !== "proofs_decl" && c.type !== "effects_decl");
    const where_ = whereNodes.flatMap(w => this.lowerWhereBindings(w));
    const lifetimeConstraints = whereNodes.flatMap(w => this.lowerLifetimeConstraints(w));
    const surface = usingNode ? this.lowerUsingClause(usingNode) : null;
    const rawRetNode = typeIdx >= 0 ? rest[typeIdx] : undefined;
    const { effects: inlineEffects, effectTails, retRef: ret } = this.unpackEffectType(rawRetNode ?? null);
    // Union the clause row with any inline `Effect [..]` row (the clause is the
    // readable spelling; the inline form stays for HOF effect-tail polymorphism,
    // so both can legally co-occur). Dedupe, clause names appended.
    const effects = [...new Set([...inlineEffects, ...clauseEffects])];

    return { params, ret, effects, effectTails, body: this.lowerBody(bodyContent), where_, lifetimeConstraints, surface,
             ...(proofs.length ? { proofs } : {}), span: this.sp(n) };
  }

  // `using S` / `using surface = <expr>`: extract the role name and (for the inline
  // sugar) the bound expression. The named form leaves `value` null.
  private lowerUsingClause(n: N): { name: string; value: Expr | null } {
    const nameId = n.namedChildren.find(c => c.type === "lower_id");
    const valNode = n.namedChildren.find(c => c !== nameId && isExprKind(c.type));
    return {
      name: nameId?.text ?? "?",
      value: valNode ? this.lowerExpr(valNode) : null,
    };
  }

  // where_stmt in the grammar is lifetime constraints, not value bindings.
  // Value `where` bindings (spec §3.4) are not yet in the grammar — return empty.
  private lowerWhereBindings(_n: N): { pat: Pat; value: Expr }[] { return []; }

  // Extract the `(~a >= ~b)` / `(~a = ~b)` lifetime constraints from a where_stmt.
  private lowerLifetimeConstraints(n: N): import("./ast.js").LifetimeConstraint[] {
    const out: import("./ast.js").LifetimeConstraint[] = [];
    for (const c of n.namedChildren) {
      if (c.type !== "lifetime_constraint") continue;
      const refs = c.namedChildren.filter(r => r.type === "lifetime_ref");
      if (refs.length !== 2) continue;
      const op = c.children.some(ch => ch.text === ">=") ? "outlives" : "eq";
      const lhs = this.lowerLifetimeRef(refs[0]!);
      const rhs = this.lowerLifetimeRef(refs[1]!);
      if (lhs && rhs) out.push({ lhs, op, rhs });
    }
    return out;
  }

  private lowerLifetimeRef(ref: N): import("./ast.js").LifetimeRef | null {
    const inner = ref.namedChildren[0];
    if (!inner) return null;
    if (inner.type === "lifetime_var") return { tag: "LVar", name: inner.text };
    if (inner.type === "lifetime_of_type") {
      const id = inner.namedChildren.find(c => c.type === "lower_id" || c.type === "upper_id");
      return id ? { tag: "LOf", binding: id.text } : null;
    }
    return null;
  }

  private lowerBody(nodes: N[]): Expr {
    if (nodes.length === 1 && isExprKind(nodes[0]!.type)) return this.lowerExpr(nodes[0]!);
    const stmts = nodes.map(n => this.lowerStmt(n));
    const span = nodes[0]
      ? this.sp(nodes[0])
      : { start: { line: 0, col: 0, offset: 0 }, end: { line: 0, col: 0, offset: 0 }, source: this.file };
    return { tag: "Do", stmts, span };
  }

  // ── Type definitions ────────────────────────────────────────────────────────

  private lowerTypeDef(n: N): Decl {
    const named = n.namedChildren;
    const name   = named.find(c => c.type === "upper_id")?.text ?? "?";
    const params = named.filter(c => c.type === "lower_id").map(c => c.text);
    let body: TypeBody;

    if (named.some(c => c.type === "adt_variant")) {
      body = { tag: "TBAdt", variants: named.filter(c => c.type === "adt_variant").map(v => this.lowerVariant(v)) };
    } else if (n.text.includes("extern")) {
      const rt = named.find(c => c.type === "record_type");
      const fields = (rt?.namedChildren.filter(c => c.type === "type_field") ?? []).map(f => ({
        name: f.namedChildren[0]!.text,
        type: this.lowerTypeRef(f.namedChildren[1]!),
      }));
      body = { tag: "TBExtern", fields, align: null };
    } else {
      const typeNode = named.find(isTypeKind);
      // `type T = Base where <pred>` — the predicate is the named expr right after
      // the `where` token (refers to the refined value as `value`); its presence
      // marks a refinement. (Locate it via `where` because the type *name* is an
      // `upper_id`, which is itself an expr-kind and would otherwise be picked up.)
      const whereIdx = n.children.findIndex(c => c.type === "where");
      const predNode = whereIdx >= 0
        ? n.children.slice(whereIdx + 1).find(c => c.isNamed && isExprKind(c.type))
        : undefined;
      const pred = predNode ? this.lowerExpr(predNode) : null;
      // `type T = Number unit m/s^2` — collect the dimension as signed factors.
      // The first factor is positive; each later factor's sign is the `*`/`/`
      // token that precedes it. `^<int>` is the exponent (default 1).
      const unitNode = named.find(c => c.type === "unit_clause");
      const unit = unitNode ? this.lowerUnitClause(unitNode) : undefined;
      const ref = typeNode ? this.lowerTypeRef(typeNode) : { tag: "TRNamed" as const, name: "Unknown", args: [] };
      body = { tag: "TBAlias", ref, pred, ...(unit ? { unit } : {}) };
    }

    return { tag: "DType", name, params, body, span: this.sp(n) };
  }

  // `unit m/s^2` → [{atom:"m",exp:1},{atom:"s",exp:-2}]. Walks the unit_clause's
  // children in order: the leading `unit` keyword is skipped, each `unit_factor`
  // takes the sign of the most recent `/` (negative) or `*`/start (positive).
  private lowerUnitClause(n: N): { atom: string; exp: number }[] {
    const out: { atom: string; exp: number }[] = [];
    let sign = 1;
    for (const c of n.children) {
      if (c.type === "/") sign = -1;
      else if (c.type === "*") sign = 1;
      else if (c.type === "unit_factor") {
        const atom = c.namedChildren.find(k => k.type === "lower_id")?.text ?? "?";
        const numNode = c.namedChildren.find(k => k.type === "number");
        const exp = numNode ? parseInt(numNode.text, 10) : 1;
        out.push({ atom, exp: sign * exp });
        sign = 1;
      }
    }
    return out;
  }

  private lowerVariant(n: N): AdtVariant {
    const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
    const payload = n.namedChildren.find(isTypeKind);
    return { name, payload: payload ? this.lowerTypeRef(payload) : null, span: this.sp(n) };
  }

  // ── Store definitions ───────────────────────────────────────────────────────

  private lowerStoreDef(n: N): Decl {
    const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";

    const stateBlock = n.namedChildren.find(c => c.type === "state_block");
    const fields = (stateBlock?.namedChildren.filter(c => c.type === "state_field") ?? []).map(f => {
      const kids = f.namedChildren;
      const nameNode = kids.find(c => c.type === "lower_id");
      // The default value is the trailing expr — exclude the field-name id and
      // the type node (a bare `lower_id` also counts as an expression).
      const valNode = kids.find(c => c !== nameNode && !isTypeKind(c) && isExprKind(c.type));
      return {
        name:     nameNode?.text ?? "?",
        type:     this.lowerTypeRef(kids.find(isTypeKind) ?? kids[0]!),
        default_: valNode ? this.lowerExpr(valNode) : null,
      };
    });

    const msgBlock = n.namedChildren.find(c => c.type === "messages_block");
    const messages = (msgBlock?.namedChildren.filter(c => c.type === "message_def") ?? []).map(m => {
      // Body is either a single inline expr, or a block of statements (do-block).
      // Exclude the message name (upper_id) and params — the upper_id also counts
      // as an expression, so a naive find() would grab the name itself.
      const bodyNodes = m.namedChildren.filter(c => c.type !== "upper_id" && c.type !== "param");
      const stmts = bodyNodes.filter(c => isStmtKind(c.type));
      const exprBody = bodyNodes.find(c => isExprKind(c.type));
      const span = this.sp(m);
      const body: Expr = stmts.length > 0
        ? { tag: "Do", stmts: stmts.map(s => this.lowerStmt(s)), span }
        : exprBody ? this.lowerExpr(exprBody) : { tag: "Lit", lit: { tag: "Unit" }, span };
      return {
        name:   m.namedChildren.find(c => c.type === "upper_id")?.text ?? "?",
        // Filter out zero-length phantom params from `Msg ()` (empty parens in grammar)
        params: m.namedChildren.filter(c => c.type === "param" && c.text.trim().length > 0).map(p => this.lowerParam(p)),
        body,
      };
    });

    const pubBlock = n.namedChildren.find(c => c.type === "pub_block");
    const pubs = (pubBlock?.namedChildren.filter(c => c.type === "pub_field") ?? []).map(p => {
      const nameNode = p.namedChildren.find(c => c.type === "lower_id");
      // `pub name = expr` — the body is the expr after the name; a bare `pub name`
      // (no `=`) re-exports the state field, so there is no separate body node.
      const valNode = p.namedChildren.find(c => c !== nameNode && isExprKind(c.type));
      return {
        name: nameNode?.text ?? "?",
        body: valNode ? this.lowerExpr(valNode) : null,
      };
    });

    return { tag: "DStore", name, fields, messages, pubs, span: this.sp(n) };
  }

  // ── First-class saga declarations ────────────────────────────────────────────

  // Deprecated `saga Name(...): T [over Store]` keyword. Lowers to the same
  // DSaga node as the canonical `machine … persisted` form, then emits a
  // deprecation warning on the surface keyword.
  private lowerSagaDef(n: N): Decl {
    const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
    const params = n.namedChildren.filter(c => c.type === "param").map(p => this.lowerParam(p));
    const retNode = n.namedChildren.find(isTypeKind);
    const ret = retNode ? this.lowerTypeRef(retNode) : null;
    // `over StoreName` — explicit backing store; else the saga is auto-backed
    // (its own store named after the saga).
    const overNode = n.namedChildren.find(c => c.type === "over_clause");
    const store = overNode?.namedChildren.find(c => c.type === "upper_id")?.text ?? null;
    const steps = n.namedChildren.filter(c => c.type === "saga_step").map(s => this.lowerMachineStep(s));
    this.diagnostics.push({
      kind: "warning",
      span: this.sp(n),
      message: "`saga` is deprecated; write `machine … persisted over Store`.",
    });
    return { tag: "DSaga", name, params, ret, store, persisted: true, deprecated: true, steps, span: this.sp(n) };
  }

  // Canonical `machine Name(...): T persisted [over Store]`. A durable/compensating
  // machine — identical runtime semantics to `saga`. Lowers to the same DSaga node.
  private lowerMachineDef(n: N): Decl {
    const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
    const params = n.namedChildren.filter(c => c.type === "param").map(p => this.lowerParam(p));
    const retNode = n.namedChildren.find(isTypeKind);
    const ret = retNode ? this.lowerTypeRef(retNode) : null;
    // The grammar places an optional `over` backing-store upper_id AFTER the return
    // type's upper_id(s). The last upper_id that is neither the name nor part of the
    // return type is the explicit backing store. We identify it as a direct
    // `upper_id` child of the machine_def that is not the leading name and not nested
    // inside the type node.
    const directUppers = n.namedChildren.filter(c => c.type === "upper_id");
    // First upper_id is the machine name; a trailing direct upper_id (when present)
    // is the `over Store` target (the return type is wrapped in a *_type node).
    const store = directUppers.length > 1 ? directUppers[directUppers.length - 1]!.text : null;
    const steps = n.namedChildren.filter(c => c.type === "saga_step").map(s => this.lowerMachineStep(s));
    return { tag: "DSaga", name, params, ret, store, persisted: true, deprecated: false, steps, span: this.sp(n) };
  }

  // ── Machine steps ───────────────────────────────────────────────────────────

  private lowerMachineStep(n: N): import("./ast.js").MachineStep {
    const span = this.sp(n);
    // First atom_lit is the state name; the lower_ids after it are step params.
    const atom = n.namedChildren.find(c => c.type === "atom_lit");
    const name = atom?.namedChildren[0]?.text ?? atom?.text?.replace(/^:/, "") ?? "?";
    const params = n.namedChildren
      .filter(c => c.type === "lower_id" && c !== atom?.namedChildren[0])
      .map(c => c.text);
    // Everything after the state header is the body.
    const bodyNodes = n.namedChildren.filter(c => c !== atom && c.type !== "lower_id");
    return { name, params, body: this.lowerStepBody(bodyNodes), span };
  }

  // Lower a step/branch body, grouping concurrency constructs that span several
  // sibling nodes: `go..go` (+ `| branches` = a join) and `race {..}` (+ branches).
  private lowerStepBody(nodes: N[]): import("./ast.js").SagaStmt[] {
    const out: import("./ast.js").SagaStmt[] = [];
    let i = 0;
    while (i < nodes.length) {
      const n = nodes[i]!;
      const span = this.sp(n);
      const isGo = (x: N) => x.type === "go_stmt" || x.type === "go_expr";
      if (isGo(n)) {
        const tasks: Expr[] = [];
        while (i < nodes.length && isGo(nodes[i]!)) {
          const inner = nodes[i]!.namedChildren.find(c => isExprKind(c.type)) ?? nodes[i]!.namedChildren[0]!;
          tasks.push(this.lowerExpr(inner));
          i++;
        }
        const branches = this.collectSagaBranches(nodes, () => i, (k) => { i = k; });
        if (branches.length > 0) out.push({ tag: "SagaJoin", tasks, branches, span });
        else for (const t of tasks) out.push({ tag: "SagaGo", expr: t, span });
      } else if (n.type === "race_block") {
        const arms = (n.namedChildren).map(a => {
          const arm = a.type === "race_arm" ? a.namedChildren[0]! : a;
          // `after Ns` carries a duration_lit; capture it so the race can sleep.
          if (arm.type === "after_stmt") return { kind: "after" as const, expr: arm.namedChildren[0] ? this.lowerExpr(arm.namedChildren[0]) : null };
          if (arm.type === "until_stmt") return { kind: "until" as const, expr: arm.namedChildren[0] ? this.lowerExpr(arm.namedChildren[0]) : null };
          return { kind: "go" as const, expr: arm.namedChildren[0] ? this.lowerExpr(arm.namedChildren[0]) : null };
        });
        i++;
        const branches = this.collectSagaBranches(nodes, () => i, (k) => { i = k; });
        out.push({ tag: "SagaRace", arms, branches, span });
      } else if (n.type === "saga_branch") {
        // Stray branch without a preceding go/race — skip (shouldn't normally occur).
        i++;
      } else {
        out.push(...this.lowerSagaStmt(n));
        i++;
      }
    }
    return out;
  }

  private collectSagaBranches(nodes: N[], get: () => number, set: (k: number) => void): import("./ast.js").SagaBranch[] {
    const branches: import("./ast.js").SagaBranch[] = [];
    let i = get();
    while (i < nodes.length && nodes[i]!.type === "saga_branch") {
      branches.push(this.lowerSagaBranch(nodes[i]!));
      i++;
    }
    set(i);
    return branches;
  }

  private lowerSagaBranch(b: N): import("./ast.js").SagaBranch {
    const patNode = b.namedChildren.find(c => isPatKind(c.type));
    const pat: Pat = patNode ? this.lowerPat(patNode) : { tag: "PWild", span: this.sp(b) };
    const bodyNodes = b.namedChildren.filter(c => c !== patNode);
    return { pat, body: this.lowerSagaBranchNodes(bodyNodes) };
  }

  private lowerSagaStmt(n: N): import("./ast.js").SagaStmt[] {
    const span = this.sp(n);
    switch (n.type) {
      case "step_goto":
      case "step_inline": {
        const atom = n.namedChildren[0];
        const target = atom?.namedChildren[0]?.text ?? atom?.text?.replace(/^:/, "") ?? "?";
        const args = n.namedChildren.slice(1).map(c => this.lowerExpr(c));
        return [{ tag: "Goto", target, args, span }];
      }
      case "implicit_match": {
        const subj = n.namedChildren[0]!;
        const branches = n.namedChildren.filter(c => c.type === "saga_branch").map(b => this.lowerSagaBranch(b));
        return [{ tag: "SagaMatch", subject: this.lowerExpr(subj), branches, span }];
      }
      case "rollback_stmt": {
        // expr ? rollback :step  (defer compensation)  |  expr ?: rollback :step (recover on failure)
        const exprNode = n.namedChildren.find(c => isExprKind(c.type))!;
        const targetAtom = n.namedChildren.find(c => c.type === "atom_lit");
        const target = targetAtom?.namedChildren[0]?.text ?? targetAtom?.text?.replace(/^:/, "") ?? "?";
        const mode = n.children.some(c => !c.isNamed && c.text === "?:") ? "recover" as const : "defer" as const;
        return [{ tag: "Rollback", expr: this.lowerExpr(exprNode), mode, target, span }];
      }
      case "match_expr": {
        const [subj, ...rest] = n.namedChildren;
        const branches = rest.filter(c => c.type === "match_branch").map(b => this.lowerSagaBranch(b));
        return [{ tag: "SagaMatch", subject: subj ? this.lowerExpr(subj) : this.err(span), branches, span }];
      }
      case "await_stmt": {
        // `await Stream` inside a machine step (SPEC §4.3) — the consumer form
        // whose branches may be step transitions (`| Push(e) -> :handle e`).
        // Lowers to a SagaMatch on a branch-less Await subject: the Await pulls
        // the next value, and the saga-branch machinery gives the branch bodies
        // the full step grammar (Goto / rollback / blocks). Before this case
        // existed the statement fell to the default and was silently DROPPED
        // (an empty step body) — the §3.2 await→step-goto gap.
        const subjNode = n.namedChildren.find(c => isExprKind(c.type));
        const branches = n.namedChildren.filter(c => c.type === "match_branch").map(b => this.lowerSagaBranch(b));
        const subject: Expr = { tag: "Await", expr: subjNode ? this.lowerExpr(subjNode) : this.err(span), branches: [], span };
        return [{ tag: "SagaMatch", subject, branches, span }];
      }
      case "if_expr": {
        const cond = n.namedChildren[0]!;
        const elseAnonIdx = n.children.findIndex(c => !c.isNamed && c.text === "else");
        const thenNodes = n.namedChildren.filter(c => c !== cond && (elseAnonIdx < 0 || n.children.indexOf(c) < elseAnonIdx));
        const elseNodes = elseAnonIdx >= 0 ? n.namedChildren.filter(c => n.children.indexOf(c) > elseAnonIdx) : [];
        return [{
          tag: "SagaIf",
          cond: this.lowerExpr(cond),
          then: this.lowerSagaBranchNodes(thenNodes),
          else_: this.lowerSagaBranchNodes(elseNodes),
          span,
        }];
      }
      case "binding":
      case "block_binding": {
        const nameId = n.namedChildren.find(c => c.type === "lower_id");
        const valNode = n.namedChildren.find(c => c !== nameId && !isTypeKind(c) && isExprKind(c.type));
        return [{ tag: "SBindS", name: nameId?.text ?? "_", value: valNode ? this.lowerExpr(valNode) : this.err(span), span }];
      }
      default:
        // A bare expression is the step's terminal/yielded value (or a side-effect).
        if (isExprKind(n.type)) return [{ tag: "Yield", expr: this.lowerExpr(n), span }];
        return [];
    }
  }

  // Interpret a sequence of CST nodes appearing in a saga branch/step tail. A
  // leading atom (`:state`, optionally followed by argument exprs) is a state
  // transition; anything else lowers as a regular saga statement.
  private lowerSagaBranchNodes(nodes: N[]): import("./ast.js").SagaStmt[] {
    if (nodes.length === 0) return [];
    const atom = this.asAtomNode(nodes[0]!);
    if (atom) {
      const target = atom.namedChildren[0]?.text ?? atom.text.replace(/^:/, "");
      const args = nodes.slice(1).filter(c => isExprKind(c.type)).map(c => this.lowerExpr(c));
      return [{ tag: "Goto", target, args, span: this.sp(nodes[0]!) }];
    }
    return this.lowerStepBody(nodes);
  }

  // Unwrap `literal(atom_lit)` or a bare `atom_lit` node.
  private asAtomNode(n: N): N | null {
    if (n.type === "atom_lit") return n;
    if (n.type === "literal" && n.namedChildren[0]?.type === "atom_lit") return n.namedChildren[0]!;
    return null;
  }

  // ── Type references ─────────────────────────────────────────────────────────

  lowerTypeRef(n: N): TypeRef {
    switch (n.type) {
      case "simple_type":
        return { tag: "TRNamed", name: n.text, args: [] };
      case "type_var":
        return { tag: "TRNamed", name: n.text, args: [] };  // lowercase → resolved as type var later
      case "unit_type":
        return { tag: "TRNamed", name: "()", args: [] };
      case "parameterized_type": {
        const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
        const args = n.namedChildren
          .filter(c => c.type === "type_or_expr")
          .map(c => {
            const child = c.namedChildren[0] ?? c;
            // A compound value expression (`listLength xs`, a number, `a.b`) is a
            // dependent-type argument → keep it as an expression. Bare identifiers
            // (`a`) and type nodes stay type references, so ordinary generics like
            // `List(a)` / `Result(a, e)` are unaffected.
            if (!isTypeKind(child) && child.type !== "identifier_expr")
              return { tag: "TRExpr" as const, expr: this.lowerExpr(child) };
            return this.lowerTypeRef(child);
          });
        return { tag: "TRNamed", name, args };
      }
      case "record_type": {
        const fields = n.namedChildren.filter(c => c.type === "type_field").map(f => ({
          name: f.namedChildren[0]!.text,
          type: this.lowerTypeRef(f.namedChildren[1]!),
          optional: false,
        }));
        return { tag: "TRRecord", fields };
      }
      case "tuple_type":
        return { tag: "TRTuple", elems: n.namedChildren.filter(isTypeKind).map(c => this.lowerTypeRef(c)) };
      case "function_type": {
        // `(A, B -> C)` — params in source order, the last type is the return.
        // An `Effect [caps, ..tail] C` return slot (E2) unpacks onto the TRFn:
        // caps become its effects, `..e` its effectTail (the user-spelled row).
        const typeNodes = n.namedChildren.filter(isTypeKind);
        const retNode = typeNodes.pop() ?? null;
        const { effects, effectTails, retRef: ret } = this.unpackEffectType(retNode);
        const types = typeNodes.map(c => this.lowerTypeRef(c));
        // `(() -> T)` is a THUNK: zero-param defs type as `() -> T` with an
        // EMPTY param list (no Unit argument exists at calls), so a lone `()`
        // param means zero params. `()` among several params stays a
        // Unit-typed argument.
        const params = types.length === 1 && types[0]!.tag === "TRNamed" && types[0]!.name === "()"
          ? [] : types;
        return { tag: "TRFn", params, ret, effects,
                 ...(effectTails[0] !== undefined ? { effectTail: effectTails[0] } : {}) };
      }
      case "tainted_type": {
        const inner = n.namedChildren.find(isTypeKind);
        return { tag: "TRNamed", name: "Tainted", args: inner ? [this.lowerTypeRef(inner)] : [] };
      }
      case "effect_type": {
        // Effect [caps] RetType — unpack as TRNamed("Effect", [RetType]) with caps noted
        const { retRef } = this.unpackEffectType(n);
        return retRef;
      }
      case "async_type": {
        const inner = n.namedChildren.find(isTypeKind);
        return { tag: "TRNamed", name: "Async", args: inner ? [this.lowerTypeRef(inner)] : [] };
      }
      case "result_type": {
        // The error slot admits `_` (grammar-restricted to that slot) — the
        // inferred-row marker (error-rows-design S1). Lowered as the name "_";
        // infer resolves it to the def's ErrRow (and rejects it off-slot).
        const types = n.namedChildren.filter(c => isTypeKind(c) || c.type === "wildcard")
          .map(t => t.type === "wildcard"
            ? { tag: "TRNamed" as const, name: "_", args: [] }
            : this.lowerTypeRef(t));
        return { tag: "TRNamed", name: "Result", args: types };
      }
      case "array_type": {
        const inner = n.namedChildren.find(isTypeKind);
        return { tag: "TRNamed", name: "Array", args: inner ? [this.lowerTypeRef(inner)] : [] };
      }
      case "atomic_type": {
        const inner = n.namedChildren.find(isTypeKind);
        return { tag: "TRNamed", name: "Atomic", args: inner ? [this.lowerTypeRef(inner)] : [] };
      }
      case "pointer_type": {
        // Ptr [~lifetime] T — the lifetime annotation is metadata for the borrow
        // checker (region inference); the value-level type is just Ptr(T).
        const lifeNode = n.namedChildren.find(c => c.type === "lifetime_var");
        const inner = n.namedChildren.find(isTypeKind);
        return {
          tag: "TRPtr",
          lifetime: lifeNode ? lifeNode.text : null,
          inner: inner ? this.lowerTypeRef(inner) : { tag: "TRNamed", name: "Unknown", args: [] },
        };
      }
      default:
        return { tag: "TRNamed", name: n.text, args: [] };
    }
  }

  // Unpacks Effect [cap1, ..tail] RetType → { effects, effectTails, retRef }.
  // `..e` entries are user-spelled effect TAILS (row-variables E2): names tying
  // the def's own row to the rows of fn params marked with the same `..e`. At
  // most one tail per clause — a second is a lower error (one row, one rest).
  private unpackEffectType(n: N | null): { effects: string[]; effectTails: string[]; retRef: TypeRef } {
    const empty: TypeRef = { tag: "TRNamed", name: "()", args: [] };
    if (!n || n.type !== "effect_type") return { effects: [], effectTails: [], retRef: n ? this.lowerTypeRef(n) : empty };
    const effects = n.namedChildren.filter(c => c.type === "lower_id").map(c => c.text);
    const effectTails = n.namedChildren.filter(c => c.type === "effect_tail").map(c => c.namedChildren[0]?.text ?? "?");
    if (effectTails.length > 1)
      this.diagnostics.push({ kind: "error", span: this.sp(n),
        message: `at most one effect tail per row — found [${effectTails.map(t => ".." + t).join(", ")}]` });
    const retNode  = n.namedChildren.find(isTypeKind);
    return { effects, effectTails, retRef: retNode ? this.lowerTypeRef(retNode) : empty };
  }

  // ── Params ──────────────────────────────────────────────────────────────────

  private lowerParam(n: N): Param {
    const span = this.sp(n);
    const named = n.namedChildren;

    // atom_lit param (:name)
    const atom = named.find(c => c.type === "atom_lit");
    if (atom) return { pat: { tag: "PAtom", name: atom.text.slice(1), span }, ascription: null, span };

    // literal param (0, true) — clause-head dispatch on a constant value
    const lit = named.find(c => c.type === "number" || c.type === "bool");
    if (lit) return { pat: { tag: "PLit", lit: this.lowerLit(lit), span }, ascription: null, span };

    // wildcard
    if (named.find(c => c.type === "wildcard") || n.text === "_")
      return { pat: { tag: "PWild", span }, ascription: null, span };

    // upper_id (type pattern)
    const upper = named.find(c => c.type === "upper_id");
    if (upper) return { pat: { tag: "PCtor", name: upper.text, inner: null, span }, ascription: null, span };

    // lower_id  or  lower_id : Type   — optionally with a `= <default>`
    const nameId = named.find(c => c.type === "lower_id");
    const typeNode = named.find(isTypeKind);
    // A default is the `_expr` that follows the `=` token (distinct from a bare
    // `number`/`bool` clause-head literal param, which is unwrapped above).
    const eq = n.children.find(c => !c.isNamed && c.text === "=");
    let default_: Expr | undefined;
    if (eq) {
      const valNode = named.find(c => c.startIndex >= eq.endIndex && isExprKind(c.type));
      if (valNode) default_ = this.lowerExpr(valNode);
    }
    return {
      pat: { tag: "PVar", name: nameId?.text ?? n.text, span },
      ascription: typeNode ? this.lowerTypeRef(typeNode) : null,
      ...(default_ ? { default_ } : {}),
      span,
    };
  }

  // A function-signature parameter list (`param_list`): lowers each `param`,
  // flipping `keywordOnly` on for every parameter that appears after a `*`
  // separator (`def render(node, *, theme=Dark)`).
  private lowerParamList(n: N): Param[] {
    const out: Param[] = [];
    let kwOnly = false;
    for (const c of n.namedChildren) {
      if (c.type === "kw_separator") { kwOnly = true; continue; }
      if (c.type !== "param") continue;
      const p = this.lowerParam(c);
      if (kwOnly) p.keywordOnly = true;
      out.push(p);
    }
    return out;
  }

  // ── Statements ──────────────────────────────────────────────────────────────

  lowerStmt(n: N): Stmt {
    const span = this.sp(n);

    switch (n.type) {
      case "binding":
      case "block_binding": {
        const named = n.namedChildren;
        const nameId  = named.find(c => c.type === "lower_id");
        const typeNode = named.find(isTypeKind);
        const valNode  = named.find(c => c !== nameId && !isTypeKind(c));
        const pat: Pat = { tag: "PVar", name: nameId?.text ?? "?", span };
        // A leading `let`/`const`/`mut` keyword means this declares a new binding;
        // a bare `x = e` is a reassignment of an existing (mutable) binding.
        const declares = n.children.some(c => c.type === "let" || c.type === "const" || c.type === "mut");
        const mutable = n.children.some(c => c.type === "mut");
        return { tag: "SBind", pat, ascription: typeNode ? this.lowerTypeRef(typeNode) : null, value: valNode ? this.lowerExpr(valNode) : this.err(span), declares, mutable, span };
      }

      case "brace_binding": {
        // `[let|mut|const] name = expr` inside a `{ }` block. Like `binding` but
        // no `: type` ascription (keeps the `=` vs `:` record fork one token wide).
        const named = n.namedChildren;
        const nameId  = named.find(c => c.type === "lower_id");
        const valNode = named.find(c => c !== nameId && isExprKind(c.type));
        const pat: Pat = { tag: "PVar", name: nameId?.text ?? "?", span };
        const declares = n.children.some(c => c.type === "let" || c.type === "const" || c.type === "mut");
        const mutable = n.children.some(c => c.type === "mut");
        return { tag: "SBind", pat, ascription: null, value: valNode ? this.lowerExpr(valNode) : this.err(span), declares, mutable, span };
      }

      case "index_assign":
      case "deref_assign": {
        // `xs[i] = v` (target = array_index) or `p.* = v` (target = deref_expr).
        const lhs = n.namedChildren[0]!;        // array_index | deref_expr
        const valNode = n.namedChildren[1]!;    // the rhs value
        return {
          tag: "SAssign",
          target: this.lowerExpr(lhs),
          value: this.lowerExpr(valNode),
          span,
        };
      }

      case "destructure": {
        const named = n.namedChildren;
        const valNode = named.at(-1);
        const bindings = named.slice(0, -1).filter(c => c.type === "lower_id");
        const isRec = n.text.trimStart().startsWith("{");
        const pat: Pat = isRec
          ? { tag: "PRecord", fields: bindings.map(b => ({ name: b.text, pat: { tag: "PVar" as const, name: b.text, span: this.sp(b) } })), span }
          : { tag: "PTuple", elems: bindings.map(b => ({ tag: "PVar" as const, name: b.text, span: this.sp(b) })), span };
        return { tag: "SBind", pat, ascription: null, value: valNode ? this.lowerExpr(valNode) : this.err(span), declares: true, mutable: false, span };
      }

      case "pipe_block":
        return { tag: "SExpr", expr: this.lowerPipeBlock(n, span), span };

      case "try_block":
        return { tag: "SExpr", expr: { tag: "Try", stmts: n.namedChildren.map(c => this.lowerStmt(c)), span }, span };

      case "retry_block":
        return { tag: "SExpr", expr: this.lowerRetryBlock(n, span), span };

      case "loop_expr":
        return { tag: "SExpr", expr: { tag: "Loop", stmts: n.namedChildren.map(c => this.lowerStmt(c)), span }, span };

      case "await_stmt": {
        const exprNode = n.namedChildren[0];
        const branches = n.namedChildren.filter(c => c.type === "match_branch").map(b => this.lowerBranch(b));
        return { tag: "SExpr", expr: { tag: "Await", expr: exprNode ? this.lowerExpr(exprNode) : this.err(span), branches, span }, span };
      }

      case "go_stmt": {
        const exprNode = n.namedChildren.find(c => isExprKind(c.type));
        return { tag: "SExpr", expr: { tag: "Go", expr: exprNode ? this.lowerExpr(exprNode) : this.err(span), span }, span };
      }

      case "if_expr":
        return { tag: "SExpr", expr: this.lowerIfExpr(n, span), span };

      case "if_pattern_expr":
        return { tag: "SExpr", expr: this.lowerIfPatternExpr(n, span), span };

      case "match_expr": {
        const [subj, ...rest] = n.namedChildren;
        const branches = rest.filter(c => c.type === "match_branch").map(b => this.lowerBranch(b));
        return { tag: "SExpr", expr: { tag: "Match", subject: subj ? this.lowerExpr(subj) : this.err(span), branches, span }, span };
      }
      case "responsive_expr":
        return { tag: "SExpr", expr: this.lowerResponsive(n, span), span };

      // `expr |> match | ...` / `expr |> fn p -> ...` in statement position.
      // Same shape as a pipe expression — route through lowerPipe so the branches
      // aren't dropped (the default case would lower only the scrutinee).
      case "pipe_match_stmt":
      case "pipe_lambda_stmt":
        return { tag: "SExpr", expr: this.lowerPipe(n, span), span };

      default:
        if (isExprKind(n.type)) return { tag: "SExpr", expr: this.lowerExpr(n), span };
        // expression-statement: the expr is the sole named child
        const child = n.namedChildren.find(c => isExprKind(c.type));
        return { tag: "SExpr", expr: child ? this.lowerExpr(child) : this.err(span), span };
    }
  }

  // ── Expressions ─────────────────────────────────────────────────────────────

  lowerExpr(n: N): Expr {
    const span = this.sp(n);

    switch (n.type) {
      // ── literals ──
      case "literal": {
        const inner = n.namedChildren[0] ?? n;
        if (inner.type === "string") return this.lowerStringExpr(inner, span);
        return { tag: "Lit", lit: this.lowerLit(inner), span };
      }
      case "string":
        return this.lowerStringExpr(n, span);
      case "number": case "bool": case "multiline_string":
      case "triple_quote_string":
      case "unit":   case "atom_lit": case "duration_lit": case "hex_color":
      case "sigil_string": case "regex_sigil":
        return { tag: "Lit", lit: this.lowerLit(n), span };

      // ── variables ──
      case "identifier_expr":
        return { tag: "Var", name: (n.namedChildren[0] ?? n).text, span };
      case "lower_id": case "upper_id":
        return { tag: "Var", name: n.text, span };

      // ── operators ──
      case "unary_expr": {
        const op = n.children.find(c => !c.isNamed)?.text ?? "-";
        return { tag: "UnOp", op, expr: n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span), span };
      }
      case "binary_expr": {
        const [left, right] = n.namedChildren;
        // operator is the first anonymous child that isn't empty
        const op = n.children.find(c => !c.isNamed && c.text.trim() !== "")?.text ?? "+";
        return { tag: "BinOp", op, left: left ? this.lowerExpr(left) : this.err(span), right: right ? this.lowerExpr(right) : this.err(span), span };
      }

      case "pipe_expr": return this.lowerPipe(n, span);

      case "ternary_expr": {
        // The ternary `cond ? a : b` is DEPRECATED in favour of `if c then a else b`
        // (if_then_expr). It is still lowered to the same `If` node, but flagged:
        // a warning in the baseline edition, an error in 2026.6+ (SPEC §17 lifecycle).
        const deprecated = atLeast(this.edition, "2026.6");
        this.diagnostics.push({
          kind: deprecated ? "error" : "warning",
          message: deprecated
            ? "the `cond ? a : b` ternary is removed in edition 2026.6 — use `if c then a else b`"
            : "the `cond ? a : b` ternary is deprecated — use `if c then a else b` (rejected from edition 2026.6)",
          span,
        });
        const [cond, then_, else_] = n.namedChildren;
        return { tag: "If", cond: cond ? this.lowerExpr(cond) : this.err(span), then: then_ ? this.lowerExpr(then_) : this.err(span), else_: else_ ? this.lowerExpr(else_) : null, span };
      }

      case "if_then_expr": {
        const [cond, then_, else_] = n.namedChildren;
        return { tag: "If", cond: cond ? this.lowerExpr(cond) : this.err(span), then: then_ ? this.lowerExpr(then_) : this.err(span), else_: else_ ? this.lowerExpr(else_) : null, span };
      }

      // ── access ──
      case "field_access": {
        const obj = n.namedChildren[0]!;
        const field = n.namedChildren.at(-1)!;
        return { tag: "Field", obj: this.lowerExpr(obj), field: field.text, span };
      }
      case "optional_chain": {
        const obj = n.namedChildren[0]!;
        const field = n.namedChildren.at(-1)!;
        return { tag: "Field", obj: this.lowerExpr(obj), field: field.text, span };
      }
      case "array_index": {
        const [obj, idx] = n.namedChildren;
        return { tag: "Index", obj: obj ? this.lowerExpr(obj) : this.err(span), index: idx ? this.lowerExpr(idx) : this.err(span), span };
      }
      case "deref_expr":
        return { tag: "Deref", expr: n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span), span };
      case "addr_of_expr":
        return { tag: "AddrOf", expr: n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span), span };

      // ── error propagation ──
      case "propagate_expr": {
        const [expr, alt] = n.namedChildren;
        return alt
          ? { tag: "PropWith", expr: this.lowerExpr(expr!), alt: this.lowerExpr(alt), span }
          : { tag: "Propagate", expr: expr ? this.lowerExpr(expr) : this.err(span), span };
      }

      // ── collections ──
      case "range_expr": {
        const [from, to] = n.namedChildren;
        return { tag: "Range", from: from ? this.lowerExpr(from) : this.err(span), to: to ? this.lowerExpr(to) : this.err(span), inclusive: n.children.some(c => c.text === "..="), span };
      }
      case "record_literal": {
        this.checkRecordOpener(n);
        const fields = n.namedChildren.filter(c => c.type === "record_field").map(f => ({ name: f.namedChildren[0]!.text, value: this.lowerExpr(f.namedChildren[1]!) }));
        return { tag: "Record", fields, span };
      }
      case "record_spread": {
        // #{ ...base, k: v } — base record's fields, overridden by explicit fields.
        this.checkRecordOpener(n);
        const baseNode = n.namedChildren.find(c => c.type !== "record_field");
        const fields = n.namedChildren.filter(c => c.type === "record_field").map(f => ({ name: f.namedChildren[0]!.text, value: this.lowerExpr(f.namedChildren[1]!) }));
        return baseNode
          ? { tag: "Record", fields, spread: this.lowerExpr(baseNode), span }
          : { tag: "Record", fields, span };
      }
      case "list_literal":
        return { tag: "List", elems: n.namedChildren.map(c => this.lowerExpr(c)), span };
      case "tuple_literal":
        return { tag: "Tuple", elems: n.namedChildren.map(c => this.lowerExpr(c)), span };
      case "grouped":
        return n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span);

      // ── calls ──
      // Unified `call`: callee `(` positional…, name=value… `)`. The callee is any
      // expression — `lowerExpr` turns identifier_expr→Var, field_access→Field,
      // grouped→inner, nested call→Call (currying). Whether the head names a
      // function or a constructor is decided downstream by its capitalization.
      case "call": {
        const calleeNode = n.namedChildren[0]!;
        const fn = this.lowerExpr(calleeNode);
        const { args, named } = this.lowerArgs(n.namedChildren.slice(1));
        // Paren-form element: an Uppercase head naming a built-in primitive lowers
        // to an `Element`, not a `Call` (call-syntax §2.1). `Text("hi", size=12)` ≡
        // the legacy `Text "hi" size=12`. ADT constructors (`Ok(x)`) keep their head
        // out of PRIMITIVE_ELEMENTS, so they stay calls. Childless only — a
        // children-bearing element carries an indented block and parses via the
        // `element` grammar rule (lowerElement).
        if (fn.tag === "Var" && PRIMITIVE_ELEMENTS.has(fn.name))
          return this.elementFromCall(fn.name, args, named, span);
        return { tag: "Call", fn, args, named, span };
      }

      // A bare component call as a child (`card()` under an element). The head is
      // a bare lower_id — lowercase, so it can never name a primitive element —
      // and lowers straight to a Call.
      case "call_child": {
        const head = n.namedChildren[0]!;
        const fn: Expr = { tag: "Var", name: head.text, span: this.sp(head) };
        const { args, named } = this.lowerArgs(n.namedChildren.slice(1));
        return { tag: "Call", fn, args, named, span };
      }

      // ── lambdas ──
      case "lambda":
        return n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span);
      case "lambda_simple": {
        const bodyNode = n.namedChildren.at(-1)!;
        // Params are pattern children (`fn x ->`, `fn (a, b) ->`) or the bare
        // lower_id children of the multi-arg form (`fn (a b c) ->`).
        const paramNodes = n.namedChildren.filter(c => c !== bodyNode && (isPatKind(c.type) || c.type === "lower_id"));
        const params: Param[] = paramNodes.map(pn => ({
          pat: pn.type === "lower_id" ? { tag: "PVar" as const, name: pn.text, span: this.sp(pn) } : this.lowerPat(pn),
          ascription: null,
          span: this.sp(pn),
        }));
        if (params.length === 0) params.push({ pat: { tag: "PWild", span }, ascription: null, span });
        return { tag: "Lambda", params, body: this.lowerExpr(bodyNode), span };
      }
      case "lambda_block": {
        const branches = n.namedChildren.filter(c => c.type === "match_branch").map(b => this.lowerBranch(b));
        return { tag: "Match", subject: { tag: "Var", name: "__arg", span }, branches, span };
      }

      // ── control flow ──
      case "match_expr": {
        const [subj, ...rest] = n.namedChildren;
        const branches = rest.filter(c => c.type === "match_branch").map(b => this.lowerBranch(b));
        return { tag: "Match", subject: subj ? this.lowerExpr(subj) : this.err(span), branches, span };
      }
      case "responsive_expr":  return this.lowerResponsive(n, span);
      case "if_expr":          return this.lowerIfExpr(n, span);
      case "if_pattern_expr":  return this.lowerIfPatternExpr(n, span);
      case "brace_block":
        return { tag: "Do", stmts: n.namedChildren.map(c => this.lowerStmt(c)), span };
      case "pipe_block":
        return this.lowerPipeBlock(n, span);
      case "try_block":
        return { tag: "Try", stmts: n.namedChildren.map(c => this.lowerStmt(c)), span };
      case "retry_block":
        return this.lowerRetryBlock(n, span);
      case "loop_expr":
        return { tag: "Loop", stmts: n.namedChildren.map(c => this.lowerStmt(c)), span };
      case "machine_expr":
        return { tag: "Machine", steps: n.namedChildren.filter(c => c.type === "saga_step").map(s => this.lowerMachineStep(s)), span };
      case "saga_expr": {
        // `saga StoreName` — a state machine backed by a store, with rollback.
        const store = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
        const steps = n.namedChildren.filter(c => c.type === "saga_step").map(s => this.lowerMachineStep(s));
        return { tag: "Machine", steps, store, span };
      }
      case "await_expr": {
        const expr = n.namedChildren[0];
        return { tag: "Await", expr: expr ? this.lowerExpr(expr) : this.err(span), branches: [], span };
      }
      case "go_expr": {
        const inner = n.namedChildren.find(c => isExprKind(c.type)) ?? n.namedChildren[0];
        return { tag: "Go", expr: inner ? this.lowerExpr(inner) : this.err(span), span };
      }
      case "resume_expr": {
        const inner = n.namedChildren.find(c => isExprKind(c.type)) ?? n.namedChildren[0];
        return { tag: "Resume", expr: inner ? this.lowerExpr(inner) : this.err(span), span };
      }
      case "drop_expr": {
        const inner = n.namedChildren.find(c => isExprKind(c.type)) ?? n.namedChildren[0];
        return { tag: "Drop", expr: inner ? this.lowerExpr(inner) : this.err(span), span };
      }
      case "break_expr":    return { tag: "Break", value: null, span };
      case "continue_expr": return { tag: "Continue", span };

      // ── misc ──
      case "type_test": {
        const [expr] = n.namedChildren;
        const upper = n.namedChildren.find(c => c.type === "upper_id");
        return { tag: "TypeTest", expr: expr ? this.lowerExpr(expr) : this.err(span), against: { tag: "TRNamed", name: upper?.text ?? "?", args: [] }, span };
      }
      case "for_expr": return this.lowerForExpr(n, span);
      case "for_child": return this.lowerForChild(n, span);
      case "send_expr": case "ask_expr": return this.lowerSendAsk(n, span);
      case "js_block": {
        // @js{ raw JS expression } — grammar: seq('@js{', token.immediate(/[^}]*/), '}')
        // Extract by slicing `@js{` prefix and `}` suffix from the full node text.
        const full = n.text;
        const code = full.startsWith("@js{") ? full.slice(4, full.lastIndexOf("}")) : "";
        return { tag: "JSExpr", code: code.trim(), span };
      }
      case "lazy_expr": return n.namedChildren[0] ? this.lowerExpr(n.namedChildren[0]) : this.err(span);

      case "transaction_expr": {
        // `transaction within { cfg }` then an indented body of statements.
        // The optional leading record_literal is the within-config (retry/window),
        // not a body statement.
        const cfgNode = n.namedChildren.find(c => c.type === "record_literal") ?? null;
        const config = cfgNode ? this.lowerExpr(cfgNode) : null;
        const body = n.namedChildren
          .filter(c => c !== cfgNode && (isStmtKind(c.type) || isExprKind(c.type)))
          .map(c => this.lowerStmt(c));
        return { tag: "Transaction", config, body, span };
      }
      case "comptime_block":
      case "unsafe_block":
        return { tag: "Do", stmts: n.namedChildren.filter(c => isStmtKind(c.type) || isExprKind(c.type)).map(c => this.lowerStmt(c)), span };

      case "element":
      case "element_leaf":
        return this.lowerElement(n, span);

      case "on_handler": {
        // `on <event> -> <body>` (inline) or a block of statements. The event is
        // the first named child (e.g. `onClick`); the rest is the handler body,
        // captured as a thunk so it runs on dispatch, not at render time.
        const eventNode = n.namedChildren[0];
        const event = eventNode?.text ?? "on";
        // An optional event param is a bare `lower_id` right after the event (body
        // exprs are always wrapped nodes like identifier_expr, never bare lower_id).
        const paramNode = n.namedChildren[1]?.type === "lower_id" ? n.namedChildren[1] : null;
        const param = paramNode?.text ?? null;
        const bodyNodes = n.namedChildren.slice(paramNode ? 2 : 1);
        const body: Expr = bodyNodes.length === 1 && isExprKind(bodyNodes[0]!.type)
          ? this.lowerExpr(bodyNodes[0]!)
          : { tag: "Do", stmts: bodyNodes.map(c => this.lowerStmt(c)), span };
        return { tag: "Handler", event, param, body, span };
      }

      default:
        if (n.namedChildren.length === 1) return this.lowerExpr(n.namedChildren[0]!);
        return this.err(span);
    }
  }

  // ── Pipe desugar ─────────────────────────────────────────────────────────────

  private lowerPipe(n: N, span: Span): Expr {
    const [lhsNode, rhsNode] = n.namedChildren;
    const left = lhsNode ? this.lowerExpr(lhsNode) : this.err(span);
    if (!rhsNode) return left;

    switch (rhsNode.type) {
      case "lower_id": case "upper_id":
        return { tag: "Call", fn: { tag: "Var", name: rhsNode.text, span: this.sp(rhsNode) }, args: [left], named: [], span };

      // `x |> f(a)` / `x |> Mod.f(a)` — the piped value is spliced in as the
      // leading positional argument; any args/named-args already written stay.
      case "call": {
        const inner = this.lowerExpr(rhsNode);
        if (inner.tag === "Call") {
          return { tag: "Call", fn: inner.fn, args: [left, ...inner.args], named: inner.named, span };
        }
        return { tag: "Call", fn: inner, args: [left], named: [], span };
      }

      case "pipe_match": {
        const branches = rhsNode.namedChildren.filter(c => c.type === "match_branch").map(b => this.lowerBranch(b));
        return { tag: "Match", subject: left, branches, span };
      }

      case "pipe_lambda_call": {
        // fnName :cap* param -> body
        const fnName = rhsNode.namedChildren[0]?.text ?? "?";
        const patNode = rhsNode.namedChildren.find(c => isPatKind(c.type));
        const bodyNode = rhsNode.namedChildren.at(-1)!;
        const p: Param = { pat: patNode ? this.lowerPat(patNode) : { tag: "PWild", span }, ascription: null, span };
        const lambda: Expr = { tag: "Lambda", params: [p], body: this.lowerExpr(bodyNode), span: this.sp(rhsNode) };
        return { tag: "Call", fn: { tag: "Var", name: fnName, span }, args: [left, lambda], named: [], span };
      }

      default:
        return { tag: "Call", fn: this.lowerExpr(rhsNode), args: [left], named: [], span };
    }
  }

  // ── If / if-pattern ──────────────────────────────────────────────────────────

  // `responsive | Mobile -> … | …` desugars to a match on the implicit
  // `viewport.breakpoint` subject — reusing the Breakpoint exhaustiveness check.
  private lowerResponsive(n: N, span: Span): Expr {
    const branches = n.namedChildren
      .filter(c => c.type === "match_branch")
      .map(b => this.lowerBranch(b));
    const subject: Expr = {
      tag: "Field",
      obj: { tag: "Var", name: "viewport", span },
      field: "breakpoint",
      span,
    };
    return { tag: "Match", subject, branches, span };
  }

  private lowerIfExpr(n: N, span: Span): Expr {
    const named = n.namedChildren;
    const cond = named[0]!;
    const elseAnonIdx = n.children.findIndex(c => !c.isNamed && c.text === "else");

    const thenNodes = elseAnonIdx < 0
      ? named.slice(1)
      : named.filter(c => n.children.indexOf(c) > 0 && n.children.indexOf(c) < elseAnonIdx);
    const elseNodes = elseAnonIdx >= 0
      ? named.filter(c => n.children.indexOf(c) > elseAnonIdx)
      : [];

    const toBlock = (nodes: N[]): Expr =>
      nodes.length === 1 && isExprKind(nodes[0]!.type)
        ? this.lowerExpr(nodes[0]!)
        : { tag: "Do", stmts: nodes.map(s => this.lowerStmt(s)), span };

    return { tag: "If", cond: this.lowerExpr(cond), then: toBlock(thenNodes), else_: elseNodes.length ? toBlock(elseNodes) : null, span };
  }

  private lowerIfPatternExpr(n: N, span: Span): Expr {
    // if expr = pattern → desugar to match
    const named = n.namedChildren;
    const subj = named[0]!;
    const patNode = named.find(c => isPatKind(c.type));
    const elseAnonIdx = n.children.findIndex(c => !c.isNamed && c.text === "else");

    const isBodyNode = (c: N): boolean => c !== subj && !isPatKind(c.type);
    const thenNodes = named.filter(c => isBodyNode(c) && (elseAnonIdx < 0 || n.children.indexOf(c) < elseAnonIdx));
    const elseNodes = elseAnonIdx >= 0 ? named.filter(c => isBodyNode(c) && n.children.indexOf(c) > elseAnonIdx) : [];

    const thenExpr: Expr = { tag: "Do", stmts: thenNodes.map(s => this.lowerStmt(s)), span };
    const elseExpr: Expr | null = elseNodes.length ? { tag: "Do", stmts: elseNodes.map(s => this.lowerStmt(s)), span } : null;
    const pat: Pat = patNode ? this.lowerPat(patNode) : { tag: "PWild", span };

    const branches: Branch[] = [
      { pat, guard: null, body: thenExpr, span },
      ...(elseExpr ? [{ pat: { tag: "PWild" as const, span }, guard: null, body: elseExpr, span }] : []),
    ];
    return { tag: "Match", subject: this.lowerExpr(subj), branches, span };
  }

  // ── For / send / ask ─────────────────────────────────────────────────────────

  private lowerForExpr(n: N, span: Span): Expr {
    const clauses: import("./ast.js").ForClause[] = [];
    // The body is the expression after `->`; the generators and filters are the
    // for_generator / for_clause nodes — anything else is the body.
    const bodyNode = n.namedChildren.find(c => c.type !== "for_generator" && c.type !== "for_clause");
    for (const c of n.namedChildren) {
      if (c === bodyNode) continue;
      if (c.type === "for_generator") clauses.push(this.lowerForGen(c, span));
      else if (c.type === "for_clause") {
        const inner = c.namedChildren[0];
        if (inner?.type === "for_generator") clauses.push(this.lowerForGen(inner, span));
        else if (inner) clauses.push({ tag: "Filter", cond: this.lowerExpr(inner) });
      }
    }
    return {
      tag: "For",
      clauses,
      body: bodyNode ? this.lowerExpr(bodyNode) : this.err(span),
      span,
    };
  }

  // `for r in rows` → a list comprehension `for (r = rows) -> <body>`, where the
  // per-item element is auto-keyed: if it sets no `id`/`key` prop of its own, we
  // stamp `key = r.id` (the implicit SQL-primary-key default). An item type without
  // an `id` field then fails type-checking on `r.id` — that *is* the "you must key
  // it" enforcement (add an `id`, or set an explicit `id`/`key` on the element).
  private lowerForChild(n: N, span: Span): Expr {
    const binding = n.namedChildren.find(c => c.type === "lower_id")?.text ?? "_";
    const bodyNode = n.namedChildren.find(c => c.type === "element" || c.type === "element_leaf");
    const srcNode  = n.namedChildren.find(c => c.type !== "lower_id" && c !== bodyNode);
    const body = bodyNode ? this.lowerExpr(bodyNode) : this.err(span);
    if (body.tag === "Element" && !body.props.some(p => p.name === "id" || p.name === "key"))
      body.props.push({
        name: "key",
        value: { tag: "Field", obj: { tag: "Var", name: binding, span }, field: "id", span },
      });
    return {
      tag: "For",
      clauses: [{ tag: "Gen", binding: { tag: "PVar", name: binding, span }, iter: srcNode ? this.lowerExpr(srcNode) : this.err(span) }],
      body,
      span,
    };
  }

  // A record literal/spread opened with a bare `{` (not `#{`) is the legacy form,
  // deprecated in favour of `#{ … }` so records never collide with `{ … }` blocks.
  // Warn in 2026.1, error in 2026.6 (SPEC §17 lifecycle).
  private checkRecordOpener(n: N): void {
    if (n.children[0]?.text !== "{") return;   // already `#{` — canonical
    const deprecated = atLeast(this.edition, "2026.6");
    this.diagnostics.push({
      kind: deprecated ? "error" : "warning",
      message: deprecated
        ? "bare `{ … }` record literals are removed in edition 2026.6 — use `#{ … }`"
        : "bare `{ … }` record literals are deprecated — use `#{ … }` (rejected from edition 2026.6)",
      span: this.sp(n),
    });
  }

  private lowerForGen(gen: N, span: Span): import("./ast.js").ForClause {
    const binding = gen.namedChildren.find(c => c.type === "lower_id")?.text ?? "_";
    const src = gen.namedChildren.find(c => c.type === "for_source");
    let iterNode: N | undefined;
    if (src) {
      // Legacy `x = source` form (optionally `%source`). Deprecated → use `x in iter`.
      const hasPercent = src.children.some(c => !c.isNamed && c.text === "%");
      const deprecated = atLeast(this.edition, "2026.6");
      const what = hasPercent ? "the `%` iteration sigil and `for (x = …)`" : "`for (x = …)`";
      this.diagnostics.push({
        kind: deprecated ? "error" : "warning",
        message: deprecated
          ? `${what} is removed in edition 2026.6 — use \`for (x in iter)\``
          : `${what} is deprecated — use \`for (x in iter)\` (rejected from edition 2026.6)`,
        span: this.sp(gen),
      });
      iterNode = src.namedChildren[0];
    } else {
      // New `x in iter` form: the iterable is the generator's non-binding child.
      iterNode = gen.namedChildren.find(c => c.type !== "lower_id");
    }
    return {
      tag: "Gen",
      binding: { tag: "PVar", name: binding, span },
      iter: iterNode ? this.lowerExpr(iterNode) : this.err(span),
    };
  }

  private lowerSendAsk(n: N, span: Span): Expr {
    const storeName = n.namedChildren[0]?.text ?? "?";
    const msgNode   = n.namedChildren[1];
    if (!msgNode) return { tag: "Lit", lit: { tag: "Unit" }, span };

    if (n.type === "send_expr") {
      // `send Stream (Push v)` or `send Store (Msg args)` — preserve the store name
      // so the runtime can route to the right stream queue or store mailbox.
      return { tag: "Send", store: storeName, msg: this.lowerExpr(msgNode), span };
    } else {
      // `ask Store val` — read a pub value; equivalent to `Store.val`.
      const inner = msgNode.type === "atom" ? (msgNode.namedChildren[0] ?? msgNode) : msgNode;
      const fieldName = inner.type === "atom_lit"
        ? (inner.namedChildren[0]?.text ?? inner.text.replace(/^:/, ""))
        : inner.text;
      return { tag: "Field", obj: { tag: "Var", name: storeName, span }, field: fieldName, span };
    }
  }

  // ── Elements ─────────────────────────────────────────────────────────────────

  private lowerElement(n: N, span: Span): Expr {
    const name = n.namedChildren.find(c => c.type === "upper_id")?.text ?? "?";
    const childBlock = n.namedChildren.find(c => c.type === "children_block");
    const children = (childBlock?.namedChildren.filter(c => c.type === "child") ?? []).flatMap(c => {
      const inner = c.namedChildren[0];
      return inner ? [this.lowerExpr(inner)] : [];
    });

    // Paren-form (`Column(gap=8)` + children): content = first positional, props =
    // `name=value`. Childless paren elements never reach here (they parse as `call`).
    const argsNode = n.namedChildren.find(c => c.type === "element_args");
    if (argsNode) {
      const props: Prop[] = [];
      let contentExpr: Expr | null = null;
      for (const a of argsNode.namedChildren) {
        if (a.type === "named_arg") props.push(this.lowerProp(a));
        else if (contentExpr === null) contentExpr = this.lowerExpr(a);   // first positional = content
      }
      return { tag: "Element", name, content: contentExpr, props, children, span };
    }

    // Legacy space-form (`Text "hi" size=12`) — the last space-form holdout from the
    // call-syntax unification (§2.1). Deprecated in 2026.1, an error in 2026.6.
    this.checkElementForm(n, name);
    const content = n.namedChildren.find(c => c.type === "element_content");
    const props = n.namedChildren.filter(c => c.type === "prop").map(p => this.lowerProp(p));
    const contentExpr = content?.namedChildren[0] ? this.lowerExpr(content.namedChildren[0]) : null;
    return { tag: "Element", name, content: contentExpr, props, children, span };
  }

  // Deprecate the space-form element surface: `Text "hi" size=12` reads as a third
  // application syntax (vs `f(x)` and `Ok(x)`); the paren-form `Text("hi", size=12)`
  // unifies it. Warning in 2026.1, error in 2026.6 (SPEC §17 lifecycle).
  private checkElementForm(n: N, name: string): void {
    const deprecated = atLeast(this.edition, "2026.6");
    this.diagnostics.push({
      kind: deprecated ? "error" : "warning",
      message: deprecated
        ? `space-form element \`${name} …\` is removed in edition 2026.6 — use paren-form \`${name}(…)\``
        : `space-form element \`${name} …\` is deprecated — use paren-form \`${name}(…)\` (rejected from edition 2026.6)`,
      span: this.sp(n.namedChildren.find(c => c.type === "upper_id") ?? n),
    });
  }

  // Build an `Element` from a lowered paren-form call whose head is a primitive
  // (`Text("hi", size=12)`). The first positional becomes the node's content; named
  // args become props (bare flags already carry value=true). Childless — children
  // ride the `element` grammar rule's indented block (lowerElement).
  private elementFromCall(name: string, args: Expr[], named: NamedArg[], span: Span): Expr {
    const content = args.length > 0 ? args[0]! : null;
    const props: Prop[] = named.map(a => ({ name: a.name, value: a.value }));
    return { tag: "Element", name, content, props, children: [], span };
  }

  private lowerProp(n: N): Prop {
    const span = this.sp(n);
    const nameId = n.namedChildren.find(c => c.type === "lower_id");
    const val = n.namedChildren.find(c => c !== nameId);
    return {
      name: nameId?.text ?? "?",
      value: val ? this.lowerExpr(val) : { tag: "Lit", lit: { tag: "Bool", value: true }, span },
    };
  }

  // ── Call argument lowering ────────────────────────────────────────────────────
  // The `call` grammar rule yields a real argument list: each child after the
  // callee is either a positional `_expr` or a `named_arg` (name=value). Split
  // them into the two buckets the resolver expects.

  private lowerArgs(argNodes: N[]): { args: Expr[]; named: NamedArg[] } {
    const args: Expr[] = [];
    const named: NamedArg[] = [];
    for (const a of argNodes) {
      if (a.type === "named_arg") {
        const nameNode = a.namedChildren[0]!;
        const valNode = a.namedChildren[1]!;
        named.push({ name: nameNode.text, value: this.lowerExpr(valNode), span: this.sp(a) });
      } else {
        args.push(this.lowerExpr(a));
      }
    }
    return { args, named };
  }

  // ── String interpolation ─────────────────────────────────────────────────────

  private lowerStringExpr(n: N, span: Span): Expr {
    const hasInterp = n.children.some(c => c.type === "{");
    if (!hasInterp) {
      const value = unescapeStr(n.text.slice(1, -1));
      return { tag: "Lit", lit: { tag: "Str", value }, span };
    }

    const raw   = n.text;           // includes surrounding quotes
    const base  = n.startIndex;
    const parts: Expr[] = [];
    let textStart = 1;              // skip opening "

    for (let i = 0; i < n.childCount; i++) {
      const child = n.child(i)!;
      const offset = child.startIndex - base;

      if (child.type === "{") {
        // flush text before this {
        const text = unescapeStr(raw.slice(textStart, offset));
        if (text) parts.push({ tag: "Lit", lit: { tag: "Str", value: text }, span });
        // the next child is the interpolated expression
        const exprChild = n.child(i + 1);
        // An empty (`{}`) or errored interpolation has no expression to lower
        // (tree-sitter yields an error `identifier_expr` with empty text). Report
        // it as an error — `{…}` always interpolates, so empty braces are a
        // mistake; literal braces must be written `\{` / `\}`. Lower the slot to
        // an empty string so neither the type checker nor the interpreter crashes
        // on a `Var ""` (the diagnostic is the user-facing signal).
        const isEmpty = !exprChild?.isNamed || exprChild.hasError || exprChild.text.trim() === "";
        if (!isEmpty) {
          const es = this.sp(exprChild);
          const inner = this.lowerExpr(exprChild);
          parts.push({ tag: "Call", fn: { tag: "Var", name: "toString", span: es }, args: [inner], named: [], span: es });
          i++; // skip expr, the } is handled next iteration
        } else {
          const rbrace = exprChild?.isNamed ? n.child(i + 2) : n.child(i + 1);
          const braceSpan: Span = rbrace
            ? { ...this.sp(child), end: this.sp(rbrace).end }
            : this.sp(child);
          this.diagnostics.push({
            kind: "error",
            span: braceSpan,
            message: "empty interpolation: `{}` has no expression — write `{name}` to interpolate a value, or `\\{` `\\}` for literal braces",
          });
          parts.push({ tag: "Lit", lit: { tag: "Str", value: "" }, span });
          if (exprChild?.isNamed) i++; // skip the empty/error node so the `}` resets textStart
        }
      } else if (child.type === "}") {
        textStart = offset + 1;
      } else if (child.type === '"' && i === n.childCount - 1) {
        // closing quote — flush trailing text
        const text = unescapeStr(raw.slice(textStart, offset));
        if (text) parts.push({ tag: "Lit", lit: { tag: "Str", value: text }, span });
      }
    }

    if (parts.length === 0) return { tag: "Lit", lit: { tag: "Str", value: "" }, span };
    if (parts.length === 1) return parts[0]!;
    let result = parts[0]!;
    for (let i = 1; i < parts.length; i++)
      result = { tag: "BinOp", op: "++", left: result, right: parts[i]!, span };
    return result;
  }

  // ── Literals ─────────────────────────────────────────────────────────────────

  lowerLit(n: N): Lit {
    switch (n.type) {
      case "number":           return { tag: "Num",  value: parseNumber(n.text) };
      case "bool":             return { tag: "Bool", value: n.text === "true" };
      case "unit":             return { tag: "Unit" };
      case "atom_lit":         return { tag: "Atom", name: n.text.slice(1) };
      case "duration_lit":     return { tag: "Duration", ms: parseDuration(n.text) };
      case "triple_quote_string": return { tag: "Str", value: n.text.slice(3, -3) };
      case "string":           return { tag: "Str",  value: unescapeStr(n.text.slice(1, -1)) };
      case "multiline_string": {
        const t = n.text;
        if (t.startsWith('"""')) return { tag: "Str", value: t.slice(3, -3) };
        return { tag: "Str", value: t.slice(1, -1) };  // backtick
      }
      default:                 return { tag: "Str",  value: n.text };
    }
  }

  // ── Patterns ─────────────────────────────────────────────────────────────────

  // The shared row lowering for inputmap_def / keymap_def: each inputmap_row
  // is [pattern, action-expr, label?-string] — the label string is field-tagged
  // in the grammar so it can't be confused with the action.
  private lowerInputmapRows(n: N): InputmapRow[] {
    return n.namedChildren
      .filter(c => c.type === "inputmap_row")
      .map(r => {
        const span = this.sp(r);
        const patNode = r.namedChildren.find(c => c.type === "pattern");
        // Guards ride inside the pattern node (`pat if cond`) — split them
        // out the same way lowerBranch does.
        const guardNode = patNode?.namedChildren[0]?.type === "guard_pattern"
          ? patNode!.namedChildren[0]! : null;
        const pat = guardNode
          ? (guardNode.namedChildren[0] ? this.lowerPat(guardNode.namedChildren[0]!) : { tag: "PWild" as const, span })
          : (patNode ? this.lowerPat(patNode) : { tag: "PWild" as const, span });
        const guard = guardNode?.namedChildren[1]
          ? this.lowerExpr(guardNode.namedChildren[1]!) : null;
        const labelNode = r.childForFieldName("label");
        const actionNode = r.namedChildren.find(c => c !== patNode && c !== labelNode && isExprKind(c.type));
        return {
          pat, guard,
          action: actionNode ? this.lowerExpr(actionNode) : this.err(span),
          label: labelNode ? unescapeStr(labelNode.text.slice(1, -1)) : null,
          span,
        };
      });
  }

  lowerPat(n: N): Pat {
    const span = this.sp(n);

    switch (n.type) {
      case "pattern":
      case "simple_pattern":
        return n.namedChildren[0] ? this.lowerSimplePat(n, span) : { tag: "PWild", span };
      case "guard_pattern": {
        // guard is handled at branch level; return just the inner pat
        const inner = n.namedChildren[0];
        return inner ? this.lowerPat(inner) : { tag: "PWild", span };
      }
      case "binding_pattern": return { tag: "PVar",  name: n.text, span };
      case "wildcard":        return { tag: "PWild", span };
      case "record_pattern": {
        const fields = n.namedChildren.filter(c => c.type === "lower_id").map(c => ({
          name: c.text, pat: { tag: "PVar" as const, name: c.text, span: this.sp(c) },
        }));
        return { tag: "PRecord", fields, span };
      }
      case "literal": {
        const inner = n.namedChildren[0] ?? n;
        return { tag: "PLit", lit: this.lowerLit(inner), span };
      }
      case "upper_id":    return { tag: "PCtor", name: n.text, inner: null, span };
      case "lower_id":    return { tag: "PVar",  name: n.text, span };
      case "atom_lit":    return { tag: "PAtom", name: n.text.slice(1), span };
      case "tuple_pattern":
        return { tag: "PTuple", elems: n.namedChildren.filter(c => isPatKind(c.type)).map(c => this.lowerPat(c)), span };
      default:            return { tag: "PWild", span };
    }
  }

  // A constructor pattern destructures its payload with construction syntax:
  // `Ok(v)`, mirroring how the value is built (`Ok(v)`). The legacy *bare* form
  // `Ok v` (space-separated, undelimited payload) is the last space-form holdout
  // from the call-syntax unification (§2.1) — deprecated in 2026.1, removed in
  // 2026.6. Delimited payloads (`Ok(v)`, `Ok (Chunk c)`, `Ok {body}`) already read
  // as construction and are left untouched.
  private checkCtorPatternForm(upper: N, inner: N, childCount: number): void {
    // Only the simple single-payload form is migrated; the rare `Ok response {body}`
    // (binding + record) shape (childCount > 2) is left alone.
    if (childCount > 2) return;
    const t = inner.text;
    if (t.startsWith("(") || t.startsWith("{")) return;   // already delimited
    const deprecated = atLeast(this.edition, "2026.6");
    this.diagnostics.push({
      kind: deprecated ? "error" : "warning",
      message: deprecated
        ? `bare constructor pattern \`${upper.text} ${t}\` is removed in edition 2026.6 — use \`${upper.text}(${t})\``
        : `bare constructor pattern \`${upper.text} ${t}\` is deprecated — use \`${upper.text}(${t})\` (rejected from edition 2026.6)`,
      span: this.sp(inner),
    });
  }

  private lowerSimplePat(n: N, span: Span): Pat {
    const named = n.namedChildren;

    // Upper_id  (constructor, possibly with payload)
    const upper = named.find(c => c.type === "upper_id");
    if (upper) {
      const inner = named.find(c => c !== upper);
      if (inner) this.checkCtorPatternForm(upper, inner, named.length);
      return { tag: "PCtor", name: upper.text, inner: inner ? this.lowerPat(inner) : null, span };
    }

    const first = named[0];
    if (!first) {
      // Bare text node
      if (n.text === "_") return { tag: "PWild", span };
      if (n.text === "[]") return { tag: "PLit", lit: { tag: "Str", value: "[]" }, span };
      return { tag: "PVar", name: n.text, span };
    }

    return this.lowerPat(first);
  }

  // ── Branches ──────────────────────────────────────────────────────────────────

  lowerBranch(n: N): Branch {
    const span = this.sp(n);
    // Split on the '->' token — everything named before it is a pattern, after it is the body.
    const arrowIdx = n.children.findIndex(c => !c.isNamed && c.text === "->");
    const patNodes = arrowIdx >= 0
      ? n.namedChildren.filter(c => n.children.indexOf(c) < arrowIdx)
      : n.namedChildren.filter(c => c.type === "pattern" || c.type === "simple_pattern" || c.type === "guard_pattern");
    const bodyNodes = arrowIdx >= 0
      ? n.namedChildren.filter(c => n.children.indexOf(c) > arrowIdx)
      : [];

    let pat: Pat = { tag: "PWild", span };
    let guard: Expr | null = null;

    if (patNodes.length >= 1) {
      const first = patNodes[0]!;
      // guard_pattern may be the first node directly, or wrapped in a pattern node
      const guardNode = first.type === "guard_pattern" ? first
        : (first.type === "pattern" && first.namedChildren[0]?.type === "guard_pattern")
          ? first.namedChildren[0]!
          : null;
      if (guardNode) {
        const [innerPat, guardExpr] = guardNode.namedChildren;
        pat   = innerPat  ? this.lowerPat(innerPat)   : pat;
        guard = guardExpr ? this.lowerExpr(guardExpr) : null;
      } else {
        pat = this.lowerPat(first);
      }
    }

    const body = bodyNodes.length ? this.lowerBranchBody(bodyNodes, span) : this.err(span);
    return { pat, guard, body, span };
  }

  // `pipe` block: thread each line's result into `ret` for the next line.
  // `a; b ret; c ret` becomes `ret = a; ret = b ret; c ret` — a Do block whose
  // value is the last line (which still sees the prior `ret`). Reuses Do, so no
  // infer/eval changes are needed. Bindings written explicitly pass through.
  //
  // DEPRECATED (Phase 3a): removed in edition 2026.6 — multiline `|>` chains cover
  // the same threading without the magic `ret` identifier (whose only meaning is
  // this desugar, so it vanishes with the block). Warning in baseline 2026.1,
  // error in 2026.6+ (SPEC §17 lifecycle). The block still lowers either way so the
  // rest of the module checks.
  private lowerPipeBlock(n: N, span: Span): Expr {
    const deprecated = atLeast(this.edition, "2026.6");
    this.diagnostics.push({
      kind: deprecated ? "error" : "warning",
      message: deprecated
        ? "the `pipe` block (and its magic `ret`) is removed in edition 2026.6 — use a multiline `|>` chain"
        : "the `pipe` block (and its magic `ret`) is deprecated — use a multiline `|>` chain (rejected from edition 2026.6)",
      span,
    });
    const stmts = n.namedChildren.map(c => this.lowerStmt(c));
    const threaded: Stmt[] = stmts.map((s, i) => {
      const isLast = i === stmts.length - 1;
      if (!isLast && s.tag === "SExpr") {
        return { tag: "SBind", pat: { tag: "PVar", name: "ret", span: s.span }, ascription: null, value: s.expr, declares: true, mutable: false, span: s.span };
      }
      return s;
    });
    return { tag: "Do", stmts: threaded, span };
  }

  // `retry [N] [D]` block. The count/schedule and optional bare duration delay
  // sit on the `retry` line; body statements are indented below. The delay is the
  // bare `duration_lit` on the header row; the count is the other header expr.
  private lowerRetryBlock(n: N, span: Span): Expr {
    const row = n.startPosition.row;
    const onRow = (c: N) => c.startPosition.row === row;
    const delayNode = n.namedChildren.find(c => c.type === "duration_lit" && onRow(c)) ?? null;
    const countNode = n.namedChildren.find(c => isExprKind(c.type) && onRow(c) && c !== delayNode) ?? null;
    const count = countNode ? this.lowerExpr(countNode) : null;
    const delay = delayNode ? this.lowerExpr(delayNode) : null;
    const bodyNodes = n.namedChildren.filter(c => c !== countNode && c !== delayNode);
    return { tag: "Retry", count, delay, stmts: bodyNodes.map(c => this.lowerStmt(c)), span };
  }

  // A branch body is the run of CST nodes after `->`. They are direct siblings of
  // the `match_branch` (not wrapped in a block node): a single inline expression,
  // a single statement (e.g. a bare `x = e` reassignment, which parses as a
  // `binding`), or several indented statements. A lone expression node is lowered
  // as an expression so the branch keeps its value; anything else is a Do block of
  // statements so reassignments (`SBind` declares:false) and multi-line bodies are
  // preserved rather than having the assignment's children flattened away.
  private lowerBranchBody(nodes: N[], span: Span): Expr {
    if (nodes.length === 1 && isExprKind(nodes[0]!.type)) return this.lowerExpr(nodes[0]!);
    return { tag: "Do", stmts: nodes.map(c => this.lowerStmt(c)), span };
  }
}
