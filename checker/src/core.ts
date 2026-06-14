// core.ts — Velve Core IR (the D0 grammar, compiler-architecture-design §11.3) and
// the AST→Core lowering for the **pure compute spine** (D1(i)).
//
// This is the first real backend code. It honors the D0 contract: a fresh, small,
// normalized IR — NOT the annotated AST — in A-Normal Form (every non-trivial
// subexpression is named by a `Let`, every operand is an atom). The erasure law
// (§11.5) holds by construction here: nothing type-level is carried across this
// frontier. Units, refinement predicates, error/effect rows, taint, totality are
// already discharged upstream and simply do not appear below — the lone survivor,
// the width tag, rides `PrimOp` as inert metadata (unset on this JS-only slice).
//
// SCOPE (through D2(b) go/await): `def`s (single- AND multi-clause); `Lit` (Str/Num/Bool/Unit/Atom/Duration→ms);
// `Var`; arithmetic/comparison/equality `BinOp`; `UnOp`; saturated `Call` to a user
// `def` or a whitelisted pure builtin; tail-position `If` (incl. else-if ladders);
// `Do` blocks of `let`/expr statements; scalar `match` (D1(ii)); TUPLES — built and
// destructured via `PTuple` (D1(iii)); ADT CONSTRUCTORS — built (applied `Ok(x)` or
// nullary `None`) and destructured in `match` arms via `PCtor` (D1(iv)); RECORDS
// — built (`#{ x: a }`, incl. `...spread`), field-read (`p.x`), and destructured via
// `PRecord` (D1(v)); LISTS — built (`[a, b, …]`), element-read (`xs[i]`), and
// measured (`length`/`isEmpty`) (D1(vi)); CLOSURES-AS-VALUES — a `fn x -> …`
// lowered to a JS arrow that captures by lexical scope, bound by `let`, passed as an
// argument, returned from a `def`, called through a local name, and displayed
// `<fn:<lambda>>` (D1(vii)); and FIRST-CLASS FUNCTION REFERENCES — a named `def` OR a
// whitelisted builtin mentioned without calling it becomes a value (the JS
// `function`/prelude `const` is itself a value), bound/passed/returned/called like any
// closure and displayed `<fn:name>` (D1(viii) defs, D1(ix) builtins); and SHORT-CIRCUIT
// `&&`/`||` — lazy in the right operand, lowered to a value-producing `Cond` (D1(x)).
// (Pipe `|>` desugars to a saturated `Call` upstream, so it has compiled since D1(i).)
// The supported ctor names are the module's own `type … = | …` variants plus the core
// data ctors eval defines globally (Ok/Error/Some/None). Everything else is refused
// LOUDLY via CompileUnsupported — the frontier is explicit, never a silent miscompile.
// non-tail `if`/`match` AS A VALUE — the `let`-RHS / argument-position conditional via
// `Cond` (D1(xi)) and the value-position `match` decision-spine reified by a `Block`
// IIFE (D1(xii)); and MULTI-CLAUSE `def`s — clause dispatch over the parameter patterns,
// compiled to one JS `function` whose body is a `match`-on-the-arguments decision-spine
// (D1(xiii)); and REASSIGNMENT of a `mut` binding — a `let mut` lowers to a JS `let`, a
// bare `x = e` to an assignment yielding Unit (D1(xiv)); ATOM literals `:name` — a tagged,
// interned runtime value so JS `===` matches eval's by-name equality (D1(xv)); DURATION
// literals `5s` — folded to their millisecond Number, the Duration type erasing per §11.5
// (D1(xvi)); and `for` COMPREHENSIONS — `for (x in xs, …guards) -> body` lowered to nested
// `for…of` over each source's `.es` with an `if` per guard, accumulating a list (D1(xvii));
// and integer RANGES — `1..n` (exclusive) / `1..=n` (inclusive) lowered to a `$range` fill
// producing the same `$list` a literal `[…]` builds (D1(xviii)); and INDEX ASSIGNMENT —
// `xs[i] = v`, an in-place list-element write (`SAssign`), mutating the backing `.es` array
// exactly as eval mutates `elems` (D1(xix); the surface has no record-field-assign form, and
// a pointer `p.* = v` refuses); and the `loop` construct — an unbounded imperative loop
// lowered to an IIFE around a labeled `while (true)`, with `break`/`continue` as real labeled
// control flow and a CPS loop-body lowering that threads the "iterate again" terminator into
// each branch (D1(xx)); and TYPE TESTS — `e is Ctor(b)`: the binder form (in an `if` cond)
// desugars to a ctor-pattern match binding the payload, the binder-less form lowers to a
// `CtorTest` Bool (`v.$t==="C" && v.name===name`) (D1(xxi)); and the PROPAGATE operator `e?`
// — hoist the subject, early-return it from the fn when it is an `Error` (a `PropGuard` →
// `if (_t.name==="Error") return _t`), value is the payload; refused inside a value IIFE where
// `return` couldn't reach the fn (D1(xxii)); and PROP-WITH `e ?: alt` — a PURE unwrap-or-
// fallback, reusing `Cond` over a `CtorTest(_,"Ok")` with the payload as `then` and the lazy
// fallback as `else` (D1(xxiii)); and the `try` block — an IIFE yielding a Result, auto-peeling
// each line (`$isFail`/`$peelVal`), the first failure escaping, the final value `$tryWrap`ped;
// a `?` inside targets this IIFE, matching eval's catch (D1(xxiv)). EFFECT-ROW COLORING (D2a):
// a `def` with a non-empty `Effect [...]` row lowers to an `async function` and its calls
// `await` — the row survives AST→IR (a 2nd erasure-law exception, like the width tag); an
// effectful (awaited) call inside a value IIFE refuses (the `await` can't cross the value
// boundary, exactly as `?` can't). ASYNC `go`/`await` (D2b): `go expr` → `$sched.spawn(async
// () => …)` (a future); `await fut` → `await $sched.awaitFuture(fut)`; eval's scheduler ports
// verbatim into the prelude (gated on use), so ordering matches by construction. The async set
// is now a CALL-GRAPH FIXPOINT (go/await are typed `Async T`, not effect-row entries). `retry`,
// streams (`send`/`await`-branches), `race`, sagas/stores are next (D2c+).

import type { Module, Expr, Stmt, Lit, Pat, Branch, FnClause } from "./ast.js";
import type { Span } from "./span.js";

// ── The node grammar (§11.3) ────────────────────────────────────────────────────

export type IRLit =
  | { t: "Num"; v: number }
  | { t: "Str"; v: string }
  | { t: "Bool"; v: boolean }
  | { t: "Unit" }
  | { t: "Atom"; name: string };   // `:name` — a tagged, INTERNED value so `==` is identity

// Atoms are trivial — pure, no naming needed.
export type IRAtom =
  | { k: "Lit"; lit: IRLit }
  | { k: "Var"; name: string };

// The width tag the erasure law lets survive: a *representation* choice for native/
// WASM, dropped by JS. Unset throughout this slice (a Num is just a Num on JS).
export type Width = { bits: number; signed: boolean };

// Computations — everything with a value to name; each is the RHS of a `Let`.
export type IRComp =
  | { k: "Atom"; atom: IRAtom }
  | { k: "Call"; fn: string; args: IRAtom[]; await?: boolean } // saturated; fn is a name. `await` ⇒ the callee is effectful (async), so `await` it (D2a)
  | { k: "PrimOp"; op: string; args: IRAtom[]; width?: Width }
  | { k: "Tuple"; elems: IRAtom[] }                    // build a positional aggregate
  | { k: "Proj"; tuple: IRAtom; index: number }        // read element `index` of a tuple
  | { k: "Ctor"; name: string; payload: IRAtom | null } // build a tagged variant (nullary ⇒ payload null)
  | { k: "CtorName"; ctor: IRAtom }                    // read a variant's tag (a string) — for the match test
  | { k: "CtorPayload"; ctor: IRAtom }                 // read a variant's payload — to bind/recurse
  | { k: "CtorTest"; ctor: IRAtom; name: string }      // `e is Name` — a runtime tag check yielding a Bool
  | { k: "Record"; spread: IRAtom | null; fields: { name: string; value: IRAtom }[] } // build a record (spread base, then explicit fields — display order)
  | { k: "Field"; obj: IRAtom; field: string }         // read a named field
  | { k: "List"; elems: IRAtom[] }                     // build a sequence (display `[a, b, …]`)
  | { k: "Index"; obj: IRAtom; index: IRAtom }         // read element `index` of a list
  | { k: "Lambda"; params: string[]; body: IRExpr }    // an anonymous closure value — captures by lexical scope
  | { k: "Cond"; cond: IRAtom; then: IRExpr; else_: IRExpr } // a value-producing conditional — the lazy `if` short-circuit `&&`/`||` lower to
  | { k: "Block"; body: IRExpr }                        // reify an arbitrary value-`IRExpr` (e.g. a `match` decision-spine) as a value
  | { k: "For"; clauses: IRForClause[]; body: IRExpr }  // a list comprehension — nested generators × filters building a list
  | { k: "Range"; from: IRAtom; to: IRAtom; inclusive: boolean } // an integer fill `from..to` (`..` exclusive, `..=` inclusive) → a list
  | { k: "Loop"; body: IRExpr }                         // an unbounded imperative loop — `break` escapes with a value, `continue` re-iterates
  | { k: "Try"; body: IRExpr }                          // a `try` block — an IIFE yielding a Result; auto-peels each line, first failure escapes
  | { k: "Helper"; name: string; arg: IRAtom }          // a unary prelude-helper call (`$isFail`/`$peelVal`/`$tryWrap`) — the `try` peel primitives
  | { k: "Go"; body: IRExpr }                           // `go expr` — spawn the (deferred) body as a task on the scheduler, yields a future (D2b)
  | { k: "AwaitFut"; fut: IRAtom };                     // `await fut` — block on a future's value (D2b); always inside an `async` fn
