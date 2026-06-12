# North-star grades — per-field A+ targets and routes

**Status:** 🧭 **Aspirational / direction-setting.** This is the *ceiling* companion to
`TODO.md §1` (which grades the language as-shipped). TODO answers "what's broken before the
surface freezes"; this answers "what would an A+ look like in each lane, and what closes the
distance." Grades track §1 exactly — re-grade a row only when a green fixture proves its gap
closed, same rule as TODO. Several proposals here (`Proof [...]`, the proof tiers) are *theses*,
not decisions — flagged as such.

Legend mirrors TODO: 🔴 load-bearing · 🟡 important · 🟢 nice-to-have.

---

## 1. Per-field A+ targets

Each row is graded *against the field*, so "A+ exemplar" = the gold-standard language(s) in
that lane. The throughline: in **UI, animation, and games** Velve's ceiling is already
*above* any shipping language — each has a feature nobody ships (accessibility-as-proof,
inaccessible-motion-is-uncompilable, "what can change X" in the signature). Those rows are
held down by *build status*, not design. **Type-core and error-handling** are where the
remaining gap is a live *design* choice.

| Field | Now | A+ exemplar(s) | What closes the gap | Gap is… |
|---|---|---|---|---|
| **Type core** | **A** *(2026-06)* | F★ / Liquid Haskell (SMT refinements); Idris / Lean (full dependent) | The old A− was the **conservative skip** — Velve bailed on hard obligations instead of discharging them. (**User generics shipped 2026-06**, SPEC §2.12 — implicit def-signature type vars, polymorphic at call sites / rigid in the body.) (**Proof-gradient surface live 2026-06**, SPEC §12.6–12.7 — `@total` + the `proofs: [...]` module scope; `total`/`exhaustive`/`handled` checkable, 3 of the 6 obligations.) **A− → A re-graded 2026-06** — this row's named next lever landed: **§5.1 constEval widening** (`constfold_total_test`/`_bad`) — the refinement folder executes `@total` predicates at check time, so the skip set shrinks by exactly the code that proved it terminates. The skip is now *opt-out-able per predicate* (mark it `@total`), which changes its character: what remains skipped is the un-asked-for frontier, not a refusal. Honest bound: this fold is also the *only* check a plain refined call gets (runtime enforcement is the explicit `T.parse` boundary), and `Number ≠ Nat` keeps it fuel-bounded. **Refined-type library SHIPPED 2026-06** (SPEC §7.1, `refined_types_test`/`_bad`): `Natural`/`NonZero`/`Positive`/`InBounds` as `@private` ADTs — gates from raw `Number`, closed ops with no re-check, `divBy`/`getAt` deleting the zero/out-of-bounds cases as type errors; a pure library add (zero checker changes, the §3.5 prediction exact), itself proof-carrying (`proofs: [total, exhaustive, handled]`). **`nonzero` + the fact env SHIPPED 2026-06** (`facts.ts`, SPEC §12.7, `proof_nonzero_test`/`_bad`): the flow-sensitive fact environment — §3.1 catch 1, the named "real engineering lift, bigger than the solver call" — now exists (comparison facts from if/match/guards/filters/literal clause heads, mutation kills, no-solver interval entailment), discharging the fourth obligation. **The Tier-2 Z3 back-end SHIPPED one slice later 2026-06** (`smt.ts`, `proof_nonzero_z3_test`/`_bad`): the floor's residue goes to Z3 as refutation over ℝ — the pinned `a != b ⟹ a - b != 0` case *graduated from `_bad` to green*, counterexample models surface in the errors, the solver loads lazily (~120 ms) and only ever removes floor errors. **The `proof.terminates` measure check SHIPPED 2026-06** (`terminates.ts`, SPEC §12.6, `proof_terminates_test`/`_bad`): `@total`'s `n/2` residue now falls through to Z3 — unit-decreasing floored measure from path facts (`F ⟹ arg ≤ n−1 ∧ n ≥ 0` over ℝ), automatic under `@total`, no new surface; non-constant decreases (`shrink(n - k, k)` under `k >= 1`) prove, the loose-guard failures answer with the model that breaks them (`n = 1`, `k = 1/2`, `k = -1`). **`bounds` SHIPPED 2026-06** (SPEC §12.7, `proof_bounds_test`/`_bad`): every list index read proved `0 ≤ i < length(xs)` — the fact env's first **function symbol** (`length(xs)`, Int-sorted, `≥ 0` asserted; Int-sortedness turns `> 0` into `≥ 1`, so `xs[length(xs) - 1]` proves), two queries per read with the leaking side named in the error; 5 of the 6 obligations now checkable. Remaining → A+: the **semantic case proper** (`proof.sorted`/`SortedList` — the §3.2 archetype) + the Tier-1.5 relational witness (`Index(xs)` — `InBounds` is deliberately non-relational). | **Build** — next lever: `proof.sorted`/`SortedList` (the semantic tier's first theorem) or the Tier-1.5 witness primitive; the cheap side-tracks are spent (`bounds` landed). |
| **UI / styling** | A | SwiftUI (ergonomics) + Elm (purity); **no shipping language** has accessibility-as-proof | Ceiling already above the field. **§2.1 duality closed** (paren-form elements), the **theme system shipped 4/4** (typed `Surface` tokens → `using` clause → derived `Theme` record → `theme` read-only reactive root: `std/color` now has a real consumer; accessibility-as-proof fires on token, `using`-surface, computed, and live-root colours), and **responsive is built end-to-end** — closed `Breakpoint`, `Clamp` band, the read-only `viewport` root, the `responsive` keyword, and the **prop-site auto-collapse** of a `Responsive(Length)` against the live `viewport.breakpoint` (re-collapsing on `setViewport`, the viewport sibling of `setTheme`). Re-graded A− → **A** (2026-06): the prior hold was "responsive/inputmap design-only" — responsive is shipped, and `inputmap` is an input/event item (event-row §3.2). Residual is polish (compile-time vs runtime cycle detection; §2.1 handler/spread tail), not a pillar. | **Build** — A→A+ is table-stakes breadth (§2), not a single lever. |
| **Event / state** | A *(2026-06)* | Erlang/OTP + Temporal + XState — Velve already unifies all three | Both named gaps shipped 2026-06: per-stream **backpressure** (`drop`/`buffer N`/`block` at decl site, policy-exempt `Done`, `stream_policy_test`) and **`await`→step-goto** in machine steps (lowering fix, `machine_await_test` — the idiomatic stream-draining machine works). Re-graded A− → **A**. The `inputmap` **core shipped 2026-06** (SPEC §10.5, `inputmap_test`/`_bad`): typed pattern-match table over a stream, conflict analysis ("bound twice"/"shadowed" — the dual of exhaustiveness, as designed), labels retained, drain-loop runtime. **Help-as-derived-data shipped too** (`inputmap_help_test`/`_bad`): a dedicated `Inputmap` type + `help(map) : List({pattern, label})` — the auto-help differentiator's data layer, check-time-typed. **And `++` layering** (`inputmap_layer_test`/`_bad`): maps are values, `default ++ userOverrides` replaces-in-place/appends, cross-stream layering is a check error (the type carries the stream). **And chord-refinement literals** (`inputmap_chord_test`/`_bad`): `Push("Ctl+S")` is a check-time typo — the literal-pattern refinement fold, general to every match site. **And `keymap` sugar** (`keymap_test`/`_bad`): `keymap N` ≡ `inputmap N over Key`, proven by layering a keymap with a plain inputmap over `Key`. A→A+ residual: remaining breadth — std `Key` device library + physical-key prefix, focus-zone scoping, the *rendered* overlay element. | **Build** — inputmap breadth (the overlay element waits on the element-DSL render path; the Key library waits on a host keyboard source). |
| **Error handling** | A+ *(2026-06)* | Rust (`Result`+`?`+`thiserror`); Swift typed `throws`; Zig inferred error sets | B→B+ was readability (ternary deleted). **B+→A** (SPEC §2.6, `error_adt_test`/`_bad`): named error ADTs — prelude `ParseError`, stringly-error use a check error, map-at-the-boundary convention; `try` soundness closed (`try_sound_test`/`_bad`). **A→A+ shipped 2026-06** (SPEC §2.13, `error_rows{,_match}_test`/`_bad`): **inferred error rows v1** — `Result T _` infers the raised ctor set with zero threading (the §4 hybrid: Zig ergonomics inside), named-ADT pins check ctor-set inclusion with escapees listed (reviewed contract at the edge), and rows are directly matchable with exhaustiveness over the **actual raised set** incl. "can never match" arms — the combination none of the references ship (Zig has no reviewed pin, Rust threads everything, Swift's `throws` set is declared not derived). **Ctor shadowing fixed 2026-06** (`ctor_shadow_test`/`_bad`): shared ctor names resolve by expected type in expression position and scrutinee type in patterns — declaration order no longer matters. **Late contributions fixed 2026-06** (`row_late_test`/`_bad`): a callee error type still unresolved at the `?` is re-judged at end of module — landed in the row or rejected, never silently dropped. **Pin fix-its shipped 2026-06** (`row_fixit_test`/`_bad`): failing pins name the smallest edit (re-pin with a covering ADT, or add the missing variants). S3 closed. Residuals (honest): mixed-arity shared names keep last-decl-wins (runtime-ambiguous — needs an eval redesign, not a rows slice); prose `parseInt`/`parseFloat` remain. **Row variables shipped 2026-06** (v2/S4b, SPEC §2.13 v2 block, `row_tails_test`/`_bad`): generic row defs with per-call-site rows — a callback's error var is a tail, the same def pins differently at each call, matches are exhaustive over *this* call's set. | **v2 done** (S4a fn-type ascriptions + S4b row tails + S4c effect tails shipped — the §4 convergence built at E1 scope); remaining residuals are the documented eval-side/prose items, not rows work. |
| **Low-level** | B− | Rust (borrow + sized types); Zig (comptime) | Four numeric stories that never met + gpu/audio/std-low sketches. A+ = **F#-style units-of-measure** as the general mechanism + sized types built on it. See §5. | **Design** — the unifying note (TODO §3.4 🔴) is unwritten. |
| **Games** | C+ / A− | Bevy ECS; Unity DOTS | **100% gated on the compiled target** — a tree-walker can't hold 60fps. A+ = compiled backend + frame clock + `@interaction`. | **Build.** |
| **Animation** | C / A | SwiftUI animation; Framer Motion | `animated` + motion-policy chokepoint is unique, unbuilt. Ceiling is **A** not A+ — see §8 (choreography breadth). Blocked on `frames` + reconciler. | **Build + undesigned breadth.** |
| **Security** | **A+** *(2026-06)* | Capability-secure: Austral, Pony, Koka/Unison; IFC: Jif / Flow Caml | Taint-at-parse is the right cut. A+ = make `Effect` **enforcement** real (TODO §3.6). **The mechanism now is** (2026-06): direct calls checked (`effects_test`, pure-hole edition-gated) and the HOF laundering route closed (SPEC §12.4, `hof_effects_test`/`_bad` — latent effects of a function argument charge the call that supplies it; aliasing doesn't launder; fires for untyped and typed callees alike). **Effect tails shipped 2026-06** (S4c, SPEC §12.4 effect-tails block, `effect_tails_test`/`_bad`): tailed builtin HOF signatures charge the argument's row precisely per call site, and the conservative rule defers to them — the effect-rows ingredient at E1 scope. **A− → A re-graded 2026-06** (SPEC §12.5, `builtin_effects_test`/`_bad`): the named coverage gap is closed — the effectful runtime builtins charge their capability (`setTheme`/`setViewport` `[ui]`, `externSource` + network `[io]`), including through S4c tails (`pmap(setViewport)` charges `[ui]` in a pure def), so the stdlib no longer lies by omission. Decided ambient line: `print`/`println` (observation channel) and `sleep` (virtual time) charge nothing. **E2 user-spelled effect rows shipped 2026-06** (SPEC §12.4 E2 block, `effect_spell_test`/`_bad`): `..e` in the Effect bracket — param position binds, clause position charges — gives user HOFs the same per-call-site precision as tailed builtins, including the spellable identity pattern (uncharged keep, row preserved); unbound tails error. **Ascription effect-coverage shipped 2026-06** (`effect_ascribe_test`/`_bad`): the erasure laundering hole is closed — a fn-type ascription (def return or binding) must COVER the value's row, checked covariant-deep (record fields, list elems, Stream/Async); over-approximation legal; the check even caught and fixed a genuine erasure in `effect_tails_test`'s own `keep`. **`@total` shipped 2026-06** (SPEC §12.6, `total_test`/`_bad`) — the proof gradient's first checked obligation: structural decrease + the DOWNWARD call gate (a total fn may only call total code — effect enforcement's dual, run in reverse), with conservative rejection of mutual/closure recursion. **`Proof [...]` module scope shipped 2026-06** (SPEC §12.7, `proof_scope_test`/`_bad`): `proofs: [total, exhaustive]` rides the `capabilities:` shape — closed vocabulary, declared = enforced (unknown/not-yet-checkable obligations are errors, never silent skips), `total` implicitly @total-marks every module def, `exhaustive` hardens clause heads in every edition. **`handled` shipped 2026-06** (`proof_handled_test`/`_bad`): no silently discarded `Result` anywhere in a `proofs: [handled]` module — the third checkable obligation, landing exactly on the per-obligation cadence (3 of 6 live). The proof gradient is now a live surface with per-obligation rollout. **A → A+ re-graded 2026-06** (the §3.6 re-grade): the field's exemplars ship *one* gradient — capability security, effects flowing up (Austral/Pony/Koka). Velve now ships the **dual pair under one declaration shape**: `capabilities:` up, `proofs:` down, both closed vocabularies, both declared = enforced, with every known laundering route closed on the effect side (direct/HOF/tails/ascription/builtins/user rows) and per-obligation rollout live on the proof side — a shape none of the exemplars has. Honesty owed and hereby on record: **ambient stdout is a *decided* hole** — `print`/`println` are an uncharged observation channel (SPEC §12.5), which a strict capability reading (Austral) would charge; that's a documented ergonomics trade, not an oversight. Residual is breadth, not enforcement: per-def/per-block proof scopes stay PROPOSED — and for *security* specifically the module is the trust boundary, so the shipped scope is the security-relevant one. | **Hold** — remaining items (finer proof scopes, refined types, Tier 2) are §3 type-core work, not security gaps. |

---

## 2. What blocks A+ — the table-stakes ceiling

The pattern across every row: **A / A− comes from a differentiator nobody ships; A → A+ is
table-stakes *breadth*.** Velve buys novel features cheaply and the boring 80% expensively.
So "what prevents A+" is rarely the unique feature (we have those, design-wise) — it's parity
on the unglamorous parts, plus the perf substrate. Three rows make the shape concrete:

**Design / type-core — a *values conflict*, not a capability gap.** Nothing technical blocks
A+: Z3 integration is known work. But A+-by-pervasive-SMT (Liquid Haskell / F★) means proofs
that time out, verify on one machine and not another, and emit counterexamples no human can
map to source — betraying the readability/no-magic goal. **The A− *is* the skip** — the
"better than all four" ergonomics verdict exists *because* of it. The resolution is §3: don't
refuse the frontier, **gate** it.

**Error handling — A and A+ are different mechanisms.** B+→**A** = named error ADTs (kill the
stringly tax, TODO §3.5). **A→A+** = inferred, structured, exhaustively-checked error rows
(Zig `!T`, Koka effect rows). Insight: this is the *same row-polymorphic inference pass* as
effects (TODO §3.6) and effect-polymorphism (§3.6 🟡). **Error-A+, effect-A+, security-A+
converge on one unbuilt feature** — error/effect row inference. Build it once, three rows
move. See §4.

**Animation — the ceiling is A, not A+, deliberately.** **A** = the motion-policy chokepoint
("motion you can't write inaccessibly"). **A+** needs that *plus* table-stakes parity with
SwiftUI/Framer that is mostly **undesigned**: interruptible springs, gesture continuity,
shared-element transitions, timeline choreography. See §8.

**UI / styling — now A; A→A+ is the boring 80%, and it's mostly unbuilt, not undesigned.**
The differentiator (accessibility-as-proof) is built and above the field; the gap to A+ is
**breadth parity** with React/SwiftUI on the unglamorous layout/runtime surface. Grounded in
the actual checker: only ~8 CSS properties emit (`render.ts` — `background`/`color`/`gap`/
`width`/`height`/`padding`/`margin`/`opacity` plus the flex-item set), and the primitive
catalogue is `elements.ts`'s closed set (`Row/Column/Stack/Grid`, `Box/Card/Scroll/List/Item`,
`Text/Heading/Label/Button/Link/Image/Canvas/Input/Slider`). So the table-stakes breadth owed:
- **Layout depth** — `Grid` is modeled as *flex* (no real tracks/areas/template); no
  absolute/sticky **positioning**, no `z-index`/stacking, no `overflow`/clip modes beyond a
  `Scroll` primitive, no `aspect-ratio`/`object-fit`. The convergence layer handles *flow*; the
  CSS-emit breadth behind it is thin.
- **Motion** — enter/exit + layout transitions (overlaps the animation row: `animated` unbuilt).
- **Forms** — `Input`/`Slider` exist, but the form *ecosystem* (every input type, validation UX
  wiring, controlled-state patterns) is sparse.
- **Performance substrate** — list **virtualization** for large keyed lists; today the
  tree-walking interpreter re-renders wholesale (the *same* perf gate as games — a compiled/
  windowed render path).
- **Typography & i18n** — truncation/line-clamp, rich text, RTL/bidi, font loading.
- **Media** — responsive images (`srcset`), lazy loading, an icon/SVG system.
- **Theming breadth** — nested/scoped themes + per-component overrides (both listed as deferred
  non-goals in `theme-design.md §4`).

None of these is a *differentiator* — they're the parity tax. So UI is **A** (unique feature
shipped, end-to-end) and the route to A+ is "build the boring 80%," led by the layout/CSS-emit
depth and the virtualization/perf substrate. Unlike type-core/error, no *design* question
blocks it; unlike animation, it's mostly already designed in CSS-land — it just isn't built.

