import type { Span } from "./span.js";
import type { Type } from "./types.js";
import type { Edition } from "./edition.js";

// Every node carries a span and (after inference) a resolved type.
interface Node {
  span: Span;
  type?: Type;
}

// ── Literals ──────────────────────────────────────────────────────────────────

export type Lit =
  | { tag: "Str";    value: string }
  | { tag: "Num";    value: number }
  | { tag: "Bool";   value: boolean }
  | { tag: "Unit" }
  | { tag: "Atom";   name: string }     // :ok, :err, :pending …
  | { tag: "Duration"; ms: number }     // 30s, 100ms, 5m, 1h

// ── Patterns ──────────────────────────────────────────────────────────────────

export type Pat =
  | ({ tag: "PWild" }                                        & Node)
  | ({ tag: "PVar";     name: string }                       & Node)
  | ({ tag: "PLit";     lit: Lit }                           & Node)
  | ({ tag: "PAtom";    name: string }                       & Node)   // :ok
  | ({ tag: "PCtor";    name: string; inner: Pat | null }    & Node)   // Ok(x)
  | ({ tag: "PTuple";   elems: Pat[] }                       & Node)
  | ({ tag: "PRecord";  fields: { name: string; pat: Pat }[] } & Node)
  | ({ tag: "PTyped";   name: string; ascription: TypeRef }  & Node)   // r: Rect

// ── Type references (as written in source, before resolution) ─────────────────

export type TypeRef =
  | { tag: "TRNamed";  name: string; args: TypeRef[] }
  | { tag: "TRAtom";   name: string }
  | { tag: "TRFn";     params: TypeRef[]; ret: TypeRef; effects: string[]; effectTail?: string }  // effectTail: user-spelled `..e` in the return slot's Effect clause (E2)
  | { tag: "TRTuple";  elems: TypeRef[] }
  | { tag: "TRRecord"; fields: { name: string; type: TypeRef; optional: boolean }[] }
  | { tag: "TRPtr";    lifetime: string | null; inner: TypeRef }   // Ptr [~a] T — lifetime is borrow-checker metadata
  | { tag: "TRExpr";   expr: Expr }   // a value-level argument in a (dependent) type application, e.g. InBounds(listLength xs)

// ── Expressions ───────────────────────────────────────────────────────────────