// Perform — D2.

// A lowered `for`-comprehension clause. A generator binds a simple name to each
// element of its (value-`IRExpr`) iterable; a filter prunes when its cond is false.
// Both the iterable and the cond are full value-`IRExpr`s, NOT pre-hoisted atoms, so
// a later generator may depend on an earlier one's binding (`for (xs in xss, x in xs)`)
// — each is evaluated at its own nesting depth inside the emitted loop.
export type IRForClause =
  | { k: "Gen"; name: string; iter: IRExpr }
  | { k: "Filter"; cond: IRExpr };

// Expressions — the ANF spine. `Match` does NOT survive into the IR: D1(ii) lowers
// it to the `If`/`Let` decision-spine already here (classic match compilation), so
// the backend never grows a pattern-matching node. `Fail` is the one addition — the
// fall-through when no branch matches, mirroring eval's non-exhaustive RuntimeError.
// The checker's `exhaust` pass means valid programs never reach it; it is a witnessed
// safety net, not a path the differential harness ever exercises.
export type IRExpr =
  | { k: "Ret"; atom: IRAtom }                          // tail / trivial return
  | { k: "Let"; name: string; comp: IRComp; body: IRExpr; mut?: boolean } // `mut` ⇒ a reassignable JS `let`
  | { k: "Assign"; name: string; comp: IRComp; body: IRExpr } // reassign an existing `mut` binding (yields Unit)
  | { k: "IndexSet"; obj: IRAtom; index: IRAtom; value: IRAtom; body: IRExpr } // `xs[i] = v` — in-place list-element write (yields Unit)
  | { k: "If"; cond: IRAtom; then: IRExpr; else_: IRExpr }
  | { k: "Break"; value: IRAtom | null }                // escape the enclosing `loop` with a value (null ⇒ Unit)
  | { k: "Continue" }                                   // skip to the enclosing `loop`'s next iteration
  | { k: "PropGuard"; ctor: IRAtom; body: IRExpr }      // `e?`: if `ctor` is an `Error`, early-return it from the fn; else fall to `body`
  | { k: "Fail"; msg: string };                         // non-exhaustive fall-through

export interface IRFn { name: string; params: string[]; body: IRExpr; async?: boolean }
export interface IRModule { fns: IRFn[]; hasMain: boolean; usesScheduler?: boolean }

// The loud frontier: any AST form outside the supported core throws this, so the
// differential harness reports the file `unsupported` (a clean refusal) rather than
// emitting JS that miscomputes or crashes. The backend-slice analogue of a `_bad`
// guardrail: the guarantee is "refuse, never lie", asserted by the harness.
export class CompileUnsupported extends Error {
  constructor(public form: string) {
    super(`Velve Core (D1): unsupported form — ${form}`);
    this.name = "CompileUnsupported";
  }
}

// The pure builtin surface this slice emits (mapped to a JS prelude in emitjs.ts).
// A `Call` to anything outside this set ∪ the module's own `def`s is refused.
export const BUILTINS = new Set([
  "print", "println", "toString",
  "abs", "floor", "ceil", "round", "sqrt", "int", "max", "min",
  "length", "isEmpty",
]);

// ── Lowering ────────────────────────────────────────────────────────────────────

// `guard` marks a propagate (`e?`) temp: after binding it, early-return it from the enclosing
// function if it is an `Error` (eval's ReturnSignal). `wrap` renders a guard bind as a `Let`
// followed by a `PropGuard`; ordinary binds (the vast majority) leave it undefined.
interface Bind { name: string; comp: IRComp; guard?: boolean }

// One step of a compiled pattern: introduce a name, or assert an atom is truthy
// (else the branch falls through). A flat list of these folds into the decision-spine.
type MatchStep =
  | { s: "bind"; bind: Bind }
  | { s: "test"; binds: Bind[]; atom: IRAtom };

// What the lowerer knows about a constructor name: its arity. `nullary` ctors are
// referenced as a bare `Var` and build a payload-less variant; unary ctors are
// `Call`ed with their single payload. (Velve variants carry 0 or 1 payload — a
// multi-field variant spells its payload as one tuple type, so arity is binary.)
type CtorInfo = { nullary: boolean };

class Lowering {
  private n = 0;
  usedScheduler = false;   // set when a `Go`/`AwaitFut` is actually lowered — gates the scheduler prelude (D2b)
  constructor(private userFns: Set<string>, private ctors: Map<string, CtorInfo>, private asyncFns: Set<string> = new Set()) {}
  private fresh(): string { return `_t${this.n++}`; }

  fn(params: string[], body: Expr): IRExpr {
    return this.tail(body, new Set(params));
  }

  // A MULTI-CLAUSE `def` (D1(xiii)): the JS `function` takes the fresh param names
  // `_a0..` and dispatches across clauses. eval (applyFn/runClause) tries each clause in
  // order, accepting the first whose PARAM PATTERNS all match — so dispatch is exactly a
  // `match` whose subject is the parameter tuple. Built back-to-front like `matchE`: each
  // clause's pattern steps fold into an `If`/`Let` spine that falls through to the next
  // clause, the last falling through to `Fail` (eval's non-exhaustive RuntimeError, which
  // the checker's coverage analysis proves unreachable on valid programs).
  clauses(cls: FnClause[], paramNames: string[]): IRExpr {
    let chain: IRExpr = { k: "Fail", msg: "non-exhaustive patterns in clause dispatch" };
    for (let i = cls.length - 1; i >= 0; i--) chain = this.clause(cls[i]!, paramNames, chain);
    return chain;
  }

  // One clause: match every param pattern against its `_ai` (accumulating binds/tests
  // left-to-right, like `PTuple` across slots); on full success run the body, else fall
  // through to `next`. `where_`/`using` clause-bindings run only AFTER a clause is chosen
  // (eval.ts runClause) and a failure THROWS rather than falling through — they are body
  // bindings, not dispatch guards — so a clause carrying them is refused (the same place
  // the single-clause path leaves them: at the frontier) to keep dispatch pattern-only.
  private clause(cl: FnClause, paramNames: string[], next: IRExpr): IRExpr {
    if (cl.where_.length || cl.surface?.value) throw new CompileUnsupported("def clause with `where`/`using` bindings");
    const steps: MatchStep[] = [];
    let scope = new Set(paramNames);
    for (let i = 0; i < paramNames.length; i++) {
      const sub = this.pattern(cl.params[i]!.pat, { k: "Var", name: paramNames[i]! }, scope);
      steps.push(...sub.steps);
      scope = sub.scope;
    }
    let then = this.tail(cl.body, scope);
    for (let i = steps.length - 1; i >= 0; i--) {
      const st = steps[i]!;
      if (st.s === "bind") then = { k: "Let", name: st.bind.name, comp: st.bind.comp, body: then };
      else then = wrap(st.binds, { k: "If", cond: st.atom, then, else_: next });
    }
    return then;
  }

  // Tail position — yields an IRExpr (the `If`/`Ret` spine).
  private tail(e: Expr, scope: Set<string>): IRExpr {
    switch (e.tag) {
      case "Do": return this.block(e.stmts, scope);
      case "If": {
        // `if e is Ctor(b) then … else …` (D1(xxi)) — eval desugars a binder type-test
        // condition to a ctor-pattern match (eval.ts If handler), so we lower it through
        // the same decision-spine: the payload binds in the `then` scope, a tag mismatch
        // falls to `else`. A binder-less `is` is an ordinary Bool, handled by `norm` below.
        if (e.cond.tag === "TypeTest" && e.cond.binder && e.cond.against.tag === "TRNamed")
          return this.typeTestIf(e.cond.expr, e.cond.against.name, e.cond.binder, e.then, e.else_, scope, e.cond.span);
        const c = this.norm(e.cond, scope);
        const then = this.tail(e.then, new Set(scope));
        const els = e.else_ ? this.tail(e.else_, new Set(scope)) : RET_UNIT;
        return wrap(c.binds, { k: "If", cond: c.atom, then, else_: els });
      }
      case "Match": return this.matchE(e.subject, e.branches, scope);
      default: {
        const c = this.norm(e, scope);
        return wrap(c.binds, { k: "Ret", atom: c.atom });
      }
    }
  }