**General rule:** when a row says ceiling **A**, read "differentiator built, table-stakes
parity still owed." An **A+** ceiling means we'd also have to beat the field on the boring
80% — usually undesigned, not just unbuilt.

---

## 3. Type system — the opt-in proof gradient

The headline reframing from the whole design conversation: **the type-system A+ is not bought
with a solver Velve doesn't have — it's bought with *coherence*.** Velve doesn't need to
*refuse* the frontier (which caps it at A−) or *adopt* pervasive SMT (which betrays
readability). It can **gate** the frontier behind opt-in rungs, readable by default,
frontier-capable on demand.

### 3.1 The SMT machinery already lives in the `where` system

Doing "the SMT stuff" needs **no new syntax** — the `where` refinements are already here, and
the discharge hook is one identified site. From the checker:
- Refinements keep their **predicate AST** in a `REFINEMENTS` registry (`infer.ts:166–168`);
  dependent refinements (`type InBounds n = Number where 0 <= value && value < n`) already
  **fold their params into an env** at call sites (`infer.ts:193–198`).
- `constEval(e, env)` walks the predicate and **returns `undefined` when it isn't
  compile-time constant** (`infer.ts:313, 277`). **That `undefined` is the conservative skip.**

So "do SMT with our `where` system" = intercept that one site — when `constEval` would bail,
hand the same predicate AST + env to a decision procedure. Two real catches bound how far it
reaches:
1. **The env holds *values*, not *facts*.** It's `Map<string, ConstVal>` (constants only). A
   solver earns its keep on *symbolic* facts — `if k <= len(xs) then …` makes `k <= len(xs)`
   true in that branch. Using that needs widening the env to **constraints + path conditions**
   (flow-sensitive). That's the real engineering lift, bigger than the solver call.
   *(The floor of this lift SHIPPED 2026-06 as `facts.ts`: a flow-sensitive fact env of
   comparison-to-constant facts on immutable names — if/else negation, `&&`/`||`/`not`,
   match literals + fall-through binders, guards, `for` filters, multi-clause literal heads;
   `mut`/reassignment kills — built to discharge `nonzero` (SPEC §12.7) with a no-solver
   interval entailment. The Z3 back-end then landed one slice later (`smt.ts`,
   `proof_nonzero_z3_test`/`_bad`): symbolic facts — name-vs-name, compound terms — go to the
   solver as refutation queries over ℝ, with counterexample models in the errors. The
   `len(xs)` symbols then landed with `bounds` (2026-06, `proof_bounds_test`/`_bad`):
   `length(xs)` on an immutable name is an Int-sorted uninterpreted-but-congruent constant
   with `≥ 0` asserted — exactly the `k <= len(xs)` fact this catch named.)*
