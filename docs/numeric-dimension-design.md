# Numerics & dimensions — one algebra, four manifestations

Status: **DESIGN (2026-06, Phase B slice B1)** — the unifying note the Low-level
row (north-star §5) names as its blocker. No code yet; this note settles, in
writing, the decisions B2 (units of measure) and B3 (sized types + the
`overflow` obligation) build against. Companion to SPEC §2.1 (`Number`), §2.6
(refinements), §3.13 (numeric literals), §11.3 (`Length`), the totality note
(§5 the `Number ≠ Nat` caveat), and the endgame plan §3 (Phase B).

---

## 0. The problem this closes

Velve grades **B− on Low-level** for one reason: it has *four numeric stories
that never met*.

| Story | Where | What it is today |
|---|---|---|
| `Number` | SPEC §2.1 | the one runtime numeric (compiler picks Int/Float on JS) |
| `Duration` | SPEC §3.13 | a hand-built dimension: `100ms * 3` ✓, `100ms * 50ms` ✗, `400ms / 100ms : Number` |
| `Px` / `Fr` / `Pct` | SPEC §11.3, styles §4.1 | a shipped `Length` ADT for layout, bare-number → `Px` coercion |
| `u8 … i32` / `Float32` | unbuilt | sized types, sketched, never specced |

North-star §5 already named the fix: **these are not four systems — they are one
dimensional algebra with four manifestations.** `Number` is the dimensionless
case; `Duration` and `Length` are dimensioned; sized types are
dimensionless-but-bounded. F#-style units-of-measure is the general mechanism;
sized types ride on the same `Number` substrate with a width bound. This note
makes that one thing, and pins the surface and the conversion rules so B2/B3 are
implementation, not redesign.

The tell that `Duration` is a one-off: **`ms * ms` is an error today.** Under a
real unit algebra it is *legal* → `Duration²`, exactly what a physics integrator
wants (`accel : Length / Duration²`). Generalizing turns that rejection from a
feature into a derived consequence of the algebra.

---

## 1. Three layers, one substrate

Everything below is a `Number` at runtime on JS. The type system carries three
*orthogonal* pieces of compile-time information on top of it:

| Layer | Type-system shape | Solver-visible? | Erases on JS? | Survives to native IR? |
|---|---|---|---|---|
| **Refinement** | `{ tag: "Refinement", base, pred, args }` (exists) | **yes** (a logical property — `value > 0`) | yes | as a width/range tag (B3) |
| **Unit** | `{ tag: "United", base, dims }` (**new, B2**) | **no** (a shape discipline, like effects) | yes | as a dimension id |
| **Width** | a refinement *plus* an IR width tag (B3) | yes (range is a refinement) | yes | as `i32`/`u8`/… |

These compose. The strongest numeric is all three at once — a bounded, dimensioned,
proven value — but each layer is independently optional, and each erases to a bare
`Number` on the JS target. **eval never sees types** (SPEC §12.6), so every layer
here is free at runtime today; the IR tags exist only to let a future
native/WASM emitter (Phase D) lower the same source to machine primitives.

> **DECIDED: `Number` stays the one runtime numeric on JS.** No `Int`/`Float`
> split at the surface; the compiler's internal Int/Float choice (SPEC §2.1) is
> unchanged. Sized and united types are *compile-time refinements over `Number`*
> that vanish at emit. "One surface, two representations, chosen per target."

---

## 2. Units of measure (B2)

> **B2(i) AS BUILT (2026-06)** — `uom_test`/`uom_bad`, SPEC §2.15. The
> `{ tag: "United"; base; dims; name? }` variant, the `unit_clause` grammar tail
> (flat signed-factor form), the registration (a `UNITS` map parallel to
> `REFINEMENTS`; resolved in `resolveRef`), and the full `*`/`/`/`+`/`-`/cmp
> algebra + dimensionless-collapse all shipped exactly as specced below. `unify`
> compares two `United` by `dimsEqual` and lets `United`-vs-base fall through to
> the mismatch error — the explicit-casts-only rule (§4) enforced for free.
> So this fixture validates the algebra through unit-typed defs and runs on the
> erased plain-`Number` semantics.
>
> **B2(ii) AS BUILT (2026-06)** — `uom2_test`/`uom2_bad`. `Duration` folded into
> the algebra: the literal is now a `United{s:1}` (the `isDur` special-cases in
> `inferBinOp` deleted), so `ms*ms : s^2` (the showcase), `400ms/100ms : Number`,
> `1/30s : s^-1` all fall out of the general rules. A `unitMathCall` intercept
> gives the `Math.*` builtins unit semantics (`sqrt`/`cbrt` scale exponents,
> abs-family preserve, transcendentals demand dimensionless), firing only when an
> argument is United (zero plain-Number perturbation). The `Duration` stdlib
> module (`fromMs`/`toMs`) is retyped to the shared `United` — the explicit
> Number↔Duration conversion bridge §5 anticipated, for the time dimension.
> **Still deferred:** a *general* unit-value constructor / literal-defaulting
> surface (§5) for non-Duration units — they remain params-only.

