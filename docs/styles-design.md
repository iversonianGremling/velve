# Styles, layout, and the convergence layer — design note

Status: **LARGELY SHIPPED** (updated 2026-06-09). This note formalizes how Velve's
UI styling works end-to-end: the prop/attr model, units, design tokens,
state-indexed styling, accessibility as types, and — the load-bearing new idea —
the **convergence layer** that lets elements reference each other's resolved
properties without forming a cycle. Most of it is now built (see the per-section
"as-built" notes and the updated baseline table below); the original design-only
framing of this header is obsolete.

It is the design companion to SPEC §11 (Layout System), which sketches the
surface syntax but not the typing or resolution semantics.

---

## 0. What exists today (baseline)

| Piece | Where | State |
|---|---|---|
| Element DSL (`Column`/`Row`/`Text`/`Button`, indented children, `key=value` props, `{expr}` interp, `on ev -> …`) | grammar + `lower.ts` (`element`) | **built** |
| `view() -> Element` evaluated to a `VElement` tree | `eval.ts` | **built** |
| Server HTML emit (flow → flexbox; numeric props get `px`) | `render.ts` `renderHtml` | **built** |
| State-indexed styling via multi-clause atom dispatch (`def statusColor(:resolved) -> …`) | `examples/ui_dashboard.velve:48` | **built** (falls out of normal functions) |
| Element prop **typing** | `infer.ts` (`case "Element"`, `ELEMENT_PROP_TYPES`) | **built** — props are typed by name+primitive; unknown/required-prop errors fire. (§3.1/§3.2 as-built.) |
| Units as a type (`Px/Fr/Pct/Fit/Fill`) | `Length` ADT in `resolve.ts` + ctors in infer/eval | **built** (§4.1 as-built) |
| Convergence / cross-prop resolution | `converge.ts` + `Evaluator.converge` | **built** — self/parent/prev/next/children scope, cycle-checked (§6 as-built) |

So: flow layout, variants, the rendering pipeline, prop typing, units, and the
convergence layer are all real. What started as the two big gaps (**prop typing**,
§2–§5, and **the convergence layer**, §6–§8) have since shipped — see the
per-section "as-built" subsections. Remaining open items are noted inline where
they apply (e.g. JS bundler, focus/scroll preservation, `for…key=`).

---

## 1. Guiding principle

> The easiest thing to type should be the correct, consistent, accessible thing.
> Every UI "best practice" we care about becomes a type the compiler enforces —
> not a convention a linter nags about after the fact. (CSS fails precisely
> because nothing is enforced.)

Concretely, the design forbids — at compile time — off-scale spacing, unknown/
misspelled props, missing interactivity handlers, insufficient colour contrast,
and cyclic property references. Each gets an explicit, greppable escape hatch so
the wrong thing is *possible but loud*.

---

## 2. The model: styles are attr-bundles, applied by value

An Element carries a set of **attrs** (props). A **style** is just a value or
function that produces attrs — there is no separate stylesheet language. Three
forms, in increasing power, all already expressible:

```
-- 1. inline attrs (built)
Text "Hi" size=14 color=#fff

-- 2. a named bundle (a saveable value)
let cardAttrs = [padding=space.3, radius=radius.md, background=surface]
Column ..cardAttrs

-- 3. state-indexed (a function over a variant — exhaustiveness enforced)
def buttonStyle(s: ButtonState): List Attr
  match s
    | Idle    -> [background=accent,        color=onAccent]
    | Hovered -> [background=accent.hover,   color=onAccent]
    | Pressed -> [background=accent.pressed, color=onAccent]
    | Disabled-> [background=surface.muted,  color=text.muted]
```

Form 3 is the **variant guardrail**: because it is an ordinary `match`,
`exhaust.ts` already forces every state to be handled, and contradictory states
(`Idle && Pressed`) are unrepresentable. This is the recommended way to express
hover/focus/pressed/disabled — *not* boolean props. No new machinery needed;
document it as the idiom.

> **DECIDED:** styles are values/functions producing `List Attr`. Keep `|>` for
> threading an element through transforms when that reads better; do **not** add a
> `compose` operator (see styles discussion — pipe + currying already cover it).

---

## 3. Typed prop schemas (the unblock)

Today `infer.ts:1551` returns `Named "Element"` and never looks at the prop name.
Give each primitive a **prop schema** and unify each supplied prop against it.
This single change unblocks §4, §5, and most of §1.

```ts
// strawman registry, consulted in case "Element"
interface PropSpec { type: Type; required?: boolean }
const PRIMITIVES: Record<string, Record<string, PropSpec>> = {
  Column: { gap: Space, padding: Space, align: Align, justify: Justify, width: Size, height: Size, background: Color, ... },
  Text:   { size: TypeScale, weight: Weight, color: { type: OnSurface, required: true }, ... },
  Button: { /* content */ label: { type: Str, required: true }, color: Color, ... },
}
```

In `case "Element"`:
1. look up `PRIMITIVES[expr.name]`; unknown primitive → keep today's permissive
   `Named "Element"` (custom components are plain functions, unaffected);
2. for each prop, unify `inferExpr(p.value)` against the spec's `type`
   (this is where units/tokens/contrast get enforced);
3. **unknown prop name** → error (`hieght` typo caught);
4. **missing required prop** → error (no dangling `Button` without a label).

Custom components stay just functions returning `Element`, so this is purely
additive — it only constrains the built-in primitives.

> **DECIDE:** schema as a TS table (fast, but the primitive set is fixed in the
> compiler) vs. a Velve prelude declaration the checker reads (extensible, more
> work). Recommend the TS table for v1; the primitive set is small and stable.

### 3.1 As-built (v1, 2026-06)

Value-type checking shipped — the smallest correct slice. `ELEMENT_PROP_TYPES` (a
module-level map in `infer.ts`) gives the shared DSL prop vocabulary, mirroring
`render.ts`'s CSS map: `width/height/padding/margin/gap/radius/size/weight/opacity
: Number`, `background/color/font/align/justify : String` (colours are `String`
because hex literals lower to `Str`). `case "Element"` now unifies each *known*
prop's value against its type (`unify(expected, vt, …)` so the message reads
"expected Number, got String"); **unknown props pass through unchecked** (no false
positives on custom attrs). Unknown-prop and required-prop *errors* are deferred to
the next slice — they need the per-primitive table, not the global one.

Verified: `prop_schema_bad.velve` fires exactly 3 errors (`gap=#fff`, `size="big"`,
`radius=true`); the clean `ui_render_test.velve` stays clean; every `_bad` file's
count is unchanged (move 3, ptr 3, where 2, refinement_compile 4, dependent 4,
transaction 2, slice 2, ptr_region 3, ptr_aggregate 3). One **true positive** in an
aspirational demo: `particle_system.velve` used `width=Screen height=Screen`, where
`Screen` is a `BlendMode` constructor, not a dimension — silently accepted before,
now flagged. Correct fix is `width=Fill` once the `Unit` ADT (§4.1) lands.

### 3.2 As-built (unknown-prop + required-prop errors, 2026-06-08)

The deferred slice from §3.1 / §9.5 shipped — the per-primitive prop **vocabulary**,
not just value types. Three module-level structures in `infer.ts` close the gap:

- `COMMON_PROPS` — names valid on *every* primitive: the `ELEMENT_PROP_TYPES` keys
  (styling) plus identity (`id`/`key`, used for keyed reconciliation) plus a11y
  labels (`label`/`ariaLabel`/`title`).
- `PRIMITIVE_PROP_TYPES` — functional props specific to one primitive, **value-typed**
  so they get the same unify treatment: `Link.to`, `Image.src`/`alt`, `Input.value`/
  `placeholder`/`checked`/`disabled`/`type`/`name`/`min`/`max`/`step`,
  `Slider.value`/`min`/`max`/`step`/`disabled`/`name`, `Button.disabled`/`type`.
- `REQUIRED_PROPS` — props a primitive cannot render without: `Image` needs `src`,
  `Link` needs `to`.

**The false-positive guard** (the reason this was held back) is `mode !== undefined`:
both checks fire **only for built-in primitives**. A capitalized *user component* is
an opaque call — `PRIMITIVE_MODE` returns `undefined`, so its props are never
second-guessed. So `Gauge whatever=42` stays clean while `Column colour=#000` is
flagged. Unknown-prop is the `else` branch of the value-type lookup (a prop with no
expected type that isn't in `COMMON_PROPS` is the typo); required-prop is a
post-loop sweep over the element's `REQUIRED_PROPS`.

Verified: `prop_unknown_test.velve` (Link/Image/Input/Button with valid functional
props) checks clean **and renders**; `prop_unknown_bad.velve` fires exactly 5 errors
(`colour` typo on Column, `onClick` prop on Text, `href` on Button, missing
`Image.src`, missing `Link.to`); a custom-component probe (`Gauge whatever=42`)
stays clean. All clean UI fixtures unchanged; every `_bad` count unchanged.

---

## 4. Units and design tokens as types

### 4.1 Units

SPEC §11.3 already specifies a unit ADT — make it real instead of `render.ts`'s
`px`-on-any-number:

```
type Unit = Px Number | Fr Number | Pct Number | Fit | Fill
```

A layout prop's spec type is `Unit` (with a bare `Number` literal coercing to
`Px` for ergonomics, decided below). Then `width=Fit`, `width={Fr 1}`,
`width=100` (→ `Px 100`) all typecheck and, crucially, `width=#fff` does not.