2. **`where` out-expresses any solver.** `OnSurface = Color where contrast(value, surface) >= 60`
   calls `contrast` (APCA math) — an **uninterpreted function** to a solver, opaque, computable
   *only* when inputs are constant. A solver only adds power over a **theory it knows** (linear
   arithmetic). So predicates over arbitrary Velve functions discharge by folding-or-honest-skip
   *no matter what solver you bolt on*. This is structural: **the `where` language is strictly
   more expressive than any discharge engine**, so the design question is always "where's the
   total-discharge line," never "solver yes/no."

### 3.2 The structural-vs-semantic law

A property gets a **cheap, no-solver tier iff it has a structural or constructive proxy.**
This predicts cost instead of excusing it, and it's why `@total` is free and `@sorted` isn't:

| Property | Structural / constructive proxy? | Cheap tier | Example |
|---|---|---|---|
| Termination | yes — structural recursion | **free** | `@total` (`totality-design.md`) |
| Non-negative / non-zero / bounded-by-constant | yes — smart constructor | **free** | `Natural`, `NonZero`, `Positive` |
| Acyclicity | yes — topological sort | **free, built** | convergence DAG (styles §6) |
| **Sortedness** | **no** — semantic | **none** | `@sorted` / `SortedList` |
| "this index fits *this* array" | no — relational | none | `InBounds` tied to `len(xs)` |

`@total` is cheap *because* termination ≈ structural recursion (a shape the compiler sees);
since 2026-06 its `n/2`-style residue falls through to the Z3 measure check (see the tier
table below) instead of conservatively rejecting.
Sortedness has no syntactic shape, so a `@sorted` *verification marker* would have **no cheap
tier** — it falls straight to Z3 every time. Your two honest options for a semantic property
are **construct it** (smart-constructor `SortedList`, no solver, API ceremony) or **prove it**
(Z3, zero ceremony, readability tax).

### 3.3 The tiers

