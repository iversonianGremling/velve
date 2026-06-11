# Inferred error rows — design note

*Status: design (2026-06). Not built. This is the north-star §4 decision
("infer internally, pin at module boundaries") worked out to the level where
implementation can be sliced. Error-A+, effect-A+, and precise HOF effect
polymorphism converge on this mechanism — but **not all at once**; see §6.*

## 1. The problem, concretely

Today `?` unifies the propagated error type with the enclosing declared error
type. Two callees with different error ADTs cannot coexist under one `?`:

```
def both(): Result Number AError
  x = fa()?          -- fa raises AError: fine
  y = fb()?          -- fb raises BError: "expected AErr(String), got BErr(Number)"
  Ok(x + y)
```

The composition tax is what forced every example toward `Result T String`
(prose errors) before the named-error-ADT slice, and still forces the
map-at-the-boundary convention (SPEC §2.6) on *every intermediate def*, not
just at real boundaries. Zig's insight: inside a component, the error set is
*derived*; only the edge needs a reviewed contract.

## 2. The decision, restated as semantics

- **Inside**: a def may elide its error type. Its error set (a **row**) is
  computed from its body: the union of the rows of everything it propagates
  with `?` (and everything it returns via `Error(...)`).
- **Edge**: a def with an *explicit* error ascription is a **pin**. Where an
  inferred-row def is consumed by a pinned def, the row must be covered by
  the pinned type, or it's a check error listing exactly the escaping
  constructors. Public surface stays reviewed prose-free names; internals pay
  zero threading tax.

## 3. The row model (v1: transitive sets, NOT row-polymorphic HM)

The honest scoping decision: **v1 is Zig-shaped, not OCaml-shaped.** A row is
a closed, finite set of constructor entries:

```
Row = { ctorName -> payloadType, ... }
```

computed bottom-up over the call graph — there are **no row variables** in
v1. This avoids extending the HM core at all: rows never unify with rows;
they only (a) accumulate by union at `?` sites inside row-inferred defs, and
(b) get *checked for inclusion* against a pinned ADT's constructor set. Velve
already compares constructors across ADTs by name (constructor sharing,
edition-gated) and keys exhaustiveness by scrutinee type — both reusable
here.