  // `match` lowering (D1(ii)). The subject is named once; branches compile to a
  // nested `If` decision-spine built back-to-front, terminating in `Fail`. Only
  // SCALAR patterns are in this slice — PWild/PVar/PTyped (irrefutable, maybe bind)
  // and PLit (an `==` test). Constructor/tuple/record/atom patterns destructure
  // heap values that the compute spine has no values for yet, so they trip the
  // frontier (D1(iii)). Match is supported in TAIL position only; as a mid-block
  // value it still routes through normComp's default → CompileUnsupported.
  private matchE(subjectExpr: Expr, branches: Branch[], scope: Set<string>): IRExpr {
    const s = this.norm(subjectExpr, scope);
    let chain: IRExpr = { k: "Fail", msg: "non-exhaustive match" };
    for (let i = branches.length - 1; i >= 0; i--) {
      chain = this.branch(branches[i]!, s.atom, scope, chain);
    }
    return wrap(s.binds, chain);
  }

  // One branch: if its pattern matches the subject atom (and any guard holds), run
  // the body in the extended scope; otherwise fall through to `next`. The pattern
  // compiles to a flat list of `MatchStep`s (binds and truthy-tests, in order);
  // folding them back-to-front threads each test's else-edge to `next`, so any
  // failure anywhere in a nested pattern falls through cleanly.
  private branch(br: Branch, subj: IRAtom, scope: Set<string>, next: IRExpr): IRExpr {
    const p = this.pattern(br.pat, subj, scope);
    let then = this.tail(br.body, p.scope);
    if (br.guard) {
      const g = this.norm(br.guard, p.scope);
      then = wrap(g.binds, { k: "If", cond: g.atom, then, else_: next });
    }
    for (let i = p.steps.length - 1; i >= 0; i--) {
      const st = p.steps[i]!;
      if (st.s === "bind") then = { k: "Let", name: st.bind.name, comp: st.bind.comp, body: then };
      else then = wrap(st.binds, { k: "If", cond: st.atom, then, else_: next });
    }
    return then;
  }

  // `if e is Ctor(b) then T else E` (D1(xxi)). eval desugars a binder type-test condition
  // to a one-armed ctor match — `match e | Ctor(b) -> T | _ -> E` — so this builds the same
  // decision-spine `branch` does for that arm: compile the `PCtor(b)` pattern against the
  // subject atom, run `T` in the bound scope on success, fall through to `E` (or Unit) on a
  // tag mismatch. Reuses `pattern`'s ctor lowering (the tag test + payload bind from D1(iv)).
  private typeTestIf(subjExpr: Expr, ctorName: string, binder: Pat | null, thenE: Expr, elseE: Expr | null, scope: Set<string>, span: Span): IRExpr {
    const s = this.norm(subjExpr, scope);
    const ctorPat: Pat = { tag: "PCtor", name: ctorName, inner: binder, span };
    const p = this.pattern(ctorPat, s.atom, scope);
    const elseIR = elseE ? this.tail(elseE, new Set(scope)) : RET_UNIT;
    let then = this.tail(thenE, p.scope);
    for (let i = p.steps.length - 1; i >= 0; i--) {
      const st = p.steps[i]!;
      if (st.s === "bind") then = { k: "Let", name: st.bind.name, comp: st.bind.comp, body: then };
      else then = wrap(st.binds, { k: "If", cond: st.atom, then, else_: elseIR });
    }
    return wrap(s.binds, then);
  }

  // Compile a pattern against the subject atom into an ordered `MatchStep[]`: a
  // `bind` introduces a name (a variable, or a tuple-element projection), a `test`
  // is an atom that must be truthy or the branch falls through. `scope` is the body
  // scope after the pattern's bindings. Mirrors eval.ts matchInto: PLit compares
  // with `==` (eval's strict `v === lit.value`); PTuple projects each slot and
  // recurses (the arity is type-guaranteed, so the tuple shape itself is no test).
  private pattern(p: Pat, subj: IRAtom, scope: Set<string>):
    { steps: MatchStep[]; scope: Set<string> } {
    switch (p.tag) {
      case "PWild":
        return { steps: [], scope };
      case "PVar": case "PTyped": {
        // `match n | n -> …` binds the subject to its own name: emitting `const n = n`
        // is a TDZ crash in JS. The rebind is identity — the name is already in scope
        // holding that value — so skip it. (eval gets this free via env child.)
        if (subj.k === "Var" && subj.name === p.name) return { steps: [], scope };
        const ns = new Set(scope); ns.add(p.name);
        return { steps: [{ s: "bind", bind: { name: p.name, comp: { k: "Atom", atom: subj } } }], scope: ns };
      }
      case "PLit": {
        const litAtom: IRAtom = { k: "Lit", lit: lowerLit(p.lit) };
        const t = this.fresh();
        return {
          steps: [{ s: "test", binds: [{ name: t, comp: { k: "PrimOp", op: "==", args: [subj, litAtom] } }], atom: { k: "Var", name: t } }],
          scope,
        };
      }
      case "PTuple": {
        // Project each slot to a fresh name, then recurse the sub-pattern against it.
        // Projection binds precede the sub-pattern's steps, so nested tests see the
        // already-extracted element. Scope accumulates left-to-right across slots.
        const steps: MatchStep[] = [];
        let sc = scope;
        for (let i = 0; i < p.elems.length; i++) {
          const slot = this.fresh();
          steps.push({ s: "bind", bind: { name: slot, comp: { k: "Proj", tuple: subj, index: i } } });
          const sub = this.pattern(p.elems[i]!, { k: "Var", name: slot }, sc);
          steps.push(...sub.steps);
          sc = sub.scope;
        }
        return { steps, scope: sc };
      }
      case "PCtor": {
        // Discriminate on the variant tag, then (if the pattern names a payload)
        // project it and recurse. Mirrors eval.ts matchInto's PCtor: a name mismatch
        // falls through; arity is type-guaranteed, so the tag test is the whole
        // refutation (the payload-presence checks eval also does are redundant on
        // check-passing programs). The tag-read + `==` ride the test's own binds, so
        // they evaluate only when control reaches this branch.
        const tag = this.fresh();
        const eq = this.fresh();
        const steps: MatchStep[] = [{
          s: "test",
          binds: [
            { name: tag, comp: { k: "CtorName", ctor: subj } },
            { name: eq, comp: { k: "PrimOp", op: "==", args: [{ k: "Var", name: tag }, { k: "Lit", lit: { t: "Str", v: p.name } }] } },
          ],
          atom: { k: "Var", name: eq },
        }];
        let sc = scope;
        if (p.inner) {
          const slot = this.fresh();
          steps.push({ s: "bind", bind: { name: slot, comp: { k: "CtorPayload", ctor: subj } } });
          const sub = this.pattern(p.inner, { k: "Var", name: slot }, sc);
          steps.push(...sub.steps);
          sc = sub.scope;
        }
        return { steps, scope: sc };
      }
      case "PRecord": {
        // Read each named field and recurse the sub-pattern against it. Like PTuple
        // this is pure projection — no shape test: the checker guarantees the subject
        // is a record carrying these fields (eval's tag/presence checks are redundant
        // on check-passing programs). Field order in the pattern is irrelevant; binds
        // accumulate left-to-right. The grammar's `record_pattern` is shorthand-only
        // (`{ x, y }`), so each `f.pat` is a PVar — but we recurse generically anyway.
        const steps: MatchStep[] = [];
        let sc = scope;
        for (const f of p.fields) {
          const slot = this.fresh();
          steps.push({ s: "bind", bind: { name: slot, comp: { k: "Field", obj: subj, field: f.name } } });
          const sub = this.pattern(f.pat, { k: "Var", name: slot }, sc);
          steps.push(...sub.steps);
          sc = sub.scope;
        }
        return { steps, scope: sc };
      }
      default:
        throw new CompileUnsupported(`match pattern ${p.tag} (heap-value destructuring — D1(vi)+)`);
    }
  }