export type Expr =
  | ({ tag: "Lit";        lit: Lit }                                           & Node)
  | ({ tag: "Var";        name: string }                                       & Node)
  | ({ tag: "Call";       fn: Expr; args: Expr[]; named: NamedArg[] }           & Node)
  | ({ tag: "BinOp";      op: string; left: Expr; right: Expr }               & Node)
  | ({ tag: "UnOp";       op: string; expr: Expr }                             & Node)
  | ({ tag: "Field";      obj: Expr; field: string }                           & Node)
  | ({ tag: "Index";      obj: Expr; index: Expr }                             & Node)
  | ({ tag: "Lambda";     params: Param[]; body: Expr }                        & Node)
  | ({ tag: "Match";      subject: Expr; branches: Branch[] }                  & Node)
  | ({ tag: "If";         cond: Expr; then: Expr; else_: Expr | null }         & Node)
  | ({ tag: "Do";         stmts: Stmt[] }                                      & Node)
  | ({ tag: "For";        clauses: ForClause[]; body: Expr }                  & Node)
  | ({ tag: "Loop";       stmts: Stmt[] }                                      & Node)
  | ({ tag: "Range";      from: Expr; to: Expr; inclusive: boolean }           & Node)
  | ({ tag: "Tuple";      elems: Expr[] }                                      & Node)
  | ({ tag: "List";       elems: Expr[] }                                      & Node)
  | ({ tag: "Record";     fields: { name: string; value: Expr }[]; spread?: Expr } & Node)
  | ({ tag: "Propagate";  expr: Expr }                                         & Node)   // expr?
  | ({ tag: "PropWith";   expr: Expr; alt: Expr }                              & Node)   // expr?: alt
  | ({ tag: "Await";      expr: Expr; branches: Branch[] }                     & Node)
  | ({ tag: "TypeTest";   expr: Expr; against: TypeRef }                       & Node)   // expr is Rect
  | ({ tag: "Element";    name: string; content: Expr | null; props: Prop[]; children: Expr[] } & Node)
  | ({ tag: "Handler";    event: string; param: string | null; body: Expr }    & Node)   // on onInput e -> …Click -> body
  | ({ tag: "Break";      value: Expr | null }                                & Node)
  | ({ tag: "Continue" }                                                       & Node)
  | ({ tag: "Machine";    steps: MachineStep[]; store?: string }              & Node)
  | ({ tag: "Go";         expr: Expr }                                         & Node)   // spawn a concurrent task, returns a future
  | ({ tag: "Resume";     expr: Expr }                                         & Node)   // re-hydrate a crashed saga from its journal
  | ({ tag: "Drop";       expr: Expr }                                         & Node)   // `drop x` — deterministic early release of a Drop value; yields Unit
  | ({ tag: "AddrOf";     expr: Expr }                                         & Node)   // `e.&` — borrow: take the address of an lvalue, yields Ptr T
  | ({ tag: "Deref";      expr: Expr }                                         & Node)   // `e.*` — dereference a Ptr T, yields T
  | ({ tag: "JSExpr";     code: string }                                       & Node)   // @js{ raw JS expression }
  | ({ tag: "Send";       store: string; msg: Expr }                           & Node)   // send Stream (Push v) / send Store (Msg args)
  | ({ tag: "Transaction"; config: Expr | null; body: Stmt[] }                 & Node)   // transaction within { ... } <body> — atomic store coordination
  | ({ tag: "Try";        stmts: Stmt[] }                                      & Node)   // try block — `?` collapses to here; value is Result T E (Design A)
  | ({ tag: "Retry";      count: Expr | null; delay: Expr | null; stmts: Stmt[] } & Node) // retry [N] [after D] — re-run body on Error; count is N or a delay-schedule array; value Result T E

// A clause inside a `for` comprehension: either a generator (`x = source`) or a
// boolean filter. Clauses are evaluated left-to-right; generators nest (cartesian
// product) and filters prune combinations.
export type ForClause =
  | { tag: "Gen";    binding: Pat; iter: Expr }
  | { tag: "Filter"; cond: Expr }

export interface Prop {
  name: string;
  value: Expr;
}

// A `name=value` keyword argument at a call site. Same shape as Prop; kept as a
// distinct name so the call-resolution code reads clearly.
export interface NamedArg {
  name: string;
  value: Expr;
  span: Span;
}

export interface Branch {
  pat: Pat;
  guard: Expr | null;
  body: Expr;
  span: Span;
}

// ── Statements ────────────────────────────────────────────────────────────────

export type Stmt =
  | ({ tag: "SBind";   pat: Pat; ascription: TypeRef | null; value: Expr; declares: boolean; mutable: boolean } & Node)  // `let/mut x = e` (declares) vs bare `x = e` (reassign); mutable = `mut` keyword present (affine, single-owner)
  | ({ tag: "SExpr";   expr: Expr }                                          & Node)
  | ({ tag: "SAssign"; target: Expr; value: Expr }                          & Node)  // `xs[i] = v` / `p.* = v` — write through an lvalue (Index/Deref/Field)
  | ({ tag: "SBreak";  value: Expr | null }                                  & Node)
  | ({ tag: "SReturn"; value: Expr | null }                                  & Node)  // desugared from ?

// ── Function pieces ───────────────────────────────────────────────────────────

export interface Param {
  pat: Pat;
  ascription: TypeRef | null;
  default_?: Expr;        // `n = 0` / `n: Number = 0` — opts the param out of currying
  keywordOnly?: boolean;  // declared after a `*` separator — must be passed by name
  span: Span;
}

export interface FnSig {
  params: TypeRef[];
  ret: TypeRef;
  effects: string[];
  effectTails: string[];  // user-spelled `..e` tails in the Effect clause (E2; ≤1 enforced at lower)
  span: Span;
}