Row entries come from named constructors only. A callee whose error type is
`String` (the prose residual: `parseInt` etc.) contributes the pseudo-entry
`String` — rows don't launder prose into names; a pinned boundary cannot
cover it and says so ("'parseInt' raises prose 'String' — match it out or
use a structured parser").

**What v1 deliberately does not do:** open rows, row variables, effect rows,
HOF error polymorphism. The §4 "one mechanism, three scorecard rows"
convergence happens at v2 (§6) — v1 builds the row *representation*,
*accumulation*, and *boundary check* that v2's row variables will ride on.

## 4. Surface

One new spelling, additive (no edition gate needed — nothing existing
changes meaning):

```
def step(): Result Number _      -- `_` = infer my error row
  a = parseNumber(raw)?          -- row += ParseError
  b = lookup(a)?                 -- row += NotFound
  Ok(b)

def api(): Result Number AppError  -- the pin: explicit = contract
  v = step()?                      -- check {ParseError, NotFound} <= ctors(AppError)
  Ok(v)
```

- `_` is legal **only as the error argument of `Result`** in a def return
  ascription. Not for param types, not for the ok type, not elsewhere — the
  grammar gets a `wildcard` in exactly that slot (the node type already
  exists for patterns).
- **No anonymous union ascriptions** (`Result T (A | B)`). The pin must be a
  *named* ADT — names at the edge is the whole point, and anonymous unions
  would reintroduce structural prose with extra steps. (Revisit only if real
  programs show pin-ADT proliferation.)
- Pinning rule: ctor-set inclusion. Every row entry must be a constructor of
  the pinned ADT with a unifiable payload. The diagnostic lists the escapees:
  "error row {NotFound(String), Timeout(Number)} is not covered by 'AppError'
  — missing Timeout(Number)".

## 5. Mechanics through the pipeline

- **lower/grammar**: `wildcard` in the Result-error slot of `simple_type`;
  lowers to `TRNamed "_"`-equivalent marker on the sig.
- **infer**: a def with the marker gets return type `Result(T, ErrRow(own))`
  where `ErrRow` is a new internal Type tag carrying the set. `?` inside it
  unions the callee's error contribution into the set instead of unifying.
  `?` inside a *pinned* def consuming a row-typed Result runs the inclusion
  check (and then behaves as today). Defs are processed in dependency order;
  **recursion among row-inferred defs is an error in v1** ("recursive
  inferred error set — pin one def in the cycle"), exactly Zig's restriction,
  with the fixpoint as a later polish slice if wanted.
- **exhaust**: matching a row-typed scrutinee checks exhaustiveness over the
  row's ctor set — rows are *matchable* without ever naming an ADT (this is
  where "exhaustiveness over the actual raised set" beats declared-E).
- **eval**: zero changes. Rows are check-time only; runtime error values are
  already plain ctor values.
- **display**: rows print as `{Ctor1(T) | Ctor2 | ...}` in diagnostics only;
  they never appear in stored signatures (the boundary is always a named
  ADT or a `_`).

## 6. v2 — row variables (the convergence)

OCaml-style open rows + row vars is what makes `map(f, xs)`'s error/effect
*precise* instead of conservative: `map : (a -> b ! e, List(a)) -> List(b) ! e`
— the HOF's row is its argument's row. That subsumes:
- the conservative latent-argument effect rule (SPEC §12.4) as the
  closed-row case,
- effect-A+ (inferred effect sets use the same accumulate-and-pin shape:
  effects are already per-call unioned sets — a row in everything but name),
- error-A+ beyond v1 (HOFs that thread callbacks' errors).

v2 is a genuine HM extension (row unification, occurs over tails) and waits
until v1's representation is proven in fixtures. Do not start with v2.

## 7. Build plan (fixture-provable slices)

1. **S1 — row + `?` accumulation + pin check.** Grammar `_`, ErrRow tag,
   union at `?`, inclusion at pins, dependency-order walk, recursion
   rejected. Fixtures: green (two unrelated error ADTs composing under one
   `_` def, consumed by a pinned def), bad (escaping ctor listed; recursive
   `_` cycle; `_` outside the Result-error slot is a parse/check error).
   **✅ BUILT 2026-06** (SPEC §2.13, `error_rows_test`/`_bad`). As-built
   deltas from the sketch above: no dependency-order walk — defs check in
   module order and rows close by **end-of-module fixpoint** over recorded
   ⊇-edges (the same defer-then-judge shape as the try-soundness sweep), with
   pins also deferred to finalize; cycle detection is DFS over the edge graph.
   Generic unify treats a row vs a named error as accumulate-into-row (sound
   over-approximation; covers direct `Error(ctor)` returns), and the pin path
   skips the error-side unify so a pin never pollutes the callee's row for its
   other consumers. Discovered residual: when a pin ADT re-declares a shared
   ctor name, expression-position *construction* resolves to the last
   declaration of that name — **fixed by the S3 shadowing slice (below)**.
   Var/Unknown callee errors contributed nothing — the documented S1
   leniency, **closed by the S3 late-contribution slice (below)**.
2. **S2 — match/exhaustiveness over rows.** Green: match a row-typed value
   with exactly the raised ctors, no wrapper ADT. Bad: missing-ctor match.
   **✅ BUILT 2026-06** (`error_rows_match_test`/`_bad`). As built: arms are
   recorded at the Match site and judged in finalizeRows after rows close
   (same defer as pins); a ctor pattern against a row types its payload from
   the ctor's own scheme and **never unifies with the row** (a match must not
   widen what a def raises). Three verdicts: row entry unmatched without
   catch-all → missing; arm ctor outside the row → "can never match"; prose
   entries are coverable only by catch-all. Guarded arms conservatively cover
   nothing. exhaust.ts needed no changes — it judges the Result level only
   and never descends into the error payload, so the two passes compose.
3. **S3 — diagnostics + prose interop.** Row pretty-printing, the `String`
   pseudo-entry story, fix-its naming the smallest covering ADT edit.
   **Shadowing slice ✅ BUILT 2026-06** (`ctor_shadow_test`/`_bad`):
   expected-type-driven resolution of shared ctor names. Expression-position
   uses of a name with ≥2 owner ADTs are deferred behind fresh vars (the
   same defer-then-judge shape as pins/row-matches) and judged in
   finalizeRows step 0 — the substitution shows which ADT the context
   demanded; a use whose context turned out to be a row contributes via the
   generic accumulate rule for free. Patterns pick by scrutinee type (as the
   outcome/Async prelude pre-cases already did), and a ctor pattern against
   a row prefers the **row entry's payload** (the contributing ADT) over the
   env's last declaration. Declaration order of sharing ADTs no longer
   matters.
   **Late-contribution slice ✅ BUILT 2026-06** (`row_late_test`/`_bad`):
   the S1 Var leniency is closed with the same defer-then-judge shape — a
   `?` site whose callee error type is still a Var (a forward call to a def
   with unascribed params, or an unannotated module-level `let` lambda) is
   recorded in `pendingRowContribs` and re-judged in finalizeRows step 0.5
   (after shared-ctor uses bind their vars, before the cycle check and
   closure, so a Var that resolved to another row adds a real ⊇-edge and
   resolved entries propagate). A type that never becomes contributable is
   REJECTED, not dropped — still-a-Var ("never resolved — annotate the
   callee or pin this def", e.g. a multi-clause callee whose Unknown type
   binds nothing) and concrete non-ADTs ("resolved to 'Number', which has no
   named constructors") are check errors; only `Unknown` itself, the
   checker's explicit give-up type, stays lenient. Under S1 all of these
   silently under-approximated the row and pins passed vacuously.
   **Fix-it slice ✅ BUILT 2026-06** (`row_fixit_test`/`_bad`): a failing
   pin names the smallest edit that would make it hold — an already-declared
   ADT covering the whole row is offered as a re-pin ("fix: pin with
   'WideError' (it covers this row)", smallest ctor count wins), and the
   missing variants are spelled in declaration syntax ("add Boom Number to
   'AppError'"). Both can appear together; prose escapees suppress the
   re-pin suggestion (nothing declared can cover prose) and keep
   match-it-out as the fix. The green fixture is the bad fixture's case (1)
   with the suggested re-pin applied — proving the suggestion actionable.
   Remaining S3: mixed-arity shared names and never-resolving ctor-use
   contexts keep last-declaration-wins. The mixed-arity case turned out not
   to be check-side work at all: eval binds each ctor name ONCE — a builtin
   function when it takes a payload, a bare `VCtor` value when nullary
   (eval.ts ~309–311) — so a single runtime binding cannot serve a payloaded
   owner and a nullary owner simultaneously. Closing it needs an eval
   redesign (hybrid ctor values, or expected-type-driven lowering); out of
   scope for rows v1.
4. **S4 (v2) — row variables** for HOF error/effect polymorphism; replaces
   SPEC §12.4's conservative rule with precision.

Each slice keeps the corpus baselines untouched: `_` is additive, and no
existing fixture uses it.