### 2.1 Surface — refinement-flavored declaration

A unit type is declared with the `unit` tail on a `Number`-based `type`, reusing
the `type X = Number …` shape the refinement form already established (so the
grammar change is a small additive keyword tail, not a new declaration form):

```
type Meters   = Number unit m
type Seconds  = Number unit s
type Velocity = Number unit m/s
type Accel    = Number unit m/s^2
```

The `unit` clause carries a **dimension expression**: a product/quotient of base
unit atoms with integer exponents (`m`, `s`, `m/s`, `m/s^2`, `m*kg/s^2`). The
parser change: after a `Number` base in a type alias, accept `unit <dim-expr>`,
where `<dim-expr>` is a small grammar of atoms, `*`, `/`, and `^<int>`. The
right-hand `Velocity`/`Accel` names are *aliases for the normalized dimension*,
not new primitives — `m/s` and `Velocity` are the same type.

> **DECIDED (reviewer call, 2026-06): refinement-flavored over F#-style angle
> brackets.** `Number<m>` collides with comparison and `Named`-type args in the
> grammar (a GLR ambiguity); `Number unit m` stays inside existing shapes. The
> constructor-only route (today's `Duration`) was rejected because it gives no
> `m/s` composition — it just blesses the B− status quo.

### 2.2 The algebra

A new `Type` variant `{ tag: "United", base: Type, dims: DimVector }`, where
`DimVector` is a normalized map from base-unit atom → integer exponent (`m/s²`
is `{ m: 1, s: -2 }`; dimensionless is the empty map). The infer-side rules:

- **`*`** unions the operands' dim vectors by **adding** exponents:
  `Meters * Meters → {m:2}` (`Duration²` is just `{s:2}` — the `ms*ms` win).
- **`/`** **subtracts** exponents: `Meters / Seconds → {m:1, s:-1}` = `Velocity`.
- **`+` `-` and all comparisons** require **equal** dim vectors, else an error
  (`m + s` is rejected — this is the whole point).
- A dim vector that subtracts to **all-zero collapses to bare `Number`**:
  `400ms / 100ms : Number` (the existing Duration win, now derived).
- **`Math.sqrt`** halves every exponent (must divide evenly, else error):
  `sqrt(Area{m:2}) → Meters`. `Math.abs`/`min`/`max`/`floor` preserve dims;
  transcendentals (`sin`, `log`) require dimensionless input.

> **DECIDED: units are NOT transparent to their base, unlike refinements.** A
> refinement `Age = Number where …` *is-a* `Number` (you can add it to a
> `Number`). A unit `Meters` is **not** a bare `Number` for arithmetic — that
> non-transparency is what makes `m + s` an error. This is why units need their
> own `Type` variant rather than riding the `Refinement` tag. The solver is
> never consulted for unit checking; it is a structural shape discipline,
> exactly like the effect-row check (which also flows through infer without Z3).

### 2.3 Erasure

Units erase at lowering — `Meters` becomes `Number`, the `dims` are dropped, and
eval runs on raw numbers exactly as today (the styles `Length`/`Duration` pattern
generalized). On a future typed backend the dim vector lowers to a dimension id
on the IR node; it never reaches JS.

---

## 3. Sized types + the `overflow` obligation (B3)

### 3.1 Sized types are range refinements

The integer family ships as a stdlib refinement family over `Number`, mirroring
the refined-types library pattern (gates / closed ops / faulting ops through the
gate) exactly:

```
type u8  = Number where 0 <= value && value <= 255
type i8  = Number where -128 <= value && value <= 127
type u16 = Number where 0 <= value && value <= 65535
-- … i16 u32 i32 …
```

Construction goes through a **gate** (the refined-types pattern), so narrowing is
explicit and faulting:

```
def u8(n: Number): Result u8 String   -- gate; errors out-of-range
```

Because the range is an ordinary refinement, **the existing fact-env + Z3
pipeline already reasons about it** — no new solver machinery. What B3 adds on
top of the refinement is the **IR width tag**: `u8` records `width: 8,
signed: false` on the type so the native emitter (Phase D) can lower it to a
machine `u8` instead of an f64. On JS the width tag is inert; `u8` *is* a
`Number` at runtime and the range is enforced only at the gate (and folded at
check time where operands are constant, per the §5.1 constEval payback).

### 3.2 The seventh obligation — `overflow`

The proof vocabulary's last word (`total bounds nonzero arith overflow
exhaustive handled` — 6/7 checkable today). Under `proofs: [overflow]`, every
arithmetic op whose operands carry a width must **prove the result stays in
range**:

- Discharged on the **same fact-env + Z3 path as `bounds`**: interval floor for
  the literal/guarded case (`a: u8, b: u8` with `a + b` under a guard `a + b <=
  255` proves guard-free), solver residue with the **out-of-range model in the
  error** otherwise.
- Scope-local like the other obligations (module head `proofs:`, per-function
  `proofs:` clause — A4 — or implied by role).
- Only fires on operands that *carry a width*; bare `Number` arithmetic is
  unconstrained (the `Number ≠ Nat` honesty: plain `Number` can overflow to
  ±Infinity on JS doubles, and that is documented, not gated, until a value asks
  for a width).

> **Vocabulary complete: 7/7 once B3 ships.** `overflow` is the only word that
> needed a substrate (sized types) before it could be built — which is exactly
> why it waited on Phase B.

---

## 4. Conversions — explicit casts only

> **DECIDED (reviewer call, 2026-06): crossing any dimension or width boundary
> is explicit.** No silent coercion between `Number`, sized, and united types.

| From → To | How |
|---|---|
| literal `5` → `Meters` | **annotation or constructor only**: `let d: Meters = 5` (literal defaulting, §5) or `meters(5)` |
| `Number` → `Meters` (non-literal) | constructor `meters(x)` — never implicit |
| `Meters` → `Number` | divide out the unit (`d / meters(1)`) or an explicit `unitless(d)` |
| `Number` → `u8` | the gate `u8(n): Result u8 _` — may fail, so it is a `Result` |
| `u8` → `u16` (widening) | explicit `u16(x)` — *always succeeds*, but still written |
| `u16` → `u8` (narrowing) | the gate `u8(x): Result u8 _` — may fail |
| `Meters` + `Seconds` | **error** — no conversion, dimensions differ |

The strictness is deliberate: it keeps `overflow` an honest obligation (no
coercion can silently move a value into a width where overflow hides) and matches
the refined-types gate discipline already shipped. Ergonomics come from
**literal defaulting** (§5), not from implicit runtime coercion.

---

## 5. Literal defaulting

A bare numeric literal is **dimensionless `Number`** by default. It takes a unit
or width **only from an annotation or a constructor at its use site**:

```
let n      = 5            -- Number (dimensionless)
let d: Meters = 5         -- 5 defaults into Meters via the annotation
let x: u8   = 200         -- 200 defaults into u8; in range, ok
let bad: u8 = 300         -- error: 300 not in u8 (folded at check time)
gap = 8                   -- the existing bare-number → Px prop coercion (styles §4.1)
                          --   stays as a documented, localized special case
```

This is the one place a literal "becomes" a dimensioned/bounded type without an
explicit constructor — and it is sound because the literal's value is *constant*,
so the range check folds at compile time (the §5.1 constEval payback), never
deferring to runtime. The bare-number → `Px` coercion in layout props (styles
§4.1) is the precedent; this note generalizes it to "a literal coerces into any
`Number`-based type its annotation names, range-checked by folding."

---

## 6. What this unblocks (the re-grade arithmetic)

Low-level is **B−** today, blocked (per the row) on *"the unifying note is
unwritten."* This note writes it. The grade does not move on the note alone — it
moves when the two named mechanisms ship:

- **B2 ships units** → axis (2), first-class dimensions, goes from "Duration is a
  one-off" to "one algebra"; `ms*ms → Duration²` is the showcase pin.
- **B3 ships sized types + `overflow`** → axis (1); the proof vocabulary closes
  7/7.

At that point Low-level re-grades **B− → A−** by the row's own two-axis rubric
(north-star §5): both named mechanisms shipped, sized types built *on* the unit
substrate rather than as a fifth disjoint system. The held-back `+` is the native
representation (real machine `u8`/`i32`), which is Phase D's neutral-IR work —
the width tags this note specs are the down payment on it.

---

## 7. Slice plan (the rest of Phase B)

- **B2 (i)** — `United` type variant + `unit` decl grammar + the `*`/`/`/`+`/cmp
  algebra + the dimensionless-collapse rule. Fixture: a kinematics def
  (`Meters`/`Seconds`/`Velocity`), `_bad` pins `m + s`, `m * s` mis-annotation.
- **B2 (ii)** — `Math.*` interplay (sqrt halves exponents, transcendentals
  require dimensionless), conversions, the `ms*ms → Duration²` showcase pin.
- **B2 (iii, optional)** — a small `std/units` library (SI base + common derived)
  if wanted; sequenced after Phase C imports land so it can be `import`ed.
- **B3 (i)** — the `u8 … i32` range-refinement family + gates + closed ops + the
  IR width tag.
- **B3 (ii)** — the `overflow` obligation on the fact-env/Z3 path; vocabulary 7/7.

Erasure is free throughout (eval never sees types); the only runtime-visible
artifacts are the gates, which are ordinary refined constructors.
