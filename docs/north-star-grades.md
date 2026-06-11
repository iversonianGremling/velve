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
| **Type core** | A− | F★ / Liquid Haskell (SMT refinements); Idris / Lean (full dependent) | The A− is the **conservative skip** — Velve bails on hard obligations instead of discharging them. A+ route = the **opt-in proof gradient** (§3): structural/constructive tiers + `Proof [...]` obligation sets (proofs as the dual of effects), Z3 as the opt-in floor. *Not* "add a solver." (**User generics shipped 2026-06**, SPEC §2.12 — implicit def-signature type vars, polymorphic at call sites / rigid in the body; closed a silent trap where `def idy(x: a): a` parsed but `idy(5)` errored.) | **Design** — the skip is deliberate; A+ here means *gating* the frontier, not *refusing* it (§3.6). |
| **UI / styling** | A | SwiftUI (ergonomics) + Elm (purity); **no shipping language** has accessibility-as-proof | Ceiling already above the field. **§2.1 duality closed** (paren-form elements), the **theme system shipped 4/4** (typed `Surface` tokens → `using` clause → derived `Theme` record → `theme` read-only reactive root: `std/color` now has a real consumer; accessibility-as-proof fires on token, `using`-surface, computed, and live-root colours), and **responsive is built end-to-end** — closed `Breakpoint`, `Clamp` band, the read-only `viewport` root, the `responsive` keyword, and the **prop-site auto-collapse** of a `Responsive(Length)` against the live `viewport.breakpoint` (re-collapsing on `setViewport`, the viewport sibling of `setTheme`). Re-graded A− → **A** (2026-06): the prior hold was "responsive/inputmap design-only" — responsive is shipped, and `inputmap` is an input/event item (event-row §3.2). Residual is polish (compile-time vs runtime cycle detection; §2.1 handler/spread tail), not a pillar. | **Build** — A→A+ is table-stakes breadth (§2), not a single lever. |
| **Event / state** | A *(2026-06)* | Erlang/OTP + Temporal + XState — Velve already unifies all three | Both named gaps shipped 2026-06: per-stream **backpressure** (`drop`/`buffer N`/`block` at decl site, policy-exempt `Done`, `stream_policy_test`) and **`await`→step-goto** in machine steps (lowering fix, `machine_await_test` — the idiomatic stream-draining machine works). Re-graded A− → **A**. The `inputmap` **core shipped 2026-06** (SPEC §10.5, `inputmap_test`/`_bad`): typed pattern-match table over a stream, conflict analysis ("bound twice"/"shadowed" — the dual of exhaustiveness, as designed), labels retained, drain-loop runtime. **Help-as-derived-data shipped too** (`inputmap_help_test`/`_bad`): a dedicated `Inputmap` type + `help(map) : List({pattern, label})` — the auto-help differentiator's data layer, check-time-typed. **And `++` layering** (`inputmap_layer_test`/`_bad`): maps are values, `default ++ userOverrides` replaces-in-place/appends, cross-stream layering is a check error (the type carries the stream). **And chord-refinement literals** (`inputmap_chord_test`/`_bad`): `Push("Ctl+S")` is a check-time typo — the literal-pattern refinement fold, general to every match site. **And `keymap` sugar** (`keymap_test`/`_bad`): `keymap N` ≡ `inputmap N over Key`, proven by layering a keymap with a plain inputmap over `Key`. A→A+ residual: remaining breadth — std `Key` device library + physical-key prefix, focus-zone scoping, the *rendered* overlay element. | **Build** — inputmap breadth (the overlay element waits on the element-DSL render path; the Key library waits on a host keyboard source). |
| **Error handling** | A *(2026-06)* | Rust (`Result`+`?`+`thiserror`); Swift typed `throws`; Zig inferred error sets | B→B+ was readability (ternary deleted). **B+→A shipped 2026-06** (SPEC §2.6, `error_adt_test`/`_bad`): named error ADTs — prelude `ParseError { expected, got, detail }` returned by refinement `T.parse` and `parseNumber` (now real end-to-end; `Json.parse` structured at runtime); treating an error as a `String` is a *check error*, and the convention is map-at-the-boundary into a domain ADT (exhaustiveness-checked), which `examples/pipeline.velve` already practised. Residual prose-errors: `parseInt`/`parseFloat`/`String.toNumber`. The **§12 `try` soundness gap is also closed** (2026-06, `try_sound_test`/`_bad`): a Var-typed try line is re-judged after whole-module inference — late-Result or never-resolved lines are check errors, late-non-Result accepted retroactively. A→A+ is **inferred error rows** — see §4. | **Build** — row inference (§4), the one mechanism shared with effect-A+. |
| **Low-level** | B− | Rust (borrow + sized types); Zig (comptime) | Four numeric stories that never met + gpu/audio/std-low sketches. A+ = **F#-style units-of-measure** as the general mechanism + sized types built on it. See §5. | **Design** — the unifying note (TODO §3.4 🔴) is unwritten. |
| **Games** | C+ / A− | Bevy ECS; Unity DOTS | **100% gated on the compiled target** — a tree-walker can't hold 60fps. A+ = compiled backend + frame clock + `@interaction`. | **Build.** |
| **Animation** | C / A | SwiftUI animation; Framer Motion | `animated` + motion-policy chokepoint is unique, unbuilt. Ceiling is **A** not A+ — see §8 (choreography breadth). Blocked on `frames` + reconciler. | **Build + undesigned breadth.** |
| **Security** | A− | Capability-secure: Austral, Pony, Koka/Unison; IFC: Jif / Flow Caml | Taint-at-parse is the right cut. A+ = make `Effect` **enforcement** real (TODO §3.6). **The mechanism now is** (2026-06): direct calls checked (`effects_test`, pure-hole edition-gated) and the HOF laundering route closed (SPEC §12.4, `hof_effects_test`/`_bad` — latent effects of a function argument charge the call that supplies it; aliasing doesn't launder; fires for untyped and typed callees alike). Holding A− because the residual is *coverage*: runtime builtins without typed signatures carry no effects to check (typed-prelude/BUILTINS split), so the stdlib surface can still lie by omission. A− → A when the builtin surface is effect-typed; → A+ adds effect rows (§4). | **Build.** |

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

`@total` is cheap *because* termination ≈ structural recursion (a shape the compiler sees).
Sortedness has no syntactic shape, so a `@sorted` *verification marker* would have **no cheap
tier** — it falls straight to Z3 every time. Your two honest options for a semantic property
are **construct it** (smart-constructor `SortedList`, no solver, API ceremony) or **prove it**
(Z3, zero ceremony, readability tax).

### 3.3 The tiers

| Tier | Mechanism | Covers | Solver? | Status |
|---|---|---|---|---|
| 0 | Refinement + `.parse` boundary | literal/foldable checks | no | **built** (constEval) |
| 1 | **`@total`** (structural) + **correct-by-construction types** (`Natural`, `NonZero`, `Positive`, `InBounds(n)`, `SortedList`) | termination + **intrinsic** invariants (counts, div-by-zero, bounds) | **no** | `@total` design-not-built; refined types **not yet proposed** |
| 1.5 | **Witness tokens** — `checkBounds(i, xs) : Result(Index(xs), :oob)`, then proof-requiring ops | **relational** facts | no | needs 1 primitive (below) |
| 2 | **Z3 `std/proof`** — `proof.sorted`, `proof.terminates`, arbitrary predicates | semantic / termination residue, zero ceremony | **yes** | **proposed stub** (SPEC §std/proof) |

`@total` itself already mirrors this shape internally (`totality-design.md §3`): **Tier-1
structural** (recursion on a smaller arg, bounded loops) free and common-case; **Tier-2
`proof.terminates`** Z3 fall-through for `n/2`-style measures. And `@total` *pays back into the
type system*: a refinement predicate marked `@total` is **safe to fold every time** (totality
§5.1), shrinking the conservative-skip set the grade is capped by — the cheapest type-core
improvement on the board.

**Correct-by-construction, concretely:** make `Natural` opaque; the only gate from raw `Number`
is `Natural.parse(x) : Result(Natural, :negative)`; closed ops (`+`, `*`) return `Natural`;
faulting ops don't (`sub : Natural -> Natural -> Result(Natural, :underflow)`). A `Natural` is
then ≥ 0 **by construction** — not because a solver proved your arithmetic, but because you
*cannot build a negative one*. `NonZero` makes division total; `InBounds` makes indexing safe.
No solver. This is the **endorsed** "refinements transparent + explicit `.parse`" decision
(TODO §7) applied as a library. It needs a **trusted kernel**: closed ops assert their result
via `@unsafe{}` (the stdlib is the TCB).

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
| `bounds` | out-of-range indexing | `InBounds` + path facts | needs flow env (§3.1) |
| `nonzero` / `arith` | div-by-zero, partial arithmetic | refinement + path facts | needs flow env |
| `overflow` | silent numeric overflow | sized types (§5) | needs §5 |
| `exhaustive` | incomplete match | already built | **yes** |
| `handled` | unpropagated error | error rows (§4) | needs §4 |

What does **not** go in the list: value invariants like `sorted`/`positive` — those stay
**types** (`SortedList`, `Natural`), because they're properties of *values*, not *operations*.
That split is what keeps the vocabulary closed: **scope-proofs = "operations can't fault";
type-proofs = "values satisfy invariants."** The list is bounded by the fixed set of fault
kinds, exactly as §5.4 is bounded by the fixed set of capabilities.

**Honest rollout:** the *vocabulary* is fixed and small; the *implementations* land per
obligation. `total` and `exhaustive` ship now; `bounds`/`nonzero` need the flow-sensitive fact
env (§3.1 catch 1); `overflow` needs sized types (§5); `handled` needs error rows (§4). So
`Proof [...]` is a stable surface where each obligation is a checker capability arriving on its
own schedule — declare `proofs: [total]` the day totality lands, add `bounds` later. **The
grade moves per-obligation, not all-or-nothing** — which is also what makes it genuinely
"optionally good for whoever needs it": you opt into exactly the faults you care about.

### 3.5 The one primitive to confirm — module-private constructors 🔴

The entire construction tier is only *sound* if external code cannot reach a type's unchecked
constructor (only `.parse` + closed ops). Velve has opaque/named types (the `UserId`/`Named`
example, `blocks-design.md:824`) and `@unsafe{}`, but **whether a constructor can be made
module-private is unconfirmed.** This single feature decides whether Tier 1 is a pure-library
add or a small language change. **Check this first** — it gates 3.3 and 3.4's soundness.

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

Two honest reasons it's an A+ *thesis*, not a delivered A+:
1. **The hard-proof floor still costs what F★ costs.** Under `Proof [...]`, a listed obligation
   outside the SMT-tractable set (nonlinear, uninterpreted functions) is now a hard error —
   lemmas, timeouts. The construct buys *coherence and access*, **not cheaper hard proofs**; on
   the genuinely hard theorem, maxed-Velve = F★ and still trails Idris's *native* dependent
   ergonomics (the `Vec n` / `append : Vec n -> Vec m -> Vec (n+m)` flex stays clunkier).
2. **It's design-on-design-on-design, all unbuilt.** `Proof [...]` rests on `std/proof` (stub)
   resting on `@total` (design-not-built). A design grade discounts for "survived contact with
   a compiler"; none has, and the propagation/boundary rules (§3.4) are exactly the kind that
   bleed on impl.

**Definition of done** (converts the A into "optionally good for whoever needs it"):
1. 🔴 Confirm/add **module-private constructors** (§3.5) — gates everything below.
2. 🔴 Ship **Tier-1 `@total`** (structural) — also shrinks the conservative-skip set.
3. 🟡 Ship the **Tier-1 refined-type library** (`Natural`/`NonZero`/`Positive`/`InBounds`).
4. 🟡 Specify **`Proof [...]`** (§3.4) — the exhaustive fault vocabulary, the three scopes
   (mirroring `Effect [...]`/`capabilities:`), and the downward propagation rule — as the
   single-construct "what do I reach for" answer.
5. 🟢 Z3 **Tier-2** + relational witnesses — later, opt-in, for the semantic residue.

Do 1 → 2 → 4 and the type system *is* the opt-in spectrum, and the A+ thesis becomes
arguable. It will not, and shouldn't try to, win the field's A+ on *cheaper hard proofs* —
that path runs straight through the readability the language exists to protect.

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
- **Live design choice still open** — Type-core (the proof gradient + `Proof [...]` spec, §3),
  Error-handling (the infer-and-pin hybrid + row inference, §4), Low-level (units-of-measure,
  §5).

---

## 10. Evidence basis (honest)

- **"Ceiling above the field"** (a11y-as-proof, inaccessible-motion, footprint-in-signature):
  true on *feature-presence* — no shipping language has these. **Unproven on delivered-value**
  because the features are unbuilt. The ceiling is real; the floor is "does not exist yet."
- **A+ exemplar choices**: field/practitioner consensus, not controlled study — same caveat as
  `call-syntax-design.md §7`.
- **§3 proof tiers + `Proof [...]`**: *theses*, design-on-design, none built; the propagation/boundary rules
  especially is unproven against a compiler. The frontier-capability claim is sound on
  feature-composition; the *A+* claim is contingent on the coherence work, not on adding power.
- **§4 hybrid + §5 redefinition**: rubric/mechanism reframings, *not* shipped work — they change
  *what we measure* and *how we'd build it*, not what exists. `ms*ms → Duration²` is a direct
  consequence of units-of-measure (F# is the existence proof).
