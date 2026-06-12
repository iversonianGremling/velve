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
| Type system core (HM + refinements + dependent) | **A** *(2026-06)* | TS, Elm, F#, Liquid Haskell | Refinements-as-transparent-base with free constant-folding is genuinely better ergonomics than all four; conservative skip keeps it honest. **A−→A re-graded 2026-06** (north-star §1 + §3.6): the row's named lever shipped — **§5.1 constEval widening** (`constfold_total_test`/`_bad`): the folder now *executes* `@total` refinement predicates at check time (fuel-bounded, decidable-pattern clause dispatch, bails on anything undecidable), so the skip is opt-out-able per predicate — mark it `@total` and `half(3)` against `EvenNum = Number where isEven(value)` is a compile error that was previously accepted *and ran unchecked* (runtime enforcement is `T.parse` only). Remaining → A+: refined-type library (gated on module-private ctors — a language change) + Tier-2 Z3. |
| UI / styling | **A** *(2026.6)* | React+CSS, Elm, SwiftUI | Typed props, context-validity (`gap` on non-flex = error), real units, and **accessibility-as-proof** — an unreadable `color` on its resolved background now *fails to compile* (APCA Lc, opt-in `OnSurface`), not just a linter note — beat CSS's silent no-ops. The **element/call syntax duality is now closed** (§2.1, PLAN §5b): elements use the unified paren-form `Text("hi", size=12)` (space-form deprecated→error in 2026.6), proven by green `element_paren_test`. (Responsive shipped end-to-end 2026-06; the only design-only UI-adjacent item left is `inputmap`, an event/input concern — see the event/state row §3.2. Residual §2.1 tail: inline-handler/spread props in paren-form; value juxtaposition is now fully removed.) The **theme system is now COMPLETE (4/4)**: typed `Surface` tokens, the `using` clause, a `Theme` record whose roles are *derived* via `std/color` and folded into the contrast proof at check time (`std/color`'s first consumer), and — as of Slice 4 — `theme` as a built-in **read-only reactive root** that is APCA-proven against at check time *and* swappable at runtime (`setTheme`), acyclic by construction (a `theme.*` read adds no convergence edge; container-query feedback is rejected by the existing §6.2 cycle-checker). Accessibility-as-proof now fires on token, `using`-surface, computed, **and live-root** colours, not just inline hex. And as of 2026-06 **responsive is built end-to-end** (§9.2–9.4): closed `Breakpoint` variant, `Clamp` band, the read-only `viewport` root, the `responsive | …` keyword, and now **prop-site auto-collapse** — a `Responsive(Length)` (`Breakpoint -> Length`) handed directly to a `Length` prop and collapsed against the live `viewport.breakpoint`, with `setViewport` re-collapsing on swap (the viewport sibling of `setTheme`). **Now A** (the row's prior A− hold was "responsive/inputmap design-only"; responsive is now shipped, and `inputmap` is an input/event-handling item tracked in the event/state row §3.2, not UI styling). Residual UI-styling polish, not pillars: compile-time (vs runtime) convergence-cycle detection (§3.1) and the §2.1 inline-handler/spread-prop tail. |
| Event handling / state | **A** *(2026-06)* | Elm, Redux, Rx, XState, Erlang/OTP | The four-primitive taxonomy (store/machine/stream/transaction + `persisted`) with a "what do I reach for" table is the best-explained state story in any draft language I know. `machine … persisted` + journal + `resume` is XState+Temporal in one construct. **Both named gaps closed by green fixtures (2026-06):** per-stream backpressure (`drop`/`buffer N`/`block` at decl site, `stream_policy_test`) and `await`→step-goto in machine steps (`machine_await_test` — machines drain streams idiomatically now). Re-graded A− → **A**. The `inputmap` **core is now built** (2026-06, SPEC §10.5, `inputmap_test`/`_bad`): the typed pattern-match input table over a stream, with conflict analysis ("bound twice"/"shadowed") and the drain-loop runtime — plus the **`Inputmap` type and `help(map)` derived data** (`inputmap_help_test`/`_bad`): the auto-help table is queryable, check-time-typed data — plus **`++` layering** (`inputmap_layer_test`/`_bad`): maps are values, `default ++ userOverrides` works, cross-stream layering is a check error — plus **chord-refinement literals** (`inputmap_chord_test`/`_bad`): a typo'd chord pattern is a check-time error at every match site, via the literal-pattern refinement fold — plus **`keymap` sugar** (`keymap_test`/`_bad`). Residual for A→A+: the remaining inputmap *breadth* — std `Key` device library + physical-key prefix, focus-zone scoping, the *rendered* overlay element (store messages dispatch synchronously today, so streams are the only queue and they now have policies). |
| Error handling | **A+** *(2026-06)* | Rust `?`, Zig, Go | `?`/`?:`/`try`/`retry` cover the space well; the whitespace-keyed `?` (spaced = ternary vs glued = propagate, §2.2) — the draft's worst readability decision — is **gone from edition 2026.6**: the ternary was deleted in favour of `if c then a else b`, so `?` now carries one glued meaning. **Named error ADTs shipped 2026-06** (§3.5, SPEC §2.6, `error_adt_test`/`_bad`): prelude `ParseError { expected, got, detail }` from `T.parse`/`parseNumber`/`Json.parse`; stringly error use is a check error; domain-ADT convention documented. **A→A+ shipped 2026-06: inferred error rows v1** (north-star §4, SPEC §2.13, `error_rows{,_match}_test`/`_bad`) — `Result T _` infers the raised ctor set with zero threading, named-ADT pins check inclusion (escapees listed), rows directly matchable with exhaustiveness over the ACTUAL raised set ("can never match" included). Residual: S3 polish; row variables are v2 (effect-A+). |
| Low-level | **B−** | Rust, Zig | Ptr/regions/outlives/move tracking are real and end-to-end. But unified `Number` vs. planned sized types vs. `Duration` dimensions vs. `Px` units = four numeric stories that haven't met each other (§3.4). `std/low`/gpu/audio are sketches. |
| Games / intensive interactive | **C+** (today) / **A−** (as designed) | Unity C#, Bevy ECS, Pony | `docs/interaction-model-design.md` (footprint = `mut` params, capability-keyed dispatch, `@interaction`/`@confined`) is a credible, novel answer to ECS — but nothing of it is implemented, there is no frame clock, and a tree-walking interpreter can't hold 60fps. The claim depends on the compiled target. |
| Animation | **C** (today) / **A** (as designed) | CSS, Framer Motion, SwiftUI | The `animated` modifier + mandatory motion-policy chokepoint ("motion you can't write inaccessibly") is a real differentiator no shipping system has. Entirely unimplemented; depends on `frames` + reconciler work. |
| Security model | **A+** *(2026-06)* | everything mainstream | Taint-at-parse (not at transport) is the right boundary and well-argued. `Effect` capability enforcement is real end-to-end (§3.6 closed): direct calls + HOF laundering + effect tails + the effect-typed builtin surface (SPEC §12.5 — `setTheme`/`setViewport` `[ui]`, `externSource`/network `[io]`; `print`/`sleep` decided-ambient). E2 user-spelled effect rows shipped (2026-06, `..e` — user HOFs get builtin-grade per-call precision); ascription effect-coverage shipped (2026-06 — fn-type ascriptions can't erase rows). **Proof-gradient slice 1 shipped (2026-06): Tier-1 `@total`** (SPEC §12.6, `total_test`/`_bad`) — structural decrease + the downward call gate, effect enforcement's dual. **Proof-gradient slice 2 shipped (2026-06): the `Proof [...]` module scope** (SPEC §12.7, `proof_scope_test`/`_bad`) — `proofs: [total, exhaustive]` rides `capabilities:`; closed vocabulary, declared = enforced (unknown/not-checkable obligations are loud errors, never silent skips); `total` implicitly @total-marks every module def, `exhaustive` hardens clause heads in every edition. **A→A+ re-graded 2026-06** (north-star §3.6 re-grade + §1 Security row): the dual-gradient pair is live — capabilities flow up, proofs flow down, one declaration shape, both closed vocabularies, both declared = enforced — a shape none of the capability-secure exemplars ships; and ambient stdout is on record as a *decided* hole (`print`/`println` = uncharged observation channel), not an oversight. Residual is breadth (per-def/per-block proof scopes PROPOSED — for security the module is the trust boundary, so the shipped scope is the relevant one), not enforcement. The deferred payback landed (2026-06): `constEval` folds refinement predicates whose call-closure is `@total` (totality §5.1, `constfold_total_test`/`_bad`) — the type-core row's A−→A lever, not a security item. |

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

- [ ] 🔴 Write the unified numeric/dimension design note. The `Duration`
  algebra (`100ms * 3` ok, `100ms * 50ms` error, `400ms/100ms : Number`) is
  the best piece — consider making *dimensioned numbers* the general mechanism
  and deriving Duration, Length, angle, etc. from it (F#-style units of
  measure). That would turn three ad-hoc systems into one concept. **See
  `docs/north-star-grades.md §5`** for the worked argument: under a two-axis rubric
  (sized types + first-class dimensions) this is already ≈B+/A−, and `100ms * 50ms`
  *should* be legal as `Duration²` (physics) — the current rejection is the tell that
  Duration is a one-off, not a general unit system.
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
- [ ] 🟡 **Multi-clause head exhaustiveness** (open §14) — multi-clause dispatch
  without exhaustiveness checking is a pattern-match that silently lost the
  language's flagship guarantee.
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
