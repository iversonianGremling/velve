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
  | { tag: "TRFn";     params: TypeRef[]; ret: TypeRef; effects: string[] }
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
  body: Expr;
  where_: { pat: Pat; value: Expr }[];  // where bindings
  lifetimeConstraints: LifetimeConstraint[];  // `where (~a >= ~b)` region bounds
  // `using S` / `using surface = <expr>` clause (theme-design §2b): the ambient
  // Surface this element-returning function renders onto. `value` is null for the
  // named form (`using panel`), set for the inline declare-and-apply sugar.
  surface: { name: string; value: Expr | null } | null;
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
       lowLevel?: boolean }                                                  & Node)

  | ({ tag: "DType";
       name: string;
       params: string[];
       body: TypeBody }                                                       & Node)

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

  | ({ tag: "DStream";
       name: string;
       inner: TypeRef }                                                      & Node)

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
       decls: Decl[] }                                                       & Node)

// ── Type bodies (for type declarations) ──────────────────────────────────────

export type TypeBody =
  | { tag: "TBAlias";   ref: TypeRef; pred: Expr | null }  // pred set ⇒ refinement type
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
