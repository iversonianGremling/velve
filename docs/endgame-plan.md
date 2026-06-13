# Velve endgame plan — everything left, priced

*2026-06. Written to be self-contained for a reviewer who hasn't seen the rest
of the repo: read this top to bottom and you know what Velve is, what's done,
what's decided, what remains, in what order, and why.*

---

## 0. Context & ground rules

**Velve** is a tree-sitter grammar + TypeScript checker/interpreter for a
readable-by-default language with an opt-in proof gradient: HM inference,
refinement types, ADTs + exhaustiveness, effects-as-capabilities, sagas/
streams/machines/stores for state, an element DSL for UI, and a
`proofs: [...]` module obligation system discharged by a flow-sensitive fact
environment with a Z3 fall-through. Pipeline: `grammar.js → lower → resolve →
infer → exhaust → borrow → total → handled → facts → terminates → smt (async)
→ eval`. CLI: `node dist/index.js <check|run> <file.velve>` from `checker/`.

**The work cadence** (non-negotiable, inherited from the whole project): one
slice at a time, where a slice = (1) a green fixture — 0 check errors AND runs
with deterministic output; (2) a `_bad` twin with an exact expected error
count; (3) corpus baselines unchanged except the new rows (capture script
diffs check-error-counts and run-status for every fixture before/after);
(4) docs updated honestly (SPEC.md, TODO.md, PLAN.md,
docs/north-star-grades.md); (5) immediate commit with explicit path lists.
Grade rows re-grade only when a green fixture proves their named gap closed.

**Grades today** (north-star-grades.md §1): Type core **A+**, Error handling
**A+**, Security **A+**, Event/state **A**, UI/styling **A**, Low-level
**B−**, Games **C+/A−**, Animation **C/A**. The pattern: differentiators
nobody ships are built; what's owed is table-stakes breadth and the perf
substrate.

---

## 1. Decisions taken for this plan

These four were settled with the project owner (2026-06) and are inputs, not
open questions:

1. **Scope: everything priced.** Not just the designed board — the compiled
   backend is staged into milestones and the breadth tails are decomposed,
   accepting the estimates get rougher left to right.
2. **Sized types are range refinements, with a target-split.** On the JS
   target, `u8`/`i32`/… are check-time range refinements over `Number`
   (`u8 = Number where 0 <= value && value <= 255`) that **erase completely**
   at emit — `overflow` is a proof obligation, not a runtime behavior. The IR
   carries the width/signedness tag anyway, so a future native/WASM emitter
   lowers the same type to a real machine primitive. One surface, two
   representations, chosen per target.
3. **Backend: JS now, IR stays neutral.** Only the JS emitter gets built in
   this plan, but the IR bakes in no JS-isms (no implicit doubles-everywhere
   assumption beyond what `Number` already means, no DOM types in core IR,
   erasable judgments — units, refinements, error rows — dropped at lowering,
   not at parse).
4. **Ordering: finish the proof arc first** while the fact-env/Z3 machinery
   is warm; then numerics (worst grade); then infrastructure; backend phase
   after; breadth rides the backend.

---

## 2. Phase A — proof-arc completion (~6 slices)

The fact environment (`facts.ts`), Z3 back-end (`smt.ts`), and the
`proofs: [...]` vocabulary (`total bounds nonzero arith overflow exhaustive
handled`; **all 7 checkable as of 2026-06** — `arith` then `overflow` (B3(ii))
closed the set; `exhaustive` became always-on 2026-06, `vocab_cleanup_test`/`_bad` —
enforced regardless of declaration, the word kept for intent/back-compat) are
live. The Tier-1.5 relational witness
(`Index(length(xs))` dependent-refinement params: callers prove from path
facts, callees assume their signatures) just shipped. What's left in-arc:

- **A1. Witness gate spelling — binder seeding** *(1–2 slices)*. **FULLY
  SHIPPED 2026-06.** The `Ok`-payload half (`index_gate_test`/`_bad`): the
  Result gate `Result Index(length(xs)) e` carries the witness in return
  position — the callee proves each `Ok(payload)` in range (the gate can't
  lie), the caller seeds the `Ok`-binder of a `match`. **The `let`-direct half
  SHIPPED 2026-06** (`index_let_test`/`_bad`): a def returning a BARE
  `Index(length(xs))` (no `Result`, no Error escape hatch) is itself a gate —
  the tail-position guarantee check landed as `infer.tailExprs` (walk If/Match/
  Await/Do-block leaves) feeding `WITNESS_DEMANDS` over EVERY tail (the body is
  total, so each path must hand back an in-range index), and `bareWitnessRet`
  records the call in `WITNESS_RETURNS` so `facts.walkStmt` seeds the `let`
  binder — the `let` dual of the `match … | Ok(j)` seed in `walkBranch`. Both
  bridges pinned four ways in the `_bad` twin (construction overshoot, one tail
  unproven while its sibling proves, return relational pin, seed relational
  pin). Zero perturbation to the 193-row corpus. Original framing: Make
  `checkBounds(i, xs): Result(Index(length(xs)), :oob)` real: a dependent
  refinement in **return position** instantiates its `length(xs)` argument
  with the caller's actual binding, and the facts seed onto the binder —
  `let j = …` directly, and through `match … | Ok(j) ->` for the Result
  gate. Mechanism: infer records instantiated return-refinements per call
  site; facts.ts seeds match/let binders from them (needs pattern-binder
  type info or a side table keyed on AST nodes, same trick as
  `WITNESS_DEMANDS`). Mutation kills apply. If `let`-seeding and
  `Ok`-payload-seeding don't fit one slice, split exactly there.
- **A2. `arith` obligation** *(1 slice)*. **SHIPPED 2026-06**
  (`proof_arith_test`/`_bad`): the sixth vocabulary word — partial arithmetic
  domains, `sqrt(x)` needs `x >= 0`, `log/log2/log10` need `x > 0`,
  `asin/acos` need `-1 <= x <= 1`. Built exactly as predicted: a per-builtin
  domain table (`facts.ts ARITH_DOMAINS`) of one or two interval constraints,
  walked over both surface spellings (`Math.sqrt(x)` and bare `sqrt(x)`),
  discharged on the same floor + Z3 the other obligations already speak
  (`sqrt(a * a)` and `if a > b then log(a - b)` prove guard-free; out-of-domain
  model in the error). Scope-local. `proof_scope_bad`'s not-checkable pin moved
  `arith` → `overflow`, then B3(ii) retired it entirely. **Vocabulary 7/7 — complete.**
- **A3. Fractional-measure slice + binary-search showcase** *(1 slice)*.
  **SHIPPED 2026-06** (`proof_binsearch_test`/`_bad`): the floor-aware step
  turned out to need NO change to terminates.ts — the fix is to admit `floor(e)`
  into the translatable fragment (facts.ts `floorArg`) and model it in smt.ts as
  an Int-sorted term bracketed by `e − 1 < ⌊e⌋ ≤ e`, the same ToReal-wrapped Int
  trick as the `length` symbol. Integrality is what closes the gap: with
  `m = lo + floor(span/2)` the left half recurses on `⌊span/2⌋`, pinned to `0`
  for span ∈ [1, 2), which IS ≤ span − 1 — the existing "unit decrease over ℝ
  above a floor is finite" soundness covers it (no fractional-index detour
  needed; the indices stay integer because the recursion passes the floor). The
  showcase ships green under `proofs: [bounds, total]` on one function — `bounds`
  on the guarded read, `total` on the halving measure — and the floor term now
  serves `bounds`/`nonzero`/`arith` too. Original framing kept below.

  Probed during the SortedList arc: with `m = lo + span/2` the left-half
  measure fails over ℝ for span ∈ [1, 2); `m = lo + (span-1)/2` fixes the
  measure but leaves fractional indices. The slice: teach the
  `proof.terminates` measure translation a floor-aware step (the runtime
  floors indices; `0 ≤ i ∧ i < len ⟹ 0 ≤ ⌊i⌋ < len` is already the bounds
  soundness argument — the measure needs its analog), then ship the
  `bounds`+`terminates` binary search as the showcase fixture for the whole
  gradient.