> **DECIDE:** bare-number → `Px` coercion. Recommend **yes** (matches today's
> `gap=8` corpus and SPEC §11.3's `Column gap=8 -- Px 8`); implement as a unify
> rule (`Number` accepted where `Unit` expected, lowered to `Px`).

### 4.1 As-built (units, 2026-06)

Shipped end-to-end. The ADT is named **`Length`**, not `Unit` — `Unit` is taken by
the `()` void type (`Prim Unit`). Constructors: `Px Number`, `Fr Number`,
`Pct Number`, `Fit`, `Fill` — registered the same way as `Ok`/`Some`: infer env
(`Px/Fr/Pct : Number -> Length`, `Fit/Fill : Length`), `resolve.ts` BUILTINS,
`eval.ts` (Px/Fr/Pct → `VCtor`, Fit/Fill nullary), `exhaust.ts` closed type-def.

Box-model props (`width/height/padding/margin/gap/radius`) are typed `Length`;
`size/weight/opacity` stay `Number`; colours stay `String`. **Bare-number → Px
coercion** is a special-case at the prop-check site (`case "Element"`): a `Number`
where a `Length` is expected is accepted (no global unify rule, so it can't leak
elsewhere). `render.ts` gained `unitToCss` (`Px n`→`npx`, `Pct n`→`n%`, `Fr n`→
`nfr`, `Fit`→`fit-content`, `Fill`→`100%`); bare numbers still get `px` via the
existing `PX()` in the CSS map.

Verified: `unit_test.velve` checks clean and renders
`gap:12px / padding:16px / width:100%|320px|50%|1fr|fit-content`; `unit_bad.velve`
fires 3 errors (Length←String, String←Length, Length←Bool); `ui_render_test` stays
clean; every `_bad` count unchanged. Grammar untouched → 177 parse corpus
unaffected. **Retired the `width=Screen` class:** `particle_system.velve` migrated
to `width=Fill height=Fill` (was `Screen`, a `BlendMode` ctor mistaken for a
dimension). `Fr` currently emits `nfr` (grid-correct; in a flex parent it's a no-op
until the layout/convergence pass maps it to `flex-grow`) — documented limitation.

### 4.2 Tokens (the scale guardrail)

Magic numbers are the #1 source of visual inconsistency (`ui_dashboard.velve` is
full of `size=12 gap=16 padding=24`). Bind the scale into the type using the
**refinement machinery that already exists** (§25–26 of blocks-design):

```
type Space     = Number where value in [0, 4, 8, 12, 16, 24, 32, 48, 64]
type TypeScale = Number where value in [11, 12, 14, 16, 20, 24, 32]
```

Off-scale literals fail `constEval`'s compile-time refinement check (blocks-design
§26) exactly like `birthday(200)` does. The greppable escape is `raw(13)` — a
builtin `raw : Number -> Space` that bypasses the refinement, so off-scale values
are *possible but show up in review*.

Three-tier token layering (the part that makes theming a one-line swap):

```
-- primitive  (raw palette)
let blue500 = #4FC1FF
-- semantic   (intent)        components reference THESE, never primitives
let accent  = blue500
let surface = #0d1117
-- component  (local)
let buttonBg = accent
```

> **DECIDE:** enforce "components may only reference *semantic* tokens, not
> primitives"? Powerful (guarantees themability) but needs a capability/visibility
> rule on token bindings. Recommend deferring to v2 — ship the scale refinements
> first.

#### As-built (token scales, 2026-06)

