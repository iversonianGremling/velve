# SVG / free-position legibility as proof — design note

*Status: S0+S1 built (2026-06, SPEC §11.1.2, `canvas_legible_test`/`_bad`);
S2–S5 remain. The question this answers: can rendered
text that is unreadable — because it overlaps other text/elements, or lacks
contrast against what is actually painted behind it — be made impossible by
construction, with the system finding satisfying layouts on its own? Short
answer: yes, and it is two different math problems wearing one feature's
coat. It is the accessibility-as-proof pattern (north-star §6) generalized
from "color vs nominal surface" to "color + geometry vs composited scene."*

## 0. Substrate honesty

Velve has **no free-positioned rendering surface today**. The element DSL is
flow-shaped (`Column`/`Row`/gaps/`Fit`), where overlap is *inexpressible* —
that is already the structural half of "impossible by construction," and it
is why this problem has not bitten yet. SVG exists only as owed breadth
(north-star §2, media row). So the build plan starts with a substrate
decision (S0): a minimal free-position form — a `Canvas` element whose
children carry `at=(x, y)` — *introduced together with its proof obligation*,
never shipped without it. Free positioning is exactly the door through which
unreadability enters; Velve should not open the door before the guard exists.

## 1. The two obligations

For a free-positioned scene with text elements `t_i` and occluders `e_k`:

- **(A) Disjointness** — no two text extents intersect, and no occluder
  drawn *above* a text intersects it:
  `disjoint(box(t_i), box(t_j))` for all pairs; `disjoint(box(t_i), box(e_k))`
  for occluders later in paint order.
- **(B) Geometric contrast** — for every region `r` that `t_i` sits over,
  the *composited* color of `r` must clear the APCA threshold:
  `contrast(color(t_i), composited(r)) >= Lc` for all `r ∈ regionsUnder(t_i)`.

(B) is the existing `OnSurface` refinement with the nominal `using`-surface
chain replaced by geometric background resolution: intersect the text box
with the painted scene below it (paint order), composite solid fills exactly,
and check against **every** resulting region — the binding constraint is the
minimum. (A) is new but trivially *checkable*: pairwise AABB tests or a sweep
line. Neither obligation needs a solver to **check**.

## 2. The two meanings of "impossible by construction"

Following the structural-vs-semantic law (north-star §3.2):

1. **Structural (free)**: flow layouts cannot overlap. Keep this the default;
   `Canvas` is the opt-in escape into geometry.
2. **Proof-level (the Canvas case)**: the program compiles only if (A) and
   (B) discharge. When positions, sizes, and colors `constEval`-fold —
   the same folding the contrast refinement uses today — this is a
   compile-time check with **no solver**. What doesn't fold takes the same
   gradient as refinements: conservative skip / runtime boundary (§4), or
   the synthesis tier (§5).

Per the decided constraint on contrast checking: **opt-in, never forced.**
The obligation activates the way `OnSurface` does — a project declares it
(spelled as the `Proof [legible]` obligation set when §3.4's proof-gradient
syntax lands; until then, refinement-style opt-in on the Canvas form).

## 3. Text extents — the metrics problem

A text's box needs font metrics. This is the genuinely new *input*:

- **Bundled fonts**: ship a glyph-advance table per bundled face; extent of a
  constant string folds at check time (advance sum × size, line height).
  The table is part of the proof input, versioned with the font.
- **Declared bounds**: `label(s, maxChars=24)` — extent from the declared
  bound; the bound itself becomes a runtime-checked refinement on `s`
  (`.parse`-style), exactly the compile-static/runtime-dynamic split
  refinements already use.
- **System fonts**: unprovable — conservative skip with a warning, or a
  declared fallback metric. Never silently assume.

**Dynamic text without a bound is the honest limit**: `label(user.name)` has
no extent. The choices are (a) require a bound on Canvas text, (b) prove for
the bound and define overflow behavior (truncate/reflow) as part of the
obligation. (a) for v1 — "impossible by construction" must not be a lie.

## 4. Background resolution for (B)

- **Solid fills**: exact. Region decomposition of the boxes under the text
  (at most O(n) regions per text after clipping); composite top-down until
  opaque; one APCA check per region.
- **Alpha**: composite numerically — still exact for constants.
- **Gradients**: minimum contrast over a continuous region. Not generally
  monotone in any single channel, so: interval bounds on L (APCA contrast is
  driven by lightness difference) — if the *worst-case* interval clears, the
  region passes; if not provable, conservative skip with the precise "could
  not prove" diagnostic, per the existing law. Sampling is a diagnostic aid,
  never the proof.

## 5. Solving — where SAT/SMT actually earns its place

Checking needs no solver. **Synthesis** ("find a legible layout for me") is
the classic cartographic label-placement problem — NP-hard in general,
practical at realistic n:

- Disjointness of two boxes = a disjunction of four linear half-plane
  constraints → the system is QF_LRA. **MaxSMT** formulation: hard
  constraints (A)+(B)+stay-in-viewport; soft objective = minimize
  displacement from authored positions. The model returned IS the repaired
  layout — closest legible layout, not an arbitrary one.
- The **color axis rarely needs the solver**: `legibleOn` (std/color, already
  built and constEval-folded) is closed-form repair — move L along the OKLCH
  cusp until APCA clears. Try color repair first; it never moves anything.