// A lifetime appearing in a `where` constraint: either a named region (`~a`) or
// the lifetime *of* a binding (`buf.~`, the region buf's referent lives in).
export type LifetimeRef =
  | { tag: "LVar"; name: string }      // ~a
  | { tag: "LOf";  binding: string };  // buf.~

// `where (~a >= ~b)` / `where (~a = ~b)` — an outlives or equality constraint
// between two lifetimes, used by the borrow checker's region solver.
export interface LifetimeConstraint {
  lhs: LifetimeRef;
  op: "outlives" | "eq";   // >= | =
  rhs: LifetimeRef;
}

export interface FnClause {
  params: Param[];
  ret: TypeRef | null;    // return type from function_def (if written inline)
  effects: string[];      // capabilities declared in Effect [...] annotation
  effectTails: string[];  // user-spelled `..e` tails in the Effect clause (E2; ≤1 enforced at lower)
  body: Expr;
  where_: { pat: Pat; value: Expr }[];  // where bindings
  lifetimeConstraints: LifetimeConstraint[];  // `where (~a >= ~b)` region bounds
  // `using S` / `using surface = <expr>` clause (theme-design §2b): the ambient
  // Surface this element-returning function renders onto. `value` is null for the
  // named form (`using panel`), set for the inline declare-and-apply sugar.
  surface: { name: string; value: Expr | null } | null;
  // Finer proof scope (SPEC §12.7 A4): a `proofs: [...]` clause at the head of
  // this clause's body promises THIS function's obligations — the same closed
  // vocabulary as the module scope, validated identically at lowering. Unioned
  // onto DFn.proofs (proofs are a function-level promise, spelled per clause).
  proofs?: string[];
  span: Span;
}

// ── Top-level declarations ────────────────────────────────────────────────────