| Tier | Mechanism | Covers | Solver? | Status |
|---|---|---|---|---|
| 0 | Refinement + `.parse` boundary | literal/foldable checks | no | **built** (constEval) |
| 1 | **`@total`** (structural) + **correct-by-construction types** (`Natural`, `NonZero`, `Positive`, `InBounds(n)`, `SortedList`) | termination + **intrinsic** invariants (counts, div-by-zero, bounds) | **no** | **BUILT (2026-06)** — `@total`: SPEC §12.6, `total_test`/`_bad`; **refined-type library SHIPPED**: SPEC §7.1, `refined_types_test`/`_bad` (`SortedList` deferred — sortedness is the §3.2 semantic case) |
| 1.5 | **Witness tokens** — `checkBounds(i, xs) : Result(Index(xs), :oob)`, then proof-requiring ops | **relational** facts | no | needs 1 primitive (below) |
| 2 | **Z3 `std/proof`** — `proof.sorted`, `proof.terminates`, arbitrary predicates | semantic / termination residue, zero ceremony | **yes** | **two slices BUILT (2026-06)**: the `nonzero` back-end (`smt.ts`, `proof_nonzero_z3_test`/`_bad`) and the **`proof.terminates` measure check** (`terminates.ts`, `proof_terminates_test`/`_bad` — automatic under `@total`, unit-decreasing floored measure from path facts; `halve(n/2)` and non-constant `shrink(n-k, k)` prove) — refutation over ℝ, counterexample models in errors, lazy-loaded, floor fallback when uninstalled; `proof.sorted` + the `std/proof` *spelling* remain **proposed stub** (SPEC §std/proof) |

`@total` itself already mirrors this shape internally (`totality-design.md §3`): **Tier-1
structural** (recursion on a smaller arg, bounded loops) free and common-case; **Tier-2
`proof.terminates`** Z3 fall-through for `n/2`-style measures — **SHIPPED 2026-06**
(`terminates.ts`, `proof_terminates_test`/`_bad`): automatic under `@total` when the
structural decrease is the only failure, proving a unit-decreasing floored measure from the
fact env over ℝ — non-constant decreases (`shrink(n - k, k)` under `k >= 1`) prove too,
which no structural rule could. And `@total` *pays back into the
type system*: a refinement predicate marked `@total` is **safe to fold every time** (totality
§5.1) — **this payback SHIPPED 2026-06** (`constfold_total_test`/`_bad`): the folder now runs
`@total` predicates at check time, the lever behind the row's A− → A re-grade (§1).

**Correct-by-construction, concretely:** make `Natural` opaque; the only gate from raw `Number`
is `Natural.parse(x) : Result(Natural, :negative)`; closed ops (`+`, `*`) return `Natural`;
faulting ops don't (`sub : Natural -> Natural -> Result(Natural, :underflow)`). A `Natural` is
then ≥ 0 **by construction** — not because a solver proved your arithmetic, but because you
*cannot build a negative one*. `NonZero` makes division total; `InBounds` makes indexing safe.
No solver. This is the **endorsed** "refinements transparent + explicit `.parse`" decision
(TODO §7) applied as a library. It needs a **trusted kernel**: closed ops assert their result
via `@unsafe{}` (the stdlib is the TCB).

**SHIPPED 2026-06** (SPEC §7.1, `refined_types_test`/`_bad`) — and as built, the trusted
kernel got *cheaper* than the design above: no `@unsafe{}` anywhere. `@private type` (§3.5)
means the module boundary itself is the TCB — closed ops construct directly because they're
inside it, and the four boundary violations (forge by call, match by pattern, raw `Number`
where `NonZero`/`InBounds` is demanded) are compile errors pinned by the `_bad` twin. The
gates spell as module functions (`natural(n)`, not `Natural.parse`) returning
`Result T String` — same construct, today's surface. Two as-built honesty notes: the
library module is itself **proof-carrying** (`proofs: [total, exhaustive, handled]` — the
gradient eats its own cooking), and `InBounds` is the **non-relational** Tier-1 cut: it
witnesses "an index that passed a bounds check", not "an index into *that* list" — the tie
to a specific list is exactly Tier 1.5's witness-token primitive, deliberately not faked
here. Zero checker changes: the "pure library add" prediction held exactly.

### 3.4 `Proof [...]` — proofs as the dual of effects

> **Thesis, not a decision** — but a principled one, not a whim. The earlier monolithic
> `@proof{}` ("turn everything on") was the whim; this is its real form: a **granular,
> exhaustive obligation set scoped exactly like effects.** The naming is free (`std/proof`'s
> `proof.*` is a module namespace, not a decorator/keyword).

The risk with Tiers 0–2 is **sprawl** — five reaches (`.parse`, `@total`, refined types,
witnesses, `proof.*`) violate the language's own "what do I reach for" discipline. The fix is
not a new monolith; it's to notice **Velve already solved this shape for side effects** and
mirror it. Effects are a closed capability vocabulary (§5.4) declared at three scopes:
per-function `Effect [network]` (SPEC:460), per-module `capabilities: [render, network]`
(§5.2), enforced at the definition site (§12.3). **Proofs are the same construct for
guarantees instead of permissions:**

| | Effects (built) | `Proof [...]` (proposed, mirrors it) |
|---|---|---|
| Per-function | `Effect [network] T` | `Proof [total, bounds] T` |
| Per-block | `@unsafe{ … }` | `@proof[total, bounds]{ … }` |
| Per-module | `capabilities: [render, network]` | `proofs: [total, bounds]` |
| Vocabulary | closed list (§5.4) | closed fault list (below) |
| Default (none) | no effects permitted | nothing proven (today's skip) |
| Escape | `@unsafe{}` / raw JS | `@unsafe{}` |

**The semantic core is one flipped policy bit, *scoped to the declared set*.** Outside any
proof scope, an undischarged obligation **skips** (trust the runtime boundary). Under
`Proof [total, bounds]`, an undischarged obligation *in that set* is a **compile error** →
fall through to Z3 → if Z3 can't, you write the proof. Reuses all existing machinery
(constEval, REFINEMENTS, `@total`, std/proof); changes only what "couldn't prove" *means*,
and only for the listed obligations.

**The one thing NOT to carry over from effects — they propagate in opposite directions:**
- **Effects flow *up*.** A `[network]` function demands its *callers* have `network`. The
  annotation is a requirement on the environment *above*; adding an effect *widens* what's
  permitted.
- **Proofs flow *down*.** A `[total]` function may only call other `[total]` functions
  (`totality-design.md §6`). The annotation is a requirement on what you use *below*; adding a
  proof *narrows* what compiles.

So `proofs: [total, bounds]` on a module means every def must be total + bounds-checked **and**
may only call code that also satisfies those — the obligation flows *into* the call graph.
That is the verified-kernel boundary, stated precisely: **it's effect-enforcement run in
reverse.** (Model proofs as "just more capabilities" and you get the direction backwards.)

**The exhaustive vocabulary — and why it's actually closeable.** Scope-proofs are the
enumerable taxonomy of *runtime faults we can statically forbid*, not open-ended properties:

| Obligation | Forbids | Discharge | Cheap? |
|---|---|---|---|
| `total` | non-termination | structural + Z3 (`@total`) | **yes** (structural) |
| `bounds` | out-of-range indexing | `InBounds` + path facts | **SHIPPED 2026-06** (`proof_bounds_test`/`_bad`) — fact env + the Int-sorted `length(xs)` symbol; two Z3 queries per read, the error names which side leaked; `xs[length(xs) - 1]` proves |
| `nonzero` / `arith` | div-by-zero, partial arithmetic | refinement + path facts | **`nonzero` SHIPPED 2026-06** (`proof_nonzero_test`/`_bad`) — fact env + interval entailment; **Z3 fall-through SHIPPED one slice later** (`proof_nonzero_z3_test`/`_bad` — the pinned compound-divisor residue graduated to green); `arith` pending |
| `overflow` | silent numeric overflow | sized types (§5) | needs §5 |
| `exhaustive` | incomplete match | already built | **yes** |
| `handled` | unpropagated error | error rows (§4) | **SHIPPED 2026-06** (`proof_handled_test`/`_bad`) — no silently discarded `Result` in the scope |

What does **not** go in the list: value invariants like `sorted`/`positive` — those stay
**types** (`SortedList`, `Natural`), because they're properties of *values*, not *operations*.
That split is what keeps the vocabulary closed: **scope-proofs = "operations can't fault";
type-proofs = "values satisfy invariants."** The list is bounded by the fixed set of fault
kinds, exactly as §5.4 is bounded by the fixed set of capabilities.

**Honest rollout:** the *vocabulary* is fixed and small; the *implementations* land per
obligation. `total`, `exhaustive`, `handled`, `nonzero`, and `bounds` are shipped — 5 of the
6 classes; `arith` extends `nonzero`'s engine; `overflow`
needs sized types (§5). So
`Proof [...]` is a stable surface where each obligation is a checker capability arriving on its
own schedule — declare `proofs: [total]` the day totality lands, add `bounds` later. **The
grade moves per-obligation, not all-or-nothing** — which is also what makes it genuinely
"optionally good for whoever needs it": you opt into exactly the faults you care about.
*(Live as of 2026-06: SPEC §12.7 ships the module scope with `total` + `exhaustive` +
`handled` + `nonzero` + `bounds` checkable and `arith`/`overflow` as loud not-checkable-yet
errors — the rollout above, as built. `handled` also surfaced the second enforcement shape:
it is scope-local
like `exhaustive` — its fault is syntactic to the scope — where `total` is the call-graph
obligation needing the downward gate; `nonzero` is scope-local too.)*

### 3.5 The one primitive to confirm — module-private constructors ✅ SHIPPED

The entire construction tier is only *sound* if external code cannot reach a type's unchecked
constructor (only `.parse` + closed ops). Velve has opaque/named types (the `UserId`/`Named`
example, `blocks-design.md:824`) and `@unsafe{}`, but **whether a constructor can be made
module-private is unconfirmed.** This single feature decides whether Tier 1 is a pure-library
add or a small language change. **Check this first** — it gates 3.3 and 3.4's soundness.

> **CONFIRMED (investigated 2026-06): it's a language change, not a library add.** The
> resolver has no visibility mechanism at all — `collectDecls`/`registerAliases` put every
> declaration, including those inside `module` blocks, into one flat global scope, and ADT
> constructors resolve from anywhere. Does NOT gate `@total` or the `Proof [...]` surface —
> totality and scope-proofs are checks on operations, not value invariants.

> **SHIPPED (2026-06): `@private type`** (SPEC §7.1, `private_ctor_test`/`_bad`). An ADT
> declared `@private` inside a module seals its constructors at the module boundary in both
> directions — no forging by call, no representation-dependence by pattern — while the type
> name stays public for signatures. Implementation matched the "small language change" read:
> the resolver's scope stays flat; privacy is a use-site check on the ctor binding (a
> `privateTo` tag checked against the enclosing-module stack), so shadowing and resolution
> order are untouched. **The construction tier (item 3) is now ungated**: `Natural`/`NonZero`/
> `Positive`/`InBounds` as a module of `@private` ADTs with `.parse`-style smart constructors
> and closed ops is a pure library add from here.