- Honesty: the solver guarantees *legible*, only approximates *good*. Real
  label engines layer annealing/force-direction for multi-criteria
  aesthetics. Keep the solver behind the same opt-in flag as the proof
  gradient's Z3 floor (north-star §3: the solver is a *tier*, never the
  foundation), and surface its output as a **fix-it** (proposed `at=` edits),
  not silent mutation — the author stays the author.

## 6. What this reuses (nothing here starts from zero)

| Piece | Already built | This design adds |
|---|---|---|
| APCA contrast in `constEval` | ✅ (`color.ts`, contrast refinement) | called per-region instead of per-surface |
| `legibleOn` / cusp repair | ✅ (std/color) | used as the color-axis synthesizer |
| Opt-in proof pattern | ✅ (`OnSurface`, "opt-in never forced") | second instance; later `Proof [legible]` |
| Compile-static / runtime-dynamic split | ✅ (refinement `.parse`) | text-bound refinements, overflow boundary |
| Structural no-overlap layouts | ✅ (`Column`/`Row`) | stated as the default tier |
| Conservative skip + honest diagnostic | ✅ (type-core law) | gradients/system fonts |
| Solver tier | designed (north-star §3, Z3 floor) | first concrete client |

## 7. Build plan (fixture-provable slices)

- **S0 — substrate**: `Canvas` element + `at=(x, y)` child placement +
  paint order = child order. Eval renders into the existing UI model.
  Shipped together with S1 — never alone.
- **S1 — static checker, no solver, no metrics**: Canvas text carries
  explicit `w=`/`h=` (or maxChars × declared advance). All-constant scenes:
  pairwise disjointness + per-region APCA against solid fills, as check
  errors. Fixtures: green (legible labeled diagram, runs), bad (two
  overlapping labels; text over a too-close fill; text half-over a dark and
  half-over a light rect where only one region fails — proving per-region
  resolution).
  **S0+S1 ✅ BUILT 2026-06** (SPEC §11.1.2, `canvas_legible_test`/`_bad` —
  the bad fixture pins all three sketched cases plus occlusion-from-above,
  a could-not-prove, and `at` outside Canvas). As-built deltas:
  - **The substrate dig found the element DSL itself broken**: paren-form
    elements' indented children parsed as sibling STATEMENTS — the GLR
    resolved the `[call, element]` conflict toward call-plus-statements
    (the demand-driven indent scanner never gets asked for the indent on
    that path), so every 2026.6 view silently rendered only its last leaf
    (`theme_root_test` rendered flat; §14.1's nested-ancestor contrast
    threading never actually engaged for paren-form). Fixed with
    `prec.dynamic` on the children-bearing element branch. Zero corpus
    baseline changes (counts and run statuses; uiModel/html outputs now
    nest, which the count-based baselines don't record). Residual: a bare
    component CALL child (`card()`) is not a `child` grammar form and still
    falls back to siblings — spell it `{card()}`. **Residual closed
    (2026-06)**: `call_child` (lowercase-headed, SPEC §11.1) makes bare
    component calls real children; `theme_root_test` un-flattened.
  - `Canvas` already existed as a primitive name (leaf, `<canvas>` tag);
    S0 makes it the free-position container: `at` is a common prop typed
    `(Number, Number)` and context-checked to Canvas parents (the
    FLEX_ITEM_PROPS pattern), html emits `position:relative`/`absolute`,
    and `constEval` learned tuples. Canvas keeps layout mode "leaf" so
    container/flex-item props stay invalid around it.
  - **Extents reuse `width`/`height`** (bare numbers, which fold) instead
    of the sketch's `w=`/`h=` — no new prop names.
  - **Opt-in spelling**: declaring a refinement named `Legible` (the
    OnSurface pattern; its predicate is the threshold, `surface` binds per
    region). Texts = `Text`/`Label`/`Heading`; fills = `Box`/`Card`;
    direct children only. With the proof active, unfoldable geometry and
    unsupported child kinds are could-not-prove ERRORS (the §3 "must not
    be a lie" rule); non-constant text colours and an unknown canvas
    background stay silent (the OnSurface law).
  - Region decomposition is coordinate bisection of the text box on
    covering fill edges; each cell's background is the topmost solid fill
    (paint order), else the canvas background; identical failing colours
    report once per text. `uiModel`/`uiJson`/`analyze` suppress their
    naive ancestor-bg contrast notes (and the empty-container note) for
    free-positioned children — geometry, not the tree, decides there.
- **S2 — bundled font metrics**: constant-string extents fold; `w=` becomes
  optional for constants.
- **S3 — alpha + gradient intervals**: composited backgrounds; worst-case
  interval proof; conservative-skip diagnostics.
- **S4 — dynamic-text boundary**: `maxChars` refinement + defined overflow;
  runtime `.parse`-style check at the data edge.
- **S5 — synthesis (opt-in)**: MaxSMT placement repair emitted as fix-its;
  `legibleOn` auto-suggestion for the color axis. The Z3 dependency stays
  optional (the checker without it just reports violations, never repairs).

Each slice keeps corpus baselines untouched: `Canvas` is additive and the
obligation only activates on opt-in.