Shipped **opt-in** (user steer: "make a good way for users to restrict them, with
sane defaults" — don't force a scale). The mechanism reuses the existing refinement
machinery with **zero new config**: a `PROP_SCALE` map (infer.ts) ties box-model
props → `Space` and `size` → `TypeScale`. At the prop site, if the project has
*defined* that refinement type (`type Space = Number where …`, auto-registered in
`REFINEMENTS` at infer.ts:244), a constant prop value is folded against its
predicate via the same `constEval` path as Call-site refinements; off-scale → error
("`13 is off the 'Space' scale; use a scale value or raw(13)`"). **If the project
never defines `Space`/`TypeScale`, nothing is enforced** — so existing files are
untouched.

Escape hatch: **`raw(n)`** — a builtin typed `Number -> Number`, runtime identity;
its only job is to be *opaque to `constEval`*, so a wrapped value skips the scale
check. Explicit `Px n`/`Fr n` are opaque too (the unit *is* the acknowledgement).
Both must be braced as prop values (`margin={raw(13)}`, `width={Px 13}`) — the
grammar only allows bare scalars unbraced; complex prop values need `{…}` (a
pre-existing convention, same as `{Fr 1}`). Note: `prop=fn(x)` *unbraced*
mis-parses (the arg leaks as a child) — pre-existing grammar footgun, not introduced
here; always brace call/ctor prop values.

The default `Space`/`TypeScale` definitions live in `scale_ok.velve` as a
copy-paste **sane-default preset** (Tailwind-aligned: spacing on a 4px grid; type
scale 11–32). Verified: `scale_ok.velve` (on-scale + `raw`/`Px` escapes) checks
clean and renders `margin:13px`/`width:13px`; `scale_bad.velve` fires 3 off-scale
errors; `ui_render_test` (defines no scale) stays clean **despite `gap=2`/`radius=6`**
— proving opt-out works. Every prior `_bad` count unchanged; grammar untouched.

This is the **intent tier** made real (§9.6): on-scale = intent (silent),
`raw()`/off-scale = tweak. A future lint counts `raw()`/escapes per component to
surface the tweak gradient.

### 4.3 Accessibility as a refinement (the distinctive feature)

This is the one no mainstream framework enforces and it falls out of refinements
for free. A foreground colour prop is typed against its background:

```
type OnSurface = Color where contrast(value, surface) >= 60   -- APCA Lc (body text)
```

The `contrast` builtin is **APCA Lc** (perceptual, WCAG-3 / `multitarget-design.md`),
not the flat WCAG ratio — so the threshold is an Lc value (≈ 60 for body text, ≈ 45 for
large text), not the WCAG `4.5`. A `Text color=…` whose Lc against the resolved
background is below target is a **type error**, using the same fold path as numeric
refinements (add the `contrast` builtin to `constEval`). Requires the background to be
known at check time — which is exactly what the convergence layer (§6) resolves, so this
lands *after* it. (Note: the `uiModel` inspector in `render.ts` currently reports the
flat WCAG ratio for quick a11y linting — see README — and predates this APCA decision.)

---

## 5. Where prop checking sits in the pipeline

```
parse → lower → resolve → infer ──(prop schemas §3, §4)── exhaust → borrow
                                                                       │
                                          ┌── convergence pass (§6) ───┘
                                          ▼
                                    render emit (render.ts)
```

- §3/§4 checks ride inside existing `infer.ts` (`case "Element"`).
- §6 convergence is a **new pass** after type-checking, before `renderHtml`,
  matching the `render.ts:5` comment ("rewriting props into concrete values…this
  renderer only emits whatever props it is handed").
- §4.3 contrast checking runs *inside or after* convergence (needs resolved bg).

---

## 6. The convergence layer — cross-referencing without cycles

This is the original motivating idea: **an element's prop may be computed from
another element's resolved prop, as long as the references don't form a cycle.**

### 6.1 The graph

The dependency graph's nodes are **(element instance, property) pairs**, not
elements. An edge `A.p ← B.q` means "A's `p` is computed from B's `q`."

Reference vocabulary a prop expression may use:

| Form | Meaning |
|---|---|
| `self.p` | this element's own resolved `p` |
| `parent.p` | containing element's `p` |
| `children.p` | aggregate over children — `max`/`min`/`sum(children.p)` |
| `prev.p` / `next.p` | adjacent sibling in the same flow axis |
| `name.p` | a sibling bound by `let name = …` (constraint-style, §7) |

### 6.2 The invariant — and why "same prop" is too narrow

The user's instinct — *"reference each other without going cyclic on the same
prop"* — is the **common case** of the real rule, which is:

> **The (element, property) graph must be acyclic.**

"Same prop both directions" (`A.width ← B.width ← A.width`) is the textbook
over-constraint, and it is the case flow layout makes structurally tempting. But
the *general* hazard is the **diagonal cycle** on different prop names:

```
A.width  ← B.height
B.height ← A.width      -- different prop names, still a deadlock
```

So checking "same prop" alone would still hang on diagonals. We check full
acyclicity of the (element, prop) graph; "same prop" is just the error message
users will hit most.

### 6.3 Why flow layout is acyclic *by construction*

The reason this rarely bites in practice: in flow layout the two natural data
flows use **different props**, so they never cycle:

- **cross-axis size flows down** (parent → child): `child.width ← parent.contentWidth`
- **main-axis size flows up** (child → parent): `parent.height ← sum(children.height)`

`width` depends downward, `height` aggregates upward — different props, no cycle.
This is exactly the user's "not cyclic on the same prop" intuition, and it is the
*correctness invariant of flow itself*. The convergence layer generalizes it to
arbitrary references while keeping the acyclicity guarantee.

### 6.4 Resolution algorithm

1. **Collect** every prop whose value expression contains a reference form (§6.1).
   Props with only literals/local values are already concrete — they seed the graph.
2. **Build** the (element, prop) edge set.
3. **Cycle-check** via topological sort. A cycle → compile error pointing at the
   offending edge, with the "same prop on A and B" special-case message when it
   applies.
4. **Resolve** in topological order: each node's expression is evaluated with its
   referenced nodes already concrete. Aggregates (`sum(children.p)`) read the
   resolved children.
5. **Emit**: `render.ts` receives a tree whose props are all concrete (its current
   contract — it "only emits whatever props it is handed").

### 6.5 Cycle policy (the one real choice)

> **DECIDED for v1:** strict DAG. A cycle is a compile error. Predictable,
> spreadsheet-like, one clear rule, and it matches flow's own invariant.

Two alternatives, deliberately deferred:

- **Seeded fixpoint** — allow a cycle if one edge carries an explicit
  `default`/seed; iterate to convergence (enables true parent↔child *same-prop*
  negotiation, e.g. intrinsic sizing). Powerful but can oscillate; needs a
  damping/iteration-cap story. **[DECIDE — future]**
- **Directional two-way bind** (`A.p <-> B.p`) — rejected on the same prop only.
  A narrower middle ground; only worth it if fixpoint is wanted but scary.

### 6.6 As-built (build-order #6, 2026-06)

Shipped — the spine. New module `converge.ts` + an `Evaluator.converge` pass that
runs inside `html()`/`uiModel()`, just before emit, on the concrete tree:

- **Reference vocabulary** (§6.1): `self.P`, `parent.P`, `prev.P`, `next.P`, and
  `children.P` (aggregate via `sum`/`avg`). A prop expression mentioning any of
  these scope names is **deferred** at eval time — held as a new `VDeferred` value
  (the unevaluated `Expr` + its captured `Env`) instead of being evaluated eagerly.
  `converge.ts:scanConvRefs`/`hasConvRef` detect the references syntactically;
  `eval.ts case "Element"` does the deferral.
- **The graph** is over (element instance, prop) pairs, built on the evaluated
  `VElement` tree: each element gets tree context (parent / element-children /
  flow siblings, with one level of `VList` flattening for dynamic `{xs |> map …}`).
  An edge is added only when a referenced prop is *itself* deferred (concrete
  props are seeds). Resolution is a **Kahn topological sort**; the diagonal case
  (`A.width ← B.height`, `B.height ← A.width`) is caught like any other.
- **Cycle policy**: strict DAG. A cycle is reported — at convergence time, so it
  is a **RuntimeError** rather than a compile diagnostic (the per-instance graph
  only exists once dynamic lists are evaluated), with the §6.2 same-prop special
  message: *"'width' on Box and Box reference each other"*. Static
  pre-flagging on the `view()` AST is a possible follow-on but cannot see
  per-instance structure.
- **Resolution**: each deferred prop is evaluated in a child of its captured env
  with the used scopes bound to records of the *already-resolved* referenced props
  (`children.P` → a `VList` across element children). The concrete value is
  written back into the element's prop map; the pass is idempotent (a second
  `converge` sees no `VDeferred` and returns immediately).

Typing: the scope names + `sum`/`avg` are loosely typed (`Unknown`) in the infer
prelude and listed in `resolve.ts` BUILTINS, so `scope.prop` infers to a fresh var
(via the Field rule) that unifies with whatever the prop expects — real per-prop
typing across elements is left to the runtime graph, not the type checker.

Verified in `checker/converge_test.velve`: `self.padding/2` → `border-radius:10px`,
`parent.padding*10` → `width:240px`, `prev.width` → `240px` (topo resolves the
dependency first), `sum(children.height)` → `height:120px`.
`checker/converge_bad.velve` raises the cycle error. 177 corpus green.

**Deferred:** `name.p` sibling refs (the §7 constraint-island `let name = …`
form); `min`/`max` aggregates over `children` (the 2-arg numeric builtins would
clash — `sum`/`avg` are the 1-arg aggregate forms for v1); and the responsive
prop-site **auto-collapse** of a `Responsive(Length)` (the §9.4 deferred half) —
now unblocked, since convergence is the place to fold a breakpoint match against
`viewport.breakpoint` before emit.

---

## 7. Flow default, constraints as a loud escape

Flow (§6.3) handles ~90% of UI and is acyclic for free. The painful 10% —
aligning distant elements (a shared label column, baseline alignment across rows)
— wants explicit constraints. Provide them as an **opt-in island**, not the
default, so people don't reach for the solver when a stack would do:

```
Column gap=space.2
  for r in rows
    Row gap=space.3
      Text (r.label) align=right to=labelEdge   -- the ONE constraint
      Toggle r.value
-- every label's right edge converges on the shared guide `labelEdge`,
-- though the rows know nothing about each other
```

Constraints are where same-prop cycles actually appear, so the §6 cycle-checker is
*confined to this subsystem* — flow stays acyclic-by-construction and pays no
solver cost.

> **DECIDED:** flow is the default; constraints/alignment guides are explicit and
> rarer. The cycle-checker only runs over the convergence graph (which is empty
> for pure-flow trees).

---

## 8. Runtime model (for the UI, alongside styles)

`render.ts` is a static server emit; handlers are currently dead — it writes
`data-onclick="true"` markers and notes "a live runtime wires the actual closures
(this static emit can't run them)" (`render.ts:79`). So `on onClick -> send …`
and stores don't yet fire in a browser. This is the immediate-vs-retained choice,
made concrete.

> **DECIDED (recommendation):** **retained mode with reconciliation.** Because
> `view = f(state)` is already pure, diff the new tree against the live one and
> reattach handlers by node identity. This makes `on …` + stores work and gives
> focus/scroll/animation/accessibility a stable home — all of which immediate mode
> would force callers to thread by hand.

Identity is the one new obligation: **dynamic lists must declare a key**, and the
affine/ownership system (blocks-design §18–19) can enforce it — a retained node is
an owned resource, so a keyless `for` over a dynamic collection is a type error.

```
Column
  for r in rows key=r.id   -- key = stable identity = the node's "owner" handle
    reportRow r
```

### 8.1 As-built (build-order #8, 2026-06)

Shipped — a **headless retained runtime**, fully exercised in the Node harness
(there is no browser in-tree). Decided with the user: headless + reconciliation now
(the patch list is the seam a browser host applies later), with **id/key-prop**
identity and a **soft warn** on keyless dynamic lists (no grammar change; full
affine enforcement deferred).

- **`runtime.ts`** (new, pure) — `diff(oldTree, newTree)` produces a minimal patch
  list (`setProp`/`removeProp`/`setText`/`replace`/`insertChild`/`removeChild`/
  `moveChild`). Children reconcile **keyed** when every child carries an `id`/`key`
  string prop (match by key, detect moves), else **positional**. Reuses the model's
  `unitToCss`/`asText`/`renderHtml`. `keylessListWarnings` flags fragile lists.
- **`interactive(view, steps)`** builtin (in `eval.ts` `patchHOF`, beside
  `html`/`sandbox`) — renders `view()`, then per scripted step `{ target, event }`
  fires the matching element's handler thunk, `await`s store quiescence
  (`Evaluator.settle()` drains each store's `tail`), re-runs `view()`, converges,
  and **diffs** against the prior tree, printing the patches. This is the proof the
  loop works: handlers fire → stores mutate → re-render → minimal patch.
- Targets are found by `id` prop; handler thunks were already runnable
  (`VElement.events`), only never driven.

Verified: `runtime_counter_test.velve` — three clicks emit `setText 0 "count 1/2/3"`
(handler→store→reconcile end-to-end); `runtime_list_test.velve` — keyed rows, Add
emits one `insertChild 1[2] <span id="gamma">…`; `runtime_keyless_test.velve` —
emits the `⚠ dynamic list … has no key` warning. 177 corpus green.

> **Gotcha confirmed:** a store message in `send` must be **parenthesized** —
> `send Counter (Inc())`, not `send Counter Inc()` (the latter parses the message
> as a bare var and never dispatches). And a `store` requires a `messages` block to
> parse; list-typed state fields use `List(String)`, not `List String`.

### 8.2 Browser host (replay) — as-built (2026-06)

`domHost(view, steps)` (`domhost.ts`) emits a **self-contained HTML page** that
mounts the initial render in `#velve-root` and **replays** the recorded
event→patch session against the live DOM, via a vanilla-JS applier (`APPLIER_JS`)
that mirrors `render.ts`'s prop→CSS map so patched styles match the SSR. The
applier is the browser counterpart of `runtime.ts` `diff`: `setProp`/`removeProp`
(style or attribute), `setText`, `replace`, `insertChild`/`removeChild` (via a
`<template>`), `moveChild` (keyed). Paths navigate `element.children` (element-only,
matching `diff`'s `childList` for element trees).

Verified two ways: `checker/dom_host_test.velve` emits a page whose embedded
`<script>` passes `node --check` and carries the `setText` session; and
`checker/dom_applier_test.mjs` `eval`s the *same* `APPLIER_JS` against a DOM shim
(11/11 — setText/setProp/removeProp/removeChild/moveChild).

Also deferred: focus/scroll preservation.

#### Keyed lists — `for r in rows` as-built (2026-06-08)

The `for … ` list-render sugar shipped, with the keyless concern resolved
**structurally** rather than via a separate affine pass. New grammar rule
`for_child` — `for <id> in <expr>` over an indented per-item element, valid as an
element child (distinct from the `for ( … ) ->` comprehension, which requires
parens, so no collision; keyword-led → safe, **179 corpus green**). Lowering
(`lowerForChild`) desugars it to a `for (r = rows) -> <body>` comprehension and
**stamps the key**: if the body element sets no `id`/`key` of its own, it gets
`key = r.id` — the implicit **SQL-primary-key** default the user chose (a record's
`id` *is* its key; explicit `key=`/`id=` on the element is the optional override).

The enforcement falls out of the type system for free: an item type with no `id`
field makes the stamped `r.id` a "missing record field 'id'" **error** — so a
keyless dynamic list is simply *not expressible* through this form (you add an `id`,
or set your own `id`/`key`). No affine ownership machinery needed. `key` is the
reconciliation identity (read by `keyOf`), **stripped from emitted markup** in all
three render paths (`render.ts` SSR string, `browser.ts` live DOM) like React.

Verified: `for_key_test.velve` (implicit `r.id` keying, checks clean, `key` absent
from HTML); `for_key_reconcile_test.velve` — reversing the list emits keyed
`moveChild key=c 2->0` / `key=a 0->2` (identity match, not positional re-render),
proving the implicit key reaches the runtime diff; `for_key_bad.velve` → 1 error
(missing `id`).

> **Suggestion (not built) — declared keys for non-`id` PKs.** Today a record's key
> is `id` by convention, overridable by setting `id=`/`key=` on the row element. A
> SQL-`PRIMARY KEY`-style sugar would let a type *name* its key field —
> `type Row = { @key slug: String, title: String }` — so `for r in rows` auto-keys on
> `slug` with no per-row annotation. **Why it's only a suggestion:** the key is
> stamped during *lowering* (`lowerForChild`), which runs *before* type inference, so
> it can't yet see `r`'s type or its declared key field. Doing it properly means
> moving the key-stamping into a post-infer pass (which has the types). The explicit
> `for r in rows key=…` / `… by r.slug` surface forms are blocked by the `rows key` /
> `rows by` juxtaposition-as-application ambiguity unless a keyword is reserved. The
> existing `id=(r.slug)` override already covers non-`id` PKs, so this stays parked.

### 8.3 Live host — as-built (2026-06)

The **live** host (no replay): the interpreter runs **in the browser**, so a DOM
event re-runs the actual `view()` and the result is reconciled into the live DOM.
The insight: a velve→JS *compiler* is unnecessary — the interpreter is plain JS;
only **parsing** is Node-native, so the AST is produced in a Node build step and
shipped as JSON.

- **`browser.ts`** (new, zero Node deps) — `buildDom(vel, doc, ev, onEvent)` turns a
  `VElement` into real DOM (styling via the *same* `render.ts` prop→CSS helpers, now
  exported), wiring each `on …` to `addEventListener` → run the velve thunk →
  `ev.settle()` → re-render. `patchDom(dom, oldV, newV, …)` reconciles old→new
  against the live DOM (keyed by `id`/`key` else positional), building new subtrees
  with `buildDom` so inserted nodes are also wired — reconciliation against a REAL
  DOM, not a string replay. `mountLive(rootEl, ev, viewName, doc)` ties it together.
- **`Evaluator.loadModule(mod)` / `global(name)`** (new public API) let the host
  evaluate decls and grab `view` without running `main`.
- **Browser-safe interpreter:** `eval.ts`'s `node:fs` is now a lazy dynamic import
  and `process` is guarded, so `eval.js` + `browser.js` + their deps form a
  Node-free import graph the browser can load. (None of them import tree-sitter.)
- **Deliverable:** `velve ast <file>` emits the lowered module as JSON;
  `checker/web/index.html` is a served page that `fetch`es `app.ast.json`,
  `loadModule`s it, and `mountLive`s — a genuinely live app (serve over http for
  ESM+fetch: `python3 -m http.server`).

Verified two ways: `browser_live_test.mjs` mounts the counter + keyed list into a
faithful DOM **shim** and fires REAL dispatched clicks — count goes `0→1→3` with
**node identity preserved** (reconciled, not rebuilt), Add inserts one keyed row
keeping existing nodes (13/13); and `browser_focus_test.mjs` runs the interpreter
against a **real headless DOM (jsdom)**.

#### Focus / scroll preservation — as-built (2026-06-08)

Reconciliation moves/replaces DOM nodes, which the DOM spec says **blurs** a focused
element and drops its text selection (jsdom reproduces this — the test asserts it as
a control). So `mountLive`'s re-render now snapshots, just before patching: the
focused element's `id` + its `selectionStart/End`, and the scroll offsets of every
id'd element; then after `patchDom` it **restores** them, keyed off `id` — so the new
node occupying the same logical slot regains focus/selection/scroll (React's
approach). All guarded with optional chaining + null checks, so a DOM without
`activeElement`/`querySelectorAll` (the shim) degrades to a no-op — the shim live
test still passes unchanged. Verified on jsdom (`browser_focus_test.mjs`, 11/11): a
keyed list of inputs is reordered by a store message (moving the DOM nodes); the
focused input keeps **focus**, its **(1,3) selection**, and the container's
**scrollTop=50** across the reconcile.

#### SSR hydration — as-built (2026-06-08)

velve already had both halves: `html(view())` (render.ts) is the server render, and
the client interpreter is `mountLive`. **`hydrate(rootEl, ev, viewName, doc)`** (new)
is the bridge: it re-runs `view()`, then instead of `buildDom`+append it walks the
**existing** server DOM in lockstep with the tree (`hydrateDom`), attaching the `on …`
handlers to the nodes already there and seeding the `patchDom` loop — **reusing every
server node** (fast first paint, no flash). Element children align by position
(`elemChildren` vs `.children`); text nodes — including render.ts's pretty-print
whitespace — are left untouched. It works cleanly *because velve's view is pure +
deterministic*: same AST + same initial store state ⇒ server and client trees match
by construction (none of React's hydration-mismatch class). Verified on jsdom
(`browser_hydrate_test.mjs`, 9/9): server HTML injected, hydrated with a *fresh*
client evaluator — the root, button, and count span are the **same node objects**
after hydration, and a post-hydrate click reconciles them **in place** (still the same
nodes).

#### Event payloads — as-built (2026-06-08)

Handlers can now take the event: `on onInput e -> send Form (SetName(e.value))`.
Grammar: `on <event> [param] ->` (event narrowed from `_expr` to `lower_id` so
`onInput e` isn't mis-parsed as application; the optional second `lower_id` is the
param). The param is bound — in resolve (a child scope), in infer (to a typed `Event`
record `{ value: String, key: String, checked: Bool }`, so `e.value` is `String` and
mis-using it is a type error), and in eval (the handler `VBuiltin` `define`s the param
from `args[0]`). `buildDom`/`hydrateDom` marshal the real DOM event into that record
(`value`/`checked` from the target, `key` from keyboard events); the headless
`interactive` driver passes an `emptyEvent()` default. Verified: `event_payload_test`
checks clean and **errors** when `e.value` feeds a `Number` field; `browser_event_test.mjs`
(jsdom, 4/4) types into an input → `e.value` flows through the store → the greeting
updates live.

#### JS bundle — as-built (2026-06-08)

`npm run bundle` (esbuild, new devDep) rolls the Node-free graph — `web-entry.ts` →
`eval`/`browser`/`render`/`converge`/`runtime`/`value`/`scheduler` (`node:fs/promises`
externalized since the browser never hits the io builtins) — into `web/app.js`. The
default build is **readable, not minified** (~126 kb): a header banner names the
modules in dependency order, and esbuild keeps each original module boundary as a
`// dist/<file>.js` comment, so the bundle stays navigable. `npm run bundle:min`
produces the minified **70 kb** `web/app.min.js` for production. `web/index.html`
imports `./app.js`, so a deployable app is three files: page + bundle + `app.ast.json`.
Both bundles smoke-tested: importing into jsdom mounts the counter and a click drives
it to `count 1`.

**Remaining deferred:** more DOM-event types (the mechanism is there — just a longer
`Event` record + more names); a `velve serve` that runs the SSR + serves the bundle
(today: `npm run bundle` + `python3 -m http.server`).

---

## 9. Responsive, breakpoints, and the intent/tweak gradient

The pains this section addresses are the Tailwind ones: trial-and-error styling
that ends messy, props silently ignored because the *context* invalidates them,
breakpoints/`min`/`max` that feel awkward, and no separation between the
designer's intent and the corrective fiddling. The throughline: the type system
already distinguishes intent (tokens, primitives, exhaustive variants) from
escape-hatch tweaks — lean on that.

### 9.1 Viewport is a read-only root — why responsive doesn't go "bananas"

Binding a prop to screen size is safe **iff** the viewport is a source with no
inbound edges in the convergence graph (§6) — model it like a store:

```
read-only roots:  viewport.width, viewport.breakpoint, theme, …
```

Anything may depend on `viewport.*`; nothing may write back to it. So a
viewport-driven layout is acyclic by construction (same guarantee as flow). The
*only* way to reintroduce a cycle is genuine feedback — content height grows → a
scrollbar appears → viewport width shrinks → reflow (the classic scrollbar loop),
or a container query that resizes the box it measures. Those are exactly what the
(element, prop) cycle-checker (§6.2) rejects, with an edge pointer. So:
**viewport-binding is free; container-measuring is allowed but cycle-checked.**

> **DECIDED:** viewport/theme are read-only reactive roots (store-like). Container
> queries are permitted only through the convergence graph, so a measure→resize
> cycle is a compile error, not a runtime oscillation.

### 9.2 Breakpoints as an exhaustive variant

Tailwind's `sm/md/lg/xl` are a convention you can violate (forget `sm:` → silent
gap, discovered on a phone). Make them a closed type and inherit the
exhaustiveness guardrail (`exhaust.ts`) for free:

```
type Breakpoint = Mobile | Tablet | Desktop | Wide
```

> **DECIDE:** the default cutoffs (proposal, Tailwind-aligned): `Mobile < 640`,
> `Tablet 640–1024`, `Desktop 1024–1536`, `Wide ≥ 1536`. Overridable per project.

### 9.3 `Responsive(T)` — one mechanism, shared with state variants

A responsive value is just `Breakpoint -> T`, written as a `match` — so it is the
**same construct** as state-indexed styling (§2), and gets the same exhaustiveness:

```
width = responsive
  | Mobile  -> Fill
  | Desktop -> Px 320
-- missing a breakpoint → compile error, exactly like a missing button state
```

Internally `responsive` lowers to a `match viewport.breakpoint`. No new evaluation
model — it reads the §9.1 root. A prop typed `Unit` accepts either a plain `Unit`
or a `Responsive(Unit)`; the convergence pass collapses the latter against the
current breakpoint before emit.

> **DECIDED:** responsive = exhaustive `match` over `Breakpoint`, unified with the
> state-variant mechanism. Do not add Tailwind-style `sm:`/`md:` prefix syntax — it
> is the unchecked, forgettable form this replaces.

#### As-built (responsive keyword sugar, 2026-06-08)

The `responsive | …` keyword shipped (the grammar half deferred in §9.4's note).
New `responsive_expr` grammar rule — a keyword-led block mirroring `match_expr`
exactly but with **no subject** (`'responsive' _newline _indent match_branch+
_dedent`), added beside `match_expr` at its three usage sites; `responsive` is a new
reserved word. Being keyword-led (like `if`/`match`), it is in the *safe* grammar
family — zero new conflicts, parser regenerated + rebuilt, **178 corpus green** (the
fragile cascades that killed `qualified_call`/`member_atom` were all atom-tail
postfix rules; this isn't one). Lowering (`lowerResponsive` in `lower.ts`, wired
into both expr- and stmt-position) desugars to `Match { subject:
viewport.breakpoint, branches }` — so infer/eval/**exhaustiveness** need no changes,
they already handle the explicit form. A missing breakpoint is the same compile
error. **Exhaustiveness strategy:** `responsive` is *always total* — either every
breakpoint is named, or a wildcard `| _ -> …` covers the rest (it satisfies the
exhaustiveness check exactly as in a `match`). So you never get a silent gap, and you
needn't enumerate all four when most share a value. Verified: `responsive_test.velve`
(an all-branches width + a wildcard-fallback padding; checks clean, renders
`width:320px`/`padding:24px` at the default Desktop viewport — Desktop falls through
the wildcard); `responsive_bad.velve` → "non-exhaustive match — missing: Wide" (no
branch, no wildcard). Like any multi-
branch block it spans lines, so it doesn't inline into a `(…)`/`{…}` prop value
(the same continuation-gap limit as `match`); authored as a named fn / let-binding.
**Still deferred (§6 convergence):** prop-site auto-collapse of a `Responsive(Length)`
*value* against the current breakpoint — today the `match` is authored explicitly in
a fn; the keyword is the surface sugar for it.

### 9.4 Clamp bands replace awkward `min`/`max`

`min()`/`max()`/`clamp()` are three nested functions for one idea: "stay within a
band, fluid between." Reuse range syntax (`..`, already in the language) as a
fluid band:

```
width = 280..720      -- ≥280, ≤720, fluid between (lowers to CSS clamp)
```

> **DECIDE:** `lo..hi` band vs. explicit `Clamp lo hi`. Recommend the explicit
> `Clamp` form first (a `Unit` constructor — no overload of numeric `..`), and only
> add the `..` sugar if it reads better in practice. Either way it is **one**
> concept, not three functions.

#### As-built (build-order #5, 2026-06)

Shipped — the no-grammar-change half of #5. End-to-end, no new evaluation model:

- **`Clamp lo hi`** is a real `Length` constructor (`Clamp : (Number, Number) ->
  Length`), payload a 2-tuple of px bounds. `render.ts:unitToCss` emits
  `clamp(${lo}px, 100%, ${hi}px)` (preferred = `100%` → fills, bounded). Added to
  the `Length` exhaust set so a `match` on a length stays total. The `..` sugar is
  not added (the explicit form won, per the DECIDE above).
- **`Breakpoint = Mobile | Tablet | Desktop | Wide`** is a closed builtin variant
  (prelude ctors in `infer.ts`/`eval.ts`, `exhaust.ts` typedef, `resolve.ts`
  BUILTINS). A `match` over it inherits exhaustiveness for free — a missing
  breakpoint is a compile error (`non-exhaustive match — missing: …`), exactly the
  §9.2 guardrail.
- **`viewport`** is the §9.1 read-only root: a prelude record `{ width, height,
  breakpoint }` (defaults to a Desktop/1280 viewport). A responsive value is today
  written `match viewport.breakpoint | Mobile -> … | …` — exhaustiveness-checked
  like any Breakpoint match. Source-only, so viewport-driven layout is acyclic by
  construction.

**Deferred to the convergence pass (#6):** the `responsive` *keyword* sugar (auto
`match viewport.breakpoint`) and **prop-site auto-collapse** — a prop typed
`Length` accepting a `Responsive(Length)` and collapsing it against the current
breakpoint before emit. Until then, responsive values are explicit `match`es that
return a `Length`, which is fully usable. Verified end-to-end in
`checker/clamp_breakpoint_test.velve` (renders `clamp(280px, 100%, 720px)`;
`responsiveWidth()` collapses to `Px 320` at the default Desktop viewport).

### 9.5 Context-dependent prop validity — the anti-soup feature

The biggest source of "tweak until it works": a prop that is **silently ignored
because the context invalidates it** — `gap` on a non-flex box, `top` without
`position`, a child's `grow` when the parent isn't flex. CSS no-ops these. Velve
makes them compile errors. Two layers:

- **Own-context** (needs the per-primitive prop table — the deferred half of §3):
  `gap`/`align`/`justify` belong to `Row`/`Column`/`Grid`, not leaves. `gap` on a
  `Text` → *"gap applies to flex containers; Text is a leaf."*
- **Parent-context** (one step deeper): a child's flex-item props
  (`grow`/`shrink`/`basis`/`align-self`) are valid only when the **parent** is a
  flex container. `Stack { Box grow=1 }` → *"grow requires a flex parent."*

Implementation: thread a small **layout context** (the parent's layout mode:
`Flex(axis)` / `Block` / `Grid` / `Leaf`) down through `case "Element"` as it walks
`expr.children`. Each prop spec declares its validity context; a prop used outside
it errors with a reason. This is the compile-time answer to "the browser flagged it
because the parent has X."

> **DECIDED:** prop validity is context-dependent (own layout mode + parent layout
> mode), checked by threading a layout context through the Element walk. Requires
> the per-primitive prop table (promote §3's global map to per-primitive + a
> validity context per prop).

#### As-built (context-validity, 2026-06)

Shipped — the high-value half of build-order #3. Implemented in `infer.ts` without
threading mutable state: `case "Element"` reads `PRIMITIVE_MODE[name]`
(`flex` = Row/Column/Stack/Grid, `block` = Box/Card/Scroll/List/Item, `leaf` =
Text/Heading/Label/Button/… ), then

- **own-context** — a `CONTAINER_PROPS` member (`gap`/`align`/`justify`) on a known
  non-flex element errors;
- **parent-context** — checked *from the parent*: a directly-nested `Element`
  child's `FLEX_ITEM_PROPS` member (`grow`/`shrink`/`basis`/`alignSelf`) errors when
  the parent's mode is known and non-flex. No layout-context parameter needed — the
  parent sees the child's literal props as it walks `expr.children`.

Both checks fire **only when the mode is known and non-flex**, so custom components
(which are *calls*, not `Element` nodes → mode `undefined`) never false-positive.
New props `grow/shrink/basis/alignSelf` added to the type map and to `render.ts`
(`flex-grow`/`flex-shrink`/`flex-basis`/`align-self`).

Verified: `context_bad.velve` fires exactly 3 (`gap` on Box, `align` on Text, `grow`
under Box); `context_ok.velve` checks clean and renders correct flex CSS
(`flex-grow:1`, `flex-basis:80px`, `align-items:center`). **Zero false positives**
repo-wide — the only context errors anywhere are in `context_bad`. `ui_render_test`
clean; every `_bad` count unchanged; grammar untouched (177 corpus unaffected).

**The other half of #3 — shipped (2026-06-08):** the per-primitive prop vocabulary
with **unknown-prop** and **missing-required** errors. The catalogue that was missing
(`id`/`key`/`to`/`src`/labels/form attrs) is now `COMMON_PROPS` + `PRIMITIVE_PROP_TYPES`
+ `REQUIRED_PROPS`; the false-positive risk is contained by the same `mode !==
undefined` guard used here (primitives only; user components opaque). See §3.2
*As-built*.

### 9.6 The intent/tweak gradient — tiering without bureaucracy

The tier model — *primary intent* vs *corrective tweaks*, minimize tweaks — is
sound and has precedent (Auto Layout constraint priorities; CSS `@layer`
base<components<utilities). The trap is making it a **syntactic** split ("declare
which tier"): people then argue about where each value goes. The fix: the tier is
**emergent from the type system**, not declared.

| Tier | What it *is* (already typed) |
|---|---|
| **Intent** | values from tokens / semantic scales / layout primitives / exhaustive `responsive`+state variants |
| **Adaptation** | the `responsive`/state `match`es themselves — bounded, exhaustive, not arbitrary |
| **Tweak** | values that *escape* the system: `raw(13)`, off-scale literals, absolute one-off overrides |

A tweak is precisely "the thing that used an escape hatch," so the compiler already
knows which is which — no annotation needed. "Keep tweaks small" becomes a
**measurable, lintable** property: count `raw()`/off-scale/absolute overrides per
component and warn on drift. This is exactly why Tailwind decays — it is *all tweak
layer* (every utility is an escape hatch, no intent tier), so everything is soup.
Velve inverts the default: intent (tokens) is the short path; tweaks are possible
but **visible and counted**.

> **DECIDED:** tiering is a *gradient the compiler measures* (token-driven →
> escape-hatch-heavy), not a syntactic wall. Surface a per-component tweak count;
> do not force values into tagged tiers.
> **DECIDE — future:** a hard warn/error threshold on tweak density, or advisory
> only.

#### As-built (tweak-density analyzer, 2026-06-08)

Shipped as the `velve tweaks <file>` CLI subcommand (new `tweaks.ts`). It is the one
analyzer that is **static, not a runtime builtin** — and necessarily so: the runtime
`VElement` tree has already collapsed `raw(13)` → `13` and `Px 13` → a resolved
value, erasing the very intent/tweak distinction. So it walks the lowered **AST**
(`visitExpr` over each component's body), where the source shape survives.

Per tracked prop (box-model lengths + `size` + `color`/`background` — the
design-token surface; layout mechanics like `grow`/`opacity` are skipped) it
classifies the value Expr into one of four classes, against the project's defined
scales (collected from `type Space = … where …` refinements):

| Class | What | Counted? |
|---|---|---|
| **token** | a literal on a defined scale (`gap=8` when `8 ∈ Space`) | intent |
| **semantic** | a layout-relative unit — `Fill`/`Fit`/`Fr`/`Clamp` | intent |
| **tweak** | `raw(n)` escape · explicit `Px n`/`Pct n` · magic colour literal · off-scale / no-scale number | **tweak** |
| **dynamic** | a variable/param/field/interpolation — parameterized, the caller decides | neutral, excluded |

Density = tweaks / (intent + tweak); a component over 50 % is flagged ⚠. With **no**
scales defined every hardcoded value is a tweak (the report says so explicitly) —
which is the §9.6 point made concrete: a utility-soup codebase reads as ~100 % tweak.
Threshold stays **advisory** (stdout report, never a diagnostic) so it disturbs no
`_bad` counts. Verified: `tweak_density_test.velve` (Space+TypeScale defined) →
`card: 3 tweaks / 7 tracked (43%)` distinguishing all four classes, and it checks
clean + renders; `scale_ok.velve` → 2/6 (only `raw(13)`/`Px 13`); `ui_render_test`
(no scales) → 100 % ⚠ across all three components.

---

## 10. Net change list

| Area | Decision | Where |
|---|---|---|
| Styles model | values/functions → `List Attr`; state-indexed via `match` (exhaustive) | idiom; no new machinery |
| `compose` operator | **do not add** — pipe + currying cover it | — |
| Prop schemas | **add** — per-primitive types, unknown-prop & missing-required errors | `infer.ts:1551` |
| Units | **make real** — `Unit` ADT, bare-number→`Px` coercion | infer + `render.ts` |
| Token scales | **add** — refinement-typed `Space`/`TypeScale`; `raw()` escape | reuse refinements (blocks-design §26) |
| Three-tier tokens | document idiom; visibility enforcement deferred to v2 | — |
| a11y contrast | **add** — `OnSurface = Color where contrast(value, surface)>=4.5`; `contrast` in `constEval` | infer; runs after §6 |
| Convergence layer | **add** — (element,prop) DAG, strict-acyclic, topological resolve | new pass between infer and `render.ts` |
| Cycle policy | **strict DAG** for v1; fixpoint / two-way bind deferred | convergence pass |
| Flow vs constraints | flow default; constraints an opt-in island; cycle-check confined to it | convergence pass |
| Viewport root | **add** — viewport/theme are read-only reactive roots; measure→resize cycles are compile errors | convergence graph |
| Breakpoints | **add** — `Breakpoint` closed type; default cutoffs overridable | prelude type |
| Responsive | **add** — `Responsive(T) = Breakpoint -> T` via exhaustive `match`; no `sm:`/`md:` prefixes | reuse state-variant + exhaust |
| Clamp band | **add** — `Clamp lo hi` (one concept, not min/max/clamp); `..` sugar optional | `Unit` ctor |
| Context-validity | **add** — own + parent layout-mode prop validity (`gap` on Text, `grow` w/o flex parent) | per-primitive table + layout context in Element walk |
| Intent/tweak tier | **add** — emergent gradient (token vs escape-hatch), measured not declared; per-component tweak count | lint/metric over `raw()`+off-scale |
| Runtime | **retained + reconciliation**; keyed dynamic lists enforced by ownership | new runtime; borrow checker |
| State taxonomy | **add** — `Interaction` ADT (precedence-resolved) + facets; loading=`Async`; exhaustive coverage | §12; reuse `exhaust.ts` |
| UI model | **add** — `uiModel(element)` → annotated outline/JSON from the `VElement` tree | §13.1; builtin beside `html()` |
| Analyzers | **add** — inconsistency / tweak-density / a11y / dedup / structure lints over the model | §13.2; pure passes |
| Sandbox | **add** — driver over `Interaction.all` × props → model+html per variant | §13.3; reuses model + taxonomy |

---

## 11. Suggested build order

1. **Prop schemas — value types** (§3.1) — ✅ shipped. Global prop→type map.
2. **Units** (§4.1) — ✅ shipped. `Length` ADT; `render.ts` honours it.
3. **Context-validity** (§9.5) — ✅ shipped (own + parent layout mode). Unknown-prop
   + required-prop errors ✅ shipped (§3.2, 2026-06-08).
4. **Token scales** (§4.2) — ✅ shipped, opt-in; `raw()` escape.
5. **Breakpoints + responsive + clamp band** (§9.2–9.4) — ✅ shipped. `Clamp`
   length ctor, closed `Breakpoint` variant, the read-only `viewport` root, and the
   `responsive | …` keyword sugar (2026-06-08, desugars to `match viewport.breakpoint`
   with full exhaustiveness) all landed. See §9.3/§9.4 *As-built*. **Deferred to #6:**
   prop-site auto-collapse of a `Responsive(Length)` value against the live breakpoint.
6. **Convergence layer** (§6) — ✅ shipped (2026-06). `converge.ts` + an
   `Evaluator.converge` pass over the concrete tree: self/parent/prev/next/children
   refs via deferred props, (element,prop) DAG, Kahn topo-sort, cycle = RuntimeError.
   See §6.6 *As-built*. Still to do here: responsive prop-site auto-collapse (the
   §9.4 deferred half, now unblocked) and contrast-after-resolve hookup.
7. **a11y contrast** (§4.3) — the distinctive feature; needs §6's resolved bg.
8. **Retained runtime** (§8) — ✅ shipped headless (2026-06). `runtime.ts`
   reconciler + `interactive(view, steps)` driver: handlers fire → stores mutate →
   re-render → minimal patch list. id/key reconciliation + keyless soft-warn. See
   §8.1 *As-built*; browser-host **replay** page in §8.2 (`domHost`); the LIVE
   browser host in §8.3; **keyed `for r in rows` lists** (2026-06-08) with the
   keyless case made a type error structurally (§8.2 *Keyed lists as-built*); and
   **focus/scroll preservation** across reconcile (§8.3); **SSR hydration**
   (`hydrate`, reuses server nodes); **event payloads** (`on … e ->` typed `Event`);
   and a **JS bundle** (`npm run bundle` → readable `web/app.js` w/ module boundaries;
   `bundle:min` → 70 kb `web/app.min.js`) — all jsdom-verified
   (§8.3 *As-built*). (Deferred: more DOM-event types; a `velve serve`.)
9. **State taxonomy** (§12) — ✅ shipped (2026-06). Closed `Interaction` +
   `UIState` variants, `interactionOf` precedence resolver, `.all` enums.
   Exhaustive coverage is a compile requirement. See §12.3 *As-built*.
   (Deferred: `Toggle`/`Validity` facet enums.)
10. **UI model + analyzers** (§13.1–13.2) — `uiModel(view())` serializes the
    `VElement` tree to an annotated outline/JSON; analyzers lint it. Buildable now
    from the concrete tree; richer after §6.
11. **Sandbox** (§13.3) — ✅ shipped (2026-06). `sandbox(name, variants, render)`
    builtin drives a component across the taxonomy (`Interaction.all`), converges
    each, emits model + html per variant. Reuses #9 + #10 + #6. See §13.3 *As-built*.

Items 1–4 shipped. 5, 9, 10 are independently shippable now; 6–8 and 11 form the
second arc (convergence is the spine; the sandbox sits on the model + taxonomy).

---

## 12. Element state taxonomy

The taxonomy comes from **design theory**, not CSS — CSS pseudo-classes/ARIA are
just the concrete *signifiers* for one axis of it. Three theory sources answer three
different questions, and modeling them makes state coverage a *compile requirement*,
not a guideline.

### 12.0 The theory spine

**Which states must exist (completeness) — "The UI Stack" (Scott Hurff, 2015).**
The real design-theory taxonomy. Every component/screen has five **content
states**, and designers habitually build only the last one:

| UI Stack state | Meaning | velve mapping |
|---|---|---|
| **Empty / blank** | no data yet (first run / cleared) | `Async.Before` |
| **Loading** | fetching | `Async.During` (`aria-busy`) |
| **Partial** | sparse data — one item, edge of happy path | *gap — not in `Async`* |
| **Error** | something went wrong | `Async.Error` |
| **Ideal / done** | fully populated happy path | `Async.After` |

Modeled as a closed ADT, a component that forgot its empty/error state **won't
compile**. `Async` already covers four of five; **`Partial`** is the design-theory
insight CSS would never surface — worth adding as a first-class data state.

**How states compose (structure) — Harel statecharts (1987).** The formal model of
UI state: hierarchical states + **orthogonal regions** (parallel independent axes).
That *is* the "hovered AND focused AND disabled" orthogonality below. velve already
has this — `machine`/`saga` are statecharts — so composition theory is in-language.

**Why states matter (principle) — Nielsen #1 "visibility of system status" +
Norman's feedback loop.** Every state must be visible and give feedback; the UI
Stack operationalizes this.

### 12.1 The interaction axis — concrete signifiers (CSS/ARIA/Material)

The *content* states above are orthogonal to an element's *interaction* state,
whose concrete vocabulary is where CSS/ARIA/Material live:

| Sub-axis | Source | States |
|---|---|---|
| **Interaction** | CSS pseudo + Material | `Idle`, `Hovered` (`:hover`), `Focused` (`:focus-visible`), `Pressed` (`:active`), `Dragged`, `Disabled` |
| **Toggle / selection** | WAI-ARIA | `checked`, `selected`, `expanded`, toggle-`pressed`, `current` |
| **Validation** | CSS UI + ARIA | `valid`/`invalid`, `required`, `readonly`, `inRange` |

These are the Harel *orthogonal regions* of an interactive element, distinct from
its UI-Stack content state.

### 12.2 Orthogonality + precedence (the one subtlety)

States are **orthogonal** — an element can be hovered *and* focused *and* disabled
simultaneously — so a single flat enum can't model them. Material's solution: a
**precedence stack** picks the one state you actually style:

```
Disabled  >  Pressed  >  Dragged  >  Focused  >  Hovered  >  Idle
```

So the model is: raw **facets** (booleans `hovered`/`focused`/…, plus toggle/
validation enums) → a derived **`Interaction`** ADT resolved by precedence. The
style function matches on `Interaction`, exhaustively:

```
type Interaction = Idle | Hovered | Focused | Pressed | Dragged | Disabled

def buttonStyle(s: Interaction): List Attr
  match s
    | Idle     -> [...]
    | Hovered  -> [...]
    | Focused  -> [...]
    | Pressed  -> [...]
    | Dragged  -> [...]
    | Disabled -> [...]
-- forget Disabled → compile error. Loading is separate (it's `Async`).
```

> **DECIDED:** the taxonomy is design-theory-grounded — **UI Stack** (content
> completeness), **statecharts** (composition; already `machine`/`saga`),
> **Nielsen/Norman** (principle). Built-in `Interaction` ADT (precedence-resolved
> visual state) + orthogonal facet enums (`Toggle`, `Validity`) for the interaction
> axis; content states extend `Async`. Exhaustive `match` (reuses `exhaust.ts`)
> makes both content-state and interaction-state coverage a compile requirement.
> **DECIDE:** add **`Partial`** as a first-class content state (the UI Stack member
> `Async` lacks) — new ADT `UIState = Empty | Loading | Partial | Error | Ideal`, or
> extend `Async`? Also: precedence resolver (`facets -> Interaction`) as builtin vs
> library; `Interaction.all` for sandbox enumeration (§13.3).

### 12.3 As-built (build-order #9, 2026-06)

Shipped — same closed-variant pattern as `Breakpoint` (§9.2), so exhaustiveness
comes for free from `exhaust.ts`:

- **`Interaction = Idle | Hovered | Focused | Pressed | Dragged | Disabled`** —
  the precedence-resolved visual state. A `match` that forgets a state is a
  compile error (*"non-exhaustive match — missing: Dragged, Disabled"*).
- **`UIState = Empty | Loading | Partial | Failed | Ideal`** — the five UI-Stack
  content states. **DECIDED:** a *new ADT* (not an `Async` extension) — it adds
  `Partial` (the member `Async` lacks) and is named `Failed`, **not** `Error`,
  because `Error` is the `Result` constructor. Loading stays conceptually `Async`;
  `UIState` is the design-completeness checklist.
- **`interactionOf(facets)`** — the precedence resolver as a **builtin** (Disabled
  > Pressed > Dragged > Focused > Hovered > Idle). Takes a record of facet
  booleans (`{ hovered, focused, … }`, missing = false), typed loosely like the
  convergence vocab; the *output* is the typed `Interaction`.
- **`Interaction.all` / `UIState.all`** — full enumerations for the §13.3 sandbox.

Registered across `infer.ts` (prelude ctors + types), `eval.ts` (nullary `VCtor`s
+ resolver + `.all` records), `exhaust.ts` (closed typedefs), `resolve.ts`
(BUILTINS). Verified in `checker/taxonomy_test.velve`
(`interactionOf({hovered, focused})` → `Focused` → its bg; `listMessage(Partial)`;
`Interaction.all` → `[Idle, Hovered, Focused, Pressed, Dragged, Disabled]`);
`checker/taxonomy_bad.velve` fails to compile. 177 corpus green.

**Also shipped (2026-06):** the orthogonal facet enums — `Toggle = Off | On |
Mixed` and `Validity = Valid | Invalid | Pending` — as closed variants (same
registration + exhaustiveness as `Interaction`), with `Toggle.all`/`Validity.all`.
Verified in `checker/facets_test.velve`; `facets_bad.velve` fails to compile
(`missing: Mixed`). The model's a11y analyzer consuming state coverage is the
natural follow-on.

---

## 13. The UI model, analyzers, and sandbox

The UI is already data — `view()` evaluates to a concrete `VElement` tree (what
`html()` consumes). The model, the analyzers, and the sandbox are three faces of
that one fact, and all are buildable *now* from the concrete tree (richer after the
§6 convergence pass resolves cross-references).

### 13.1 The model — a serializable, analyzable IR

`uiModel(element)` (a builtin beside `html()`) walks the tree and emits a
normalized, readable description — outline for humans/LLMs, JSON for tools —
annotated with what the type system already knows:

```
Column  mode=flex  gap=8 padding=16            tweaks=0
  Text  "Title"  size=24  color=#fff           contrast(bg #000)=21:1 ✓
  Text  "Body"   size=14  color=#888           contrast(bg #000)=5.4:1 ✓
  Box   margin=raw(13)                          tweaks=1  ⚠ off-scale
```

Annotations per node: layout mode, resolved props, **tweak count** (off-scale/
`raw()` uses — the §9.6 gradient made concrete), contrast, a11y facts, state
coverage. This is also the ideal artifact for an LLM to reason over.

#### As-built (v1, 2026-06)

`uiModel(element)` shipped as a builtin beside `html()` (infer env + resolve
BUILTINS + eval; walker `renderModel` in `render.ts`). Emits an indented outline
from the concrete `VElement` tree. v1 annotations:

- **`[mode]`** — layout mode (flex/block/leaf) per primitive.
- **Resolved props** — via the same `unitToCss`/`asText` path as the HTML emitter.
- **WCAG contrast** — relative-luminance ratio of a node's `color` against the
  **inherited** background (tracked down the walk; a node's own `background`
  overrides for itself and descendants). `< 4.5` → `⚠ below AA`.
- **A11y** — `Button`/`Link`/`Input`/`Slider` with no text and no `label`/
  `ariaLabel`/`title`/`alt` → warning.
- **Structure** — flex/block container with no children and no text → `⚠ empty`.

Verified on `model_test.velve`: contrast fires (21:1 ✓ white-on-black; 1.3:1 ⚠
`#222` on black), a11y fires (labelless `Button`), empty-container fires (`Row`);
on `ui_render_test` the Button's own `#4FC1FF` bg is correctly used for its
color-contrast (10.4:1), not the inherited black. All clean files stay clean; every
`_bad` count unchanged.

**Deferred (need source/static info, not the runtime tree):** tweak count and
off-scale flags (the runtime tree has already collapsed `raw(13)`→`13`) — now
**shipped** as the static `velve tweaks` analyzer (§9.6 *As-built*); plus
inconsistency/dedup across nodes (§13.2 analyzers). These run over the model as a
follow-on; the v1 builtin produces the artifact they consume.

**JSON output — shipped (2026-06):** `uiJson(element)` (`renderJson` in `render.ts`)
emits the same annotated model as a JSON tree (`element`/`mode`/`text`/`props`/
`contrast`/`a11y`/`children`) for tools and LLMs. Verified in `facets_test.velve`.

### 13.2 Analyzers — lint the model for inconsistency/bugs

Pure passes over the model (TS now, velve later). The user's "analyze as text to
find inconsistencies/bugs":

- **Inconsistency** — "7 distinct paddings across buttons; 4 text colours not from
  the token set" → consolidate.
- **Tweak density** — `raw()`/off-scale per subtree (§9.6 gradient).
- **A11y** — interactive element (`Button`/`Link`/`Input`) with no label; missing
  state coverage; contrast < 4.5.
- **Dedup** — identical prop bundles repeated N× → "extract a style."
- **Structure** — empty containers, orphans, dead `if` branches.

#### As-built (build-order #13.2, 2026-06)

Shipped — `analyze(element)` builtin beside `html`/`uiModel`/`sandbox` (converges
the tree first, then runs pure passes; `analyzeModel` in `render.ts`, reusing the
model's contrast + prop-resolution helpers). Findings report with four sections:

- **Inconsistency** — distinct value count per tracked prop (`padding`/`margin`/
  `gap`/`radius`/`size`/`width`/`height`, `color`/`background`) across the tree;
  `≥ 4` distinct → `⚠ consider consolidating to tokens`.
- **Duplication** — identical full prop bundles on same-named elements, `≥ 2×` →
  `⚠ extract a style`.
- **A11y** — labelless interactive elements + every `color`/inherited-`bg` pair
  below AA (`< 4.5:1`), reused from the model's WCAG contrast.
- **Structure** — flex/block containers with no children and no text.

Verified on `checker/analyze_test.velve` (a deliberately messy view): fires all
four — `padding: 5 distinct ⚠`, `color: 5 distinct ⚠`, `Button ×2 identical ⚠`,
labelless `Button`, `1.3:1 #222 on #000`, empty `Row`. A clean tree returns
`✓ no issues found`. 177 corpus green.

**Tweak-density — shipped (2026-06-08)** as a *static* analyzer (`velve tweaks`),
separate from this runtime-tree `analyze()` exactly because the runtime tree has
collapsed `raw(13)`→`13`. It walks the AST instead. See §9.6 *As-built*. **Still
deferred (need source/static info):** token-set membership, dead-`if`-branch /
orphan structure checks — likewise want the AST.

### 13.3 Sandbox — a text Storybook driven by the taxonomy

A driver that feeds a component the §12 taxonomy (and prop sets) and dumps the
model + HTML per variant, so you eyeball/diff/lint them in isolation:

```
sandbox "Button"
  for s in Interaction.all          -- Idle, Hovered, …, Disabled
    button("Save", s)
-- emits uiModel + html for each state
```

It *reuses* `uiModel` + `html`, *consumes* the taxonomy (#9), and *produces* models
the analyzers (#13.2) check. One subsystem: taxonomy structures it, model is the
artifact, sandbox exercises it.

> **DECIDED:** `uiModel(element)` builtin emitting outline + JSON; analyzers as pure
> passes over it; sandbox as a driver over `Interaction.all` × prop sets. All on the
> concrete `VElement` tree, so shippable before convergence.
> **DECIDE:** surface as builtins (`uiModel`, `sandbox`) vs. CLI modes
> (`velve ui-model`, `velve sandbox`); JSON schema for the model.

#### As-built (build-order #11, 2026-06)

Shipped as a **builtin** (the no-grammar choice; no `sandbox` keyword):

```
sandbox(name: String, variants: List a, render: fn(a) -> Element) -> String
```

`render` is mapped over each variant; each result is **converged** (§6) then dumped
as `uiModel` + `html` under a `=== name / <variant> ===` header (the variant label
is `display(variant)`, e.g. the `Interaction` ctor name). It *reuses* the taxonomy
(#9 — pass `Interaction.all`), the model (#10), `html`, and convergence; it
*produces* the per-variant models the §13.2 analyzers will consume. Lives in
`patchHOF` (needs the evaluator for `applyFn`/`converge`); typed in the infer
prelude; `resolve.ts` BUILTINS. The variant list is the cross-product the caller
supplies — `Interaction.all` for states, or a list of records for state × props.

Verified on `checker/sandbox_test.velve`: drives a `Button` across all six
`Interaction` states and emits model + html per variant — and immediately surfaced
a real a11y bug, the **Pressed** state (`#4FC1FF` bg, white text) at **2.0:1 ⚠
below AA** while every other state passes. 177 corpus green.

**Deferred:** JSON output mode (outline only, same as `uiModel`); a `sandbox`-as-CLI
mode; and prop-set cross-product sugar (today the caller builds the variant list).

---

## 14. Type system mechanisms

The styling types rest on three mechanisms, and deliberately no more:

| Feature | Where | Mechanism |
|---|---|---|
| Contrast / scale / unit bounds | §4.2, §4.3 | refinement types (SMT/`constEval`-dischargeable) |
| Context-validity (`gap ⇒ Flex`, `grow ⇒ flex parent`) | §9.5 | value-indexed validity — legality depends on the layout value |
| Acyclic convergence graph | §6 | termination by construction (well-foundedness) |

> **DECIDED:** refinement-typed HM plus a closed value-indexed validity layer — not
> a general dependent calculus. Refinements keep numeric/contrast/scale/unit checks
> *inferred* (§1, no annotation on `gap=8`); context-validity stays a decidable
> value-keyed check (§9.5); acyclicity stays the convergence pass's own
> well-foundedness check (§6); genuine cycles (constraint layout, seeded fixpoints,
> two-way binds) live behind a trusted solver boundary (§7), not in the type system.

**Evidence basis:** all three are shipped — refinements graded A− (§4.3, TODO §1),
context-validity zero-false-positive (§9.5 as-built), convergence cycle-checked
(§6.6 as-built).

### 14.1 Accessibility-as-proof — and the scope that keeps it readable

The one feature the fragment makes *buildable but not yet built* is
**accessibility-as-proof**: a foreground colour typed against its background so an
unreadable pairing fails to compile, not lints after the fact —
`type OnSurface = Color where contrast(value, surface) >= 60` (APCA Lc, §4.3). It adds **no
new concept**: it is an instance of the refinement mechanism already in the table, so
there is nothing extra to teach.

The only thing that could hurt the mental model is **non-locality** — the background is
set by an ancestor, so a check that chased it everywhere would produce
action-at-a-distance errors ("why does this colour error *here* but not there?"). That
is the exact failure the rest of this language avoids with one discipline: *enforce only
when the fact is locally certain; defer otherwise.* Refinements fold only on constant
args; context-validity fires only on known primitives; convergence cycles are a runtime
error, not static. Accessibility-as-proof must obey the same rule.

> **DECIDED — opt-in, never forced (the load-bearing constraint):**
> The check is OFF by default and only ever turns on because a project *chose* to define
> `OnSurface`. The language ships **no** built-in `OnSurface`, and the `color` prop is
> **never** typed `OnSurface` by default — so plain `Text color=#777` is unconstrained
> unless the project opts in. Forcing contrast on everyone is explicitly a non-goal: the
> nesting/border/effective-background subtleties are only worth their complexity to teams
> that want them, and must never be imposed. A future change that makes the check
> mandatory (a default `OnSurface`, or typing `color` as `OnSurface`) is forbidden.
>
> **DECIDED — conservative scope (binding constraint on any build):**
> - **Static check ONLY when the background is a literal on a statically-visible
>   ancestor** (the same parent walk §9.5 already does). Report the *computed* value —
>   `colour #777 → Lc 38 vs #fff, needs ≥ 60` — never a proof obligation.
> - **Borders / separators / non-text are NOT this check** — they carry a different,
>   much lower APCA threshold; conflating them would false-positive on every hairline.
>   A boundary check, if ever wanted, is its own opt-in refinement on its own prop.
> - **Non-flat backgrounds** (gradient / image / semi-transparent) don't fold to one
>   hex, so the check stays silent rather than guess an effective colour.
> - **Convergence-resolved or theme/role-inherited backgrounds are NOT chased at check
>   time.** They are already served by the runtime `uiModel` contrast linter
>   (`render.ts` prints `· contrast … vs …`); that stays their home.
> - Net: the *safe* scope is the *decided* scope. The temptation to make the check
>   "complete" (resolve every background statically) is precisely the version that would
>   break local reasoning — so it is out of scope by decision, not by omission.
>
> **Status: BUILT** (conservative scope, `accessibility_test`/`accessibility_bad`). As
> shipped: APCA Lc lives in `constEval` (`contrast(fg, bg)`); the `Element` inference
> walk threads the resolved background down the tree (own literal `background` wins,
> else inherited — mirroring the renderer's `myBg`) into a `surfaceBg` field; a `color`
> prop is folded against it **only when the project defines `OnSurface`** (the §4.2
> opt-in pattern, via `PROP_SURFACE`) and both colour and background are constant hex.
> The predicate binds `value` = the colour (the refinement subject, as in every other
> refinement) and `surface` = the background — deliberately *not* `self`, which already
> means "this element" in the convergence vocabulary (§6), so reusing it would collide.
> The error reports the computed value — `colour #9aa0a6 fails 'OnSurface' — APCA Lc 51
> against background #ffffff` — never a proof obligation. Non-literal / convergence-
> resolved backgrounds stay silent (runtime/linter), exactly as scoped above. Corpus
> impact: zero (inert unless `OnSurface` is defined).