  // A `Do`/`Try`-free block of statements; the last statement is the block's value.
  private block(stmts: Stmt[], scope: Set<string>): IRExpr {
    if (stmts.length === 0) return RET_UNIT;
    const head = stmts[0]!;
    const rest = stmts.slice(1);
    const last = rest.length === 0;
    switch (head.tag) {
      case "SBind": {
        const c = this.normComp(head.value, scope);
        if (!head.declares) {
          // Reassignment `x = e` (D1(xiv)): eval mutates the existing binding (env.set)
          // and yields Unit. Only a simple variable already in scope reaches here — a
          // field/index target is a separate `SAssign` (still frontier). The target must
          // have been declared `mut` (a reassignable JS `let`); the checker guarantees it.
          const target = patName(head.pat);
          if (!scope.has(target)) throw new CompileUnsupported(`reassignment of unbound '${target}'`);
          const cont = last ? RET_UNIT : this.block(rest, scope);   // a reassignment adds no binding
          return wrap(c.binds, { k: "Assign", name: target, comp: c.comp, body: cont });
        }
        const name = patName(head.pat);
        const next = new Set(scope); next.add(name);
        // A trailing `let` makes the block's value Unit (it binds, yields nothing). A
        // `mut` declaration lowers to a JS `let` so a later reassignment is legal.
        const cont = last ? RET_UNIT : this.block(rest, next);
        return wrap(c.binds, { k: "Let", name, comp: c.comp, mut: head.mutable, body: cont });
      }
      case "SAssign": {
        // A write through an lvalue (D1(xix)): `xs[i] = v`, an in-place list-element write.
        // eval mutates the list IN PLACE (`elems[i] = v`) and yields Unit — and the JS value
        // model already backs a list with a real `.es` array, so `xs.es[i] = v` is the same
        // in-place mutation, byte-identical. eval evaluates the RHS `value` FIRST, then the
        // target's obj/index, so the binds hoist in that order (the atoms they leave are pure,
        // so the emitted statement referencing them carries no further evaluation). Index is
        // the ONLY grammar-reachable lvalue write besides `p.* = v` (a pointer `deref_assign`,
        // refused — pointers aren't lowered); the surface has no record-field-assign form. No
        // bounds check is emitted: an OOB index makes eval throw (an `eval-error` in both columns
        // the harness never compares), exactly as the D1(vi) element-READ path leaves it.
        const t = head.target;
        if (t.tag !== "Index") throw new CompileUnsupported(`assignment target ${t.tag}`);
        const v = this.norm(head.value, scope);
        const o = this.norm(t.obj, scope);
        const i = this.norm(t.index, scope);
        const cont = last ? RET_UNIT : this.block(rest, scope);   // a write adds no binding
        return wrap([...v.binds, ...o.binds, ...i.binds], { k: "IndexSet", obj: o.atom, index: i.atom, value: v.atom, body: cont });
      }
      case "SExpr": {
        if (last) return this.tail(head.expr, scope);
        const c = this.normComp(head.expr, scope);
        return wrap(c.binds, { k: "Let", name: this.fresh(), comp: c.comp, body: this.block(rest, scope) });
      }
      case "SReturn":
        return head.value ? this.tail(head.value, scope) : RET_UNIT;
      default:
        throw new CompileUnsupported(`statement ${head.tag}`);
    }
  }

  // A LOOP-BODY block (D1(xx)). Unlike `block`, which lowers a non-last `if` to a value
  // `Cond` (a ternary), a loop body must thread its continuation INTO each branch so that a
  // `break`/`continue` buried in a branch compiles to real labeled control flow rather than
  // a value. `cont` is what runs when control falls off these statements — `RET_UNIT` at the
  // top (which emitjs renders as "fall to the next `while (true)` iteration"), or, inside a
  // branch, the statements that follow the `if`. A `break`/`continue` terminates the spine
  // (the rest is dead). `return` inside a loop refuses — it escapes the def, not the loop,
  // and the IIFE the loop emits to would catch it wrongly; a later slice. A `match` in a loop
  // body rides the generic effect path (its value `Block` is discarded) — correct UNLESS an
  // arm itself breaks/continues, which would mislower; the harness would catch that, and no
  // such program is in range.
  private loopBlock(stmts: Stmt[], scope: Set<string>, cont: IRExpr): IRExpr {
    if (stmts.length === 0) return cont;
    const head = stmts[0]!;
    const rest = stmts.slice(1);
    switch (head.tag) {
      case "SBreak": {
        if (head.value) { const v = this.norm(head.value, scope); return wrap(v.binds, { k: "Break", value: v.atom }); }
        return { k: "Break", value: null };
      }
      case "SReturn":
        throw new CompileUnsupported("`return` inside a loop");
      case "SBind": {
        const c = this.normComp(head.value, scope);
        if (!head.declares) {
          const target = patName(head.pat);
          if (!scope.has(target)) throw new CompileUnsupported(`reassignment of unbound '${target}'`);
          return wrap(c.binds, { k: "Assign", name: target, comp: c.comp, body: this.loopBlock(rest, scope, cont) });
        }
        const name = patName(head.pat);
        const next = new Set(scope); next.add(name);
        return wrap(c.binds, { k: "Let", name, comp: c.comp, mut: head.mutable, body: this.loopBlock(rest, next, cont) });
      }
      case "SAssign": {
        const t = head.target;
        if (t.tag !== "Index") throw new CompileUnsupported(`assignment target ${t.tag}`);
        const v = this.norm(head.value, scope);
        const o = this.norm(t.obj, scope);
        const i = this.norm(t.index, scope);
        return wrap([...v.binds, ...o.binds, ...i.binds], { k: "IndexSet", obj: o.atom, index: i.atom, value: v.atom, body: this.loopBlock(rest, scope, cont) });
      }
      case "SExpr":
        return this.loopBranch(head.expr, scope, this.loopBlock(rest, scope, cont));
    }
  }

  // Lower one loop-body branch/statement-expression with continuation `cont`. Handles the
  // control-flow forms structurally (`break`/`continue`/`if`/`Do`) and threads `cont` into
  // the fall-through paths; any other expression is evaluated for effect (its value bound to
  // a discard temp) before `cont`. An `if` shares one `cont` across both branches — a branch
  // that falls through reaches it, one that breaks/continues never does.
  private loopBranch(e: Expr, scope: Set<string>, cont: IRExpr): IRExpr {
    switch (e.tag) {
      case "Break": {
        if (e.value) { const v = this.norm(e.value, scope); return wrap(v.binds, { k: "Break", value: v.atom }); }
        return { k: "Break", value: null };
      }
      case "Continue":
        return { k: "Continue" };
      case "Do":
        return this.loopBlock(e.stmts, new Set(scope), cont);
      case "If": {
        const c = this.norm(e.cond, scope);
        const then = this.loopBranch(e.then, new Set(scope), cont);
        const els = e.else_ ? this.loopBranch(e.else_, new Set(scope), cont) : cont;
        return wrap(c.binds, { k: "If", cond: c.atom, then, else_: els });
      }
      default: {
        const c = this.normComp(e, scope);
        return wrap(c.binds, { k: "Let", name: this.fresh(), comp: c.comp, body: cont });
      }
    }
  }

  // A `try` body (D1(xxiv)). Builds the spine INSIDE the try IIFE: a `mut last` accumulator
  // seeded to Unit, the statements threaded after it, ending `return $tryWrap(last)`. eval
  // auto-peels each line and collapses on the first failure; this mirrors it statement by
  // statement (`tryStmts`). A `?` inside lowers to its usual `PropGuard` `return`, which now
  // lands in this IIFE — exactly eval's ReturnSignal catch — so it is allowed (not refused).
  private tryBlock(stmts: Stmt[], scope: Set<string>): IRExpr {
    const last = this.fresh();
    const inner = new Set(scope); inner.add(last);
    const r = this.fresh();
    const fin: IRExpr = { k: "Let", name: r, comp: { k: "Helper", name: "$tryWrap", arg: { k: "Var", name: last } }, body: { k: "Ret", atom: { k: "Var", name: r } } };
    const spine = this.tryStmts(stmts, inner, last, fin);
    return { k: "Let", name: last, mut: true, comp: { k: "Atom", atom: UNIT_ATOM }, body: spine };
  }