### 3.6 Verdict + definition of done

**On design, today: a confident A, not an A+ — but A+ is *reachable*, not foreclosed.** The
earlier "foreclosed by design" read was wrong: Velve doesn't *refuse* the frontier, it *gates*
it. The maxed stack (`@total` + constructed types + Z3 `std/proof`, surfaced as the
`Proof [...]` obligation set) reaches **frontier capability** — a user who opts in *can* prove
the hard theorems. The singular novelty the type-core lacked turns out to be the **opt-in
proof gradient itself**: readable-by-default, frontier-on-demand, declared exactly like effects
(§3.4). No mainstream or frontier language ships that shape (Liquid Haskell/Idris/F★/Dafny are
all-on; Rust's `forbid(unsafe)` has no proof). `Proof [...]` — proofs as the dual of
capabilities — is the construct that embodies it.

Two honest reasons the *type-core row's* A+ is still not delivered (they bound the claim —
the re-grade below argues the construct's A+, not cheaper proofs):
1. **The hard-proof floor still costs what F★ costs.** Under `Proof [...]`, a listed obligation
   outside the SMT-tractable set (nonlinear, uninterpreted functions) is now a hard error —
   lemmas, timeouts. The construct buys *coherence and access*, **not cheaper hard proofs**; on
   the genuinely hard theorem, maxed-Velve = F★ and still trails Idris's *native* dependent
   ergonomics (the `Vec n` / `append : Vec n -> Vec m -> Vec (n+m)` flex stays clunkier).
2. **It's design-on-design, partly built now.** `Proof [...]` rests on `std/proof` (stub) and
   on `@total` — which HAS survived contact with a compiler (Tier 1 built 2026-06, and the
   downward-propagation rule survived intact: it's the call gate). The module-scope
   `Proof [...]` surface is now built too (2026-06, SPEC §12.7), and the per-obligation
   rollout held: two obligations live, the other four loud errors until their checkers
   exist. The per-def/per-block scopes and the Tier-2 obligations remain unbuilt.

**Definition of done** (converts the A into "optionally good for whoever needs it"):
1. ✅ ~~Confirm/add~~ **Confirmed AND SHIPPED** (2026-06, §3.5): module-private constructors
   landed as `@private type` (SPEC §7.1, `private_ctor_test`/`_bad`) — ctors seal at the
   module boundary in both directions, the type name stays public. Item 3 is ungated.
2. ✅ **Tier-1 `@total` SHIPPED** (2026-06) — SPEC §12.6, `total_test`/`_bad`: structural
   decrease + downward call gate + bounded-construct rejection; mutual/closure/`n / 2`
   recursion conservatively rejected (Tier 2's job). The conservative-skip payback —
   **§5.1 constEval folding of `@total` predicates — SHIPPED** (2026-06,
   `constfold_total_test`/`_bad`): the totality promise is what makes running user code
   inside the checker safe, and it now does (fuel-bounded; decidable-pattern clause
   dispatch; bails on anything it can't decide).
3. ✅ **Tier-1 refined-type library SHIPPED** (2026-06) — SPEC §7.1,
   `refined_types_test`/`_bad`: `Natural`/`NonZero`/`Positive`/`InBounds` as `@private`
   ADTs; gates, closed ops, faulting ops through the gate; `divBy`/`getAt` delete the
   zero/out-of-bounds cases as *type errors*. The "pure library add" prediction held —
   zero checker changes, and the module is itself proof-carrying
   (`proofs: [total, exhaustive, handled]`). `InBounds` is the honest non-relational cut
   (Tier 1.5 owns the list-tie).
4. ✅ **`Proof [...]` module scope SHIPPED** (2026-06) — SPEC §12.7, `proof_scope_test`/`_bad`:
   `proofs: [...]` rides the `capabilities:` grammar shape; the vocabulary is closed (the §3.4
   six) and **declared = enforced** — unknown or not-yet-checkable obligations are errors,
   never silent skips, so the surface can't promise more than the checker verified. `total`
   marks every module def implicitly `@total` (the downward gate then fires automatically);
   `exhaustive` hardens clause-head gaps to errors in every edition, ahead of the 2026.6 gate.
   Per-def `Proof [obligation] T` and per-block `@proof[...]{}` remain PROPOSED in SPEC.
5. 🟢 Z3 **Tier-2** + relational witnesses — later, opt-in, for the semantic residue.
   *(Tier 2 is now LIVE for three obligations (2026-06, four slices): the fact env
   (`facts.ts`) shipped with `nonzero` and pinned the Z3 hand-off as a concrete error;
   the Z3 back-end (`smt.ts`) then landed and the pinned case graduated from `_bad` to
   green (`proof_nonzero_z3_test`) — the floor-pin-graduate cadence is the per-obligation
   rollout working at the solver tier; then `proof.terminates` rode the same engine
   (`terminates.ts`) — `@total`'s `n/2` residue proves automatically, with the same
   counterexample-in-the-error contract; then `bounds` (`proof_bounds_test`/`_bad`)
   added the env's first function symbol — Int-sorted `length(xs)` — and graduated the
   nonzero `_bad` pin `n / length(xs)` to green a second time, now guarded and proved.
   Still open: the semantic residue proper (`proof.sorted`) and the relational witness.)*

Items 1–4 are done (2026-06; item 3 landed one slice after the re-grade below), so the
type system *is* now the opt-in spectrum and only the Tier-2/relational residue (item 5)
remains.

**Re-grade (2026-06) — the A+ argued over the shipped surface.** This is no longer a thesis
defended by design prose; it's defended by fixtures (`total_test`/`_bad`,
`proof_scope_test`/`_bad`):

1. **The vocabulary held.** Two slices of compiler contact (`@total`, then `proofs: [...]`)
   added zero obligations and renamed none — the §3.4 fault taxonomy survived implementation
   exactly as written. A closed vocabulary that survives building is the strongest available
   evidence it was the right cut (the §5.4 capability list passed the same test).
2. **The rollout promise is kept, loudly.** "The grade moves per-obligation" was the §3.4
   pitch; as built, a declared obligation without a checker is a *lower error*, never a
   silent skip — so at every point in the rollout the surface cannot promise more than the
   compiler enforces. That property is what makes a partially-implemented gradient *sound*
   rather than aspirational.
3. **The direction rule survived contact.** Proofs-flow-down wasn't prose: it is the downward
   call gate in `total.ts`, and the module scope reuses that engine untouched —
   `proofs: [total]` is enforcement arriving from the module head, not an annotation.
4. **Every unshipped obligation has a named blocker — and the blockers keep falling on
   schedule.** `handled` waited on §4 error rows, which shipped (2026-06) — and then
   `handled` itself shipped (2026-06, `proof_handled_test`/`_bad`). `bounds`/`nonzero`
   waited on the flow-sensitive fact env (§3.1 catch 1) — the env shipped (2026-06,
   `facts.ts`) *together with* `nonzero` (`proof_nonzero_test`/`_bad`); `bounds` then
   landed on that env two slices later (2026-06, `proof_bounds_test`/`_bad` — the
   `length(xs)` symbol was its last missing piece): 5 of 6 obligations
   are now checkable, exactly the per-obligation cadence the rollout promised. Still
   blocked: `arith` (extends `nonzero`'s engine), `overflow` (sized types, §5).

What this argument buys, precisely: the **Security row's A+** (the proof-gradient integration
was its last named ingredient — §1) and the construct-level A+ for the gradient itself. The
**Type-core row** moved separately, one slice later: its named gap was the conservative skip,
and the promoted follow-on landed — **§5.1 constEval widening SHIPPED** (2026-06,
`constfold_total_test`/`_bad`), re-grading that row A− → A (§1); then item 3 landed too
(refined-type library SHIPPED 2026-06, `refined_types_test`/`_bad` — zero checker changes),
leaving Tier 2 + the Tier-1.5 relational witness as its remaining → A+ path. And permanently: Velve
will not, and shouldn't try to, win the field's A+ on *cheaper hard proofs* — that path runs
straight through the readability the language exists to protect.

---

## 4. Error handling — `Result` + inferred, the hybrid

Neither explicit `Result T E` nor Zig-style inferred error sets dominates; the A+ design is
**both**, and it's the most Velve-consistent answer.

| Axis | Explicit `Result T E` | Inferred error rows (Zig `!T`) |
|---|---|---|
| Annotation/threading | **loses** — write & thread `E` everywhere | **wins** — nothing to write |
| Composition under `?` | **loses** — different `E`s need manual `mapErr`/conversion → **this is what forces every example to `Result T String`** | **wins** — union accumulates automatically |
| Exhaustiveness | over the *declared* `E` (may over/under-approximate) | over the **actual** raised set |
| API stability | **wins** — a reviewed contract | **loses** — inferred set **silently grows** when a callee adds a failure (spooky action at a distance) |
| Signature readability | **wins** — names without a call-graph closure | **loses** — must compute the transitive set |
| Encapsulation | **wins** | **loses** — leaks callee internals into the public type |

**Decision (thesis): infer internally, *pin at module/public boundaries*.** Infer the error
row inside a module (ergonomics, real exhaustiveness, zero tax); **require an explicit
ascription at the boundary**, checked against the inferred set (contract, stability,
encapsulation). This mirrors the `@interaction` "writes are in the signature" philosophy —
truth at the edge, ergonomics inside — and resolves the no-Maybe stance's stringliness (TODO
§3.5) by producing *names*, inferred, not prose.

**Mechanism convergence (the load-bearing insight):** inferred error rows are
**row-polymorphic open variants** + a `?` that **widens** the row — the *same* HM extension
(OCaml-style) as effect rows. So **error-A+ = effect-A+ (TODO §3.6) = effect-polymorphism for
`map(f, xs)`**. One row-inference pass, three rows of the scorecard move. Foundationally
compatible (Velve is HM); the lift is path/row tracking, shared with §3.1 catch 1.

**Design written 2026-06 — `docs/error-rows-design.md`.** Key scoping call: the convergence
above is **v2**, not v1. v1 is Zig-shaped transitive ctor-sets (`Result T _` infers, a
named-ADT pin checks ctor-set inclusion, rows are matchable) with *no row variables and no
HM extension* — it builds the representation, accumulation, and boundary check that v2's
row variables ride on. Four build slices, each fixture-provable and corpus-neutral.

**S1 shipped 2026-06** (SPEC §2.13, `error_rows_test`/`_bad`): infer + accumulate + pin are
real — two unrelated error ADTs and the prelude `ParseError` compose under one `?` chain
with zero threading, and the pin lists escaping ctors by name.

**S2 shipped 2026-06** (`error_rows_match_test`/`_bad`): rows are directly matchable, no
wrapper ADT, with exhaustiveness over the **actual raised set** — missing ctors named,
never-raised arms rejected ("can never match"), prose coverable only by catch-all. That was
the named condition for the grade — **error handling re-graded A → A+** (§1), with the v1
residuals (S3: ctor-construction shadowing, Var-contribution leniency) honestly listed
there. Effect-A+ still waits on v2 row variables.

**S3 shadowing slice shipped 2026-06** (`ctor_shadow_test`/`_bad`): shared ctor names
resolve by **expected type** in expression position (deferred behind fresh vars, judged
once inference shows which ADT the context demands — the same defer-then-judge shape as
pins) and by scrutinee type in patterns; matching a row entry types the payload from the
ADT that contributed it. Declaration order of sharing ADTs no longer matters.

**S3 late-contribution slice shipped 2026-06** (`row_late_test`/`_bad`): the S1
Var-contribution leniency is closed — a `?` whose callee error type is still a type var
when the line is checked (a forward call to an unascribed-param def or a `let` lambda) is
deferred and re-judged once the module completes, so the late entry reaches the row, its
pins, and its match verdicts (S1 dropped it silently; pins passed vacuously). Types that
never become contributable are **rejected**, not dropped — still-polymorphic and concrete
non-ADT error types are check errors naming the fix; only `Unknown` stays lenient.

**S3 fix-it slice shipped 2026-06** (`row_fixit_test`/`_bad`): a failing pin names the
smallest edit that would make it hold — re-pin with an already-declared ADT that covers the
whole row ("fix: pin with 'WideError' (it covers this row)"), and/or the missing variants in
declaration syntax ("add Boom Number to 'AppError'"); the green fixture is the suggestion
applied. **S3 is closed**, with one honestly-reclassified residual: mixed-arity shared ctor
names are not check-side work — eval binds each ctor name once (a function when payloaded, a
bare value when nullary), so one runtime binding cannot serve both owners; that waits on an
eval redesign and belongs to no rows slice. Next: S4/v2 row variables.

**S4/v2 design written 2026-06** (`row-variables-design.md`): not full row-polymorphic HM —
row-polymorphic *signatures* over the v1 flow core. Tails are quantified type vars on the
def's row, cloned per call site at instantiation and judged by the machinery S3 already
built (finalize step 0.5; a tail resolved to a row becomes a ⊇-edge, so occurs-over-tails
is the existing cycle DFS). Designing against the real code exposed the true prerequisite:
the surface has **no function-type ascription at all** (the checker handles `TRFn`; the
grammar never produces it), and row defs are registered mono, so rows × generics is
unusable today. Build order: S4a fn-type ascriptions `(A -> B)` (mandatory parens — a bare
return-slot `->` is the single-line def body), S4b row tails, S4c effect tails on builtin
HOF signatures (the precise replacement for SPEC §12.4's conservative charge — and the
effect-A+ convergence).

**S4a shipped 2026-06** (SPEC §2.14, `fn_type_test`/`_bad`): function-type ascriptions in
every slot — `(A -> B)`, n-ary, thunk (lone `()` = empty param list), return position,
generic fn params. Grammar + lower only; the checker was already TRFn-ready. The payoff
fixture is pass-through error polymorphism with zero rows (`e` unifies per call site, the
caller's pin stays precise), and the bad fixture surfaces 4 boundary errors — arity, param
type, non-fn, wrong-pin-through-`e` — that unascribed HOF params structurally could not
catch. Effects on the ascription remain unspellable until S4c.

**S4b shipped 2026-06** (SPEC §2.13 v2 block, `row_tails_test`/`_bad`): the v2 error core.
Row defs compose with generics; a type var in a callback's error slot is a **tail** on the
def's row; every use judges a per-call-site **clone** (⊇ base via the existing fixpoint), so
the union and extension shapes plain generics can't express now check precisely — the same
`def step(f: (String -> Result Number e)): Result Number _` pins as `HttpError` at one call
and `DbError` at another, and a row-match over one call is exhaustive over *that* call's set.
Layers 2+3 of the measured gap closed: generic non-HOF row defs are callable, and skolems no
longer fabricate pseudo-ctors. As-built delta worth recording: tails register via a deferred
finalize step 0.4 (`pendingCloneTails`) because callers can be inferred before the def's body
records which type vars are tails; the judging itself is step 0.5 verbatim, as designed — no
new unification shipped. Open rows (a tail that never resolves) error at the call site and
demand a catch-all arm in matches. Residual: two-level tail forwarding (a row def passing its
callback to another row def without invoking it) stays an opaque pseudo-ctor.

**S4c shipped 2026-06** (SPEC §12.4 effect-tails block, `effect_tails_test`/`_bad`): the §4
convergence, built at E1 scope — effect tails on builtin HOF signatures. Far lighter than the
error side because effects are just names: `Fn` gains an optional quantified tail id, an
accumulate map records what each call's argument row binds into it, and Fn-unify's single new
rule is "a declared tail absorbs the other side's row" (effects themselves still never unify).
`pmap` is pure at one call site and requires `[io]` at another — SPEC §12.4's conservative
charge replaced with per-call precision exactly where a typed signature exists; and `identity`
(tailed on its own row only, never invokes its argument) accepts an effectful fn from a pure
def **uncharged**, closing the conservative rule's one false positive, with no laundering (the
value keeps its row; calling it is the ordinary per-call check). Untailed callees — surface
`map`/`filter` (Unknown to infer) and untailed user HOFs — keep the conservative rule unchanged.
Tailing the remaining fn-taking builtins (`sortBy`, `listReduce`, …) is mechanical.
**The S4/v2 slice family is complete — including E2** (2026-06, SPEC §12.4 E2 block,
`effect_spell_test`/`_bad`): user signatures spell the tail as `..e` inside the existing
`Effect [...]` bracket — param fn-types bind it, the def's own clause charges it — so user
HOFs now get exactly the builtin precision (`each(double)` free, `each(netGet)` pays `[io]`,
the `keep` identity pattern uncharged with the row preserved). Zero new checker rules: the
spelled name quantifies alongside type vars and rides the S4c machinery. Found while
building (pre-existing residual): an untailed concrete fn-type ascription erases effects —
effects don't participate in unification. **Closed the next slice over** (2026-06,
`effect_ascribe_test`/`_bad`): a directional coverage check at ascription boundaries —
declared row ⊇ actual row, walked covariant-deep — with over-approximation legal and
tail-spelled returns exempt (the tail owns the row). Effects still never unify; the law
holds, the boundary checks.

---

## 5. Low-level, redefined: two axes, not eight sketches

A sharper rubric than TODO §3.4 — **(1) sized types; (2) dimensions are first-class** — moves
the grade, for a real reason.

**The B− isn't the dimension story.** §3.4 calls the `Duration` algebra *"the best piece"*:
`100ms * 3` ✓, `100ms * 50ms` ✗, `400ms / 100ms : Number` — that *is* first-class dimensions
passing axis (2). B− is dragged by what this rubric **excludes**: gpu/audio/std-low sketches
and the four-numeric-systems incoherence (`Number` · `Duration` · `Px/Fr/Pct` · planned
`Int8…Float64`).

**`ms * ms` rejection is a symptom, not a feature.** Velve rejects it because `Duration` is a
*fixed, hand-built* dimension. In F#-style units-of-measure, `ms * ms` is **legal** → `Duration²`
— exactly what a physics integrator wants (`accel : Length / Duration²`). The rejection is the
tell that Duration is a one-off. So the §3.4 🔴 *is* the low-level A+ path — generalize and the
wins fall out:
- `ms * ms → Duration²` valid (physics) instead of an error.
- `Px 8 + 4` coercion unifies with the `gap=8` prop rule (TODO §3.1 🟢).
- `Float32 ⊆ Number?` gets a principled answer.
- Duration / Length / angle / mass derive from **one** concept (§4.0 razor applied to numerics).

**Net:** under the two-axis rubric, today ≈ **B+/A−** (dimensions ✓, sized types pending),
reaching **A** once sized types land **via** the generalized mechanism, not as a fifth disjoint
system. Sequencing matters: build sized types *on* units-of-measure.

---

## 6. Accessibility-as-proof — the styling analog

The type-core refinement story is **already transposed into styling**, on the same machinery —
this is worth recording because it's a *working half-example* of §3's A+ pattern.

`OnSurface = Color where contrast(value, surface) >= 60` (`styles-design.md:283`) is a
**refinement type** discharged by **constant-folding `contrast` in `constEval`** — not a
separate feature, the type system's refinement layer pointed at a styling predicate. Why
"non-readable" cuts two ways:
- **Literal sense:** what fails to compile is *non-readable text* (APCA Lc < 60). The proof is
  *about* human readability — the good part.
- **Predictability sense (the §3 parallel):** the proof needs the **resolved background**
  (`styles-design.md:291`). Behind an empty dynamic list the convergence graph is empty at
  check time (`:466`), so the guarantee silently degrades to runtime (§4.3 hedges "inside or
  after convergence", `:311`) — the styling version of an undischargeable obligation.

**The useful twist:** styling already does the *right* A+ thing — it doesn't reach for a general
solver, it **constant-folds a decidable predicate** and is total where operands are constant.
That's exactly "documented decidable fragment, total discharge." The gap (TODO §3.1) is only
the **honesty at the boundary**: where it can't fold, flag "unprovable here" at compile time
instead of skip-and-detonate. **Same fix as §3, both layers** — the `Proof [...]` discharge-flip
is literally this honesty applied as a declared obligation.

**Generalization designed 2026-06 — `docs/svg-legibility-design.md`:** the same pattern
extended from "color vs nominal surface" to "color + geometry vs composited scene" for a
future free-positioned `Canvas`/SVG form: disjointness (no text overlap) + per-region APCA
(contrast vs what is *actually painted* underneath), constEval-folded when static, with
MaxSMT placement repair as the opt-in synthesis tier (the §3 Z3 floor's first concrete
client). Free positioning ships only together with its obligation — the door and the guard
arrive as one slice.

**S0+S1 shipped 2026-06** (SPEC §11.1.2, `canvas_legible_test`/`_bad`): the door and the
guard did arrive as one slice — `Canvas` + `at=(x, y)` (paint order = child order) plus the
static proof, opt-in by declaring `Legible` (the OnSurface pattern, `surface` bound per
region): text disjointness, occlusion-from-above, and per-region APCA over composited solid
fills via exact box bisection — a label half on dark, half on light is judged in both
regions. Where the proof is active, unfoldable geometry is a could-not-prove ERROR (the
boundary-honesty rule, applied). The substrate dig also found and fixed the element DSL's
silent flattening: paren-form indented children parsed as sibling statements (every 2026.6
view rendered only its last leaf; the §14.1 nested-surface threading never really engaged)
— a GLR mis-resolution fixed with dynamic precedence, zero corpus baseline changes. S2–S5
(font metrics, alpha/gradients, dynamic bounds, MaxSMT repair) stay deferred.

**Call children shipped 2026-06** (SPEC §11.1, `call_child_test`/`_bad`) — the flattening
fix's last residual: a bare lowercase component call (`card()`) is now a `child` grammar
form, so composed views nest for real (`theme_root_test` un-flattened — exposing, and
fixing, that its `action()` had never painted the accent surface it proves against). A call
child resolves, type-checks, and effect-checks exactly like a call in any position — which
is why the baseline diff is empty even for the new fixtures under the old parser.

---

## 7. Closing §2.1 for UI / styling

> **✅ Closed (2026-06).** This section's plan has shipped: elements use paren-form
> (`Text("hi", size=12)`), the §2.1 duality is gone, and with the theme system (4/4) and
> responsive (end-to-end) also built, **UI is now graded A** (§1). The analysis below is
> kept as the historical route; "holding UI at B+" describes the pre-2026.6 state.

The §2.1 element/call duality is *the* item holding UI at B+. The answer is locked in
`call-syntax-design.md` — Phase 1 shipped (functions + constructors on `Name(pos…, name=val…)`);
**Phase 2 is the UI half.** To close it for UI:

1. 🔴 **Lower elements to `Call`.** `Text "hi" size=12` → `Text("hi", size=12)`; `Column gap=8`
   + indented children → `Column(gap=8, children=[…])`. Delete the `element*` grammar + `Element`
   node + `lowerElement`. **The duality that holds UI at B+ literally *is* this node existing.**
2. 🔴 **Keep the indented `children_block` as call-trailing sugar** — the UI-ergonomics
   guardrail. Don't force `children=[…]`; indentation desugars to a `children=` arg. Keeps the
   unified form reading like markup, not function-call soup.
3. 🟡 **Resolve the convergence references — the genuinely UI-specific open decision.** Once
   elements are `Call` nodes, `self`/`parent`/`prev`/`children` reference **tree structure, not
   arguments** (undefined post-unification, TODO §2.1 last item). **Proposed rule:** resolve
   against the *rendered element tree* in a namespace *separate* from arg binding — `self.width`
   means "this node's resolved layout box," never "an argument named self." Pin this **before**
   lowering or the codemod emits ambiguous nodes. The one piece `call-syntax-design.md` doesn't
   decide, because it's a styling concern.
4. 🔴 **`velve fmt` collapses redundant parens** so `print((x))` / `reserve((stockOk))` dies in
   formatted code — that idiom exists only because readers can't predict when one layer is
   enough; unification removes the cause, fmt the residue.

**After §2.1 closes:** UI comes off B+, but the same row names theme/responsive/inputmap as
design-only. §2.1 is the *gating* item for the next bump (top surface item before 0.6); the
**theme system is highest-leverage after** — `std/color` is fully built with *no consumer*, the
cheapest path to actually *using* the accessibility-as-proof machinery (§6) that is already this
row's differentiator.

> **Update (2026-06):** all three have since landed. §2.1's element/call duality is closed
> (paren-form), the theme system shipped 4/4 (the predicted highest-leverage piece — `std/color`
> now has its consumer), and responsive is built end-to-end (prop-site auto-collapse of a
> `Responsive(Length)`). The UI row is now **A**; the only `design-only` item the old text named
> that remains is `inputmap`, which is an input/event concern (event-row §3.2), not UI styling.

---

## 8. Animation — the atom vs choreography breadth

The `animated` note nails the **atom**: one value springs to its target, interruptibly
(`on Retarget(v) -> #{...s, target: v}` keeps velocity — real continuity, `:57`), with the
motion-policy chokepoint. That's the unique-differentiator **A**.

**Choreography breadth** = the orchestration of *many* atoms across mounts, layout, gestures,
and time — exactly what `animated-modifier-design.md:21–24` declares **out of scope** (pillars
3–4):
- **Enter/exit / presence** (pillar 3) — animating mount/unmount; needs the reconciler to
  *defer* removal until exit completes (Framer `AnimatePresence`).
- **Shared-element / View Transitions / FLIP** (pillar 3) — an element flying between layout
  boxes; needs **geometry read-back**, explicitly out of scope (`:218`).
- **Timeline / sequence orchestration** (pillar 4) — staggered children, keyframes, "these
  together, then that, 50ms stagger."
- **Gesture-coupling** — driving the spring from a drag's progress, handing off with the
  gesture's velocity on release.

The atom is interruptible; what's missing is interruption/continuity at the *orchestration*
level (a whole *sequence* interrupted, a gesture handoff across *coordinated* elements). The
atom + chokepoint = **A**; matching SwiftUI/Framer on orchestration = the **A→A+** gap. Plus
the same 60fps substrate gate as games (needs the compiled target).

---

## 9. Reading guide — design vs build

The most useful cut for prioritization:
- **Pure build, design settled** — Event/state, Games, Animation, Security, UI (post §2.1).
  Most are gated on the **compiled backend** (`compiler-architecture-design.md`). The compiled
  target unblocks the most rows at once (Games + Animation entirely, the perf ceiling under
  everything).
- **Live design choice still open** — Type-core (the gradient's *surface*, `@private type`,
  and the Tier-1 refined-type library all shipped 2026-06; what's open is Tier-2 Z3, the
  Tier-1.5 relational witness, and the finer proof scopes, §3),
  Error-handling (the infer-and-pin hybrid + row inference, §4), Low-level (units-of-measure,
  §5).

---

## 10. Evidence basis (honest)

- **"Ceiling above the field"** (a11y-as-proof, inaccessible-motion, footprint-in-signature):
  true on *feature-presence* — no shipping language has these. **Unproven on delivered-value**
  because the features are unbuilt. The ceiling is real; the floor is "does not exist yet."
- **A+ exemplar choices**: field/practitioner consensus, not controlled study — same caveat as
  `call-syntax-design.md §7`.
- **§3 proof tiers + `Proof [...]`**: no longer design-on-design — Tier-1 `@total`, the
  module-scope `Proof [...]` surface, the §5.1 constEval payback, and the Tier-1
  refined-type library are built (2026-06, SPEC §12.6–12.7 / §2.6 / §7.1), and the
  propagation/boundary rule (proofs flow down) survived compiler contact as the downward
  call gate. Still theses: the finer scopes, the Tier-1.5 relational witness, and Tier-2
  Z3. The frontier-capability claim is sound on feature-composition; the *construct's* A+
  is argued (§3.6 re-grade); the type-core row holds **A**, not A+ — its remaining path is
  Tier 2 + the relational witness.
- **§4 hybrid + §5 redefinition**: rubric/mechanism reframings, *not* shipped work — they change
  *what we measure* and *how we'd build it*, not what exists. `ms*ms → Duration²` is a direct
  consequence of units-of-measure (F# is the existence proof).