export type Decl =
  | ({ tag: "DFn";
       name: string;
       sig: FnSig | null;
       clauses: FnClause[];
       // Tier marker: `@low`/`@kernel def …` opts a function into the low-level
       // tier — affine `mut`, pointers (`.&`/`.*`), and lifetimes are only legal
       // here. Default (false/undefined) is the GC'd high-level tier where those
       // are rejected and `mut` is a plain reassignable binding (no move-tracking).
       lowLevel?: boolean;
       // `@total def …` — Tier-1 structural totality (totality-design §3): an
       // opt-in, checked promise that the function terminates. A standalone
       // marker, NOT a pseudo-effect (totality-design §6 DECIDED) — it shares
       // only the call-gate *shape* with effects, run in the opposite direction
       // (totality flows DOWN the call graph: a total fn may only call total code).
       total?: boolean;
       // Finer proof scope (SPEC §12.7 A4): obligations promised by a per-
       // function `proofs: [...]` clause, unioned across this function's
       // clauses. The proof passes (facts/handled) treat a def in this set
       // exactly as if its enclosing module declared the obligation — the same
       // assume/guarantee, scoped to one def. `total` here also sets `total`
       // above (it routes through the existing totality engine unchanged).
       proofs?: string[] }                                                    & Node)

  | ({ tag: "DType";
       name: string;
       params: string[];
       body: TypeBody;
       // `@private type T = …` inside a module (north-star §3.5): the type
       // NAME stays public (usable in signatures anywhere), but the variant
       // CONSTRUCTORS resolve only inside the declaring module — outside code
       // can neither build nor match the representation, so the module's
       // smart constructors are the only gate. The primitive the refined-type
       // tier's soundness needs (a Natural nobody can forge).
       private_?: boolean }                                                   & Node)

  | ({ tag: "DStore";
       name: string;
       fields: { name: string; type: TypeRef; default_: Expr | null }[];
       messages: { name: string; params: Param[]; body: Expr }[];
       pubs: { name: string; body: Expr | null }[] }                          & Node)

  | ({ tag: "DMachine";
       name: string;
       states: MachineState[] }                                              & Node)

  // First-class saga: a top-level persistent FSM with compensation. Called like
  // a function (`Checkout(args)`) to run to completion, or spawned as a live
  // instance with `go Checkout(args)` (yields a saga handle with its own journal).
  | ({ tag: "DSaga";
       name: string;
       params: Param[];
       ret: TypeRef | null;
       store: string | null;   // explicit `over Store`, or null = auto-backed
       persisted: boolean;     // true for `machine … persisted` and `saga` (always true today)
       deprecated: boolean;    // surface form used the deprecated `saga` keyword
       steps: MachineStep[] }                                                & Node)

  // The declaration-site backpressure policy (SPEC §10.1). Applies to `Push`
  // values only — `Done` is the termination signal and is never dropped/blocked.
  // Absent (null) = unbounded buffer (the pre-policy behavior, kept as default).
  | ({ tag: "DStream";
       name: string;
       inner: TypeRef;
       policy: StreamPolicy | null }                                          & Node)

  // `inputmap Name over Stream` — a typed pattern-match over an input-event
  // stream, written as a table (multitarget-design §4.0). Each row maps a
  // pattern over the stream's event type to an action expression; the optional
  // label is help text (the substrate for the auto-generated help overlay).
  // Calling the inputmap (`Editor()`) runs the drain loop: await event, run the
  // first matching row's action, fall through on no match, stop on `Done`.
  // `form` records the surface keyword: `keymap Name` is pure sugar for
  // `inputmap Name over Key` (multitarget §4.0) and lowers to the same decl —
  // the form only tailors diagnostics (a keymap missing its `Key` stream gets
  // a keymap-shaped fix-it).
  | ({ tag: "DInputmap";
       name: string;
       stream: string;
       form: "inputmap" | "keymap";
       rows: InputmapRow[] }                                                  & Node)

  // A module-level binding: `let name [: Type] = expr` at the top level. The
  // semantic-token tier of styles-design §4.2 (`let surface = #0d1117`) and the
  // substrate the theme system folds into the contrast proof (theme-design §3,
  // Slice 1). A constant RHS is foldable by `constEval`, so a colour token
  // referenced in a prop participates in the §4.3 accessibility refinement.
  | ({ tag: "DLet";
       name: string;
       ascription: TypeRef | null;
       value: Expr;
       mutable: boolean }                                                    & Node)

  | ({ tag: "DImport";
       path: string;
       names: { name: string; alias: string | null }[] }                    & Node)

  | ({ tag: "DModule";
       name: string;
       capabilities: string[];
       // Proof obligations declared with `proofs: [...]` (SPEC §12.7) — the dual
       // of capabilities: effects flow up to callers, proofs flow down into every
       // def the module contains. Closed vocabulary, validated at lower time;
       // declared = enforced (an obligation we can't check yet is a lower error,
       // never a silent skip).
       proofs: string[];
       decls: Decl[] }                                                       & Node)

// The per-stream backpressure policy (SPEC §10.1), written at the declaration
// site: `drop` (lossy — deliver to a waiting consumer, else discard), `buffer N`
// (bounded — keep the newest N, evict oldest on overflow), `block` (lossless —
// `send` suspends until a consumer takes the value).
export type StreamPolicy =
  | { kind: "drop" }
  | { kind: "buffer"; n: number }
  | { kind: "block" }

// ── Type bodies (for type declarations) ──────────────────────────────────────

export type TypeBody =
  | { tag: "TBAlias";   ref: TypeRef; pred: Expr | null; unit?: { atom: string; exp: number }[] }  // pred set ⇒ refinement type; unit set ⇒ unit-of-measure type (B2). Raw signed factors from the `unit_clause`; normalized into a Dims vector at registration.
  | { tag: "TBRecord";  fields: { name: string; type: TypeRef; optional: boolean }[] }
  | { tag: "TBAdt";     variants: AdtVariant[] }
  | { tag: "TBExtern";  fields: { name: string; type: TypeRef }[]; align: number | null }

export interface AdtVariant {
  name: string;
  payload: TypeRef | null;
  span: Span;
}

// ── State machine pieces ──────────────────────────────────────────────────────