  // One `try` statement, auto-peeled (eval's `evalTryBody`): bind the value to `_u`; if it is a
  // failure (`$isFail` — an `Error`/`None`) `return` it raw from the try IIFE; otherwise update
  // `last` with the peeled value (`$peelVal` — an `Ok`'s payload, else the value) and continue.
  // A binding `let x = e` binds `x` to the peeled value, then sets `last = Unit` (as eval does).
  // `return`/`break` inside a `try`, and reassignment/destructuring binds, refuse for now.
  private tryStmts(stmts: Stmt[], scope: Set<string>, last: string, cont: IRExpr): IRExpr {
    if (stmts.length === 0) return cont;
    const head = stmts[0]!;
    const rest = stmts.slice(1);
    switch (head.tag) {
      case "SReturn": throw new CompileUnsupported("`return` inside a `try`");
      case "SBreak": throw new CompileUnsupported("`break` inside a `try`");
      case "SAssign": {
        const t = head.target;
        if (t.tag !== "Index") throw new CompileUnsupported(`assignment target ${t.tag}`);
        const v = this.norm(head.value, scope);
        const o = this.norm(t.obj, scope);
        const i = this.norm(t.index, scope);
        return wrap([...v.binds, ...o.binds, ...i.binds], { k: "IndexSet", obj: o.atom, index: i.atom, value: v.atom,
          body: { k: "Assign", name: last, comp: { k: "Atom", atom: UNIT_ATOM }, body: this.tryStmts(rest, scope, last, cont) } });
      }
      case "SBind": {
        if (!head.declares) throw new CompileUnsupported("reassignment inside a `try`");
        const name = patName(head.pat);
        const c = this.normComp(head.value, scope);
        const u = this.fresh();
        const cf = this.fresh();
        const next = new Set(scope); next.add(name);
        return wrap(c.binds, { k: "Let", name: u, comp: c.comp, body:
          { k: "Let", name: cf, comp: { k: "Helper", name: "$isFail", arg: { k: "Var", name: u } }, body:
            { k: "If", cond: { k: "Var", name: cf }, then: { k: "Ret", atom: { k: "Var", name: u } }, else_:
              { k: "Let", name, comp: { k: "Helper", name: "$peelVal", arg: { k: "Var", name: u } }, body:
                { k: "Assign", name: last, comp: { k: "Atom", atom: UNIT_ATOM }, body: this.tryStmts(rest, next, last, cont) } } } } });
      }
      case "SExpr": {
        const c = this.normComp(head.expr, scope);
        const u = this.fresh();
        const cf = this.fresh();
        return wrap(c.binds, { k: "Let", name: u, comp: c.comp, body:
          { k: "Let", name: cf, comp: { k: "Helper", name: "$isFail", arg: { k: "Var", name: u } }, body:
            { k: "If", cond: { k: "Var", name: cf }, then: { k: "Ret", atom: { k: "Var", name: u } }, else_:
              { k: "Assign", name: last, comp: { k: "Helper", name: "$peelVal", arg: { k: "Var", name: u } }, body: this.tryStmts(rest, scope, last, cont) } } } });
      }
    }
  }

  // Normalize an expression to an ATOM, accumulating the `Let`-able binds it needs.
  private norm(e: Expr, scope: Set<string>): { binds: Bind[]; atom: IRAtom } {
    if (e.tag === "Lit") return { binds: [], atom: { k: "Lit", lit: lowerLit(e.lit) } };
    if (e.tag === "Var" && scope.has(e.name)) return { binds: [], atom: { k: "Var", name: e.name } };
    // A first-class function reference — a user `def` (the JS `function` it names) or a
    // builtin (its prelude `const`) — is already an atom, so pass it through directly
    // rather than naming it by a redundant `Let` temp.
    if (e.tag === "Var" && (this.userFns.has(e.name) || BUILTINS.has(e.name)) && !this.ctors.has(e.name))
      return { binds: [], atom: { k: "Var", name: e.name } };
    // An out-of-scope `Var` is not necessarily an error — it may be a nullary ctor
    // (`None`). Defer to normComp, which builds the variant or refuses by name.
    const c = this.normComp(e, scope);
    const t = this.fresh();
    return { binds: [...c.binds, { name: t, comp: c.comp }], atom: { k: "Var", name: t } };
  }

