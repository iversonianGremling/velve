# TODO — Language design review (v0.5 draft)

A full scan of the language against its own stated goal: *maximize readability,
ease of use, and easy mental models for programmers* — from UI to event handling
to low-level code to intensive interactive environments (games) to animations.
Sources: `SPEC.md`, `README.md`, all of `docs/`, the `examples/` programs, and the
passing `checker/*.velve` fixtures. Each section ends in actionable items.

Legend: 🔴 load-bearing (fix before the surface freezes) · 🟡 important · 🟢 nice-to-have

---

## 1. Verdict by domain (vs. the alternatives)

| Domain | Grade | Compared against | One-line verdict |
|---|---|---|---|
| Type system core (HM + refinements + dependent) | **A+** *(2026-06)* | TS, Elm, F#, Liquid Haskell | Refinements-as-transparent-base with free constant-folding is genuinely better ergonomics than all four; conservative skip keeps it honest. **A−→A re-graded 2026-06** (north-star §1 + §3.6): the row's named lever shipped — **§5.1 constEval widening** (`constfold_total_test`/`_bad`): the folder now *executes* `@total` refinement predicates at check time (fuel-bounded, decidable-pattern clause dispatch, bails on anything undecidable), so the skip is opt-out-able per predicate — mark it `@total` and `half(3)` against `EvenNum = Number where isEven(value)` is a compile error that was previously accepted *and ran unchecked* (runtime enforcement is `T.parse` only). **The refined-type library SHIPPED 2026-06** (SPEC §7.1, `refined_types_test`/`_bad`): `Natural`/`NonZero`/`Positive`/`InBounds` as `@private` ADTs (the gate `@private type` shipped one slice earlier, `private_ctor_test`/`_bad`) — smart-constructor gates from raw `Number`, closed ops with no re-check, faulting ops back through the gate; `divBy(n, NonZero)` and `getAt(xs, InBounds)` delete the zero/out-of-bounds cases as *type errors*, no solver; a pure library add (zero checker changes), itself proof-carrying (`proofs: [total, exhaustive, handled]`). **`nonzero` + the flow-sensitive fact env SHIPPED 2026-06** (`facts.ts`, SPEC §12.7, `proof_nonzero_test`/`_bad`): north-star §3.1 catch 1 — the named pre-solver lift — now exists (path facts from if/match/guards/filters/literal clause heads; mutation kills; interval entailment), discharging the fourth obligation with no solver. **The Tier-2 Z3 back-end SHIPPED 2026-06** (`smt.ts`, `proof_nonzero_z3_test`/`_bad`): the floor's residue discharges by refutation over ℝ — the pinned compound-divisor case graduated from `_bad` to green, counterexamples in the errors, lazy load, floor fallback when uninstalled (LSP shows the floor; CLI is authoritative). **`proof.terminates` SHIPPED 2026-06** (`terminates.ts`, SPEC §12.6, `proof_terminates_test`/`_bad`): `@total`'s `n/2` residue proves automatically — unit-decreasing floored measure from path facts; non-constant decreases (`shrink(n - k, k)` under `k >= 1`) prove; loose guards fail with the model that breaks them. **Floored measures SHIPPED 2026-06** (`proof_binsearch_test`/`_bad`): `floor(e)` joins the solver fragment as an Int-sorted term bracketed `e − 1 < ⌊e⌋ ≤ e`, so a binary search recursing on `floor(span / 2)` proves unit-decrease for `span ∈ [1, 2)` by integrality — the gradient's showcase, green under `proofs: [bounds, total]` on one function; the `_bad`'s `if span <= 0` leaves the `(0, 1)` gap and Z3 names a fractional `span`. **`bounds` SHIPPED 2026-06** (SPEC §12.7, `proof_bounds_test`/`_bad`): every list index read proved `0 ≤ i < length(xs)` — the fact env's first function symbol (Int-sorted `length(xs)`, `≥ 0` asserted; Int-sortedness turns `> 0` into `≥ 1`, so `xs[length(xs) - 1]` proves), two Z3 queries per read with the leaking side named in the error; 5 of 7 obligations checkable, not-yet down to `arith`/`overflow`. **`SortedList` SHIPPED 2026-06** (SPEC §7.1, `sorted_list_test`/`_bad`): the §3.2 semantic archetype by the construct-it route — order checked once at the gate (`sortedList` rejects, `fromAny` folds the closed insert), closed ops preserve the invariant by construction, `slMin`'s O(1)-`head` *correctness* precondition unforgeable; pure library add (zero checker changes, twice in a row), proof-carrying module, and the `_bad` twin's `proofs: [sorted]` pin enforces the operations/values split. **The Tier-1.5 relational witness SHIPPED 2026-06** (SPEC §2.7, `index_witness_test`/`_bad`): `Index(length(xs))` — a dependent refinement of the in-range shape — ties an index to *that* list via two fact-env bridges: callers under `proofs: [bounds]` PROVE every witness argument from path facts (floor → Z3), callees ASSUME their signatures (assume/guarantee) so the read needs no guard; a cross-list spend is refuted with the model that splits the lists. **The return-gate witness spelling SHIPPED 2026-06** (SPEC §2.7, `index_gate_test`/`_bad`): the witness rides `Result Index(length(xs)) e` in return position too — the callee proves each `Ok(payload)` in range (the gate can't lie), the caller seeds the `Ok`-binder of a `match`, so `xs[j]` reads with no guard; both bridges relational-pinned in the `_bad`. **`arith` SHIPPED 2026-06** (SPEC §12.7, `proof_arith_test`/`_bad`): the sixth checkable obligation — every domain-restricted math builtin (`sqrt` needs `x ≥ 0`, `log`/`log2`/`log10` `x > 0`, `asin`/`acos` `-1 ≤ x ≤ 1`) proved in-domain via the same floor → Z3 pipeline as `nonzero` (a per-builtin domain table; `sqrt(a * a)` and `if a > b then log(a - b)` discharge with no guard; out-of-domain model in the error; both `Math.sqrt(x)` and bare `sqrt(x)` reach it); 6 of 7 obligations checkable, not-yet `overflow` alone. **A → A+ re-graded 2026-06** — the last named ingredient landed; the gradient is complete in kind (Tiers 0/1/1.5/2, one closed vocabulary, both honest semantic routes). Not claimed: cheaper hard proofs than F★, Idris-native dependent ergonomics (the witness is the length-indexed relational fragment, params-only v1), or `overflow` (waits on the sized-types substrate). **`sortBy` infer/eval reconciliation SHIPPED 2026-06** (endgame A5, `sortby_test`/`_bad`): the one known infer/eval divergence closed — infer typed `sortBy(xs, keyFn)` (list-first, one-arg key) while eval read a two-arg comparator comparator-first, so every type-checking call crashed at runtime; reconciled onto the data-first key-fn form by fixing eval (a `keyGt` num-or-string ordering + stable decorate–sort–undecorate), the `_bad` pinning the old comparator convention as a type error both ways (3 errors). With A3/A2/A1's `Ok`-half this meets all four Phase-A-done criteria. **The bare-return witness SHIPPED 2026-06** (endgame A1 `let`-direct half, `index_let_test`/`_bad`): a def returning an unwrapped `Index(length(xs))` is itself a gate — `infer.tailExprs` walks every tail-position leaf into `WITNESS_DEMANDS` (the total body proves an in-range index on each path), `bareWitnessRet` records the call in `WITNESS_RETURNS`, and `facts.walkStmt` seeds the `let` binder (the `let` dual of the `match … Ok(j)` seed); A1 now fully shipped. **A4 finer proof scopes — per-function SHIPPED 2026-06** (`proof_fnscope_test`/`_bad`): a `proofs: [...]` clause at the head of a function body scopes the obligation to that def (same `proofs_decl` production reused verbatim, same closed vocabulary, same assume/guarantee across `facts`/`handled`/totality), so a sibling without the clause is unconstrained; chosen as a trailing body-head clause over the sketched `Proof [...] T` brackets (which would overload the return-type surface). Per-block `@proof[…]{}` cut for now (OQ#3). **Vocabulary + marker cleanup SHIPPED 2026-06** (`vocab_cleanup_test`/`_bad`): `exhaustive` is now always-on (clause-head gaps are hard errors in every edition with no declaration — the type system forces it; the word stays accepted but redundant), and the decorator set is closed to `@low`/`@kernel`/`@private`/`@total` (the inert `@deprecated`/`@idempotent`/`@audioKernel` are now unknown-decorator errors). Named follow-on: `overflow` — **SHIPPED 2026-06 in B3(ii)** (`proof_overflow_test`/`_bad`), closing the proof vocabulary at 7/7. |
| UI / styling | **A** *(2026.6)* | React+CSS, Elm, SwiftUI | Typed props, context-validity (`gap` on non-flex = error), real units, and **accessibility-as-proof** — an unreadable `color` on its resolved background now *fails to compile* (APCA Lc, opt-in `OnSurface`), not just a linter note — beat CSS's silent no-ops. The **element/call syntax duality is now closed** (§2.1, PLAN §5b): elements use the unified paren-form `Text("hi", size=12)` (space-form deprecated→error in 2026.6), proven by green `element_paren_test`. (Responsive shipped end-to-end 2026-06; the only design-only UI-adjacent item left is `inputmap`, an event/input concern — see the event/state row §3.2. Residual §2.1 tail: inline-handler/spread props in paren-form; value juxtaposition is now fully removed.) The **theme system is now COMPLETE (4/4)**: typed `Surface` tokens, the `using` clause, a `Theme` record whose roles are *derived* via `std/color` and folded into the contrast proof at check time (`std/color`'s first consumer), and — as of Slice 4 — `theme` as a built-in **read-only reactive root** that is APCA-proven against at check time *and* swappable at runtime (`setTheme`), acyclic by construction (a `theme.*` read adds no convergence edge; container-query feedback is rejected by the existing §6.2 cycle-checker). Accessibility-as-proof now fires on token, `using`-surface, computed, **and live-root** colours, not just inline hex. And as of 2026-06 **responsive is built end-to-end** (§9.2–9.4): closed `Breakpoint` variant, `Clamp` band, the read-only `viewport` root, the `responsive | …` keyword, and now **prop-site auto-collapse** — a `Responsive(Length)` (`Breakpoint -> Length`) handed directly to a `Length` prop and collapsed against the live `viewport.breakpoint`, with `setViewport` re-collapsing on swap (the viewport sibling of `setTheme`). **Now A** (the row's prior A− hold was "responsive/inputmap design-only"; responsive is now shipped, and `inputmap` is an input/event-handling item tracked in the event/state row §3.2, not UI styling). Residual UI-styling polish, not pillars: compile-time (vs runtime) convergence-cycle detection (§3.1) and the §2.1 inline-handler/spread-prop tail. |
| Event handling / state | **A** *(2026-06)* | Elm, Redux, Rx, XState, Erlang/OTP | The four-primitive taxonomy (store/machine/stream/transaction + `persisted`) with a "what do I reach for" table is the best-explained state story in any draft language I know. `machine … persisted` + journal + `resume` is XState+Temporal in one construct. **Both named gaps closed by green fixtures (2026-06):** per-stream backpressure (`drop`/`buffer N`/`block` at decl site, `stream_policy_test`) and `await`→step-goto in machine steps (`machine_await_test` — machines drain streams idiomatically now). Re-graded A− → **A**. The `inputmap` **core is now built** (2026-06, SPEC §10.5, `inputmap_test`/`_bad`): the typed pattern-match input table over a stream, with conflict analysis ("bound twice"/"shadowed") and the drain-loop runtime — plus the **`Inputmap` type and `help(map)` derived data** (`inputmap_help_test`/`_bad`): the auto-help table is queryable, check-time-typed data — plus **`++` layering** (`inputmap_layer_test`/`_bad`): maps are values, `default ++ userOverrides` works, cross-stream layering is a check error — plus **chord-refinement literals** (`inputmap_chord_test`/`_bad`): a typo'd chord pattern is a check-time error at every match site, via the literal-pattern refinement fold — plus **`keymap` sugar** (`keymap_test`/`_bad`). Residual for A→A+: the remaining inputmap *breadth* — std `Key` device library + physical-key prefix, focus-zone scoping, the *rendered* overlay element (store messages dispatch synchronously today, so streams are the only queue and they now have policies). |
| Error handling | **A+** *(2026-06)* | Rust `?`, Zig, Go | `?`/`?:`/`try`/`retry` cover the space well; the whitespace-keyed `?` (spaced = ternary vs glued = propagate, §2.2) — the draft's worst readability decision — is **gone from edition 2026.6**: the ternary was deleted in favour of `if c then a else b`, so `?` now carries one glued meaning. **Named error ADTs shipped 2026-06** (§3.5, SPEC §2.6, `error_adt_test`/`_bad`): prelude `ParseError { expected, got, detail }` from `T.parse`/`parseNumber`/`Json.parse`; stringly error use is a check error; domain-ADT convention documented. **A→A+ shipped 2026-06: inferred error rows v1** (north-star §4, SPEC §2.13, `error_rows{,_match}_test`/`_bad`) — `Result T _` infers the raised ctor set with zero threading, named-ADT pins check inclusion (escapees listed), rows directly matchable with exhaustiveness over the ACTUAL raised set ("can never match" included). Residual: S3 polish; row variables are v2 (effect-A+). |
| Low-level | **A−** *(2026-06)* | Rust, Zig | Ptr/regions/outlives/move tracking are real and end-to-end. The four numeric stories have now **met** (§3.4): B2 unified units/`Duration`/`Px` into the `United` algebra, and **B3(i) (2026-06) shipped sized types** as range refinements over `Number` + the IR width tag (`sized_test`/`sized_bad`). **B−→A− re-graded 2026-06: B3(ii) shipped the `overflow` obligation** (`proof_overflow_test`/`_bad`), the seventh and last of the proof vocabulary (now 7/7 complete) — under `proofs: [overflow]` every `+`/`-`/`*` on width-carrying operands proves its result in range on the same two-sided Z3 query as `bounds`. Both named A− mechanisms (units + sized types) shipped; held-back **+** is native representation (Phase D); `std/low`/gpu/audio are sketches. |
| Games / intensive interactive | **C+** (today) / **A−** (as designed) | Unity C#, Bevy ECS, Pony | `docs/interaction-model-design.md` (footprint = `mut` params, capability-keyed dispatch, `@interaction`/`@confined`) is a credible, novel answer to ECS — but nothing of it is implemented, there is no frame clock, and a tree-walking interpreter can't hold 60fps. The claim depends on the compiled target. |
| Animation | **C** (today) / **A** (as designed) | CSS, Framer Motion, SwiftUI | The `animated` modifier + mandatory motion-policy chokepoint ("motion you can't write inaccessibly") is a real differentiator no shipping system has. Entirely unimplemented; depends on `frames` + reconciler work. |
| Security model | **A+** *(2026-06)* | everything mainstream | Taint-at-parse (not at transport) is the right boundary and well-argued. `Effect` capability enforcement is real end-to-end (§3.6 closed): direct calls + HOF laundering + effect tails + the effect-typed builtin surface (SPEC §12.5 — `setTheme`/`setViewport` `[ui]`, `externSource`/network `[io]`; `print`/`sleep` decided-ambient). E2 user-spelled effect rows shipped (2026-06, `..e` — user HOFs get builtin-grade per-call precision); ascription effect-coverage shipped (2026-06 — fn-type ascriptions can't erase rows). **Proof-gradient slice 1 shipped (2026-06): Tier-1 `@total`** (SPEC §12.6, `total_test`/`_bad`) — structural decrease + the downward call gate, effect enforcement's dual. **Proof-gradient slice 2 shipped (2026-06): the `Proof [...]` module scope** (SPEC §12.7, `proof_scope_test`/`_bad`) — `proofs: [total, exhaustive]` rides `capabilities:`; closed vocabulary, declared = enforced (unknown/not-checkable obligations are loud errors, never silent skips); `total` implicitly @total-marks every module def, `exhaustive` hardens clause heads in every edition. **Proof-gradient obligation 3 shipped (2026-06): `handled`** (`proof_handled_test`/`_bad`) — no silently discarded `Result` inside a `proofs: [handled]` module (dropped statement positions incl. loop bodies and mid-try; scope-local like `exhaustive`, no downward gate needed — that distinction is now stated in SPEC §12.7); 3 of the 6 obligations are checkable. **A→A+ re-graded 2026-06** (north-star §3.6 re-grade + §1 Security row): the dual-gradient pair is live — capabilities flow up, proofs flow down, one declaration shape, both closed vocabularies, both declared = enforced — a shape none of the capability-secure exemplars ships; and ambient stdout is on record as a *decided* hole (`print`/`println` = uncharged observation channel), not an oversight. Residual is breadth (per-function proof scope shipped 2026-06, `proof_fnscope_test`/`_bad`; per-block `@proof{}` cut, OQ#3 — for security the module is the trust boundary, so the shipped module scope is the relevant one), not enforcement. The deferred payback landed (2026-06): `constEval` folds refinement predicates whose call-closure is `@total` (totality §5.1, `constfold_total_test`/`_bad`) — the type-core row's A−→A lever, not a security item. |

**Overall:** the semantic layer is unusually coherent — the state primitives, the
refusal discipline (§4.0 of the SPEC), and the design-note honesty ("evidence
basis" sections) are top-decile. The *surface syntax* was where consistency broke:
**three application syntaxes**, **three meanings of `?` keyed on whitespace**, and
**two iteration forms**. The editions refactor (2026.6) has since retired two of the
three: the **two iteration forms → one** (`for…in`, `%` removed, §2.5) and the
**whitespace-keyed `?` is gone** (ternary deleted, §2.2) — both edition-gated (warning
in 2026.1, error in 2026.6) so the existing corpus stays green. Also shipped: `#{}`
records (kills the record-vs-block trap, §2.3), the `Outcome` rename (kills
constructor-sharing), `pipe`/`saga` deletions, and compile-time multi-clause head
exhaustiveness. **What remains** is the **three application syntaxes** (§2.1,
call-syntax phase 2) — now the top surface item before 0.6.

> Grades tagged *(2026.6)* reflect shipped, edition-gated changes; untagged grades are
> unchanged because their named gaps are still open (low-level/games/animation as
> noted). The event/state row's two named gaps (backpressure, `await`→step-goto)
> both closed 2026-06 with green fixtures → re-graded A− → A (`inputmap` is its
> A→A+ residual; its *core* — table, conflict check, drain loop — shipped
> 2026-06, breadth remains). The UI row's gaps have since
> closed — call-syntax duality (paren-form elements), the theme system (4/4), and now
> responsive end-to-end (prop-site auto-collapse) are all proven by green fixtures, so it
> is re-graded to A. Re-grade a row only when a green fixture proves its gap closed.

> **A+ targets & routes:** the *ceiling* companion to this scorecard lives in
> `docs/north-star-grades.md` — per-field A+ exemplars, what closes each gap, and a
> design-vs-build cut. Key results folded back: ceilings sit at **A not A+** by
> table-stakes breadth, not differentiators (§2); the type-core A+ is the **opt-in proof
> gradient** (`@total` + correct-by-construction types + Z3 `std/proof`, surfaced as a
> proposed **`Proof [...]`** obligation set — proofs declared like effects) — *coherence, not a
> solver* (§3); **error-A+, effect-A+,
> and effect-polymorphism converge on one unbuilt mechanism — error/effect *row
> inference*** (relevant to §3.5 + §3.6 below).

---

## 2. 🔴 Internal-consistency hot spots (the mental-model breakers)

### 2.1 One application syntax, not three
Today a reader must distinguish:
1. `f(x)` / `Ok(x)` — paren calls (the canonical form),
2. `add 1 2` — juxtaposition, legal only for curried saturation,
3. `Text "hi" size=12` — element space-form with `key=value` props,
4. …and patterns still use space form (`| Ok v ->`) while construction uses parens (`Ok(v)`).

The fixtures show the cost: real code is full of defensive double parens
(`print(("...."))`, `reserve((stockOk))`, `Complete((task.id))`) because nobody
can predict when one layer is enough. `docs/call-syntax-design.md` already locks
the right answer (everything is `Name(pos…, name=val…)`, elements lower to
`Call` with a `children` arg); it's just unfinished.

- [x] 🔴 Ship call-syntax **phase 2** — the surface unification. **DONE** (PLAN §5a+§5b):
  patterns `| Ok v ->` → `| Ok(v) ->` and elements `Text "hi" size=12` → `Text("hi", size=12)`
  are both edition-gated (warn 2026.1 / error 2026.6) with codemods + new fixtures. The
  `Element` AST node is kept internally (childless paren elements lower by primitive-name;
  children-bearing via a dedicated grammar rule) — *not* fully folded into `Call`, which is
  deferred compiler hygiene, not a reader-facing gap. Curried juxtaposition is also **DONE**
  (next bullet — it was already grammar-removed by phase 1; this turn closed the doc/reality
  gap and added fixtures). **Remaining for full §2.1 close:** applying the element codemod to
  the examples once they parse cleanly + inline-handler/spread props in paren-form (need
  call-arg-spread grammar) — both surface-inert sugar, not new reader-facing forms.
- [x] 🔴 **Delete curried juxtaposition** (`add 1 2`). **DONE** — value-level
  juxtaposition was already removed at the grammar level by phase 1's unified
  postfix `call` (`token.immediate('(')`); `add 1 2` and the juxtaposed IIFE
  `(fn x -> x + 1) 9` are now hard syntax errors in every edition. Partial
  application via `add(1)` and saturation via `add(1)(2)` are the only spellings.
  This turn reconciled the lingering doc/reality gap: SPEC "Calling functions"
  and "Currying & over-application" no longer claim `add 1 2` is legal, and new
  fixtures `juxtaposition_test` (green) / `juxtaposition_bad` (2 syntax errors)
  lock it. **Type-level juxtaposition kept** (the chosen asymmetry): the built-in
  parametric types still write `Result a e` / `Async a` / `Tainted a`, generic
  types use parens `List(Number)` (there is no generic `Name T` juxtaposition —
  `List Number` is a syntax error, a pre-existing doc error now corrected).
- [ ] 🔴 Make `velve fmt` collapse redundant parens so the
  `print((x))` idiom dies in formatted code.
- [ ] 🟡 Decide what `self`/`parent`/`prev`/`children` convergence references
  mean once elements are `Call` nodes (they reference tree structure, not
  arguments — currently undefined post-unification).

### 2.2 `?` means three things, disambiguated by whitespace
`x?` (glued) propagates, `cond ? a : b` (spaced) is ternary, `x ?: e` is
fallback, and inside sagas `? rollback` / `?: rollback` register compensation.
A meaning that flips on a *space* is invisible in review diffs and unguessable
for newcomers — it's the draft's single worst readability decision.

- [ ] 🔴 Give propagation its own glyph or keyword. Cheapest fix: **drop the
  C-style ternary** entirely — single-line `if c then a else b` (or the existing
  `if`/`else` with the single-line `->` body) covers it — and let `?` mean
  exactly one thing: "propagate failure." `?:` stays as "propagate with
  fallback."
- [ ] 🟡 Then rename/restyle the saga forms (`? rollback :step`) so they read as
  what they are (e.g. `onAbort rollback :step` / `onError rollback :step`),
  rather than reusing the error glyph with a fourth meaning.
- [ ] 🟡 Fix `§3.18` optional chaining: `report.user?.address?.city ? "Unknown"`
  ends in a *one-armed spaced `?`* that is neither the ternary (no `:`) nor the
  propagate (spaced) — it currently has no defined parse under the spec's own
  rules.

### 2.3 `:` and `=` — say the rule out loud, then hold it
`:` is "here comes a type"… except record fields (`{x: 3}`), atoms (`:ok`),
saga step labels (`:reserve`), and the ternary else. `=` binds values… except
named args (`f(a=1)`) vs record fields (`{a: 1}`) express the same idea with
different glyphs. The named-args doc calls the record-field `:` "the one
conscious sacrifice" — fine, but the SPEC's "three core symbols" section (§3.2)
currently overstates the invariant.

- [ ] 🟡 Rewrite SPEC §3.2 to list the exceptions honestly (atoms, record
  fields, step labels). An invariant with hidden exceptions is worse for mental
  models than an honest 80% rule.
- [ ] 🟢 Consider unifying record literals to `=` (`{x = 3}`) in a future
  edition, which would also dissolve the `{,}` record vs `{;}` block trap
  (§2.4). Big change; editions (§17) exist for exactly this.

### 2.4 `{ … }` record-vs-block and the multiline asymmetry
`,` makes a record, `;` makes a block; multi-line braces work for records but
*not* for blocks (newlines are invalid inside `{}` blocks — `;` only). That
asymmetry is documented only in blocks-design §12, not the SPEC.

- [ ] 🟡 Document the multiline restriction in SPEC §3.9, or fix the scanner so
  newline-separated `{}` blocks parse. One or the other; silent asymmetry is the
  worst option.

### 2.5 Two iteration forms, one sigil
`for (x = 1..20) -> x` (range, no sigil) vs `for (u = %users) -> u.name` (list,
`%` sigil) vs the UI keyed form `for r in rows` (different keyword shape, only
in SPEC prose, used in **zero** examples or fixtures).

- [ ] 🔴 Unify on `for x in xs` / `for x in 0..n` for both comprehensions and
  keyed UI lists; **delete the `%` sigil**. The sigil exists to help the
  parser, not the reader, and it's exactly the kind of one-off a newcomer
  can't infer.
- [ ] 🟡 If the keyed-list form stays, add a passing fixture for it; right now
  it is spec fiction.

### 2.6 Atoms vs. nullary constructors — two enum systems
`type Status = Todo | InProgress | Done` and bare atoms `:ok | :error` cover
the same ground; examples use naked atoms where the SPEC's own style would use
an ADT (and atom matches then need a catch-all, silently giving up
exhaustiveness — see `statusLabel` in `cross_language.velve`).

- [ ] 🟡 Write the rule down: **atoms for open/wire-level names (messages, step
  labels, dispatch keys); ADTs for any value you match on in more than one
  place** (you want exhaustiveness). Add a lint: matching an atom-typed value
  with a catch-all where a closed ADT would check exhaustively.

### 2.7 TxResult/Result constructor sharing
`Ok`/`Error` belong to *both* `Result` and `TxResult`, resolved by expected
type. Clever, but it makes the meaning of `| Ok v ->` depend on inference
context — precisely the "no magic" principle the SPEC leads with.

- [ ] 🟢 Consider renaming TxResult's constructors (`Committed v` /
  `Aborted e` / `Conflict` / `Timeout` / `Cancelled`). Reads better at the
  match site, and removes the only expected-type-dependent name in the language.

---

## 3. 🟡 Domain gaps found in the scan

### 3.1 UI
- [ ] 🔴 Convergence cycles are detected **at runtime** (styles-design §6.6),
  while the design promises compile-time DAG checking. A cycle behind an empty
  dynamic list passes checking and detonates later. Either pre-flag static AST
  cycles at check time or re-document the guarantee honestly.
- [x] 🟡 Responsive prop-site auto-collapse — **DONE (2026-06)**. A
  `Responsive(Length)` (a `Breakpoint -> Length` value) is now accepted **directly in a
  `Length` prop** and collapsed against the live `viewport.breakpoint` before emit — the
  author never threads the viewport. Type-gated (a second coercion beside bare-`Number`→
  `Px`: a one-param `Breakpoint -> T` whose return unifies with `Length`; a
  `Breakpoint -> String` / `Number -> Length` stays a prop type error). Collapsed at
  **eval**, *not* in the convergence pass: the viewport is a §9.1 read-only root, so the
  read adds no (element,prop) edge — the exact parallel of a `theme.*` fold (and a
  container query is still the only cycle re-entry, caught by §6.2). Added `setViewport`
  (the viewport sibling of `setTheme`): a resize swaps the root and the next `view()`
  re-collapses every responsive prop. Fixtures `responsive_prop_test` (`width=sidebarWidth`
  → `width:320px` at Desktop, then `setViewport(…Mobile)` re-renders the same view as
  `width:100%`; 0 err, runs) + `responsive_prop_bad` (2 errors — wrong return, wrong
  param). Corpus unchanged (0 CRASH); colour/theme/convergence fixtures clean. Responsive
  is now built end-to-end (§9.2–9.4 all shipped).
- [ ] 🟡 The theme system (roles, `using`, `OnSurface` contrast refinement) is
  design-only while `std/color` is fully built — the color science has no
  consumer. Theme is the highest-leverage unbuilt UI piece.
  **Scoped 2026-06 → `docs/theme-design.md`.** Grounded the two concrete blockers
  by probing the live checker: (1) a module-level semantic token (`let surface =
  #0d1117`) referenced as `background=surface` reports `unresolved name` in prop
  position; (2) even resolved, the contrast proof folds with `EMPTY_ENV`
  (infer.ts:1914), so `constEval`'s `Var` case can't reach the token → the APCA
  proof is **silently skipped**. Net: the §4.3 contrast guarantee only fires on
  inline hex literals today; themeable code defeats it.
  **Model (user steer):** declaration is type-gated — a token is a `Color` *typed*
  `Surface` (`let panel: Surface = #0d1117`), no new keyword; application is
  *explicit* via a `using` clause on element-returning functions — `using panel`
  (named) or `using surface = #000000` (inline declare+apply sugar) — which sets the
  ambient surface (`surfaceBg`) the §4.3 proof already consumes. Staged into 4
  slices, value front-loaded. **Slice 1 ✅ DONE (2026-06):** module-level constant
  bindings now exist — added a `DLet` decl (there was *no* top-level `let`; the
  lowerer silently dropped it), wired through lower/resolve/infer/eval, and threaded a
  `moduleConsts` fold-env into the three element-prop `constEval` sites so a `Surface`
  token (`background=panel`) resolves to its hex and feeds the §4.3 proof. Fixtures
  `theme_token_test` (0 err, runs) + `theme_token_bad` (2 contrast errors via the
  token-resolved bg); corpus baseline unchanged (294 err / 0 CRASH — inert on any file
  without a top-level `let`). Grammar-free, no edition. **Slice 2 ✅ DONE (2026-06):**
  the `using` clause — explicit ambient-surface application. Added an optional
  `using_clause` (`using panel` / `using surface = #000000`) to both forms of
  `function_def` (regenerated parser + rebuilt native binding), a `surface` field on
  `FnClause`, lowering that extracts it from the body, resolve (named role must resolve;
  inline name defined into body scope), and `inferClause` setting/restoring `surfaceBg`
  from the clause surface — reusing the existing §4.3 threading verbatim, **zero new
  proof logic**. Fixtures `theme_using_test` (named + inline, 0 err, runs) +
  `theme_using_bad` (both forms fail, errors reporting `background #101418`/`#000000` —
  proving the surface comes purely from `using`); corpus unchanged (294 / 0 CRASH).
  **Slice 3 ✅ DONE (2026-06):** a `Theme` record + roles *derived* via `std/color`,
  folded at check time — `std/color`'s first real consumer. Extracted the OKLCH/APCA
  maths into a shared `src/color.ts` imported by both the runtime (`eval.ts`) and the
  compile-time fold (so a derived role folds to the *exact* runtime hex — no divergence);
  `ConstVal` gained a record form; `constEval` gained `Record`/`Field` cases and folds the
  pure colour builtins (`oklch`/`hex`/`lighten`/`mix`/`legibleOn`/`shades`/`toHex`/…), a
  `Color` carried as its OKLCH triple. Application reuses Slice 2's inline form
  (`using surface = dark.panel`) — grammar-free. Fixtures `theme_record_test` (dark+light
  themes, `text=legibleOn(panel)` derived, proven against panel **and** accent; 0 err,
  runs — printing the same hexes the proof checked) + `theme_record_bad` (a hand-picked
  grey `Lc 56 against #f2f5fc` and a dark literal `Lc 28 against #4a81eb`, both backgrounds
  std/color-*computed*); corpus unchanged (294 / 0 CRASH).
  **Slice 4 ✅ DONE (2026-06) — theme system COMPLETE.** `theme` is now a built-in
  read-only reactive root (the sibling of `viewport`): a `VRecord` in eval, a `Record`
  type in infer, a reserved name in resolve, default roles *derived* via the shared
  `color.ts DEFAULT_THEME`. `moduleConsts` is pre-seeded with it, so `theme.panel`/
  `theme.text` fold through the Slice 3 `Field` path — `using surface = theme.panel` +
  `color = theme.text` is APCA-proven (§4.3) against the **live root** (compile-time
  contrast for the statically-known theme; a dynamic swap is the §14.1 runtime escape).
  Runtime swap via `setTheme(theme)` (overwrites the global slot → next `view()` render
  picks up new roles; reads stay read-only). **No convergence-pass code change** — a
  `theme.*` read adds no graph edge, so theme is acyclic by construction (§9.1); the only
  re-entry is a container query, which the existing §6.2 cycle-checker already rejects.
  Fixtures `theme_root_test` (components proven against the root; `setTheme(light)`
  re-renders the same view, surviving leaf swaps `#f8f8f8 → #0b0b0b`; 0 err, runs) +
  `theme_cycle_bad` (a self-measuring container query rejected: *"convergence cycle …
  involving 'padding' on Box"*); corpus unchanged (294 / 0 CRASH), colour tests byte-identical.
- [ ] 🟡 Define when `OnSurface` contrast checking fires (inside vs after
  convergence) — currently "inside or after" hedging across two docs.
- [ ] 🟢 Bare-number → `Px` coercion is prop-position-only; `let x: Length = 8`
  behaves differently. Document this as a prop-context rule + add a checker hint.

### 3.2 Event handling / streams
- [x] 🔴 **Per-stream backpressure policy** — ✅ DONE (2026-06). `stream Name : T
  [drop | buffer N | block]` at the declaration site (SPEC §10.1 rewritten).
  **Honesty finding:** the old "drop by default" spec line was fiction — the
  as-built queue was (and, absent a policy, still is) an *unbounded buffer*;
  nothing was ever dropped. As-built: `drop` = deliver-to-waiter-else-discard
  (freshness sources: pointer moves, frames); `buffer N` = bounded, evicts
  *oldest* on overflow (positive-integer literal, else checker error); `block` =
  rendezvous — `send` parks the producer until a consumer takes the value
  (lossless, the inputmap-grade policy; the cooperative scheduler advances the
  clock only when every task is parked, so a blocked send is deterministic).
  Policies govern `Push` only — `Done` always lands (losing the termination
  signal would park consumers forever). Surface: `drop` was already a keyword;
  `buffer`/`block` are **contextual** (a lower_id in policy position, validated
  in the lowerer — a grammar keyword would have *reserved* them globally and
  broken `buffer` as a store field, caught live on `examples/llm_agent.velve`).
  Fixtures `stream_policy_test` (all three policies proven by ordering/eviction/
  rendezvous, 0 err, runs) + `stream_policy_bad` (2 errors: `buffer 0`,
  `buffer 2.5`); corpus baseline byte-identical (0 CRASH), zero new tree-sitter
  corpus failures.
- [x] 🟡 **`await`→step-goto in machine steps** — ✅ DONE (2026-06). `await Events
  | Push(e) -> :collect (acc + e) | Done -> :finish acc` now works inside `machine`
  steps end-to-end, including the self-goto drain loop. **Honesty finding:** the gap
  was never the grammar — `await_stmt` parsed inside a step (and `_branch_body`
  already admitted `step_goto`); the *lowerer* fell through to its default case and
  silently DROPPED the statement (empty step body, every await-targeted step
  "unreachable"). Fix: one `lowerSagaStmt` case lowering the statement to a
  `SagaMatch` on a branch-less `Await` subject — infer/eval/reachability needed
  zero changes (they already walked `SagaMatch`). Branch gotos are checked
  (unknown-state = error) and count for reachability. Fixtures `machine_await_test`
  (stream-draining accumulator machine, 0 err/0 warn, runs → 60) +
  `machine_await_bad` (2 errors: gotos to unknown states from await branches —
  undetectable pre-fix because the statement was dropped). SPEC §4.3 note rewritten
  as-built; corpus baseline byte-identical (0 CRASH).
- [x] 🟡 **`inputmap` core** — ✅ BUILT (2026-06, SPEC §10.5). `inputmap Name over
  Stream` + `pattern -> action ["label"]` rows: typed against the stream's event
  type (full pattern grammar incl. guards), labels parsed and retained (help-
  overlay substrate), and **conflict analysis** — "bound twice" (structural
  pattern equality, binder names normalized) and "shadowed" (row after an
  irrefutable catch-all); guarded rows exempt. Calling the map runs the drain
  loop (first matching row's action; unmatched falls through; `Done` terminates
  after a bound `Done` row runs). **As-built deviation:** actions are explicit
  calls — bare `-> save` is an error with a fix-it (`save()`), consistent with
  the §2.1 call unification, which postdates the design sketch's bare-ref rows.
  Fixtures `inputmap_test` (0 err, runs: literals/guard/fallthrough/Done order
  proven) + `inputmap_bad` (4 errors: bound-twice, shadowed, bare-fn action,
  unknown stream). **Help-as-derived-data shipped too** (2026-06): a dedicated
  **`Inputmap` type** (SagaFn precedent — survives aliasing; nullary-callable,
  arity-checked) and `help(map) : List({pattern, label})` — labelled rows only
  (a label is the opt-in to user-facing help), declaration order, guarded rows
  marked `if ...`. Fixtures `inputmap_help_test` (patterns/labels/alias proven,
  unlabelled row hidden) + `inputmap_help_bad` (3 errors: `help(42)`,
  `help(fn)`, `Editor(1)` — all check-time). **Layering shipped too**
  (2026-06): `base ++ overrides` builds a new map — unguarded override rows
  replace same-pattern base rows *in place* (structural compare via the shared
  `patKey`; help keeps base ordering), other rows append; operands untouched.
  The `Inputmap` type carries its stream, so cross-stream layering and
  `map ++ 5` are check-time errors. Fixtures `inputmap_layer_test`
  (override-wins/base-preserved/new-row run order + merged help + base help
  unchanged) + `inputmap_layer_bad` (2 errors). **Chords shipped too**
  (2026-06): no new grammar — `type Chord = String where matches(value, …)` +
  a **literal-pattern refinement fold in `checkPat`** (a literal that fails
  the matched type's refinement can never match → check error, at EVERY match
  site, conservative-skip on non-folding/dependent preds) + `Push(p)` against
  a stream of `T` now checks `p` against `T` itself (also types the `Push(e)`
  binder, previously unchecked; corpus baseline byte-identical). Fixtures
  `inputmap_chord_test` (typo-free table runs; value-side call fold passes) +
  `inputmap_chord_bad` (3 errors: row typo `Push("Ctl+S")`, plain-match typo,
  value-side `describe("notachord!")`). **`keymap` sugar shipped too**
  (2026-06): `keymap Name` ≡ `inputmap Name over Key`, same decl (a `form`
  field only tailors diagnostics); missing `Key` stream gets a fix-it
  explaining the desugar. Fixtures `keymap_test` (a keymap layers with an
  `inputmap … over Key` and the merged map runs + helps — sugar proven by
  unification) + `keymap_bad` (2 errors: no-`Key`-in-scope fix-it,
  cross-stream layering showing the keymap's type carries "Key"). Remaining
  slices (still 🟡, tracked in multitarget §4): the physical-key prefix
  (`"@KeyW"`) + a std `Key` device library with a canonical chord refinement,
  focus-zone scoping (plain modes already fall out of layering + `match`), the
  *rendered* overlay element, device libraries over the extern-source unlock
  (§4.1).

### 3.3 Games / interaction model
- [ ] 🔴 Implement the `@interaction` marker (no-ambient-writes) from
  `interaction-model-design.md` — it's specified down to the `borrow.ts`
  changes and is the cheapest one (decorator + binding-origin check). The
  whole "what can change X?" pitch is unverifiable until then.
- [ ] 🟡 Decide open question (a): `@interaction` as global default with
  opt-out. Recommendation: **yes, in the next edition** — it's nearly free
  given store-message discipline, and a default is a far better mental model
  ("writes are always in the signature") than an opt-in marker.
- [ ] 🟡 Ship the `frames` clock-stream host capability. Both the game loop and
  `animated` are blocked on it; it's also the smallest piece.
- [ ] 🟢 `examples/particle_system.velve` imports `std/gpu`/`std/audio` and uses
  `@kernel` — none of which exist. Mark it clearly as fiction or trim it to the
  implemented subset; it currently reads as a capabilities claim.

### 3.4 Low-level / numerics — four numeric stories, zero bridges
`Number` (unified, repr open since §14) · `Duration` (a real dimension with
unit algebra — excellent) · `Px/Fr/Pct` lengths (UI-only) · planned
`Int8…Float64` (std/low). Nobody has said how they interact: is `Px 8 + 4`
legal the way `gap=8` coerces? Is `Float32` a `Number`? Can `Duration`'s
dimension machinery generalize?

- [x] 🟢 **Write the unified numeric/dimension design note — DONE 2026-06**
  (`docs/numeric-dimension-design.md`, Phase B slice B1). One algebra:
  `Number` is the dimensionless case; units are a new solver-invisible `United`
  type variant (`type Meters = Number unit m`, NOT transparent to base — so
  `100ms * 50ms → Duration²` is *legal* and `m + s` errors); sized types
  (`u8…i32`) are range refinements over `Number` + an IR width tag (erase-on-JS /
  native-primitive); conversions are explicit-casts-only; the 7th proof word
  `overflow` rides the existing `bounds` fact-env/Z3 path. Duration/Length/angle
  all derive from the one concept. **All shipped 2026-06: B2 (units) + B3 (sized
  types + the `overflow` obligation) — Low-level re-graded B−→A−.** The `Duration` algebra (`100ms * 3` ok, `400ms/100ms :
  Number`) was the best piece — now generalized rather than special-cased. **See
  `docs/north-star-grades.md §5`** for the worked two-axis argument.
  - [x] 🟢 **B2(i)+B2(ii)+B3(i)+B3(ii) SHIPPED 2026-06 — Phase B done, Low-level B−→A−.** Units: `United` variant +
    `unit` decls + the `*`/`/`/`+`/cmp algebra + `Math.*` interplay + the
    `Duration` fold (`ms*ms : s^2`) + the conversion bridge (`uom_test`/`uom_bad`,
    `uom2_test`/`uom2_bad`). **Sized types (B3(i), `sized_test`/`sized_bad`):**
    the `U8…I32` range-refinement family + lowercase gates + faulting ops, exactly
    the refined-types pattern (transparent to `Number`), plus the IR width tag — a
    name-derived `{ bits, signed }` on `Refinement`, inert at runtime, with
    check-time teeth (no silent coercion across widths). Type names are `upper_id`
    so it's `U8`/gate `u8`. **`overflow` obligation (B3(ii), `proof_overflow_test`/`_bad`):**
    the 7th and final proof word (vocabulary now 7/7) — under `proofs: [overflow]`
    every `+`/`-`/`*` on width-carrying operands runs the same two-sided Z3 query as
    `bounds` against the width range; width params seed their range so a guarded op
    proves, the unguarded one reports the out-of-range model (the two `proof_*_bad`
    re-pins flipped from not-checkable to a real overflow, as their comments predicted).
    B2(iii) general unit constructor shipped after imports as C1(v) (`units_lib_test`).
- [ ] 🟡 Resolve `Number` internal repr before the compiled target (overflow
  semantics, bit ops on floats — `mask & flag` in the fixtures is already
  doing implementation-defined work).

### 3.5 Error handling / absence
- [x] 🟡 The no-`Maybe` stance is consistent and defensible, but every example
  pays the `Result T String` tax — stringly-typed errors everywhere. Add a
  conventions section + stdlib support for *named error ADTs* (and make
  `T.parse`/decoders return a structured error type, not `String`), so "absence
  is a named failure" produces names, not prose. **DONE 2026-06** (SPEC §2.6,
  `error_adt_test`/`_bad`): prelude ADT `ParseError { expected, got, detail }`
  (single ctor, shared name; registered in resolve/infer/exhaust/eval), returned
  by refinement `T.parse` and `parseNumber : String -> Result Number ParseError`
  — which this slice also made *real* (it was typed but neither resolved nor ran;
  whole-string `Number()` semantics, so `"3abc"` is an `Error`). `Json.parse`
  produces it at runtime (`detail` keeps the JS parser message). Treating the
  error as a `String` is a check error; the SPEC §2.6 convention section shows
  map-at-the-boundary into a domain error ADT (exhaustiveness-checked — what
  `examples/pipeline.velve` already did by hand). *Residual:* `parseInt`/
  `parseFloat`/`String.toNumber` still return `Result _ String`; a user ADT may
  reuse the `ParseError` ctor name (pipeline does) — exhaustiveness is keyed by
  scrutinee type name, so no collision.
- [x] 🟡 Fix the `try` soundness gap (blocks-design §12): a line whose type is
  an unresolved type variable later resolved to `Result` is unwrapped by eval
  but not by infer. Either monomorphize-before-try, reject polymorphic try
  lines, or warn. **DONE 2026-06** (`try_sound_test`/`_bad`, SPEC §3.2): a hybrid
  of the first two options — a *deferred monomorphize-then-decide sweep*. Var-typed
  try/retry lines are recorded at peel time and re-judged after the whole module is
  inferred: resolved to concrete non-Result → accepted retroactively; resolved to
  Result too late, or never → check error. Riders: calls to Unknown callees now
  return `Unknown` (not a leaked leniency var — same discipline as failed calls);
  `print`/`println` typed `forall a. a -> Unit` (surfaced + fixed dishonest
  `: String` print-bodied compensations in `saga_demo`); `identity`/`listHead`
  made real in resolve+eval; `listHead`'s free error var → concrete `String`.
- [ ] 🟡 Error-type A+ path: **infer error rows internally, pin an explicit ascription at
  module boundaries** (Zig `!T` ergonomics + a reviewed contract at the edge). This is the
  *same row-polymorphic inference* as effects (§3.6) — build it once. See
  `docs/north-star-grades.md §4` for the trade table and decision.
  **Design written 2026-06** (`docs/error-rows-design.md`): v1 is Zig-shaped
  transitive ctor-sets (no row variables, no HM extension) — `Result T _`
  infers, a named-ADT ascription pins via ctor-set inclusion, rows are
  matchable with exhaustiveness over the actual raised set; recursion among
  `_` defs rejected in v1. Row variables (the effect-A+/HOF convergence) are
  explicitly v2. Build plan: 4 slices (S1 accumulate+pin, S2 match/exhaust,
  S3 diagnostics/prose-interop, S4 row vars).
  **S1 BUILT 2026-06** (SPEC §2.13, `error_rows_test`/`_bad`): grammar `_` in
  the Result-error slot (slot-exact), ErrRow type, `?` accumulation, transitive
  closure by end-of-module fixpoint, pins deferred to finalize with escapees
  listed, cycles rejected, prose uncoverable. Zero corpus impact.
  **S2 BUILT 2026-06** (`error_rows_match_test`/`_bad`): rows directly
  matchable — payloads typed from ctor schemes, match never widens the row,
  exhaustiveness over the ACTUAL raised set (missing named; never-raised arms
  rejected; prose needs catch-all), judged post-closure like pins. **Error
  row re-graded A → A+** (north-star §1/§4).
  **S3 shadowing slice BUILT 2026-06** (`ctor_shadow_test`/`_bad`): shared
  ctor names resolve by EXPECTED type in expression position (deferred behind
  fresh vars, judged in finalizeRows step 0) and by scrutinee type in
  patterns; a row-entry match types the payload from the contributing ADT.
  Declaration order of sharing ADTs no longer matters.
  **S3 late-contribution slice BUILT 2026-06** (`row_late_test`/`_bad`): the
  S1 Var leniency closed — a `?` whose callee error type is still a Var
  (forward call to an unascribed-param def / `let` lambda) is deferred to
  finalizeRows step 0.5 and re-judged once the substitution resolves; never-
  contributable types are REJECTED (still-polymorphic → "annotate or pin";
  concrete non-ADT → named in the diagnostic), only `Unknown` stays lenient.
  S1 silently dropped these and pins passed vacuously.
  **S3 fix-it slice BUILT 2026-06** (`row_fixit_test`/`_bad`): a failing pin
  names the smallest edit — re-pin with a declared covering ADT (smallest
  wins) and/or add the missing variants in declaration syntax; the green
  fixture is the suggestion applied. S3 is now CLOSED except mixed-arity
  shared names — discovered to be runtime-ambiguous, not check-side (eval
  binds each ctor name once: function if payloaded, bare value if nullary),
  so it waits on an eval redesign. Remaining: guarded arms cover nothing,
  S4/v2 row variables (→ effect-A+).
  **S4 design written 2026-06** (`docs/row-variables-design.md`): v2 is NOT
  full row-polymorphic HM — tails are quantified type vars on the def's row,
  cloned per call site at instantiate and judged by the EXISTING finalize
  step 0.5 (resolved-to-row → ⊇-edge, so occurs-over-tails is the existing
  cycle DFS); no new unification on the error side. Probing exposed the real
  prerequisite: the grammar has NO function-type ascription (lower.ts never
  produces TRFn; the checker is TRFn-ready), and row defs are mono so rows ×
  generics is unusable today ("expected a, got String" at every call).
  Sliced: S4a fn-type ascriptions `(A -> B)` (grammar/lower; mandatory
  parens — bare `->` in the return slot is the single-line def body), S4b
  row tails, S4c effect tails on builtin HOF signatures (replacing §12.4's
  conservative charge where a HOF provably doesn't invoke its argument;
  Fn-unify must learn effect tails — today it skips effects entirely).
  **S4a BUILT 2026-06** (SPEC §2.14, `fn_type_test`/`_bad`): `(A -> B)`,
  n-ary `(A, B -> C)`, thunk `(() -> T)` (lone `()` = empty param list, the
  zero-param def shape), return-slot fn types, and generic fn params
  (`(a -> a)`) — the checker was already TRFn-ready, so the slice is
  grammar + lower only. Pass-through error polymorphism proven green under
  a pin; the bad fixture pins 4 boundary errors (arity, param type, non-fn,
  wrong pin through `e`) that unascribed HOF params could never surface.
  Effects on the ascription stay `[]` until S4c.
  **S4b BUILT 2026-06** (SPEC §2.13 v2 block, `row_tails_test`/`_bad`): row
  defs compose with generics (layer 2 closed — `wrap(x: a)` callable at two
  types); a callback's error var is a TAIL recorded on the row instead of a
  bogus pseudo-ctor (layer 3 closed); every use of a generic row def judges
  a per-call-site CLONE (⊇ base), so the same def pins as `HttpError` at one
  call and `DbError` at another, and a row-match is exhaustive over THIS
  call's set. Union + extension both proven green. As-built delta: tail
  registration defers to a new finalize step 0.4 (`pendingCloneTails`) —
  callers can check before the def's body has recorded its tails; judging is
  step 0.5 verbatim. Open rows (tail never resolved) error at the call and
  demand a catch-all in matches. Residual: forwarding a callback through a
  second row def without invoking it leaves the inner tail as an opaque
  pseudo-ctor (two-level threading out of scope).
  **S4c BUILT 2026-06** (SPEC §12.4 effect-tails block,
  `effect_tails_test`/`_bad`): builtin HOF signatures carry an effect TAIL —
  `Fn` gains `effectTail?: number` (a quantified id, remapped per use by
  substVars), `EFFECT_TAILS` accumulates what each call's argument row binds
  into it (Fn-unify's one effect rule: a declared tail absorbs the other
  side's full row; effects still never unify), and the per-call check charges
  the resolved row — `pmap` is pure at one call, `[io]` at another. A tailed
  signature is "accounted": the conservative §12.4 latent rule defers to it,
  which un-charges `identity(netGet)` (tail on its own row only, never bound
  — it returns without invoking) while the returned value still carries [io]
  for the ordinary per-call check (no laundering). Surface `map`/`filter`
  stay Unknown-callees → conservative rule unchanged; `hof_effects_bad`
  keeps 4 errors with its pmap case now failing via the tail. Residuals:
  other fn-taking builtins (`sortBy`, `listReduce`, …) still conservative
  (mechanical to tail). **E2 user-spelled tails BUILT 2026-06** (SPEC §12.4
  E2 block, `effect_spell_test`/`_bad`): `..e` inside the `Effect [...]`
  bracket — on a param fn-type it BINDS the argument's row, in the def's own
  clause it CHARGES the caller; zero new syntax concepts (effect_type is
  already a _type, so `f: (String -> Effect [..e] String)` just parses) and
  zero new checker rules (tail names quantify in generalizeSig, namespaced
  "..e" in tp, and ride the S4c machinery verbatim). The latent-rule skip
  widened to tail-AWARE (own or param Fn tailed) so the spellable identity
  pattern (`keep`) is uncharged while the value keeps its row. Validation:
  ≤1 tail/row; clause or top-level-return tails unbound by any fn param
  error (no-op lies). A tail-only clause declares an EMPTY pool — the tail
  is never a license for the body. Residual FOUND while building
  (pre-existing, S4a-era): an untailed concrete fn-type ascription ERASES
  effects (`def grab(): (String -> String)` over netGet launders [io] —
  effects don't unify). **CLOSED 2026-06** (`effect_ascribe_test`/`_bad`,
  SPEC §12.4 coverage block): directional check at ascription boundaries
  (def returns + let bindings) — declared row must COVER the actual row,
  walked covariant-deep (fn rets, type args, tuples, record fields,
  Stream/Async inners); over-approximating is legal; tail-spelled returns
  exempt at top level; fn params stay with the conservative rule
  (contravariant). Caught a real one in the corpus: effect_tails_test's
  `keep(): (String -> String)` over identity(netGet) was a genuine
  erasure — now spelled `(String -> Effect [io] String)` (the
  no-laundering property, explicit). S4/v2 complete including E2.
- [x] 🟡 **User generics** (found during the error-ADT slice, closed 2026-06;
  SPEC §2.12, `generics_test`/`_bad`): `def idy(x: a): a` parsed but the type
  var was a rigid `Named "a"` never generalized — `idy(5)` was a type error,
  making the annotation a silent trap. Now: lowercase nullary ascription names
  are implicit type variables, quantified at collect time (each call site
  instantiates fresh — same mechanism as typed-prelude generics) while the
  body keeps resolving them as rigid skolems, so an implementation that pins
  `a` (`-> x + 1`) still errors. NOTE: ordinary defs carry types on the
  *clause* (decl.sig is null) — the scheme is built from param ascriptions +
  clause ret. Zero corpus impact (nothing used the broken form — the trap
  never sprung because it never worked).

### 3.6 Effects
- [x] 🔴 Capability *enforcement* must match the spec's promise ("compiler
  verifies all effectful calls at definition site", §12.3) — the multitarget
  doc admits effects are "declared but not enforced." Honest effects that
  aren't checked are worse than none: they train readers to trust signatures
  that can lie. **Mostly closed 2026-06**: direct calls checked (`effects_test`,
  pure-hole edition-gated) and the HOF-argument laundering route closed (next
  item). Residual was *coverage*, not mechanism — **CLOSED 2026-06**
  (SPEC §12.5, `builtin_effects_test`/`_bad`): the effectful runtime builtins
  charge their capability — `setTheme`/`setViewport` `[ui]` (host-state
  writes), `externSource` `[io]` (the input FFI), the prelude network names
  `[io]` (not yet runtime-resolvable; honest when they land). The S4c tails
  carry builtin rows through HOFs (`pmap(setViewport)` charges `[ui]` in a
  pure def). DECIDED ambient: `print`/`println` (stdout is the observation
  channel — charging [io] would put `Effect [io]` on every main while
  guarding nothing host-mutable) and `sleep` (virtual time, deterministic).
  Corpus updated honestly: `theme_root_test`/`responsive_prop_test` mains
  now declare `Effect [ui]`; the baseline-edition externSource fixtures get
  the designed deprecation warnings.
- [x] 🟡 Specify effect polymorphism for higher-order functions (what is the
  effect of `map(f, xs)` when `f` is effectful?) — currently absent from the
  SPEC and it's the first wall any real program hits. **DONE 2026-06**
  (SPEC §12.4, `hof_effects_test`/`_bad`): the effect of `f`, surfaced at the
  call that supplies it. A function value carries latent effects on its `Fn`
  type; passing it as an argument charges them to the call site (conservative —
  the callee may invoke it; no effect rows yet, so a HOF can't declare it
  doesn't). Fires for both untyped callees (`map` — the Unknown-callee path)
  and typed ones (`pmap`); aliasing doesn't launder. Lambdas stay latent-free:
  their bodies are checked against the enclosing declaration and can't escape
  (no fn-type ascription syntax). Rows (north-star §4) subsume this as the
  closed-row case when they land.
- [x] 🟢 Module-qualified calls (`Math.sqrt`) still don't resolve while all
  planned stdlib docs are written in qualified style. Land qualified resolution
  before the stdlib grows further. **DONE 2026-06** (SPEC §5.5,
  `qualified_test`/`_bad`): the capitalized slash-free stdlib aliases (`Math`,
  `String`, `Json`, `Color`, `Duration`, `Dict`, `Set`, `IO`) are *ambient* —
  resolve/infer/eval each fall back to the module registry after normal lookup
  fails, so user bindings shadow. Members fully typed (unknown member / wrong
  arg type are check errors; unknown module still unresolved); the ambient form
  reuses the namespace-import record type, so the two spellings can't diverge.
  All three registries already existed (stdlib.ts MODULE_ALIASES, eval
  STDLIB_RUNTIME, import machinery) — the slice wired the bare-name fallback
  and added the missing `IO`/`JSON` runtime keys.
- [ ] 🟡 **Phase C1 — multi-file imports** (SPEC §7.3, endgame-plan §4). The
  refined-type / `SortedList` libraries travel by copy-paste inclusion today.
  **C1(i) DONE 2026-06** (`loader.ts`, `import_refined_test`/`import_private_bad`,
  `import_refined_lib`): file-relative `import … from "./mod"` now resolves to
  disk. A new loader parses+lowers the entry file and every `./`/`../` module it
  imports transitively, and merges their decls into ONE program (imported-first,
  deduped by abspath, cyclic imports rejected). Because a `module Foo { … }`
  nested in the decl list is exactly what a single-file program already
  produces, every downstream pass runs unchanged — the registries (REFINEMENTS,
  FN_PARAMS, ADT_CTORS) become **per-program for free**, and `@private` ctors
  stay sealed across the file boundary via the existing `privateTo`/moduleStack
  check (the `_bad` proves it: `Natural(99)` outside its file is rejected
  "private to module 'refined'", where pre-loader it was merely "unresolved").
  The merged-out file-local `DImport` is marked `local` so resolve/infer/eval
  skip its placeholder binding. Stdlib/ambient imports (`"String"`, `"std/json"`)
  are untouched — only `./`/`../` paths hit disk. **Honest as-built:** the green
  consumer's *check* passes pre-loader too (unknown imports bind leniently as
  `Unknown`, unknown type names are opaque), so the loader's behavioral proof is
  `run` — pre-loader `run` dies `undefined variable: natural`, post-loader it
  prints. Remaining: C1(ii) eval loading + CLI multi-file entry (largely falls
  out — `run` already works through the merge); C1(iii) `std/` on disk +
  corpus migrated off inclusion; selective-visibility enforcement (only listed
  names visible, vs the current flatten-on-merge) is a later tightening. LSP
  follows.
  **Rider DONE 2026-06 — unresolved imports are errors** (`import_unresolved_bad`/
  `import_foreign_test`): closing the C1(i) honesty gap. A path resolving to
  neither a stdlib module, a file-relative module, nor a foreign `import js` is
  now rejected ("cannot resolve import '…'"), and a braced named import of a
  missing export is "module 'M' has no export 'x'". Before, both bound the name
  to the recovery type `Unknown` (which `unify` no-ops) and any later use
  type-checked clean — the silent-leniency hole. Invariant now enforced:
  **`Unknown` is minted only after a diagnostic** (recovery, not absence); the
  sole deliberate exception is `import js` foreign interop (opaque by design,
  flagged so the error doesn't fire). Needed two small lower-time AST flags —
  `foreign` (the `js` form lowers identically to a bare import otherwise) and
  `named` (the `{…}` braces, which lowering discarded — so a braced single-name
  non-member used to misclassify as a namespace alias). Baseline: clean fixtures
  unchanged; `examples/particle_system.velve` 26→29 errors (its imports of the
  unshipped `std/gpu`/`std/audio`/`std/low` now fail honestly — already red from
  a syntax error). This also makes `import_refined_test`'s *check* depend on the
  loader (remove it → "cannot resolve import './import_refined_lib'").
  **C1(ii) eval loading + CLI multi-file entry — DONE 2026-06**
  (`import_diamond_test` + helpers `diamond_base`/`diamond_a`/`diamond_b`;
  `import_cycle_a_bad`/`import_cycle_b_bad`). It largely fell out of (i) — `run`
  already drives the merged program (`run` evals all merged decls then calls the
  entry's `main`; a library's `main` is harmlessly shadowed since entry decls
  merge last) — BUT writing the fixtures earned their keep by surfacing a real
  loader bug. The diamond (entry → {a, b, base}; a → base; b → base) proves eval
  loading composes transitively and the shared leaf merges ONCE (dedup by
  abspath); it runs `12 / 7 / 20` across four files. The cyclic pair proves the
  DAG guard fires. **Bug found + fixed:** the entry path was used as its own
  `onStack`/`loaded` key verbatim (relative, as the CLI passed it) while
  `resolveLocal` produces absolute paths — so a cycle back through the *entry*
  (a→b→a) didn't match, the back-edge went undetected, and the entry loaded +
  merged TWICE (the `ast` dump showed `cycA` duplicated). Fixed by normalizing
  the entry to absolute (`load(resolvePath(entryFile))`); the cycle is now
  caught at the true back-edge and every file merges once. Also hardened the DFS
  to push the current file onto the stack for the duration of its own load.
  **C1(iii) `std/` on disk + corpus off inclusion — DONE 2026-06**
  (`std/refined`, `std/sorted`; `refined_types_test`/`sorted_list_test` migrated;
  `import_std_bad`). A `std/X` path now resolves to a compiler-shipped source file
  at `checker/std/X.velve` — located relative to the loader module (via
  `import.meta.url`), so resolution is cwd-independent — and merges exactly like a
  `./` import (same `local` machinery). The §3.3 refined-type library and §3.2
  SortedList now live on disk ONCE each; the two corpus fixtures `import` them
  instead of inlining the whole module, with byte-identical `run` output, and the
  module's proof obligations are re-discharged standalone (the baseline now globs
  `checker/std`). Resolution is **additive**: a `std/X` is intercepted only when
  its source file exists, so the ambient stdlib namespaces with no source
  (`std/json`/`std/set`/`Math`/…) fall through to infer.ts untouched, and a typo'd
  `std/X` (no source, no ambient binding) still errors "cannot resolve import"
  (`import_std_bad`) rather than being swallowed. Baseline: 222→225 files, 0 CRASH,
  every previously-clean fixture still clean (the two migrated consumers unchanged
  at 0 err; the std libs 0 err standalone; `import_std_bad` 1 err). **Phase-C exit
  criterion met:** a green fixture imports `std/refined` (not includes it),
  baselines hold.
  **C1(iv) selective import visibility — DONE 2026-06**
  (`import_selective_test`/`import_selective_bad`/`import_selective_std_bad`; local
  `selective_lib`). A braced `import { a, b } from "./M"` now means **exactly** `a`
  and `b` are reachable from outside module `M`. The loader records the asked-for
  names per dependency file (union across all of that file's braced importers,
  collected BEFORE the diamond-dedup `continue` so every importer counts) and marks
  the merged `module` with `sealedExcept`; the resolver, after flattening the
  module's members, re-tags every non-listed fn/value binding `privateTo` the
  module — reusing the exact `privateTo`/`moduleStack` use-check that already seals
  `@private` constructors. The only new code on the check path is a kind branch in
  the message (`'x' is a member of module 'M' that was not imported`). What stays
  reachable: a module's own internal cross-references (it is on `moduleStack` when
  its bodies resolve — `quadruple` keeps calling the unexported `secretDouble`),
  and type NAMES (sealing is fn/value only; type names + their ctors keep the
  public / `@private` rules, so `refined_types_test` uses `Natural` un-imported).
  Escape hatches preserve old behavior: a bare (namespace) import seals nothing,
  and any file reached by a bare import is left fully visible. **Honest limit:** the
  exported surface is the union across a file's braced importers, not truly
  per-file — two files importing disjoint subsets would still see each other's
  picks; true per-file scoping waits on qualified module access. Baseline: 225→229
  files, 0 CRASH; diff over the pre-existing corpus is EMPTY (the migrated consumers
  stay clean — each imports every member it uses). New fixtures: green 0 err + runs
  `9`/`20`; both bad fixtures 1 err.

  **C1(v) std/units — the general unit constructor (B2(iii)) — DONE 2026-06**
  (`units_lib_test`/`units_lib_bad`; `checker/std/units.velve`). Closes the unit
  story deferred from B2(ii): every unit beyond `Duration` was params-only because
  there was no way to MAKE a unit value from a `Number`. **The one new primitive is
  literal defaulting** (numeric-dimension §5): a compile-time-CONSTANT number takes
  the unit its annotation names (`let d: Meters = 5`), implemented as
  `literalDefaultsToUnit` and applied at all three `let`-ascription sites (module
  `let`, block `SBind`, `try`-body `SBind`). It is guarded by `constEval` returning
  a number, so a **non-constant** `Number` still hits the explicit-casts-only
  mismatch (`let d: Meters = n` ⇒ "expected Meters, got Number") — the §4 rule
  holds. On that keystone, `std/units` is **pure Velve, zero further primitives**:
  `let oneMeter: Meters = 1` is the single defaulting site per dimension, and every
  constructor/extractor is the existing `*`/`/` algebra (`meters(n) = n * oneMeter`
  scales in, `inMeters(d) = d / oneMeter` divides out — design §4's conversion table
  made executable). Ships SI base (`Meters`/`Kilograms`/`Seconds`) + derived
  (`Velocity`/`Acceleration`/`Area`/`Force = kg*m/s^2`) with constructors,
  extractors, and derived relations (`speed`/`rate`/`force`) whose result dimension
  is COMPUTED by the algebra and checked against the annotation. Green imports a
  slice and runs a kinematics calc: 42 / 10 / 5 / 350. Bad pins three guardrail
  facets (non-constant Number, Velocity≠Meters, Seconds≠Meters) = 3 errors.
  **Honest gap (documented in design §5):** the sibling sized-type literal default
  (`let x: u8 = 300`) type-checks but is NOT range-checked at a bare `let`-ascription
  — that check fires at constructor/arg sites only; closing it is a small follow-on,
  not bundled here. Baseline 229→232, 0 CRASH, pre-existing corpus byte-identical.
  NOT a re-grade (Low-level already A− at B3(ii); held-back `+` is Phase D native IR).

  **C1(vi) LSP support — DONE 2026-06** (`checker/scripts/lsp_smoke.mjs`;
  `src/lsp.ts` made loader-aware + testable; `src/loader.ts`/`src/find.ts` small
  riders). The LSP server already shipped diagnostics / hover / go-to-definition /
  completion / semantic tokens, but **bypassed the loader** — it lowered the open
  buffer directly, so the whole C1 import machinery was dead in-editor (an
  `import { meters } from "std/units"` left `meters` undefined). Closed by routing
  analysis through `loadProgram(file, openDocs)`: a new optional `openDocs` map
  (abspath → live text) lets the open — possibly unsaved, possibly diskless — buffer
  override disk while every imported file still loads from disk, so imports resolve
  their transitive cone in-editor exactly as the CLI does. Riders, each earning its
  keep: `findExprAt` gained a `source` filter (the merged module now carries
  imported decls, so a cursor must not match an identically-placed expr in another
  file); go-to-definition returns the binding's true file via `span.source`, so a
  jump **crosses into** `std/units.velve`; diagnostics are scoped to the open file
  (`span.source === abs`) so a library's own errors don't smear onto the importer's
  lines; and the LSP now also surfaces the `arith`/`overflow` floors B2/B3 added
  (alongside the pre-existing nonzero/bounds floors — all conservative; the CLI's Z3
  verdict is authoritative and only ever removes them). The query logic was extracted
  into exported pure functions (`analyzeText`/`hoverAt`/`definitionAt`/
  `completionsAt`/`semanticTokensFor`) behind a main-module guard, so
  `scripts/lsp_smoke.mjs` drives them headless over in-memory buffers — 8 checks:
  imports resolve in-buffer (0 errors), hover `d : Meters`, same-file definition,
  **cross-file** definition into `std/units`, completion of imported names, semantic
  tokens for a `:idle` atom, and two error cases (a plain type error + an unresolvable
  import, each on the right line). A real stdio `initialize` handshake confirms the
  server still launches as `node dist/lsp.js --stdio`. Baseline 232→232 (the LSP is
  no `.velve` fixture; the loader/find edits are optional-param-guarded, so the CLI
  path is **byte-identical** — stash-rebuild-diff EMPTY), 0 CRASH. **Honest gaps
  (design §9):** no lazy per-symbol queries, debounce, incremental firewall reuse, or
  shared query cache yet — a `didChange` is a full re-analysis of the open program.
  NOT a graded north-star row (the board tracks language design, not tooling) → no
  re-grade. **C1 complete.**

- [x] 🟢 **Phase C2 — `if x is Ok(a)` payload binding + flow narrowing — DONE
  2026-06** (`is_narrow_test`/`is_narrow_bad`; `grammar.js` + `src/{lower,resolve,
  infer,eval,facts}.ts`). The `is` type-test gained an optional payload binder:
  `if x is Ok(a)` binds the matched constructor's payload by name on the success
  path of the `if`, and **only** there. The binder reuses the full machinery
  already in place — `checkPat`'s constructor-payload resolution (Result / Async /
  outcome / user ADT) types it, `matchPat` binds it at eval, `bindPat` scopes it —
  so the slice is mostly a new AST field (`TypeTest.binder`) wired through the five
  passes. Two facets ship green: **binding** (`if s is Circle(r)` → `r` is the
  Circle's radius, on a user ADT) and the **fact-env SEED** — `if checkBounds(xs,i)
  is Ok(j)` carries the return-gate witness onto `j`, so the licensed read `xs[j]`
  needs no guard, the `if`-form dual of A1's `match … | Ok(j) ->` seed (facts.ts).
  The guardrail (`is_narrow_bad`, 2 errors) pins the scope boundary that makes it
  sound: a reference to the binder in the else-branch or after the `if` is an
  unresolved name — you cannot read a payload that may not exist.

  **Grammar cost, honestly.** The glued payload `(` must lex as `token.immediate('(')`
  in expression position, so it inherently races `call` (`(x is Ok)(a)`) and every
  prefix/binary operator for the `is` boundary. Resolved by giving the binder
  alternative `postfix` static precedence (== `call`) with a positive **dynamic**
  precedence, plus declared conflicts (`type_test` × `call`/`unary_expr`/`drop`/`go`/
  `resume`/`lazy`/`await`/`binary_expr`) — so the binder wins exactly when a
  `(payload)` is present, and the no-binder `is` test keeps its `comparative`
  precedence and parses **identically** to before. Proven: the pre-existing corpus is
  **byte-identical** through the parser regen (stash-rebuild-diff EMPTY). Baseline
  232→234 (the two new fixtures), 0 CRASH; LSP smoke still 8/8. NOT a graded
  north-star row (flow narrowing is a control-flow ergonomic; the fact env it feeds
  is already A+ Type core) → no re-grade.

- [x] ✂️ **Phase C3 — convergence-cycle pre-flag — CUT 2026-06** (decision, not a
  slice; the refusal discipline of §4 applied to a planned feature). A static
  pre-flag would duplicate a check that already exists and is **strictly better
  placed**: the runtime `converge()` (eval.ts) resolves prop references in
  topological order over the concrete *(element instance, prop)* graph and rejects
  any cycle naming the offending edge — `converge_bad` pins it (*"convergence cycle:
  'width' on Box and Box reference each other"*). That precision needs the real
  tree; a static analysis lacks it, so it would be approximate in both directions
  (false-positive on a legal `next.P`/`prev.P` chain whose cycle the actual sibling
  count breaks; false-negative on tree-dependent cycles). `converge_bad` is itself
  such a tree-dependent cross-element cycle — so the recommendation's "unless a real
  fixture motivates it" test comes back empty. The sound home for this fault is the
  runtime pass, already shipped and tested. **With C1 complete, C2 done, and C3 cut,
  Phase C is closed** — next real work is Phase D (compiled backend).

- [x] 🟢 **Phase D0 — IR design — DONE 2026-06** (doc slice, like B1;
  `compiler-architecture-design.md` §11; endgame-plan §5). Revised the architecture
  note into the actual *contract* D1 builds against, honoring Decisions 2–3.
  **Fresh distinct Velve Core IR**, ~13 nodes, **ANF** (resolves the §10
  fresh-vs-annotated DECIDE). **OQ#4 answered: generators are a JS-*emitter* choice,
  not an IR primitive** — every effect lowers to one explicit `Perform { cap, op }`
  node (JS realizes it as a generator, native as a state machine, BEAM as a process);
  a generator IR node would bake a JS-ism into the neutral middle, violating
  Decision 3. CPS rejected (native/LLVM would undo it). The **erasure law** (§11.5):
  units / refinement predicates / error rows / effect rows / taint / totality all
  discharge at the AST→IR frontier and are absent below it; the **width tag is the
  lone survivor** — a representation choice deferred to the backend (dropped on JS,
  read by native/WASM), the concrete face of Decision 2's "one surface, two
  representations". Soundness is *witnessed, not asserted*: the runtime `Value` union
  (`value.ts`) already has no unit/refinement/width/row member, so eval is the
  standing proof the frontier is real — §11 only formalizes for the compiled path the
  erasure eval does for free. §11.4 tabulates 40+ AST forms → the 13; §11.6 anchors
  every surviving node to its `Value` counterpart (compiled output stays
  differential-testable). Hashing granularity DECIDED per-symbol. No code / no
  fixtures / SPEC untouched (the IR is compiler-internal, not language surface) / no
  graded row moves (planning, not a shipped capability). **Phase D is now open**;
  D1 = IR + compute-core JS emitter + the three-column (check/eval/compiled)
  differential harness.

- [x] 🟢 **Phase D1(i) — the compute spine compiles — DONE 2026-06** (first real
  backend code; `core.ts` + `emitjs.ts` + `compile`/`runc` CLI + `scripts/diff.mjs`;
  `compile_spine_test.velve` / `compile_frontier_test.velve`). The opening vertical
  slice of the §11.7 contract, end-to-end: AST → Velve Core (**ANF** lowering, the
  §11.3 datatypes) → JS, and a **three-column differential harness** (check / run-eval
  / run-compiled) over the whole corpus. Spine scope: single-clause defs, `Lit`/`Var`,
  arithmetic/comparison/equality `PrimOp`s, saturated `Call` to a def or whitelisted
  pure builtin, tail-`if` (incl. else-if ladders), `Do` blocks. The emitter's `$show`
  mirrors `display` and its operator table mirrors `evalBinOp`, so compiled stdout is
  **byte-identical** to eval. Anything outside the spine is refused **loudly** by
  `CompileUnsupported` (exit 2 → harness `unsupported`), never miscompiled — this is
  the backend-slice form of a `_bad` twin (no new *checker* rejection rule, so the
  guarantee is "refuse, never lie", asserted by the harness, and documented as an
  honest cadence deviation). Harness result: **15 match / 0 mismatch / 0 js-crash /
  116 unsupported / 100 check-fail / 5 eval-error** across 236 files. The **erasure
  law is now empirically witnessed**: the 15 matches include unit-carrying
  (`uom_test`, `std/units`), refinement-carrying (`refinement_compile_test`,
  `std/refined`), and totality-carrying (`proof_terminates_test`) programs — each
  compiles to JS that drops the judgment and computes identically. SPEC untouched (a
  compiled path observationally identical to eval is not a surface change); no graded
  row moves (the backend is partial). **Next: D1(ii)** — `Match` pattern compilation +
  ADT `Ctor`s + lists/records/tuples + closures (the heap-value core), still
  pre-effect.

- [x] 🟢 **Phase D1(ii) — scalar `match` compiles — DONE 2026-06** (`core.ts` Match
  lowering + the `Fail` IR node + `emitjs.ts` throw; `compile_match_test.velve`;
  frontier twin `compile_frontier_test.velve` repointed to constructor patterns).
  `Match` does **not** survive into the IR: it lowers *here* to the `If`/`Let`
  decision-spine (classic match compilation — subject named once, branches folded
  back-to-front into nested `If`s ending in `Fail`), so the backend never grows a
  pattern node. Scope: the **scalar** patterns — `PWild`/`PVar`/`PTyped` (irrefutable,
  optional bind) and `PLit` (an `==` test mirroring eval's strict `v === lit.value`) —
  plus guards (`| n if g`). `Fail` is a hard `throw` the `exhaust` pass proves
  unreachable on valid programs (witnessed, never differentially exercised). Subtlety
  paid down: `match n | n -> …` would emit `const n = n` (JS TDZ crash); the identity
  rebind is detected and skipped. **Honest slice split**: D1(i)'s "Next" folded all of
  `Match` + heap values into one slice; as built, scalar `match` shipped alone (pure
  control flow, no new value kinds) and the heap-value core slid to **D1(iii)**. Green
  fixture `compile_match_test.velve` compiles **byte-identically** to eval; the frontier
  twin moved from scalar `match` (now compiling) to **constructor destructuring**
  (`Ok(v)`/`Error(e)`), refused cleanly (`unsupported`, exit 2). Harness: **16 match /
  0 mismatch / 0 js-crash / 116 unsupported** across 237 files. SPEC untouched; no
  graded row moves (still partial). **Next: D1(iii)** — ADT `Ctor`s +
  constructor/tuple/record patterns + lists/records/tuples + closures (the heap-value
  core), still pre-effect.
- [x] 🟢 **Phase D1(iii) — tuples compile (heap-value core opens) — DONE 2026-06**
  (`core.ts` `Tuple`/`Proj` IR comps + `MatchStep[]` pattern compiler with `PTuple`;
  `emitjs.ts` `$tuple` runtime + `$show` `$t`-tag dispatch; `compile_tuple_test.velve`).
  The first HEAP value to clear all three differential columns. A tuple is the thinnest
  cut of the core — positional, fixed-arity, **no `type` decl or constructor-name
  resolution** (unlike Ctors). New: two IR computations (`Tuple` builds from atoms,
  `Proj` reads element *i*) and one runtime convention every later heap value reuses —
  heap values carry a `$t` tag (`$tuple(...) → {$t:"T", es}`) so `$show` reproduces
  value.ts `display`'s `(a, b)` exactly. The scalar pattern compiler was generalized to
  a flat `MatchStep[]` (ordered binds + truthy-tests); `PTuple` projects each slot and
  **recurses**, so nested tuples + fallible sub-patterns fold into the same `If`/`Let`
  spine (tuple shape itself is no test — arity is type-guaranteed). Known tradeoff:
  back-to-front folding duplicates the fall-through tail per branch (naive decision
  tree) — correct, differentially verified; join-point sharing is a later optimization.
  **Honest slice split (again)**: D1(iii) was forecast as the whole heap-value core; as
  built, **tuples shipped alone** and ctors/records/lists/closures slid forward. Green
  fixture `compile_tuple_test.velve` compiles **byte-identically** to eval (10 lines);
  the frontier twin `compile_frontier_test.velve` (constructor destructuring) is
  unchanged — still refused cleanly (exit 2), flips when ctors land. TAIL-position
  match only; destructuring `let`/params stay at the frontier. Harness: **17 match / 0
  mismatch / 0 js-crash / 116 unsupported** across 238 files. SPEC untouched; no graded
  row moves (still partial). **Next: D1(iv)** — ADT `Ctor`s + constructor patterns
  (flips the frontier twin), then records, lists, closures — still pre-effect.
- [x] 🟢 **Phase D1(iv) — ADT constructors compile (the frontier twin flips) — DONE
  2026-06** (`core.ts` `Ctor`/`CtorName`/`CtorPayload` IR comps + ctor registry +
  `PCtor` in the `MatchStep[]` compiler; `emitjs.ts` `$ctor` runtime + `$show` `$t:"C"`
  dispatch; `compile_ctor_test.velve`). The slice D1(iii)'s guardrail was waiting on.
  Constructors are now BUILT — applied (`Circle(2)`, `Ok(5)`) or nullary (`Point`,
  `None`) — and DESTRUCTURED via `PCtor`, including **nested** patterns and a ctor over
  a tuple payload (`Error(Rect((w, h)))`). Reuses tuples' `$t` scheme: `$ctor(name,
  payload) → {$t:"C", name, payload}` (nullary ⇒ `null`), so `$show` reproduces value.ts
  VCtor display — `Name(x)` or bare `Name`. Three IR comps: `Ctor` (build), `CtorName`
  (read tag; the test rides an existing `==` PrimOp), `CtorPayload` (read to
  bind/recurse). `PCtor` discriminates on the tag, then projects+recurses into the same
  spine (arity type-guaranteed ⇒ the tag test is the whole refutation; eval's redundant
  payload-null checks elided). Supported ctor names = the module's own `type` variants ∪
  prelude data ctors (Ok/Error/Some/None); a unary ctor used unapplied is refused as a
  first-class function. Green fixture `compile_ctor_test.velve` compiles
  **byte-identically** to eval (12 lines). The frontier twin `compile_frontier_test.velve`
  was repointed to build a **record** (`#{ x, y }`) and still refuses (exit 2). **Honest
  baseline movement**: enabling ctors also flipped the pre-existing
  `ctor_pattern_test.velve` from `unsupported` to `match` (the feature landing, not a
  regression). Harness: **19 match / 0 mismatch / 0 js-crash / 115 unsupported** across
  239 files. SPEC untouched; no graded row moves (still partial). **Next: D1(v)** —
  records (build + field read + `PRecord`), then lists, then closures — still pre-effect.

- [x] 🟢 **Phase D1(v) — records compile (the frontier twin flips again) — DONE 2026-06**
  (`core.ts` `Record`/`Field` IR comps + `PRecord` in the `MatchStep[]` compiler;
  `emitjs.ts` `$record` runtime + `$show` `$t:"R"` dispatch; `compile_record_test.velve`).
  The value D1(iv)'s guardrail was holding. Records are now BUILT — `#{ x: a, y: b }`,
  including `...spread` — FIELD-READ (`p.x`), and DESTRUCTURED via `PRecord`. Extends the
  `$t` scheme: `$record(fs) → {$t:"R", fs}` where `fs` is a plain object whose key-insertion
  order IS the display order, so `$show` reproduces value.ts VRecord display — `{ k: v, … }`,
  empty as `{  }`. The order is load-bearing: eval builds a `Map` (spread first, then
  explicit; a shadowing key updates **in place**, keeping its slot), and JS `{ ...base.fs, k }`
  matches exactly — so `#{ ...p, y: 99 }` displays its fields in the original order. Two IR
  comps: `Record` (build; optional spread atom + ordered fields) and `Field` (read). `PRecord`
  is pure projection like `PTuple` (no shape test — the checker guarantees the fields are
  present); the grammar's `record_pattern` is shorthand-only (`{ x, y }`), so each field binds
  a `PVar`. Green fixture `compile_record_test.velve` (build, field-read, spread+overwrite, a
  `PRecord` arm with a guard reading a bound field, a record field holding a ctor read via
  `.tag` then matched) compiles **byte-identically** to eval (9 lines). The frontier twin
  `compile_frontier_test.velve` was rolled to build a **list** (`[1, 2, 3]`) and still refuses
  (exit 2). Unlike D1(iv), **no** pre-existing corpus file flipped — the only new green is the
  fixture (the `&&` in an early draft of its guard was the short-circuit-operator frontier, not
  records; split into a nested `if` to keep the slice honest). Harness: **20 match / 0 mismatch
  / 0 js-crash / 115 unsupported** across 240 files. SPEC untouched; no graded row moves (still
  partial). **Next: D1(vi)** — lists (build + index/length + `PList`), then closures, then
  destructuring `let`/params — still pre-effect.

- [x] 🟢 **Phase D1(vi) — lists compile (the frontier twin flips again) — DONE 2026-06**
  (`core.ts` `List`/`Index` IR comps + `length`/`isEmpty` on the builtin whitelist;
  `emitjs.ts` `$list` runtime + `$show` `$t:"L"` dispatch + `length`/`isEmpty` impls;
  `compile_list_test.velve`). The value D1(v)'s guardrail was holding. Lists are now BUILT —
  `[a, b, …]`, including the empty `[]` — ELEMENT-READ (`xs[i]`), and MEASURED
  (`length`/`isEmpty`). Extends the `$t` scheme: `$list(...es) → {$t:"L", es}`, an array tagged
  so `$show` reproduces value.ts VList display — `[a, b, …]`, empty as `[]`, each element shown
  by the same `$show` so a list OF heap values nests (e.g. `[(1, 2), (3, 4)]`). Two IR comps:
  `List` (build; each element an atom) and `Index` (read element `i` — `.es[i]`). eval
  bounds-checks `xs[i]` at runtime (OOB is an eval-error in BOTH columns, never a miscompile);
  valid programs read in-bounds, so the column is byte-identical. Velve has **no list PATTERN**
  (`PList` does not exist in the grammar), so destructuring is by index/builtin — the `PList`
  forecast was a mis-recollection, corrected here. Green fixture `compile_list_test.velve`
  (build, empty list, element-read at literal/computed index, `length`, `isEmpty` on full and
  empty, a list of tuples, an inline list literal indexed) compiles **byte-identically** to
  eval (9 lines). The frontier twin `compile_frontier_test.velve` was rolled to bind a
  **closure** (`fn x -> x + 1`) and call it — the next unrepresented value — and still refuses
  (exit 2). Unlike D1(v), an **honest baseline movement**: one pre-existing corpus file flipped,
  `dependent_test.velve` — a dependently-typed program (`InBounds(length(xs))`, `NonEmpty(a)`)
  whose refinement/dependent machinery erases upstream (the erasure law), leaving exactly the
  list build + index + length spine the compiler now lowers; it compiles byte-identically
  (`a=10 b=30 c=1 d=5`). Harness: **22 match / 0 mismatch / 0 js-crash / 114 unsupported** across
  241 files (+2 match = fixture + flip, −1 unsupported = the flip left; the frontier stayed
  unsupported, list→closure). SPEC untouched; no graded row moves (still partial). **Next:
  D1(vii)** — closures-as-values (lambda lowering + capture), then destructuring `let`/params —
  still pre-effect.

- [x] 🟢 **Phase D1(vii) — closures compile (the frontier twin flips again) — DONE 2026-06**
  (`core.ts` `Lambda` IR comp + `normComp` `Lambda` case + one `Call`-guard clause for
  local-scope closure calls; `emitjs.ts` `Lambda` → JS arrow + `$show` `typeof === "function"`
  → `<fn:<lambda>>`; `compile_closure_test.velve`). The value D1(vi)'s guardrail was holding.
  Closures are now FIRST-CLASS: a `fn x -> …` lowers to a JS arrow function that closes over its
  enclosing `const`s by lexical scope, exactly as eval's single-clause VFn closes over its
  captured `env` — no explicit capture list computed. A closure is BOUND by `let`, RETURNED from
  a `def` (capturing that def's param — `def adder(n) -> fn x -> x + n`), PASSED as an argument,
  written INLINE at a call site, CALLED through a local name, and DISPLAYED `<fn:<lambda>>`
  (value.ts VFn display). One IR comp: `Lambda` (params + a body lowered in TAIL position with
  the params in scope); **no `$t` tag** — the arrow is callable directly, and `$show` maps any
  `typeof === "function"` to `<fn:<lambda>>` (the only functions reaching `$show` are lowered
  lambdas — user `def`s are not first-class values on the pure spine yet). The `Call` guard
  gained one clause: a name in local scope is a closure value, called with identical `fn(args)`
  syntax — JS lexical scope shadows a same-named def/builtin as eval's binding lookup does. A
  free name in a lambda body (a self-referential `let f = fn … -> f(…)`) is out of scope here
  exactly as it is absent from eval's capture env, so it refuses identically. Green fixture
  `compile_closure_test.velve` (let-bound lambda, returned closure with capture, closure-as-arg,
  inline lambda, printed closure) compiles **byte-identically** to eval (`6 / 17 / 101 / 42 /
  <fn:<lambda>>`). The frontier twin `compile_frontier_test.velve` was rolled to a **first-class
  `def` reference** (`let f = double` — naming a def without calling it; eval has it as a VFn in
  the env, the compiler refuses it as a free variable) — the next unrepresented value — and still
  refuses (exit 2). Destructuring `let`/params from the prior forecast are **syntax errors** —
  neither exists in the grammar (like `PList`) — so the frontier rolled to def references; the
  mis-recollection is corrected here. Harness: **23 match / 0 mismatch / 0 js-crash / 114
  unsupported** across 242 files (+1 match = fixture; unsupported unchanged — no corpus flip, the
  frontier stayed unsupported, closure→def-reference). SPEC untouched; no graded row moves (still
  partial). **Next: D1(viii)** — first-class `def` references (eta-expansion to a value) — still
  pre-effect.

- [x] 🟢 **Phase D1(viii) — first-class `def` references compile (the frontier twin flips again) —
  DONE 2026-06** (`core.ts` `userFns` branch in the `Var` normalizer + `norm` fast-path; `emitjs.ts`
  `$lam` identity wrapper for lambdas + `$show` `.name`-based function display; `compile_defref_test.velve`).
  The value D1(vii)'s guardrail was holding. A named `def` mentioned WITHOUT calling it is now a
  VALUE: eval has it for free (a top-level def is a VFn in the env), and the compiled def is a hoisted
  JS `function` — itself a value — so the reference lowers to a bare `Var` atom naming it, **NO
  eta-expansion wrapper and no capture** (the JS-backend shortcut the design note flagged; a native
  backend would eta-expand to a closure instead). It is BOUND by `let`, PASSED to a higher-order
  function, RETURNED from a `def` (both branches of an `if` being def references), and CALLED like any
  closure. **The display had to become faithful:** eval shows a named function `<fn:name>` but a lambda
  `<fn:<lambda>>`, so `$show` (hard-coded to `<fn:<lambda>>` for every function since D1(vii)) now reads
  the JS function's own `.name` — empty ⇒ `<lambda>`, set ⇒ the def's name. To keep lambdas anonymous
  (a let-bound arrow would otherwise inherit its binding's name via JS name inference) every lambda is
  wrapped in an identity `$lam(…)` so it sits in argument position and JS infers no `.name`. Green
  `compile_defref_test` (def let-bound and called, def passed to a HOF, def returned from a def, def
  printed) byte-identical to eval (`10 / 42 / 30 / 12 / <fn:double>`). The frontier twin
  `compile_frontier_test` ROLLED def-reference→**builtin reference** (`let f = abs` — eval has it as a
  VBuiltin, the first-class path admits user defs only, so it refuses `abs` as a free variable) — next
  unrepresented value — still exit 2. **No pre-existing corpus file flipped** (`fn_type_test` passes
  defs as values too but also uses string interpolation, so it stays unsupported). Harness: **24 match
  / 0 mismatch / 0 js-crash / 114 unsupported** across 243 files (+1 match = fixture; unsupported
  unchanged). SPEC untouched; no graded row moves (still partial). **Next: D1(ix)** — first-class
  BUILTIN references (the same value-ification for the prelude functions) — still pre-effect.

- [x] 🟢 **Phase D1(ix) — first-class BUILTIN references compile (the frontier twin flips again) —
  DONE 2026-06** (`core.ts` `BUILTINS` branch in the `Var` normalizer + `norm` fast-path; `emitjs.ts`
  `int` impl wrapped `(x) => Math.trunc(x)` so its const `.name` == "int"; `compile_builtinref_test.velve`).
  The value D1(viii)'s guardrail was holding. A whitelisted builtin mentioned WITHOUT calling it is now
  a value, exactly as a user `def` is: eval has it as a VBuiltin in the env, the compiled builtin is an
  inlined prelude `const` (itself a value), so the reference lowers to a bare `Var` atom naming it — a
  two-line echo of D1(viii). **One display trap paid down:** `$show` reads a function's `.name`, and
  every prelude impl's const already carries its Velve name EXCEPT `int`, whose impl was the bare native
  `Math.trunc` (`.name === "trunc"`). A printed `int` reference would have shown `<fn:trunc>` against
  eval's `<fn:int>`, so the impl is now wrapped `(x) => Math.trunc(x)` — an assigned arrow whose const
  infers `.name === "int"` — behaviourally identical for call sites, faithful for the value. Green
  `compile_builtinref_test` (builtin let-bound+called, builtin passed to a HOF, `abs`/`int`/`floor`
  printed) byte-identical to eval (`9 / 4 / 7 / <fn:abs> / <fn:int> / <fn:floor>`). The frontier twin
  `compile_frontier_test` ROLLED builtin-reference→**short-circuit `&&`** (`true && false` — eval is
  lazy in the right operand; the spine lowers only strict PrimOps, and `&&`/`||`/`|>` need control flow
  the lowerer does not yet emit) — next unrepresented form — still exit 2. **No pre-existing corpus file
  flipped.** Harness: **25 match / 0 mismatch / 0 js-crash / 114 unsupported** across 244 files (+1 match
  = fixture; unsupported unchanged; the `int` rewrite perturbed no `int`-calling program). SPEC
  untouched; no graded row moves (still partial). **Next: D1(x)** — short-circuit `&&`/`||` (lowered to a
  lazy `if`), then `|>` — still pre-effect.

- [x] 🟢 **Phase D1(x) — short-circuit `&&`/`||` compile (the frontier twin flips again) — DONE 2026-06**
  (`core.ts` `Cond` IR comp + `&&`/`||` lowering in `normComp` BinOp; `emitjs.ts` `Cond`→JS ternary +
  `exprValue` IIFE helper; `compile_shortcircuit_test.velve`). The value D1(ix)'s guardrail was holding.
  `&&`/`||` are now lowered and crucially **LAZY** in the right operand (eval returns false/true without
  evaluating the right when the left decides it), so they are NOT strict PrimOps: `a && b` ≡ `if a then b
  else false`, `a || b` ≡ `if a then true else b`. The new IR comp `Cond` (value-producing conditional)
  carries the left as an atom + each branch as a value-`IRExpr`; emitjs emits a **JS ternary** (itself
  short-circuit) with a non-trivial branch wrapped in an arrow-IIFE, so the right operand's spine runs
  ONLY when control reaches that branch. `Cond` is an ordinary comp ⇒ a `&&` nested in an
  argument/operand composes for free. **Load-bearing laziness test:** `guard(n) = n != 0 && 100 / n > 9`
  compiles so the division sits INSIDE the ternary then-branch — `guard(0)` prints `false` with no
  div-by-zero, byte-identical to eval (eager ANF evaluation would have diverged). Green
  `compile_shortcircuit_test` (both/either, the divide-guard at 0/5/20, chained `a && b || c`, a
  `&&`-value passed as an argument) byte-identical to eval (9 lines). **A forecast corrected:** pipe `|>`
  was NEVER a frontier — it desugars to a saturated `Call` upstream (`5 |> double` ≡ `double(5)`) and has
  compiled since D1(i); verified. So the frontier twin `compile_frontier_test` ROLLED
  short-circuit→**non-tail `if` as a value** (`let x = if …` — the lowerer handles `if` in tail position
  only; as a `let` RHS it reaches `normComp`'s default and refuses) — next unrepresented form — still
  exit 2. **No pre-existing corpus file flipped.** Harness: **26 match / 0 mismatch / 0 js-crash / 114
  unsupported** across 245 files (+1 match = fixture; unsupported unchanged). SPEC untouched; no graded
  row moves (still partial). **Next: D1(xi)** — non-tail `if`/`match` as a value (reusing `Cond`) — still
  pre-effect.

- [x] 🟢 **Phase D1(xi) — non-tail `if` as a value compiles (the frontier twin flips again) — DONE
  2026-06** (`core.ts` one `If` case in `normComp` → `Cond`; `compile_ifvalue_test.velve`). The value
  D1(x)'s guardrail was holding. An `if` whose value is CONSUMED — bound by `let`, nested in an
  arithmetic expression, written as a function argument, or chained as an else-if ladder — now lowers,
  reusing the `Cond` value-producing conditional from D1(x): cond normalizes to an atom, each branch to a
  value-`IRExpr` emitted as a ternary arm (IIFE-wrapped only when the branch has its own spine). This is
  the value-position mirror of the tail-position `if` `tail()` already lowered — a one-case addition (a
  branchless `if` yields Unit, as in `tail`). Green `compile_ifvalue_test` (if-value by `let`, nested in
  `1 + (if …)`, as an `abs2(if …)` argument, a three-way `grade` else-if chain) byte-identical to eval
  (`10 / 6 / 7 / A / B / C`). The frontier twin `compile_frontier_test` ROLLED if-value→**non-tail
  `match` as a value** (`let s = match …` — the lowerer compiles `match` in tail position only; as a
  `let` RHS it reaches `normComp`'s default and refuses) — next unrepresented form — still exit 2. **No
  pre-existing corpus file flipped.** Harness: **27 match / 0 mismatch / 0 js-crash / 114 unsupported**
  across 246 files (+1 match = fixture; unsupported unchanged). SPEC untouched; no graded row moves
  (still partial). **Next: D1(xii)** — non-tail `match` as a value (reify the decision-spine as an IIFE)
  — still pre-effect.

- [x] 🟢 **Phase D1(xii) — non-tail `match` as a value compiles (the frontier twin flips again) — DONE
  2026-06** (`core.ts` `Block` IR comp + one `Match` case in `normComp`; `emitjs.ts` `Block`→`exprValue`
  IIFE; `compile_matchvalue_test.velve`). The value D1(xi)'s guardrail was holding. A `match` whose value
  is CONSUMED (bound by `let`, a def body, or feeding an expression) now lowers: `matchE` already builds
  the `If`/`Let`/`Fail` decision-spine, and in value position that whole spine is reified by the new
  `Block` comp — emitjs wraps it in an arrow-IIFE returning the taken arm's value (the n-way
  generalization of what `Cond` does for one binary branch). `Block` is an ordinary comp ⇒ a value-`match`
  composes wherever a value is wanted. Green `compile_matchvalue_test` (scalar `match`-value by `let`, a
  ctor `match` binding its payload, a mid-def `let a = match …`, a `match`-value reaching arithmetic via a
  def) byte-identical to eval (`many / 300 / 16 / round / 37`). (Velve `match` arms are block-form, so a
  value `match` sits as a `let` RHS or def body, not inline inside a larger expression — a parse limit,
  not a compiler one.) The frontier twin `compile_frontier_test` ROLLED match-value→**multi-clause `def`**
  (`fib(0)`/`fib(1)`/`fib(n)` — eval dispatches across clauses; the lowerer emits one JS `function` per
  `def` and refuses >1 clause) — next unrepresented form — still exit 2. (String interpolation `"{x}"`
  confirmed never a frontier — desugars to `++` concat upstream, like `|>`.) **No pre-existing corpus
  file flipped.** Harness: **28 match / 0 mismatch / 0 js-crash / 114 unsupported** across 247 files (+1
  match = fixture; unsupported unchanged). SPEC untouched; no graded row moves (still partial). **Next:
  D1(xiii)** — multi-clause `def`s (clause dispatch as a `match` on the parameter tuple) — still pre-effect.

- [x] 🟢 **Phase D1(xiii) — multi-clause `def`s compile (honest baseline movement, 4 corpus flips) — DONE
  2026-06** (`core.ts` `clauses`/`clause` dispatch methods + multi-clause branch in `lowerModule`;
  `compile_multiclause_test.velve`). The value D1(xii)'s guardrail was holding. A `def` with >1 clause now
  compiles. eval (applyFn/runClause) dispatches by trying each clause in order and taking the first whose
  PARAM PATTERNS all match — so clause dispatch is exactly a `match` whose subject is the parameter tuple.
  The compiler emits ONE JS `function` per def over fresh param names `_a0..`, folding each clause's
  parameter patterns (reusing the same `MatchStep[]`/`pattern()` machinery `match` uses) into an `If`/`Let`
  chain that falls through to the next clause, the last falling to `Fail` (eval's non-exhaustive error,
  proven unreachable). Dispatch is **pattern-only**, matching eval: `where_`/`using` clause-bindings run
  only AFTER a clause is chosen and a failure THROWS rather than falling through — body bindings, not
  guards — so a clause carrying them is refused (the frontier the single-clause path already leaves them
  at). Green `compile_multiclause_test` (single-arg literal dispatch `fib`, multi-arg dispatch
  `ack`/Ackermann, fixed+bound `sign`) byte-identical to eval (`55 / 9 / 61 / zero / neg / pos`). (Velve
  clause params are literal/binder only, not ctor/tuple — a parse limit — so payload destructuring stays a
  body `match`.) **Honest baseline movement (like D1(vi)):** FOUR pre-existing corpus files flipped
  `unsupported`→`match` — `clause_heads_test`/`constfold_total_test`/`literal_param_test`/`vocab_cleanup_test`,
  all multi-clause programs the spine now lowers, each verified byte-identical. The frontier twin
  `compile_frontier_test` ROLLED multi-clause→**reassignment** (`let mut x = 1; x = x + 5` — the spine
  lowers `let` to a `const`; `block`'s `SBind` refuses a reassigning bind) — next unrepresented form —
  still exit 2. Harness: **33 match / 0 mismatch / 0 js-crash / 110 unsupported** across 248 files (+5
  match = fixture + 4 flips, −4 unsupported = the flips left; frontier stayed unsupported). SPEC untouched;
  no graded row moves (still partial). **Next: D1(xiv)** — reassignment / mutable `let` (a JS `let` +
  assignment) — still pre-effect.

- [x] 🟢 **Phase D1(xiv) — reassignment of a `mut` binding compiles (1 corpus flip) — DONE 2026-06**
  (`core.ts` `mut` flag on IR `Let` + new `Assign` IR statement + reassignment branch in `block`'s
  `SBind`; `emitjs.ts` `Let` mut→`let`/`const` + `Assign` emit; `compile_reassign_test.velve`). The value
  D1(xiii)'s guardrail was holding. A mutable binding and its reassignment now lower: eval mutates the
  existing binding (env.set) and yields Unit, so a `let mut x = v` lowers to a reassignable JS `let` (the
  new `mut` flag, `const` otherwise) and a bare `x = e` lowers to the new `Assign` statement (emit
  `x = e;`, yielding Unit via the continuation). Only a simple variable already in scope reaches the
  reassignment path — a field/index target is a separate `SAssign` (still frontier). Green
  `compile_reassign_test` (numeric accumulator reassigned twice each reading its old value, a `++` string
  accumulator, a reassignment from a conditional value, repeated decrement) byte-identical to eval
  (`12 / abc / 105 / 7`). **Honest baseline movement:** ONE pre-existing corpus file flipped
  `unsupported`→`match` — `move_ok` (a `mut` Copy-scalar rebound/reassigned in place — the move-semantics
  test, whose affine machinery erases on the JS tier where `mut` is a plain reassignable binding),
  verified byte-identical. The frontier twin `compile_frontier_test` ROLLED reassignment→**atom literal**
  (`:red` — `lowerLit` refuses it; needs a `$atom`-tagged runtime value whose `$show` reproduces
  `:name`) — next unrepresented form — still exit 2. Harness: **35 match / 0 mismatch / 0 js-crash / 109
  unsupported** across 249 files (+2 match = fixture + flip, −1 unsupported = the flip left; frontier
  stayed unsupported). SPEC untouched; no graded row moves (still partial). **Next: D1(xv)** — atom
  literals (`$atom`-tagged value, `:name` display) — still pre-effect.

---

## 4. Features to consider **deleting** (the refusal discipline, applied to syntax)

SPEC §4.0's "ship exactly one primitive per genuinely-distinct concept" is the
best thing in the document. The same razor, applied to the surface:

- [x] 🔴 **Curried juxtaposition** `add 1 2` — **DONE**, covered above (§2.1). One
  application form (value-level), grammar-removed in phase 1, docs reconciled this turn.
- [ ] 🔴 **C-style ternary** `c ? a : b` — covered above (§2.2). Its removal is
  what makes `?` unambiguous.
- [x] 🟡 **`pipe` block** — it is literally documented as "the point-free `|>`
  chain as a block," i.e. a second spelling of an existing feature, plus a new
  magic identifier (`ret`). Delete; multiline `|>` already works. **Already
  DONE** (stale checkbox, reconciled 2026-06): removed in edition 2026.6 with
  a fix-it ("use a multiline `|>` chain"), deprecation warning in the baseline
  edition — `pipe_block_2026_1` / `pipe_chain_2026_6` fixtures prove both
  halves of the lifecycle.
- [ ] 🟡 **The `%` sigil** in `for` — covered above (§2.5).
- [ ] 🟡 **Binding-form triplication**: bare `x = 5`, `const x = 5`, `let x = 5`
  are three spellings of "immutable binding" with a scoping nuance most users
  will never learn. Recommend: `x = 5` (and `mut x = 5`) as the one form;
  keep `let` only if block-scoping genuinely differs, and then *show* the
  difference in the SPEC, or cut it.
- [ ] 🟢 **`Char`** — with `s[i]` already yielding a one-char `String` by
  design, `Char` has no visible role in any example or fixture. Cut it until a
  use case appears (rule of three).
- [ ] 🟢 Finish removing **`saga`** (the alias is fine; the *aspirational
  examples still using it* are not — `examples/checkout.velve` showcases the
  deprecated form).

## 5. Features to consider **adding**

- [ ] 🔴 **Adopt the editions system now** (SPEC §17), before 0.6 — several
  items above (binding forms, ternary removal, record `=`) are edition-shaped
  breaks. The proposal is already correct (superset grammar, edition-gated
  semantics); it just needs to exist.
- [x] ✅ **Multi-clause head exhaustiveness** (§14) — DONE, and **always-on as
  of 2026-06** (`vocab_cleanup_test`/`_bad`): a clause-head gap is a hard error
  in every edition like match exhaustiveness, no `proofs: [exhaustive]` or
  edition gate needed. The flagship guarantee is no longer silently lost.
- [ ] 🟡 **`animated` modifier (pillars 1–2 + motion policy)** — the design note
  is implementation-ready and it is the single most differentiated feature in
  the deck ("motion you can't write inaccessibly"). Prioritize after `frames`.
- [ ] 🟡 A minimal **trait/constraint story**: `where a: Comparable` and the
  `Interpolate` built-in set already *are* typeclass constraints — two of them,
  unnamed. Acknowledge the mechanism (compiler-known sets now, user traits
  later) in the SPEC so users have a mental model for why `sort` works.
- [ ] 🟢 **Spread-conflict rule**: define `f(a=1, ...rec)` resolution order
  (last-wins vs error). Currently unspecified and a guaranteed pitfall.
- [ ] 🟢 **`@debug` causal tracing** (§16) — keep on the roadmap; the
  deterministic scheduler + journals make it cheap, and it compounds the
  debuggability story that `@interaction` starts.
- [x] 🟡 **Free-positioned legibility as proof** (`Canvas`/SVG; design written
  2026-06, `docs/svg-legibility-design.md`): text unreadable by overlap or by
  contrast-against-what's-actually-behind-it becomes a *check error* —
  disjointness + per-region APCA over the composited scene, constEval-folded
  when static; MaxSMT placement repair as the opt-in synthesis tier (first
  concrete client of the north-star §3 Z3 floor); `legibleOn` is the
  color-axis repair. Rule: the free-position form ships only *together with*
  its obligation (S0+S1 as one slice) — flow layouts stay the structural
  default where overlap is inexpressible. Dynamic text requires a declared
  bound in v1 ("impossible by construction" must not be a lie).
  **S0+S1 BUILT 2026-06** (SPEC §11.1.2, `canvas_legible_test`/`_bad`):
  Canvas + `at=(x, y)` (Canvas-parent-only, paint order = child order →
  position:relative/absolute in html), and the static proof — opt-in by
  declaring the `Legible` refinement (the OnSurface pattern; its predicate
  is the threshold, `surface` binds per region): (A) text-pair disjointness
  + fill-above-text occlusion, (B) per-region APCA via exact box bisection
  on covering fill edges, topmost-solid-fill compositing. When the proof is
  active, unfoldable geometry is a could-not-prove ERROR, not a skip. The
  S0 dig found and fixed a substrate bug: paren-form elements' indented
  children parsed as SIBLINGS (the GLR preferred call+statements; the
  2026.6 form silently rendered childless trees) — fixed with dynamic
  precedence on the children-bearing element branch; zero corpus baseline
  changes. Residuals: ~~bare CALL children (`card()`) still parse as
  siblings~~ **closed 2026-06** — `call_child` grammar form (SPEC §11.1,
  `call_child_test`/`_bad`): a bare lowercase component call is a real
  child; resolves/type-checks/effect-checks like a call anywhere;
  theme_root_test un-flattened (its `action()` now also PAINTS the accent
  it proves against — the flattening had hidden that the proof surface was
  never painted). Zero baseline changes — even the new fixtures score
  identically under the old parser (statements vs children hit the same
  position-independent checks). Still unbuilt: S2 font metrics, S3
  alpha/gradients, S4 dynamic-text bounds, S5 MaxSMT repair.

## 6. Spec/example hygiene (cheap, do soon)

- [ ] 🔴 Add a **"What's built" ✅/❌ table** at the top of SPEC.md and each
  design doc. The scan repeatedly found locked-vs-deferred confusion
  (call-syntax decision 3 "locked" vs status "deferred"; multitarget gating
  claims vs blocks-design's "not enforced").
- [ ] 🔴 Make `examples/` type-check or move them to `docs/sketches/`. They are
  the first code a newcomer reads, and today they contradict the SPEC (space-
  form constructor calls, deprecated `saga`, unimplemented gpu/audio imports,
  `<-` binding that appears nowhere in the SPEC's binding section).
- [ ] 🟡 Show refinement types *in use* in at least one aspirational example —
  `taskflow.velve` defines `ValidAge` and never uses it; the flagship feature
  has no flagship demo.
- [ ] 🟡 Document that store **message constructors are Capitalized** in the
  §3.1 naming table (currently inferred from examples only).
- [ ] 🟡 Document the implicit-match rule in machine/saga step bodies in §4.2
  prose ("a call followed by `|` branches matches its result — no `match`
  keyword inside steps").
- [ ] 🟢 SPEC §0 still says "type checker implementation … checker pending";
  §15 says implemented. Sweep stale status lines.
- [ ] 🟢 Drop the §15.3 README claim that contrast uses WCAG — `std/color` uses
  APCA; the README's uiModel sample prints "WCAG contrast 21.0:1". Pick one
  metric in user-facing text.

---

## 7. What NOT to change (scanned, deliberately endorsed)

These came up in review and survived scrutiny — recording them so they aren't
relitigated:

- **The four-primitive state taxonomy + `persisted` modifier** and its refusal
  discipline (§4.0). Best-in-class explanation; keep the table.
- **Refinements transparent to base** with compile-time constant folding and
  explicit `T.parse` at runtime boundaries. Right ergonomics, honest fallback.
- **Taint at parse, not transport** (§5.3/§12). The same-decoder-everywhere
  consequence is the proof it's the right cut.
- **No-Maybe** (absence = named failure) — keep, but fix the error-type
  stringliness (§3.5).
- **Motion-policy chokepoint** and the VR-inversion argument (animated doc §5).
- **Footprint = `mut` params** + read/write asymmetry (interaction doc §3–4).
  No bookkeeping, fails safe — implement as specced.
- **Duration as a dimension** — generalize it (§3.4) rather than changing it.
- **Indentation blocks with no `do`**, scanner-based continuations, `|>`
  ergonomics, multi-clause heads, store `state/messages/pub` shape — all read
  well in fixtures; the examples-reviewer rated pipes and send/ask 5/5.
