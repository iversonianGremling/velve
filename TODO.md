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
| Type system core (HM + refinements + dependent) | **A−** | TS, Elm, F#, Liquid Haskell | Refinements-as-transparent-base with free constant-folding is genuinely better ergonomics than all four; conservative skip keeps it honest. |
| UI / styling | **B+** | React+CSS, Elm, SwiftUI | Typed props, context-validity (`gap` on non-flex = error), real units, and **accessibility-as-proof** — an unreadable `color` on its resolved background now *fails to compile* (APCA Lc, opt-in `OnSurface`), not just a linter note — beat CSS's silent no-ops. Still held back by the element/call syntax duality (§2.1) and by theme/responsive/inputmap being design-only, so it stays B+ until §2.1 closes. |
| Event handling / state | **A−** | Elm, Redux, Rx, XState, Erlang/OTP | The four-primitive taxonomy (store/machine/stream/transaction + `persisted`) with a "what do I reach for" table is the best-explained state story in any draft language I know. `machine … persisted` + journal + `resume` is XState+Temporal in one construct. Gaps: backpressure unspecified, `await`-to-step-goto doesn't parse. |
| Error handling | **B+** *(2026.6)* | Rust `?`, Zig, Go | `?`/`?:`/`try`/`retry` cover the space well; the whitespace-keyed `?` (spaced = ternary vs glued = propagate, §2.2) — the draft's worst readability decision — is **gone from edition 2026.6**: the ternary was deleted in favour of `if c then a else b`, so `?` now carries one glued meaning. |
| Low-level | **B−** | Rust, Zig | Ptr/regions/outlives/move tracking are real and end-to-end. But unified `Number` vs. planned sized types vs. `Duration` dimensions vs. `Px` units = four numeric stories that haven't met each other (§3.4). `std/low`/gpu/audio are sketches. |
| Games / intensive interactive | **C+** (today) / **A−** (as designed) | Unity C#, Bevy ECS, Pony | `docs/interaction-model-design.md` (footprint = `mut` params, capability-keyed dispatch, `@interaction`/`@confined`) is a credible, novel answer to ECS — but nothing of it is implemented, there is no frame clock, and a tree-walking interpreter can't hold 60fps. The claim depends on the compiled target. |
| Animation | **C** (today) / **A** (as designed) | CSS, Framer Motion, SwiftUI | The `animated` modifier + mandatory motion-policy chokepoint ("motion you can't write inaccessibly") is a real differentiator no shipping system has. Entirely unimplemented; depends on `frames` + reconciler work. |
| Security model | **A−** | everything mainstream | Taint-at-parse (not at transport) is the right boundary and well-argued. `Effect` capability *enforcement* must match the spec's promise (§3.6). |

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
> unchanged because their named gaps are still open (UI: call-syntax duality + design-only
> theme/responsive; state: backpressure + `await`-to-step-goto; low-level/games/animation
> as noted). Re-grade a row only when a green fixture proves its gap closed.

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

- [ ] 🔴 Ship call-syntax **phase 2**: lower elements to `Call`, run the pattern
  codemod (`| Ok v ->` → `| Ok(v) ->`), delete the element-specific grammar.
- [ ] 🔴 **Delete curried juxtaposition** (`add 1 2`). Partial application via
  `add(1)` already covers the use case; juxtaposition buys nothing except a
  second thing to teach and a parser ambiguity with elements. (Keep type-level
  juxtaposition `List Number` or kill it too — but pick one and say so.)
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
- [ ] 🟡 Responsive prop-site auto-collapse is deferred — `Responsive(Length)`
  can't be used directly in a prop. Land it or remove `responsive` from the
  showcase examples.
- [ ] 🟡 The theme system (roles, `using`, `OnSurface` contrast refinement) is
  design-only while `std/color` is fully built — the color science has no
  consumer. Theme is the highest-leverage unbuilt UI piece.
- [ ] 🟡 Define when `OnSurface` contrast checking fires (inside vs after
  convergence) — currently "inside or after" hedging across two docs.
- [ ] 🟢 Bare-number → `Px` coercion is prop-position-only; `let x: Length = 8`
  behaves differently. Document this as a prop-context rule + add a checker hint.

### 3.2 Event handling / streams
- [ ] 🔴 **Backpressure is "drop by default" and otherwise unspecified**
  (SPEC §10.1, open question §14). For the game/animation claims this is
  load-bearing: dropped input events are unacceptable in an inputmap, dropped
  frames are fine. Specify per-stream policy (`drop | buffer N | block`) at
  declaration site.
- [ ] 🟡 `await` whose branches are step-gotos doesn't parse inside `machine`
  steps (SPEC §4.3 implementation note). Close the grammar gap — machines that
  can't consume streams idiomatically undercut the four-primitive story.
- [ ] 🟡 `inputmap` is locked-but-unbuilt (multitarget §4). It's the keystone of
  "event handling reads as a typed pattern-match"; until it exists, input is
  raw `await`+`match` loops.

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
  measure). That would turn three ad-hoc systems into one concept.
- [ ] 🟡 Resolve `Number` internal repr before the compiled target (overflow
  semantics, bit ops on floats — `mask & flag` in the fixtures is already
  doing implementation-defined work).

### 3.5 Error handling / absence
- [ ] 🟡 The no-`Maybe` stance is consistent and defensible, but every example
  pays the `Result T String` tax — stringly-typed errors everywhere. Add a
  conventions section + stdlib support for *named error ADTs* (and make
  `T.parse`/decoders return a structured error type, not `String`), so "absence
  is a named failure" produces names, not prose.
- [ ] 🟡 Fix the `try` soundness gap (blocks-design §12): a line whose type is
  an unresolved type variable later resolved to `Result` is unwrapped by eval
  but not by infer. Either monomorphize-before-try, reject polymorphic try
  lines, or warn.

### 3.6 Effects
- [ ] 🔴 Capability *enforcement* must match the spec's promise ("compiler
  verifies all effectful calls at definition site", §12.3) — the multitarget
  doc admits effects are "declared but not enforced." Honest effects that
  aren't checked are worse than none: they train readers to trust signatures
  that can lie.
- [ ] 🟡 Specify effect polymorphism for higher-order functions (what is the
  effect of `map(f, xs)` when `f` is effectful?) — currently absent from the
  SPEC and it's the first wall any real program hits.
- [ ] 🟢 Module-qualified calls (`Math.sqrt`) still don't resolve while all
  planned stdlib docs are written in qualified style. Land qualified resolution
  before the stdlib grows further.

---

## 4. Features to consider **deleting** (the refusal discipline, applied to syntax)

SPEC §4.0's "ship exactly one primitive per genuinely-distinct concept" is the
best thing in the document. The same razor, applied to the surface:

- [ ] 🔴 **Curried juxtaposition** `add 1 2` — covered above (§2.1). One
  application form.
- [ ] 🔴 **C-style ternary** `c ? a : b` — covered above (§2.2). Its removal is
  what makes `?` unambiguous.
- [ ] 🟡 **`pipe` block** — it is literally documented as "the point-free `|>`
  chain as a block," i.e. a second spelling of an existing feature, plus a new
  magic identifier (`ret`). Delete; multiline `|>` already works.
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