  // Normalize an expression to a COMPUTATION (the RHS of a `Let`).
  private normComp(e: Expr, scope: Set<string>): { binds: Bind[]; comp: IRComp } {
    switch (e.tag) {
      case "Lit": return { binds: [], comp: { k: "Atom", atom: { k: "Lit", lit: lowerLit(e.lit) } } };
      case "Var": {
        if (scope.has(e.name)) return { binds: [], comp: { k: "Atom", atom: { k: "Var", name: e.name } } };
        // A bare name out of scope: a nullary ctor builds a payload-less variant; a
        // unary ctor used unapplied would be a first-class function (refused); a `def`
        // name mentioned without calling it is a FIRST-CLASS REFERENCE (D1(viii)) —
        // anything else is a genuine free variable.
        const ci = this.ctors.get(e.name);
        if (ci?.nullary) return { binds: [], comp: { k: "Ctor", name: e.name, payload: null } };
        if (ci) throw new CompileUnsupported(`first-class constructor '${e.name}' (apply it)`);
        // First-class `def` reference: eval has the def as a VFn in the environment;
        // the compiled `def` is a hoisted JS `function`, which is itself a value, so the
        // reference lowers to a bare `Var` atom naming it — no wrapper, no capture. It
        // is then bound/passed/returned/called like any closure, and `$show` reads the
        // JS `function`'s own `.name` to display `<fn:name>` (eval's VFn display).
        if (this.userFns.has(e.name)) return { binds: [], comp: { k: "Atom", atom: { k: "Var", name: e.name } } };
        // First-class BUILTIN reference (D1(ix)): eval has the builtin as a VBuiltin in
        // the environment; the compiled builtin is an inlined prelude `const`, itself a
        // value, so the reference lowers to a bare `Var` atom naming it. `$show` reads
        // its `.name` (the prelude impls are emitted so each const's name IS its Velve
        // name — `<fn:abs>`, `<fn:int>`) to match eval's VBuiltin display.
        if (BUILTINS.has(e.name)) return { binds: [], comp: { k: "Atom", atom: { k: "Var", name: e.name } } };
        throw new CompileUnsupported(`free variable '${e.name}'`);
      }
      case "BinOp": {
        // Short-circuit `&&`/`||` (D1(x)) are LAZY in the right operand — eval returns
        // `false`/`true` without touching the right when the left decides it (eval.ts
        // evalBinOp). So they are NOT strict PrimOps: `a && b` ≡ `if a then b else false`,
        // `a || b` ≡ `if a then true else b`. The left normalizes to an atom (always
        // evaluated); the right lowers to a value-`IRExpr` placed in ONE branch of a
        // `Cond`, so emitjs emits it inside a ternary branch and it runs only when
        // reached. A `Cond` is an ordinary comp, so a `&&` nested in an argument/operand
        // composes for free. (Pipe `|>` needs first-class application — still frontier.)
        if (e.op === "&&" || e.op === "||") {
          const l = this.norm(e.left, scope);
          const right = this.tail(e.right, new Set(scope));   // the lazy operand, as a value-expr
          noPropInValue(right, "a `&&`/`||` operand");
          noAwaitInValue(right, "a `&&`/`||` operand");
          const T: IRExpr = { k: "Ret", atom: { k: "Lit", lit: { t: "Bool", v: true } } };
          const F: IRExpr = { k: "Ret", atom: { k: "Lit", lit: { t: "Bool", v: false } } };
          const comp: IRComp = e.op === "&&"
            ? { k: "Cond", cond: l.atom, then: right, else_: F }
            : { k: "Cond", cond: l.atom, then: T, else_: right };
          return { binds: l.binds, comp };
        }
        // Arithmetic/comparison/equality/`++` are pure strict PrimOps.
        if (!ARITH.has(e.op)) throw new CompileUnsupported(`operator '${e.op}' (D1 later)`);
        const l = this.norm(e.left, scope), r = this.norm(e.right, scope);
        return { binds: [...l.binds, ...r.binds], comp: { k: "PrimOp", op: e.op, args: [l.atom, r.atom] } };
      }
      case "UnOp": {
        const x = this.norm(e.expr, scope);
        return { binds: x.binds, comp: { k: "PrimOp", op: "u" + e.op, args: [x.atom] } };
      }
      case "Tuple": {
        // The first heap value (D1(iii)). Positional, fixed-arity; each element
        // normalizes to an atom. Display is `(a, b, …)` — the runtime `$tuple`
        // wrapper carries a tag so `$show` reproduces value.ts's VTuple exactly.
        const parts = e.elems.map(x => this.norm(x, scope));
        return { binds: parts.flatMap(p => p.binds), comp: { k: "Tuple", elems: parts.map(p => p.atom) } };
      }
      case "Record": {
        // A keyed heap value (D1(v)). eval builds a Map: the spread's fields first
        // (in their own order), then explicit fields appended — an explicit key that
        // shadows a spread key updates in place, keeping its original slot. JS object
        // `{ ...base.fs, k: v }` has exactly these insertion-order semantics, so the
        // runtime $record wrapper reproduces value.ts's VRecord `display` field order.
        const spread = e.spread ? this.norm(e.spread, scope) : null;
        const parts = e.fields.map(f => ({ name: f.name, c: this.norm(f.value, scope) }));
        const binds = [...(spread ? spread.binds : []), ...parts.flatMap(p => p.c.binds)];
        return { binds, comp: { k: "Record", spread: spread ? spread.atom : null, fields: parts.map(p => ({ name: p.name, value: p.c.atom })) } };
      }
      case "Field": {
        // A record field read (`p.x`). The checker has proven `obj` is a record with
        // this field, so the read is total. (eval's `Field` also serves saga handles
        // and modules — out of the pure core; those obj exprs trip the frontier first.)
        const o = this.norm(e.obj, scope);
        return { binds: o.binds, comp: { k: "Field", obj: o.atom, field: e.field } };
      }
      case "List": {
        // The sequence heap value (D1(vi)). eval builds a VList of evaluated elements,
        // displayed `[a, b, …]`; the runtime `$list` wrapper carries a tag so `$show`
        // reproduces value.ts's VList. Homogeneous by the checker; arity is dynamic.
        const parts = e.elems.map(x => this.norm(x, scope));
        return { binds: parts.flatMap(p => p.binds), comp: { k: "List", elems: parts.map(p => p.atom) } };
      }
      case "Index": {
        // A list element read (`xs[i]`). eval bounds-checks at runtime (a RuntimeError
        // on OOB — an eval-error in BOTH columns, never a silent miscompile); on the
        // in-bounds reads valid programs make, plain `.es[i]` is byte-identical. (eval's
        // Index also slices `xs[lo:hi]` and indexes pointers — a Range index or a
        // pointer subject trips the frontier first, so only scalar element reads reach
        // here.)
        const o = this.norm(e.obj, scope);
        const i = this.norm(e.index, scope);
        return { binds: [...o.binds, ...i.binds], comp: { k: "Index", obj: o.atom, index: i.atom } };
      }
      case "Match": {
        // A non-tail `match` used as a VALUE (`let s = match … | …`, or nested in an
        // argument). `matchE` already lowers a `match` to the `If`/`Let`/`Fail` decision-
        // spine (an `IRExpr`); in value position that whole spine is reified by a `Block`,
        // which emitjs wraps in an arrow-IIFE returning the taken branch's value — the
        // n-way generalization of what `Cond` does for a single binary branch. `Block` is
        // an ordinary comp, so a value-`match` nested in an argument/operand composes.
        const mBody = this.matchE(e.subject, e.branches, scope);
        noPropInValue(mBody, "a value-position `match`");
        noAwaitInValue(mBody, "a value-position `match`");
        return { binds: [], comp: { k: "Block", body: mBody } };
      }
      case "If": {
        // A non-tail `if` used as a VALUE (`let x = if c then a else b`, or nested in an
        // argument). `tail()` already lowers a tail-position `if` to the `If` spine; in
        // value position it becomes the same value-producing `Cond` that short-circuit
        // `&&`/`||` use (D1(x)) — the cond is an atom, each branch a value-`IRExpr`
        // emitted as a ternary arm (IIFE-wrapped when it has its own spine). A branchless
        // `if` (no `else`) yields Unit, mirroring `tail`'s `RET_UNIT`.
        // A binder type-test condition (`if e is Ok(v) …`) desugars to a ctor match (D1(xxi));
        // in value position its decision-spine is reified by a `Block`, exactly like a value
        // `match`.
        if (e.cond.tag === "TypeTest" && e.cond.binder && e.cond.against.tag === "TRNamed") {
          const ttBody = this.typeTestIf(e.cond.expr, e.cond.against.name, e.cond.binder, e.then, e.else_, scope, e.cond.span);
          noPropInValue(ttBody, "a value-position `if … is …`");
          noAwaitInValue(ttBody, "a value-position `if … is …`");
          return { binds: [], comp: { k: "Block", body: ttBody } };
        }
        const c = this.norm(e.cond, scope);
        const then = this.tail(e.then, new Set(scope));
        const els = e.else_ ? this.tail(e.else_, new Set(scope)) : RET_UNIT;
        noPropInValue(then, "a value-position `if` branch");
        noPropInValue(els, "a value-position `if` branch");
        noAwaitInValue(then, "a value-position `if` branch");
        noAwaitInValue(els, "a value-position `if` branch");
        return { binds: c.binds, comp: { k: "Cond", cond: c.atom, then, else_: els } };
      }
      case "Lambda": {
        // A closure value (D1(vii)). eval makes a single-clause VFn capturing the
        // current `env`; the JS analogue is an arrow function, which closes over the
        // enclosing `const`s by the same lexical-scope rule — so no explicit capture
        // list is needed, the names just resolve outward. Params are simple binders
        // (a destructuring param spells a `PTuple`/`PRecord` and trips `patName`'s
        // frontier — that lands a later slice). The body lowers in TAIL position with
        // the params added to scope: the lambda's value IS its body's value. A free
        // name in the body (e.g. a not-yet-bound `let f = fn … -> f(…)` self-ref) is
        // out of scope here exactly as it is absent from eval's capture env, so it
        // refuses identically rather than miscompiling. Displays `<fn:<lambda>>`.
        const params = e.params.map(p => patName(p.pat));
        const inner = new Set(scope);
        for (const pn of params) inner.add(pn);
        const lamBody = this.tail(e.body, inner);
        noAwaitInValue(lamBody, "a lambda body");   // an effectful closure needs an `async` arrow — a later slice
        return { binds: [], comp: { k: "Lambda", params, body: lamBody } };
      }
      case "Go": {
        // `go expr` (D2b) — spawn the expression as a concurrent task, yielding a future.
        // eval DEFERS the body (`spawn(() => evalExpr(expr))`), so we lower `expr` in tail
        // position and wrap it in `$sched.spawn(async () => …)`. `spawn` returns synchronously,
        // so `go` is legal in any position (no `await`); the spawned arrow is its own `async`
        // function boundary, so awaits inside it are fine. A `go saga(args)` refuses for free:
        // the saga callee is not a `def`, so the inner `Call` trips the frontier.
        this.usedScheduler = true;
        return { binds: [], comp: { k: "Go", body: this.tail(e.expr, new Set(scope)) } };
      }
      case "Await": {
        // `await fut` (D2b) — block on a future's value. Branches (the `| Push v ->` arms) are
        // stream/saga territory — refuse them; a bare `await` extracts the future's value. The
        // subject is named to an atom, then `await $sched.awaitFuture(atom)`. The enclosing def
        // contains an `Await` ⇒ it is in `asyncFns` ⇒ emitted `async`, so the `await` is legal.
        if (e.branches.length > 0) throw new CompileUnsupported("`await` with branches (streams/sagas — a later slice)");
        this.usedScheduler = true;
        const s = this.norm(e.expr, scope);
        return { binds: s.binds, comp: { k: "AwaitFut", fut: s.atom } };
      }
      case "Propagate": {
        // The propagate operator `e?` (D1(xxii)). eval: an `Ok(x)` yields `x`, an `Error`
        // throws a ReturnSignal that early-returns the whole Error from the enclosing function.
        // We hoist the subject to a temp, mark it a `guard` bind (so `wrap` emits the
        // early-return `PropGuard` right after it), and the propagate's value is the payload.
        // The early-return is a real JS `return`, so `?` is valid only where its guard lands
        // in the function body (statement / tail / lambda) — inside a value IIFE it refuses
        // (see `noPropInValue` at the `Cond`/`Block`/`Loop` sites). A non-Ok/Error subject is
        // type-impossible (the checker types `e` as a Result), so the Ok/Error split is total.
        const s = this.norm(e.expr, scope);
        const g = this.fresh();
        return {
          binds: [...s.binds, { name: g, comp: { k: "Atom", atom: s.atom }, guard: true }],
          comp: { k: "CtorPayload", ctor: { k: "Var", name: g } },
        };
      }
      case "PropWith": {
        // The prop-with operator `e ?: alt` (D1(xxiii)) — eval: an `Ok(x)` yields `x`, anything
        // else evaluates the fallback `alt`. Unlike `?`, it is PURE (no early-return) — a plain
        // value conditional — so it reuses the `Cond` machinery: a `CtorTest(_, "Ok")` picks the
        // branch, the `Ok` payload is the `then` atom, `alt` the lazy `else` (run only when not
        // Ok). The payload is read eagerly into a temp (harmless — a field read; its value is
        // simply discarded on the Error branch), so the `then` arm is a bare atom, no IIFE.
        const s = this.norm(e.expr, scope);
        const ok = this.fresh();
        const pay = this.fresh();
        const elseE = this.tail(e.alt, new Set(scope));
        noPropInValue(elseE, "a `?:` fallback");
        noAwaitInValue(elseE, "a `?:` fallback");
        return {
          binds: [
            ...s.binds,
            { name: ok, comp: { k: "CtorTest", ctor: s.atom, name: "Ok" } },
            { name: pay, comp: { k: "CtorPayload", ctor: s.atom } },
          ],
          comp: { k: "Cond", cond: { k: "Var", name: ok }, then: { k: "Ret", atom: { k: "Var", name: pay } }, else_: elseE },
        };
      }
      case "TypeTest": {
        // A binder-less type test `e is Name` (D1(xxi)) — a Bool. eval returns
        // `v.tag === "VCtor" && v.name === name`, so the compiler emits the equivalent
        // runtime tag check on the `$t:"C"`-tagged ctor value (a `CtorTest` comp). Against a
        // non-named type eval returns `true` unconditionally (`name === null`); that path is
        // refused rather than folded, since no well-typed program reaches it. (A binder test
        // only ever appears in an `if` condition, desugared above; here `binder` is null.)
        if (e.against.tag !== "TRNamed") throw new CompileUnsupported("type test against a non-named type");
        const s = this.norm(e.expr, scope);
        return { binds: s.binds, comp: { k: "CtorTest", ctor: s.atom, name: e.against.name } };
      }
      case "Try": {
        // A `try` block (D1(xxiv)) — Design A. eval's `evalTryBody` AUTO-PEELS every statement:
        // each line's value is unwrapped (an `Ok(x)` → `x`), and the FIRST `Error`/`None`
        // collapses the whole block to that failure; a `?` inside likewise collapses HERE (eval
        // catches its ReturnSignal) rather than early-returning the function; the block's value
        // is the last line's peeled value, wrapped `Ok(...)` unless already a Result. We lower it
        // to an IIFE (the `Try` comp) whose body is a `mut last` accumulator spine: each statement
        // binds its value, `return`s it raw if it is a failure (`$isFail`), else updates `last`
        // with the peeled value (`$peelVal`); the IIFE ends `return $tryWrap(last)`. A `?` inside
        // emits its usual `return` — which now lands in THIS IIFE, exactly eval's catch, so it is
        // allowed here (no `noPropInValue`).
        const tBody = this.tryBlock(e.stmts, scope);
        noAwaitInValue(tBody, "a `try` block");   // a `?` is fine here (targets the try IIFE); an `await` is not yet
        return { binds: [], comp: { k: "Try", body: tBody } };
      }
      case "Loop": {
        // An unbounded imperative loop (D1(xx)). eval runs the body block forever, sharing
        // one env so a `mut` declared OUTSIDE persists and mutates across iterations; a
        // `break v` escapes (the loop's value is `v`, or Unit if bare), a `continue` jumps to
        // the next iteration, and falling off the body's end re-iterates. The body lowers via
        // `loopBlock`, a CPS block lowering that threads the "iterate again" terminator
        // (`RET_UNIT`) into each branch — so a `break`/`continue` deep inside an `if` becomes
        // real labeled control flow (a value-position `Cond` could not express it). emitjs
        // wraps the result in an IIFE around a labeled `while (true)` returning the break value.
        const body = this.loopBlock(e.stmts, new Set(scope), RET_UNIT);
        noPropInValue(body, "a `loop` body");
        noAwaitInValue(body, "a `loop` body");
        return { binds: [], comp: { k: "Loop", body } };
      }
      case "Range": {
        // An integer range (D1(xviii)). eval requires both bounds to be numbers and fills
        // `[from, end]` stepping +1, where `end = inclusive ? to : to - 1` — so `1..5` is
        // `[1,2,3,4]`, `1..=5` is `[1,2,3,4,5]`, and a descending pair yields the empty list.
        // The bounds are pure number atoms; the fill is a `$range` runtime call producing the
        // same `$list` value a literal `[…]` builds, so a range nested in a `for` generator
        // (`for (x in 1..n)`) or bound directly composes with no special case.
        const f = this.norm(e.from, scope);
        const t = this.norm(e.to, scope);
        return { binds: [...f.binds, ...t.binds], comp: { k: "Range", from: f.atom, to: t.atom, inclusive: e.inclusive } };
      }
      case "For": {
        // A list comprehension (D1(xvii)). eval evaluates the clauses left-to-right:
        // generators NEST (each element of an earlier source scopes the later clauses —
        // a cartesian product) and filters PRUNE; the body runs at the innermost depth,
        // each result pushed onto a list. The JS analogue is nested `for…of` over each
        // source's `.es`, an `if` per filter, and a `$acc.push(body)` at the bottom (see
        // emitjs `For`). Each generator binds a SIMPLE name — a destructuring binding
        // (`for ((a, b) in …)`) spells a `PTuple`/`PRecord` and trips `patName`'s frontier,
        // a later slice. The iterable and filter cond stay full value-`IRExpr`s (not hoisted
        // atoms) so a later generator can read an earlier binding. A `break`/`continue` in
        // the body is its own AST node and trips the frontier in `tail`, so a comprehension
        // carrying one refuses rather than miscompiling eval's Break/Continue signals.
        const clauses: IRForClause[] = [];
        const inner = new Set(scope);
        for (const cl of e.clauses) {
          if (cl.tag === "Filter") {
            clauses.push({ k: "Filter", cond: this.tail(cl.cond, new Set(inner)) });
          } else {
            const name = patName(cl.binding);
            clauses.push({ k: "Gen", name, iter: this.tail(cl.iter, new Set(inner)) });
            inner.add(name);
          }
        }
        return { binds: [], comp: { k: "For", clauses, body: this.tail(e.body, inner) } };
      }
      case "Call": {
        if (e.fn.tag !== "Var") throw new CompileUnsupported("call of a computed function");
        if (e.named.length) throw new CompileUnsupported("named arguments (D1 later)");
        const fn = e.fn.name;
        const ci = this.ctors.get(fn);
        if (ci) {
          // Applying a constructor builds a variant. A unary ctor takes exactly its
          // one payload; a nullary ctor is never applied in well-typed code.
          if (ci.nullary || e.args.length !== 1) throw new CompileUnsupported(`constructor '${fn}' applied to ${e.args.length} args`);
          const a = this.norm(e.args[0]!, scope);
          return { binds: a.binds, comp: { k: "Ctor", name: fn, payload: a.atom } };
        }
        // A name in local scope holds a closure value (a `let`-bound lambda or a
        // closure-typed param): call it indirectly. The emitted syntax is identical
        // to a `def` call — `fn(args)` — because the JS `const` holds the arrow
        // function, and lexical scope means a local name correctly shadows a same-named
        // def or builtin (eval resolves the local binding first too).
        if (!scope.has(fn) && !this.userFns.has(fn) && !BUILTINS.has(fn))
          throw new CompileUnsupported(`call to '${fn}' (not a def or supported builtin)`);
        const parts = e.args.map(a => this.norm(a, scope));
        // An EFFECTFUL callee (a `def` whose Effect row is non-empty) compiles to an `async`
        // function, so its call site `await`s it (D2a). The effect system propagates effects to
        // callers, so a function containing an awaited call is itself effectful ⇒ itself `async`
        // — `await` therefore only ever lands inside an `async` function. A local closure call
        // (`scope.has(fn)`) or a builtin is never marked: a closure's effects aren't tracked here
        // yet (an effectful local closure trips the value-IIFE/Lambda guard), and builtins like
        // `println` are synchronous prelude consts.
        const isAsync = this.asyncFns.has(fn) && !scope.has(fn);
        return { binds: parts.flatMap(p => p.binds), comp: { k: "Call", fn, args: parts.map(p => p.atom), await: isAsync } };
      }
      default:
        throw new CompileUnsupported(e.tag);
    }
  }
}