- **A4. Finer proof scopes** *(1–2 slices)*. **PER-FUNCTION SHIPPED 2026-06**
  (`proof_fnscope_test`/`_bad`). The set-valued obligation list ships as a
  *trailing* `proofs: [...]` clause at the head of a function body (mirroring
  the module body head — the `proofs_decl` production reused verbatim), NOT the
  originally-sketched per-def `Proof [bounds] T` result brackets, which would
  have overloaded the return-type surface. Grammar change was purely additive
  (regenerate is deterministic — identical parser.c; corpus baselines held but
  for the two new rows + one cosmetic message reword). All four proof passes
  (`facts` bounds/nonzero/arith, `handled`) and the totality engine read the
  per-function obligation by OR-ing it into the in-scope test at each `DFn`; a
  sibling without the clause is unconstrained. **Per-block `@proof[...] { }`
  CUT for now** (OQ#3): the module + per-function scopes cover every fixture;
  block granularity would push the fact walkers below `DFn` granularity for no
  demonstrated need. **The sibling `effects: [...]` clause shipped alongside**
  (2026-06, `effect_clause_test`/`_bad`, SPEC §12.4): the same body-head shape
  for the up-flowing effect row, sugar for the inline `Effect [...] T` wrapper
  (rows union; the inline form stays for effect tails). So the function body
  head now mirrors the module body head exactly — `effects:` then `proofs:`,
  the duals of `capabilities:` then `proofs:`. **Construct-implied totality
  shipped too** (2026-06, `implied_total_test`/`_bad`, SPEC §12.6): pure
  structural roles — refinement predicates and store reducers — get the §12.6
  totality check from their position with no `@total` marker (predicates join
  `totalNames`; reducers are synthesized as one-clause DFns). Corpus-safe by a
  full sweep (every predicate fn is already `@total`/builtin, every reducer body
  is structural compute); the work also fixed `checkHofArg`'s stale fn-first
  assumption to the data-first convention. Game `update` is the third such role,
  deferred to Track C with the interaction model.
- **A5. `sortBy` infer/eval reconciliation** *(1 slice, small)*. **SHIPPED
  2026-06** (`sortby_test`/`_bad`). The divergence was total: infer typed
  `sortBy(xs, keyFn)` (list-first, one-arg key) while eval read `args[0]` as a
  two-arg comparator and `args[1]` as the list — so every type-checking call
  crashed at runtime. Reconciled onto the **key-fn form**, fixing the **eval**
  side: the actual codebase convention is data-first, not fn-first (`listMap`/
  `listFilter` are `(list, fn)` and chain under `|>`), so infer's signature was
  already right and consistent — eval was the outlier. eval now reads
  keys once up front (decorate–sort–undecorate), then a stable insertion sort by
  the extracted key; a new `keyGt` orders num-or-string keys with the same rule
  as the `<`/`>` operators (`cmpOp`). Green pins both number and string keys
  (identity/negated/distance, lexicographic); the `_bad` pins exactly 3 errors —
  the old comparator convention is now a type error in both ways (two-arg key fn;
  comparator-first arg order). NB: eval.ts contains a non-UTF8 byte — edited via a
  latin1 node script so offset 3509 is preserved byte-for-byte.

**Exit:** vocabulary 7/7 checkable as of B3(ii) (2026-06), the witness flow
complete in both positions, the showcase fixture exists, the one known
infer/eval divergence closed.

---

## 3. Phase B — numerics & low-level (~6 slices)

Low-level is the worst grade standing (**B−**). The north-star redefinition
(§5): the A+ axis is **units-of-measure as the general mechanism + sized
types**, not eight scattered numeric sketches.

- **B1. Unified numeric/dimension design note** *(1 slice, doc)*. **SHIPPED
  2026-06** (`docs/numeric-dimension-design.md`; the unchecked PLAN box is now
  checked). Settled, in writing, with the two reviewer-input decisions taken:
  `Number` stays the one runtime numeric on JS; sized types are range
  refinements over `Number` + an IR width tag (erase-on-JS /
  primitive-on-native); units are a **new `{ tag: "United", base, dims }` Type
  variant** — a check-time shape discipline the solver never sees (NOT
  transparent to base, so `m + s` errors), erased on every target. **Reviewer
  decisions:** (1) unit SYNTAX is refinement-flavored `type Meters = Number unit
  m` / `type Velocity = Number unit m/s` (over F#-style angle brackets — those
  collide with comparison/`Named`-args in the GLR grammar; over constructor-only,
  which gives no `m/s` composition); (2) conversions are **explicit-casts-only**
  (no silent coercion across dimension/width; literals default dimensionless and
  coerce into an annotated `Number`-based type, range-folded at check time). The
  note carries the rest-of-B slice plan (B2 i/ii/iii, B3 i/ii).
- **B2. Units of measure** *(2–3 slices)*. The algebra: `*`/`/` add/subtract
  exponent vectors, `+`/`-`/comparison require equal units, unitless
  literals coerce via constructors (`meters(5)`) or annotation. Pure
  infer-side judgment carried like `Refinement` (transparent? NO —
  units must NOT be transparent to base, unlike refinements: adding `m` to
  `s` must error. New `Type` variant `{ tag: "United", base, dims }`).
  Slice split: (i) algebra + decl surface + arithmetic rules; (ii)
  conversions, `Math.*` interplay (sqrt halves exponents), fixtures incl.
  the classic `ms*ms → Duration²` pin; (iii) std unit library if wanted.
  Erases at lowering (today: eval never sees types — free).
  - **B2(i) SHIPPED 2026-06** (`uom_test`/`uom_bad`, SPEC §2.15). The
    `{ tag: "United"; base; dims; name? }` variant landed with `dims` a
    normalized atom→exponent vector (the canonical identity — `m/s` ≡
    `Velocity`; the solver never sees it). Grammar: a `unit_clause` tail on a
    `Number` type alias (`type Velocity = Number unit m/s`), a flat
    signed-factor form (`m/s^2` → `[{m,1},{s,-2}]`), additive — corpus parser.c
    regenerates clean, zero baseline change but the two new rows. Algebra in
    `inferBinOp`: `*` adds / `/` subtracts exponents (a cancelled dimension
    collapses to bare `Number` — the `400ms/100ms` win generalized), `+`/`-`
    require `dimsEqual`, scaling by a scalar (`m * Number`) keeps the dimension.
    `unify` compares two `United` by dims and lets `United`-vs-base fall through
    to the mismatch error — that IS the explicit-casts-only rule (a `Number` is
    not a `Meters`). **Duration left untouched** (still a `Named` type, `ms*ms`
    still errors): folding it into the algebra so `ms*ms → Duration²` is the
    B2(ii) showcase. Deferred to a later slice with conversions: unit-value
    construction (constructors / literal-defaulting), so B2(i)'s fixture
    validates the compile-time algebra through unit-typed defs and runs on the
    erased (plain-`Number`) semantics.
  - **B2(ii) SHIPPED 2026-06** (`uom2_test`/`uom2_bad`, SPEC §2.15). **Duration
    folded into the algebra**: a `100ms` literal now *is* a `United{s:1}` value,
    so the `isDur` special-cases in `inferBinOp` deleted outright — `ms*ms : s^2`
    (the showcase pin, once an error), `400ms/100ms : Number`, `1/30s : s^-1` all
    fall out of the general `*`/`/` rules. **Math interplay**: a `unitMathCall`
    intercept on the `Math.*` builtins — `sqrt`/`cbrt` scale exponents (non-even
    → error), `abs`/`round`/`sign` preserve, `min`/`max`/`clamp` demand one shared
    dimension, transcendentals demand dimensionless; fires only when an argument
    is United, so plain-Number Math is byte-identical (baseline diff: only the two
    new rows). **Conversions**: the `Duration` stdlib module (`fromMs`/`fromSeconds`/
    `toMs`) retyped to the shared `United`, becoming the explicit Number↔Duration
    bridge (runtime identity). Still deferred: a *general* unit-value constructor /
    literal-defaulting surface (B2(iii) / design §5) — Duration has its bridge,
    other units are still params-only.
- **B3. Sized types + the `overflow` obligation** *(2 slices)*. (i) The
  stdlib range-refinement family (`u8 i8 u16 i16 u32 i32`) with gates
  (`u8(n): Result u8 String`) and closed ops — mirrors the
  refined-types library pattern exactly (gates / closed ops / faulting ops
  through the gate), plus the IR width tag spec'd in B1.
    - **B3(i) SHIPPED 2026-06** (`sized_test`/`sized_bad`). The family ships as
      a stdlib `where`-refinement library over `Number` (`type U8 = Number where
      0 <= value && value <= 255`, …) with the lowercase gate `u8(n): Result U8
      String` — exactly the refined-types pattern (gate is the only way in,
      faulting ops back through the gate, the always-succeeds widening cast still
      written), and so transparent to `Number`. Type names are `upper_id`, so the
      family is `U8`…`I32` / gates `u8`…`i32` (the same `Natural`/`natural` split;
      the idealized lowercase `u8` *type* from B1 §3.1 isn't grammatical, noted as
      built). The **IR width tag** is a name-derived `{ bits, signed }` on the
      `Refinement` type — inert at runtime, the Phase-D down payment and what
      `overflow` reads; its check-time teeth are the §4 no-coercion-across-widths
      rule (two *different* widths don't unify without an explicit cast, even
      though both are transparent to `Number`). The bounds family rides the
      existing compile-time literal fold (`takesU8(300)` is a check error). Pure
      add bar the width tag + the width-boundary unify branch (baseline diff: only
      the two new rows; the branch fires only when both sides carry a width, which
      no corpus file does). Still deferred to B3(ii): the `overflow` obligation.
  (ii) The seventh
  vocabulary word: under `proofs: [overflow]`, every arithmetic op whose
  operands carry a width must prove the result in range — same fact-env +
  Z3 pipeline as `bounds` (interval floor for literal/guarded cases, solver
  residue with the model in the error). **Vocabulary complete: 7/7.**
    - **B3(ii) SHIPPED 2026-06** (`proof_overflow_test`/`_bad`). Under
      `proofs: [overflow]` every `+`/`-`/`*` whose operands carry a width tag
      runs the SAME two-sided Z3 query as `bounds`, against the width range
      (unsigned `[0, 2^bits−1]`, signed `[−2^(bits−1), 2^(bits−1)−1]`) instead of
      a list length. Each width-carrying param **seeds** its range (`0 ≤ a ≤ 255`
      for `a: U8`, the assume side of the gate's guarantee), so a guarded op
      proves and the unguarded one reports the out-of-range model. As built: the
      width tag rides only ascribed PARAMS, so an operand is always a name — the
      result never folds to a constant, the proof is inherently relational, and
      the floor forwards every translatable result to Z3 (the B1 "interval floor
      for the literal case" is vacuous, noted as built). Width is lost on
      intermediate results (`(a+b)+c` checks only the inner op — Phase D's native
      lowering propagates it); div / unary-minus INT_MIN corner deferred. The
      lower.ts not-yet-checkable guard is now a forward safety net only (all 7
      checkable). Baseline diff: the two new fixtures, plus the two anticipated
      re-pins (`proof_scope_bad`/`proof_fnscope_bad` — which the fixture comments
      *predicted*, "this pin was bounds, then arith, …" — flipped from the
      not-checkable error to a REAL overflow, each held at its 5-error count).

**Exit:** Low-level re-grades B− → **A−** by the row's own definition (the
two named mechanisms shipped; the held-back + is the native representation,
Phase D's neutral IR being the down payment). The proof vocabulary closes.

---

## 4. Phase C — infrastructure (~4 slices)

- **C1. Multi-file imports (SPEC §7.3)** *(2–3 slices)*. The biggest
  non-backend infrastructure gap: the refined-type/SortedList libraries
  travel by copy-paste inclusion today.
  - **(i) Resolution + check — DONE 2026-06** (`loader.ts`,
    `import_refined_test`/`import_private_bad`/`import_refined_lib`). A loader
    parses+lowers the entry file and every `./`/`../` module it imports
    transitively, merging their decls into ONE program (imported-first, deduped
    by abspath, cycles rejected). **As-built — the merge does all the work:** a
    `module Foo { … }` in the merged decl list is exactly what a single-file
    program already produces, so resolve/infer/exhaust/eval run *unchanged* —
    the registries (REFINEMENTS, FN_PARAMS, ADT_CTORS) become per-program for
    free, and `@private` ctors stay sealed across files via the existing
    `privateTo`/moduleStack check (the `_bad` proves it: a forged ctor outside
    its file goes from "unresolved" pre-loader to "private to module"
    post-loader). The file-local `DImport` is marked `local` so resolve/infer/
    eval skip its placeholder binding. *Honest:* the green consumer's *check*
    passes pre-loader too (lenient `Unknown` for unknown imports/types), so the
    behavioral proof is `run` (pre-loader dies `undefined variable: natural`).
  - **(i) rider — unresolved imports are errors — DONE 2026-06**
    (`import_unresolved_bad`/`import_foreign_test`). Closes the honesty gap
    above: a path that resolves to no stdlib module, no file, and isn't a foreign
    `import js` is now a hard error ("cannot resolve import"), and a braced named
    import of a missing export is "module 'M' has no export 'x'" — rather than
    binding the name to `Unknown` and type-checking clean. Invariant: `Unknown`
    is the post-diagnostic recovery type, minted only after an error (the one
    exception, `import js` foreign interop, is opaque by design). Side benefit:
    `import_refined_test`'s *check* now depends on the loader too. Two small
    AST flags (`foreign`, `named`) carry the brace/`js` info lowering discarded.
  - **(ii)** eval loading + CLI multi-file entry — largely falls out of (i)
    (the merge already makes `run` work end-to-end on the consumer).
  - **(iii)** `std/` on disk — `std/refined`, `std/sorted`, later `std/units` —
    and the corpus migrated off inclusion. Selective visibility (only the listed
    names, vs the current flatten-on-merge) is a tightening here. LSP follows.
- **C2. `is Ok(a)` payload binding / flow narrowing** *(1 slice)*. The
  optional PLAN box: `if x is Ok(a)` binds the payload in the then-branch
  (and feeds the fact env — cheap synergy with A1's binder seeding;
  sequence C2 after A1 to reuse the mechanism).
- **C3. Convergence-cycle pre-flag** — PLAN's own annotation says lowest
  ROI. **Recommendation: cut it** unless a real fixture motivates it;
  carrying it forever as an unchecked box is worse than deciding.

**Exit:** libraries are real artifacts; the designed board (north-star §9's
"live design choices") is fully closed except the backend.

---

## 5. Phase D — the compiled backend (a phase, not slices; ~20–30 slice-equivalents)

100% gate for Games and Animation, the perf ceiling under UI. Design note
exists (`compiler-architecture-design.md`) — **D0 revises it** against
Decisions 2–3 (target-neutral IR; erasure point for units/refinements/rows;
width tags; what survives to runtime).

- **D1. IR + compute-core JS emitter** *(5–8)*. Fns, ADTs, match
  compilation, lists/records/closures, the pure builtin surface. The
  existing corpus is the differential test suite: every fixture runs under
  eval AND compiled, outputs diffed — the baseline script generalizes to a
  three-column capture (check / run-eval / run-compiled). eval.ts becomes
  the reference semantics, never deleted.
- **D2. Effects & concurrency runtime** *(5–10)*. Sagas (compile to state
  machines or generators — generators are the natural JS target),
  `go`/`race`/`after` on a scheduler, streams + backpressure policies,
  machines, stores/messages, virtual time (`sleep` semantics must match
  eval exactly or differential testing drowns in noise).
- **D3. Reactive UI** *(5–10)*. The element DSL → DOM render path compiled;
  the reconciler (which Animation's presence work needs hooks into — design
  them now, see E3); keyed-list virtualization (UI row's perf substrate).
- **D4. Frame substrate** *(2–3)*. `frames` clock, `@interaction`, the
  60fps loop — the things Games/Animation name explicitly.

**Exit:** Games C+ → **A−/A** (its row: "compiled backend + frame clock +
`@interaction`"), Animation's substrate gate lifts, UI virtualization
unblocks. Honest unknown: D2 is the widest variance — sagas/streams
semantics are the subtlest part of eval.ts.

---

## 6. Phase E — breadth tails (~25–35 slices, roughest estimates)

Parity work; almost none of it needs novel design. Sequenced after/with D
because chunks are blocked on it.

- **E1. UI table-stakes** *(~10–14)*: real Grid (tracks/areas/template,
  1–2); positioning/z-index/overflow/clip (1–2); aspect-ratio/object-fit
  (1); forms ecosystem — input types, validation wiring, controlled
  patterns (2–3); typography/i18n — truncation, rich text, RTL, font
  loading (2–3); media — srcset/lazy/icons (1–2); nested/scoped themes +
  per-component overrides (1–2). Each is a normal slice (fixture + `_bad` +
  render assertions). Virtualization lands in D3.
- **E2. Inputmap residuals** *(~3)*: std `Key` device library +
  physical-key prefix (needs a host keyboard source — D3 territory);
  focus-zone scoping; the rendered help-overlay element (its data layer,
  `help(map)`, already ships — this is the pixel side, needs the render
  path).
- **E3. Animation choreography** *(~9–12, design-first)*: (i) a
  choreography design note — presence/exit (reconciler must defer unmount),
  FLIP/shared-element (needs geometry read-back, currently excluded),
  timeline/stagger orchestration, gesture-coupled springs with velocity
  handoff — this is the one genuinely UNDESIGNED area left (1–2 doc
  slices); then presence (2), timeline/stagger (2), gesture coupling (2),
  FLIP (2–3). Ceiling per §8: row reaches **A**; A+ deliberately not
  chased.
- **E4. Canvas S2–S5** *(2–4)*: font metrics, alpha/gradient compositing,
  dynamic-text bounds, MaxSMT placement repair — the deferred legibility
  stages.

---

## 7. Dependency graph

```
A1 binder seeding ──→ C2 is-Ok narrowing
A3 measure facts ──→ binary-search showcase (same slice)
B1 design note ──→ B2 units ──→ (std/units after C1)
B1 design note ──→ B3 sized types ──→ overflow (7/7)
B3 IR width tag ──→ D0/D1 IR design honors it
C1 imports ──→ std/ distribution of every library
D0 IR ──→ D1 ──→ D2 ──→ D3 ──→ D4
D3 render path ──→ E2 overlay/Key, E1 virtualization already in D3
D3 reconciler hooks ──→ E3 presence/FLIP
D4 frames ──→ Games re-grade, E3 anything timed
```

Phases A–C are strictly serializable at the slice cadence with zero blocking
on D. D can start (D0, the doc revision) any time after B1 settles the IR
questions.

## 8. Totals & expected grade movement

| Phase | Size | Grade movement |
|---|---|---|
| A proof arc | ~6 slices | Type-core A+ deepens; 6/7 obligations |
| B numerics | ~6 slices | Low-level B− → A−; 7/7 obligations |
| C infra | ~4 slices | (enables; no row moves) |
| D backend | ~20–30 | Games C+ → A−/A; Animation gate lifts |
| E breadth | ~25–35 | UI A → A+ trajectory; Event/state A → A+; Animation → A |

Designed board (A+B+C): **~16 slices**. Everything: **~60–80**. The honest
near milestone is end-of-C: a complete, internally consistent,
fully-graded *design* with every named gap closed or explicitly priced —
the backend and breadth are then build phases, not open questions.

## 9. Open questions for review

1. **Unit syntax** (B1): refinement-flavored `Number unit m/s` vs F# angle
   brackets vs a `where`-clause spelling — weigh grammar-impact (tree-sitter
   regen risk) against readability.
2. **Units and type inference**: annotation-only (units never inferred onto
   unannotated defs) is the conservative v1 — is full unit polymorphism
   (`def double(x: Number unit u): Number unit u`) worth it, given user
   generics already exist?
3. **Per-block `@proof[...]{}`** (A4): keep or cut? The module scope has
   covered every fixture; per-def brackets may be enough forever.
4. **IR shape** (D0): ANF vs CPS-for-sagas vs generators-as-primitive —
   compiler-architecture-design.md leans where? Generators make D2 cheap on
   JS but bake in a JS-ism the neutral-IR decision forbids at the IR level
   (fine at the emitter level).
5. **Differential-testing harness** (D1): three-column baseline (check /
   eval / compiled) vs golden-output files per fixture.
6. **Import syntax** (C1): SPEC §14's sketch vs module-path-as-string;
   how `@private` and `proofs:` interact across files (a proved module
   imported into an unproved one keeps its guarantees — state this).
7. **`Key` host source** (E2): browser-only (DOM events via D3) or also a
   terminal source for the CLI runtime?

## 10. Exit criteria

- **Phase A done** = binary-search fixture green under
  `proofs: [bounds, total]`-equivalent + gate-spelling fixture green +
  `arith` in the checkable list + sortBy divergence closed. **All four met
  (2026-06)** — `proof_binsearch_test`, `index_gate_test`, `proof_arith_test`,
  `sortby_test`. The A1 `let`-direct tail-position follow-on also shipped
  (`index_let_test`/`_bad`). What remains in-arc is optional/deferred: A4
  (finer proof scopes, possibly cut).
- **Phase B done** ✅ (2026-06) = `proofs: [overflow]` fixture green with a Z3
  model in the `_bad` (`proof_overflow_test`/`_bad`); `ms*ms → Duration²` pin
  green; Low-level row re-graded with the fixture named. B2(iii) general
  `std/units` is the only optional remainder, deferred to after Phase C imports.
- **Phase C done** = `std/refined` imported (not included) by a green
  fixture; corpus baselines hold through the registry refactor.
- **Phase D done** = every corpus fixture's compiled output ≡ eval output;
  a 60fps fixture exists and holds frame budget in a real browser.
- **Phase E done** = the named lists in E1–E4 each have a green fixture or
  an explicit cut recorded in this file.