// A statement inside a machine step.
export type SagaStmt =
  | { tag: "Goto";   target: string; args: Expr[]; span: Span }              // :nextState args
  | { tag: "Yield";  expr: Expr; span: Span }                                // terminal value / side-effect
  | { tag: "SBindS"; name: string; value: Expr; span: Span }                 // let x = e inside a step
  | { tag: "SagaMatch"; subject: Expr; branches: SagaBranch[]; span: Span }
  | { tag: "SagaIf"; cond: Expr; then: SagaStmt[]; else_: SagaStmt[]; span: Span }
  | { tag: "SagaGo"; expr: Expr; span: Span }                                // go expr — fire-and-forget
  | { tag: "SagaJoin"; tasks: Expr[]; branches: SagaBranch[]; span: Span }    // go..go then | branches (join on a tuple of results)
  | { tag: "SagaRace"; arms: RaceArm[]; branches: SagaBranch[]; span: Span }  // race { go/after/until } then | branches
  | { tag: "Rollback"; expr: Expr; mode: "defer" | "recover"; target: string; span: Span } // expr ? rollback :step | expr ?: rollback :step

export interface SagaBranch { pat: Pat; body: SagaStmt[] }

// One `pattern -> action ["label"]` row of an inputmap table. The action is an
// expression evaluated with the pattern's bindings in scope — an explicit call
// (`save()`), per the §2.1 unified call syntax; a bare function reference is a
// checker error with a fix-it.
export interface InputmapRow { pat: Pat; guard: Expr | null; action: Expr; label: string | null; span: Span }

// Canonical structural key of a pattern, for inputmap conflict analysis and
// `++` layering (match-overlap, multitarget-design §4.0). Binders normalize to
// `_` — what a row *matches* is unaffected by what it names: `Push(x)` and
// `Push(y)` (and `Push(_)`) all claim the same events.
export function patKey(p: Pat): string {
  switch (p.tag) {
    case "PWild": case "PVar": case "PTyped": return "_";
    case "PLit":    return JSON.stringify(p.lit);
    case "PAtom":   return `:${p.name}`;
    case "PCtor":   return `${p.name}(${p.inner ? patKey(p.inner) : ""})`;
    case "PTuple":  return `(${p.elems.map(patKey).join(",")})`;
    case "PRecord": return `{${p.fields.map(f => f.name).sort().join(",")}}`;
  }
}

// Source-shaped print of a pattern, for the inputmap help table (SPEC §10.5) —
// what a help overlay shows next to the label. Not a parser round-trip
// guarantee; just the obvious rendering of each form.
export function patToSource(p: Pat): string {
  switch (p.tag) {
    case "PWild":   return "_";
    case "PVar":    return p.name;
    case "PTyped":  return `${p.name}: …`;
    case "PAtom":   return `:${p.name}`;
    case "PCtor":   return p.inner ? `${p.name}(${patToSource(p.inner)})` : p.name;
    case "PTuple":  return `(${p.elems.map(patToSource).join(", ")})`;
    case "PRecord": return `{${p.fields.map(f => f.name).join(", ")}}`;
    case "PLit": {
      const l = p.lit;
      switch (l.tag) {
        case "Str":      return JSON.stringify(l.value);
        case "Num":      return String(l.value);
        case "Bool":     return String(l.value);
        case "Unit":     return "()";
        case "Atom":     return `:${l.name}`;
        case "Duration": return `${l.ms}ms`;
      }
    }
  }
}

// One arm of a `race` block. In the synchronous model a `go` arm yields its
// expression's value; `after` yields `Timeout`; `until` (true) yields `Cancelled`.
export interface RaceArm { kind: "go" | "after" | "until"; expr: Expr | null }

export interface MachineStep {
  name: string;        // the state atom, without the leading ':'
  params: string[];    // parameters bound from the incoming transition's args
  body: SagaStmt[];
  span: Span;
}

export interface MachineState {
  name: string;
  transitions: { event: Pat; target: string; action: Expr | null }[];
  span: Span;
}

export interface SagaStep {
  name: string;
  body: Expr;
  rollback: Expr | null;
  span: Span;
}

// ── Module (a parsed file) ────────────────────────────────────────────────────

export interface Module {
  source: string;
  decls: Decl[];
  // The resolved language edition (SPEC §17). Set by the lowerer from the
  // `@edition` pragma, or DEFAULT_EDITION when absent. lower/infer/eval gate
  // edition-specific semantics on this.
  edition: Edition;
}