const RET_UNIT: IRExpr = { k: "Ret", atom: { k: "Lit", lit: { t: "Unit" } } };
const UNIT_ATOM: IRAtom = { k: "Lit", lit: { t: "Unit" } };

// Strict, pure operators that map 1:1 onto a JS operator (emitjs.ts owns the table).
const ARITH = new Set(["+", "-", "*", "/", "%", "**", "^", "<", ">", "<=", ">=", "==", "!=", "++"]);

function wrap(binds: Bind[], body: IRExpr): IRExpr {
  let e = body;
  for (let i = binds.length - 1; i >= 0; i--) {
    const b = binds[i]!;
    // A guard bind (`e?`) binds its temp, then early-returns it when it is an `Error`.
    e = b.guard
      ? { k: "Let", name: b.name, comp: b.comp, body: { k: "PropGuard", ctor: { k: "Var", name: b.name }, body: e } }
      : { k: "Let", name: b.name, comp: b.comp, body: e };
  }
  return e;
}

// Does this statement spine carry a `PropGuard` (an `e?` early-return)? Walks the spine only —
// NOT into nested comps, which are their own IIFEs and refuse `?` at their own construction. A
// `PropGuard` emits a `return` from the enclosing JS function, so it is INVALID inside a value
// IIFE (a `Cond`/`Block`/`Loop` body) where `return` would escape only the IIFE; those sites
// call this to refuse `?` cleanly rather than miscompile (statement/tail/lambda position is fine).
function containsPropGuard(e: IRExpr): boolean {
  switch (e.k) {
    case "PropGuard": return true;
    case "Let": case "Assign": case "IndexSet": return containsPropGuard(e.body);
    case "If": return containsPropGuard(e.then) || containsPropGuard(e.else_);
    default: return false;
  }
}

function noPropInValue(e: IRExpr, ctx: string): void {
  if (containsPropGuard(e)) throw new CompileUnsupported(`\`?\` propagate inside ${ctx} — its early-return can't cross the value boundary (lift it to a \`let\` statement)`);
}

// Does this statement spine make an EFFECTFUL (awaited) call? Like `containsPropGuard`, it walks
// the spine only — a `Let`/`Assign` whose comp is an awaited `Call`, threaded through bodies and
// `If` branches. An `await` makes its arrow `async` ⇒ the arrow returns a Promise, so an effectful
// call inside a value IIFE (a `Cond`/`Block`/`Loop`/`try` body) would yield a Promise where a value
// is wanted. Those sites refuse it (D2a) — exactly the `?` boundary — until effect-aware value
// positions land. (Statement/tail position threads the `await` into the real `async` function body.)
function containsAwait(e: IRExpr): boolean {
  const awaited = (c: IRComp) => (c.k === "Call" && !!c.await) || c.k === "AwaitFut";
  switch (e.k) {
    case "Let": case "Assign": return awaited(e.comp) || containsAwait(e.body);
    case "IndexSet": case "PropGuard": return containsAwait(e.body);
    case "If": return containsAwait(e.then) || containsAwait(e.else_);
    default: return false;
  }
}

