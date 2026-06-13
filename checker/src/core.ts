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
// SCOPE (through D1(xvii) comprehensions): `def`s (single- AND multi-clause); `Lit` (Str/Num/Bool/Unit/Atom/Duration→ms);
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
// `for…of` over each source's `.es` with an `if` per guard, accumulating a list (D1(xvii)).
// Field/index assignment (`SAssign`), RANGES (`1..n`), `while`/`loop`, and `Perform`
// (effects) are next (D1(xviii)+, D2).

import type { Module, Expr, Stmt, Lit, Pat, Branch, FnClause } from "./ast.js";

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
  | { k: "Call"; fn: string; args: IRAtom[] }          // saturated; fn is a name
  | { k: "PrimOp"; op: string; args: IRAtom[]; width?: Width }
  | { k: "Tuple"; elems: IRAtom[] }                    // build a positional aggregate
  | { k: "Proj"; tuple: IRAtom; index: number }        // read element `index` of a tuple
  | { k: "Ctor"; name: string; payload: IRAtom | null } // build a tagged variant (nullary ⇒ payload null)
  | { k: "CtorName"; ctor: IRAtom }                    // read a variant's tag (a string) — for the match test
  | { k: "CtorPayload"; ctor: IRAtom }                 // read a variant's payload — to bind/recurse
  | { k: "Record"; spread: IRAtom | null; fields: { name: string; value: IRAtom }[] } // build a record (spread base, then explicit fields — display order)
  | { k: "Field"; obj: IRAtom; field: string }         // read a named field
  | { k: "List"; elems: IRAtom[] }                     // build a sequence (display `[a, b, …]`)
  | { k: "Index"; obj: IRAtom; index: IRAtom }         // read element `index` of a list
  | { k: "Lambda"; params: string[]; body: IRExpr }    // an anonymous closure value — captures by lexical scope
  | { k: "Cond"; cond: IRAtom; then: IRExpr; else_: IRExpr } // a value-producing conditional — the lazy `if` short-circuit `&&`/`||` lower to
  | { k: "Block"; body: IRExpr }                        // reify an arbitrary value-`IRExpr` (e.g. a `match` decision-spine) as a value
  | { k: "For"; clauses: IRForClause[]; body: IRExpr }; // a list comprehension — nested generators × filters building a list
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
  | { k: "If"; cond: IRAtom; then: IRExpr; else_: IRExpr }
  | { k: "Fail"; msg: string };                         // non-exhaustive fall-through

export interface IRFn { name: string; params: string[]; body: IRExpr }
export interface IRModule { fns: IRFn[]; hasMain: boolean }

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

interface Bind { name: string; comp: IRComp }

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
  constructor(private userFns: Set<string>, private ctors: Map<string, CtorInfo>) {}
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
        return { binds: [], comp: { k: "Block", body: this.matchE(e.subject, e.branches, scope) } };
      }
      case "If": {
        // A non-tail `if` used as a VALUE (`let x = if c then a else b`, or nested in an
        // argument). `tail()` already lowers a tail-position `if` to the `If` spine; in
        // value position it becomes the same value-producing `Cond` that short-circuit
        // `&&`/`||` use (D1(x)) — the cond is an atom, each branch a value-`IRExpr`
        // emitted as a ternary arm (IIFE-wrapped when it has its own spine). A branchless
        // `if` (no `else`) yields Unit, mirroring `tail`'s `RET_UNIT`.
        const c = this.norm(e.cond, scope);
        const then = this.tail(e.then, new Set(scope));
        const els = e.else_ ? this.tail(e.else_, new Set(scope)) : RET_UNIT;
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
        return { binds: [], comp: { k: "Lambda", params, body: this.tail(e.body, inner) } };
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
        return { binds: parts.flatMap(p => p.binds), comp: { k: "Call", fn, args: parts.map(p => p.atom) } };
      }
      default:
        throw new CompileUnsupported(e.tag);
    }
  }
}

const RET_UNIT: IRExpr = { k: "Ret", atom: { k: "Lit", lit: { t: "Unit" } } };

// Strict, pure operators that map 1:1 onto a JS operator (emitjs.ts owns the table).
const ARITH = new Set(["+", "-", "*", "/", "%", "**", "^", "<", ">", "<=", ">=", "==", "!=", "++"]);

function wrap(binds: Bind[], body: IRExpr): IRExpr {
  let e = body;
  for (let i = binds.length - 1; i >= 0; i--) { const b = binds[i]!; e = { k: "Let", name: b.name, comp: b.comp, body: e }; }
  return e;
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

export function lowerModule(mod: Module): IRModule {
  const userFns = new Set<string>();
  for (const d of mod.decls) if (d.tag === "DFn") userFns.add(d.name);

  // Constructor registry: the prelude data ctors plus every variant of every
  // `type … = | A | B(p)` in the module. A variant with no payload is nullary.
  const ctors = new Map<string, CtorInfo>();
  for (const [name, nullary] of PRELUDE_CTORS) ctors.set(name, { nullary });
  for (const d of mod.decls)
    if (d.tag === "DType" && d.body.tag === "TBAdt")
      for (const v of d.body.variants) ctors.set(v.name, { nullary: v.payload === null });

  const fns: IRFn[] = [];
  let hasMain = false;
  for (const d of mod.decls) {
    // Non-`def` decls carry no top-level runtime computation in the pure core
    // (a `type`'s constructors, an `import`'s names): skip them. Any *use* of what
    // they introduce trips the frontier inside the def that uses it.
    if (d.tag !== "DFn") continue;
    const low = new Lowering(userFns, ctors);
    if (d.clauses.length === 1) {
      // Single clause: params are simple binders, lowered directly (the fast path).
      const cl = d.clauses[0]!;
      const params = cl.params.map(p => patName(p.pat));
      fns.push({ name: d.name, params, body: low.fn(params, cl.body) });
    } else {
      // Multi-clause: emit ONE JS `function` over fresh param names that dispatches
      // across the clauses by their parameter patterns (D1(xiii)). All clauses of a `def`
      // share its arity, so the fresh-name count is the first clause's param count.
      const arity = d.clauses[0]!.params.length;
      const paramNames = Array.from({ length: arity }, (_, i) => `_a${i}`);
      fns.push({ name: d.name, params: paramNames, body: low.clauses(d.clauses, paramNames) });
    }
    if (d.name === "main") hasMain = true;
  }
  return { fns, hasMain };
}