function noAwaitInValue(e: IRExpr, ctx: string): void {
  if (containsAwait(e)) throw new CompileUnsupported(`an effectful (async) call inside ${ctx} — its \`await\` can't cross the value boundary (lift it to a \`let\` statement)`);
}

function lowerLit(l: Lit): IRLit {
  switch (l.tag) {
    case "Num":  return { t: "Num", v: l.value };
    case "Str":  return { t: "Str", v: l.value };
    case "Bool": return { t: "Bool", v: l.value };
    case "Unit": return { t: "Unit" };
    // An atom `:name` folds to a tagged, INTERNED runtime value (D1(xv)): eval compares
    // VAtoms by name, so the emitter interns `$atom(n)` to a per-name singleton, making
    // JS `===` (what `==`/match `PLit` lower to) agree with eval's by-name equality.
    case "Atom":     return { t: "Atom", name: l.name };
    // A duration `5s` IS its millisecond count as a plain Number (D1(xvi)): the AST already
    // carries `ms`, and eval folds `Duration → VNum(ms)` — the Duration *type* erases at
    // this frontier (§11.5), leaving the number. So `5s` compiles to `5000`, display-identical.
    case "Duration": return { t: "Num", v: l.ms };
  }
}

function patName(p: Pat): string {
  if (p.tag === "PVar") return p.name;
  if (p.tag === "PTyped") return p.name;
  if (p.tag === "PWild") return "_";
  throw new CompileUnsupported(`binding pattern ${p.tag}`);
}

// The core data constructors eval.ts defines in every program's prelude
// (Result + Option). Available globally — a file uses `Ok`/`Error`/`Some`/`None`
// without a local `type` decl — so the lowerer seeds them unconditionally. Their
// display (`Ok(x)`, `None`) is exactly the user-ADT display $show reproduces.
const PRELUDE_CTORS: Array<[string, boolean]> = [
  ["Ok", false], ["Error", false], ["Some", false], ["None", true],
];

// Scan a def's clause bodies for (a) syntactic `go`/`await` (the async SEED — `go`/`await` are
// typed `Async T`, NOT effect-row entries, so an effectful-row check alone misses them) and (b) the
// user-`def` names it calls (the call-graph EDGES, for the async fixpoint). A full recursive walk —
// missing a `go`/`await` would emit `await` in a sync function — so it covers every Expr/Stmt shape.
function asyncScan(clauses: FnClause[]): { usesConc: boolean; calls: Set<string> } {
  let usesConc = false;
  const calls = new Set<string>();
  const st = (s: Stmt): void => {
    switch (s.tag) {
      case "SBind": ex(s.value); return;
      case "SExpr": ex(s.expr); return;
      case "SAssign": ex(s.target); ex(s.value); return;
      case "SBreak": case "SReturn": if (s.value) ex(s.value); return;
    }
  };
  const ex = (e: Expr | null | undefined): void => {
    if (!e) return;
    if (e.tag === "Go" || e.tag === "Await") usesConc = true;
    switch (e.tag) {
      case "Call": if (e.fn.tag === "Var") calls.add(e.fn.name); ex(e.fn); e.args.forEach(ex); e.named.forEach(n => ex(n.value)); return;
      case "BinOp": ex(e.left); ex(e.right); return;
      case "UnOp": case "Propagate": case "Go": case "Resume": case "Drop": case "AddrOf": case "Deref": ex(e.expr); return;
      case "Field": ex(e.obj); return;
      case "Index": ex(e.obj); ex(e.index); return;
      case "Lambda": ex(e.body); return;
      case "Match": ex(e.subject); e.branches.forEach(b => { if (b.guard) ex(b.guard); ex(b.body); }); return;
      case "If": ex(e.cond); ex(e.then); ex(e.else_); return;
      case "Do": case "Loop": case "Try": e.stmts.forEach(st); return;
      case "Transaction": ex(e.config); e.body.forEach(st); return;
      case "Retry": ex(e.count); ex(e.delay); e.stmts.forEach(st); return;
      case "For": e.clauses.forEach(c => c.tag === "Gen" ? ex(c.iter) : ex(c.cond)); ex(e.body); return;
      case "Range": ex(e.from); ex(e.to); return;
      case "Tuple": case "List": e.elems.forEach(ex); return;
      case "Record": if (e.spread) ex(e.spread); e.fields.forEach(f => ex(f.value)); return;
      case "PropWith": ex(e.expr); ex(e.alt); return;
      case "Await": ex(e.expr); e.branches.forEach(b => { if (b.guard) ex(b.guard); ex(b.body); }); return;
      case "TypeTest": ex(e.expr); return;
      case "Element": ex(e.content); e.props.forEach(p => ex(p.value)); e.children.forEach(ex); return;
      case "Handler": ex(e.body); return;
      case "Break": if (e.value) ex(e.value); return;
      case "Send": ex(e.msg); return;
      default: return;   // Lit, Var, Continue, JSExpr, Machine — no expr children for async detection
    }
  };
  for (const cl of clauses) { ex(cl.body); for (const w of cl.where_) ex(w.value); }
  return { usesConc, calls };
}

export function lowerModule(mod: Module): IRModule {
  const userFns = new Set<string>();
  for (const d of mod.decls) if (d.tag === "DFn") userFns.add(d.name);

  // Async coloring (D2a + D2b): a `def` lowers to an `async function` — and calls to it `await` —
  // when it is async. The async set is a CALL-GRAPH FIXPOINT: SEED on a non-empty Effect row (D2a;
  // the row survives AST→IR, a deliberate exception to the §11.5 erasure law, as the width tag does)
  // OR a body that syntactically uses `go`/`await` (D2b; those are typed `Async T`, not effect-row
  // entries, so the row alone misses them); then PROPAGATE — a caller of an async def is itself async
  // (so its `await` of that call sits inside an `async` fn). The checker propagates *effects* to
  // callers, but not concurrency-by-type, so the fixpoint is computed here rather than read off rows.
  const scans = new Map<string, { usesConc: boolean; calls: Set<string> }>();
  for (const d of mod.decls) if (d.tag === "DFn") scans.set(d.name, asyncScan(d.clauses));
  const asyncFns = new Set<string>();
  for (const d of mod.decls)
    if (d.tag === "DFn" && (d.clauses.some(cl => cl.effects.length > 0 || cl.effectTails.length > 0) || scans.get(d.name)!.usesConc))
      asyncFns.add(d.name);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, s] of scans) {
      if (asyncFns.has(name)) continue;
      for (const callee of s.calls) if (asyncFns.has(callee)) { asyncFns.add(name); changed = true; break; }
    }
  }

  // Constructor registry: the prelude data ctors plus every variant of every
  // `type … = | A | B(p)` in the module. A variant with no payload is nullary.
  const ctors = new Map<string, CtorInfo>();
  for (const [name, nullary] of PRELUDE_CTORS) ctors.set(name, { nullary });
  for (const d of mod.decls)
    if (d.tag === "DType" && d.body.tag === "TBAdt")
      for (const v of d.body.variants) ctors.set(v.name, { nullary: v.payload === null });

  const fns: IRFn[] = [];
  let hasMain = false;
  let usesScheduler = false;
  for (const d of mod.decls) {
    // Non-`def` decls carry no top-level runtime computation in the pure core
    // (a `type`'s constructors, an `import`'s names): skip them. Any *use* of what
    // they introduce trips the frontier inside the def that uses it.
    if (d.tag !== "DFn") continue;
    const low = new Lowering(userFns, ctors, asyncFns);
    const isAsync = asyncFns.has(d.name);
    if (d.clauses.length === 1) {
      // Single clause: params are simple binders, lowered directly (the fast path).
      const cl = d.clauses[0]!;
      const params = cl.params.map(p => patName(p.pat));
      fns.push({ name: d.name, params, body: low.fn(params, cl.body), async: isAsync });
    } else {
      // Multi-clause: emit ONE JS `function` over fresh param names that dispatches
      // across the clauses by their parameter patterns (D1(xiii)). All clauses of a `def`
      // share its arity, so the fresh-name count is the first clause's param count.
      const arity = d.clauses[0]!.params.length;
      const paramNames = Array.from({ length: arity }, (_, i) => `_a${i}`);
      fns.push({ name: d.name, params: paramNames, body: low.clauses(d.clauses, paramNames), async: isAsync });
    }
    if (low.usedScheduler) usesScheduler = true;
    if (d.name === "main") hasMain = true;
  }
  return { fns, hasMain, usesScheduler };
}
