# The `animated` modifier & motion policy — design note

Status: **PROPOSED** (2026-06-09). Not yet implemented. This note specs Velve's
single animation surface — the `animated` binding modifier — and the
**motion-policy layer** (accessibility) that every animation is routed through.

It builds directly on two established results from earlier design work:

1. **Animation reduces to existing primitives.** An animated value is a record
   `{value, velocity, target}` folded over a frame clock by a machine — i.e. the
   render loop is a `scan`, not a `map`, and momentum is just state the fold
   retains. The core language therefore grows by **one binding modifier**; the rest
   is host capabilities, stdlib, and reconciler work. (See the animation analysis;
   the modifier is the only new *surface*.)
2. **It composes with the interaction model.** An `animated` value is `mut` state
   with a clock-driven self-update — a node in the entity model
   ([[project_velve_interaction_model]] / `docs/interaction-model-design.md`).
   Retargeting is a *write*, so "what drives this animation?" is answered by the
   same footprint/debug query as "what can change this entity?".

This note covers pillars 1–2 of the four-pillar plan (the `animated` default +
friendly spring knobs) and the reduced-motion cross-cutting rule, re-cast as a
general motion-policy layer. Pillar 3 (enter/exit + View Transitions, reconciler
work) and pillar 4 (imperative timelines, stdlib) are **out of scope** here.

---

## 1. Guiding principle

> There is exactly one way to make a value move: mark its binding `animated`. You
> declare the *intent* ("this value springs to its target"); the runtime and a
> replaceable **motion policy** decide how that intent is *realized* in the current
> environment. You never write a duration, a frame loop, or interruption handling.

Two consequences:

- **Single chokepoint.** Because `animated` is the only motion path, the runtime has
  exactly one place to apply accessibility/comfort policy. Honoring user motion
  preferences is therefore *structural*, not a lint rule you can forget.
- **Intent ≠ realization.** The binding says *what should move*; the policy says
  *how much actually moves*. Separating these is what lets the same code do the
  right thing under reduced-motion **and** under VR comfort settings — which want
  opposite realizations (see §5).

---

## 2. The model

`animated let x = 0` lowers to the spring machine we already derived — nothing new
at runtime:

```
type Spring(T) = #{ value: T, velocity: T, target: T, cfg: SpringCfg }   where T: Interpolate

machine spring(s: Spring(T))
  on Tick(dt)    -> integrate(s, dt)        -- physics step; carries velocity forward
  on Retarget(v) -> #{ ...s, target: v }    -- velocity untouched ⇒ springs from current motion
```

The binding is sugar over: **machine** (have) + **`frames` clock-stream** (host
capability) + **`Interpolate`** (a compiler-known type set) + the modifier itself.

| Surface | Meaning |
|---|---|
| `animated let x = 0` | `x` is a `Number` that springs to its target; reads sample the live value |
| `x = 100` | **retarget** — set the target to 100, integrate from current `(value, velocity)`. *Not* an instant set. |
| `x.jump(100)` | **cut/teleport** — set value to 100 immediately, zero velocity, no animation |
| `x.velocity`, `x.target`, `x.settling` | derived observables on the trajectory |
| `let y = x * 2` | `y` **moves** (samples a moving source) but owns **no** spring/target — only assigned bindings own momentum |

---

## 3. Surface syntax

### 3.1 The modifier

`animated` is a **binding modifier**, sibling to `mut` (which it implies — an
animated value is mutable):

```velve
animated let x = 0
animated let pos = vec2(0, 0)
```

Config is an optional named argument on the modifier, reusing the named-args glyph
(`=`) and the spring presets (§4):

```velve
animated(spring = snappy) let x = 0
animated(spring = #{ stiffness = 170, damping = 26 }) let x = 0
```

> **Open:** modifier spelling (`animated` vs `motion`/`spring`) and config form
> (`animated(spring = …)` named-arg vs an `@animated` decorator). Recommendation:
> `animated(spring = …)` — consistent with the named-args design, no new glyph.

### 3.2 Assignment is retargeting

Inside the binding's scope, plain assignment **retargets**; it does not set:

```velve
animated let x = 0
x = 100        -- target ← 100; x flows there carrying current velocity
x.jump(0)      -- escape hatch: instant, no animation
```

This is the one semantic fork the modifier introduces, and it is declared at the
binding (`animated`), never at the assignment site — so the reader knows from the
declaration that every `x = …` in scope animates. `x.jump(v)` is the explicit
"I mean now."

### 3.3 Reading is sampling

A read of an animated value yields its **current** value (type `T`), sampled at the
current frame. Reads are therefore **frame-dependent** and only meaningful in a
reactive/render context (one that has a "now"). Reading an animated value from a
pure, timeless function is a type error (or a warning): there is no frame to sample.

---

## 4. Type model — `Interpolate` and spring config

### 4.1 `Interpolate`

`animated` requires the value's type to be interpolatable — to embed in a vector
space, so `lerp(a, b, t) = a + t·(b − a)` exists (needs `+`, scalar `*`, a zero).

- **v1: a compiler-known built-in set** — `Number`, `Vec2`/`Vec3`, `Color`,
  length/angle units — exactly like the existing `isCopy` type-direction in
  `borrow.ts`. **Not** a user-facing typeclass. (Generalize to a real `Interpolate`
  trait if/when Velve gains traits; the built-in set is forward-compatible.)
- **Non-interpolatable types** (`Bool`, enums, ADTs — no "between") are **rejected**
  by `animated`. Their change-over-time is a **transition** (a state-machine edge /
  crossfade), dispatched by the type — that path is pillar 3 (reconciler), not this
  note. The compiler error should point there: ``Mode has no interpolation; use a
  transition, not `animated` ``.

### 4.2 Spring config (stdlib, not a primitive)

```
type SpringCfg
  = Perceptual #{ bounce: Number, duration: Number }   -- designer-facing (Apple/Motion model)
  | Raw        #{ stiffness: Number, damping: Number }  -- physics-facing

snappy : SpringCfg    -- named presets
smooth : SpringCfg
bouncy : SpringCfg
```

Rationale (Material 3, Apple): designers don't think in stiffness/damping; expose
`bounce + duration` perceptually with raw access underneath, plus presets. This is a
plain stdlib module — records + values, no language change.

### 4.3 Momentum ownership

A spring is owned by the **binding that gets assigned** (retargeted). Derived values
(`let y = f(x)`) are continuous functions of animated sources: they *move* but own no
target and cannot be retargeted. This keeps "where does the spring live" unambiguous
and means derived motion needs no machinery.

---

## 5. Motion policy (the accessibility layer)

Every animation is realized **through a motion policy**. This is where the
reduced-motion gate lives — deliberately *not* hardcoded into `animated`'s runtime,
because the correct realization is context-dependent.

### 5.1 The policy interface

A policy maps animation **intent + environment → realization**:

```
type MotionPolicy = #{
  realize: (cfg: SpringCfg, env: MotionEnv) -> Realization
}
type Realization = Spring(SpringCfg) | Instant | Snap   -- spring | collapse-to-end | discrete jump
```

The runtime applies the **active policy** to a binding's `cfg` before integrating.
There is **always** a policy (mandatory chokepoint — this is the "unskippable" part);
which policy is active is configurable (the pluggable part).

### 5.2 The default policy and why it is replaceable

- **Default: `reducedMotionPolicy`** — honors the `prefers-reduced-motion` host
  signal. When the user requests reduced motion, decorative springs collapse to
  `Instant`. This satisfies WCAG 2.3.3. (`prefers-reduced-motion` exists because
  motion triggers vestibular disorders — dizziness/nausea/migraine — in 70M+
  people; honoring it is an accessibility requirement, not a nicety.)
- **Replaceable: e.g. `vrComfortPolicy`** — in VR the assumption **inverts**: smooth
  locomotion *causes* sickness and snap/teleport is the comfort option. A VR app
  installs a policy that realizes locomotion intent as `Snap`, not `Instant` or
  `Spring`. The same `animated` code, a different policy, the opposite realization —
  which is only possible because intent and realization are separate layers.

### 5.3 The invariant

> Motion cannot bypass the policy layer (structural — there is no raw-motion path
> around `animated`). Motion *can* be re-policied (an app provides its own
> `MotionPolicy`). Default policy honors `prefers-reduced-motion`.

> **Open:** how a policy is installed/scoped — global, per-subtree (a `MotionEnv`
> context that nests, like a theme provider), or both. Recommendation: scoped via
> the same environment/context mechanism as theming tokens (a policy is a motion
> token writ large), so a VR view can set `vrComfortPolicy` for its subtree only.

---

## 6. What it reuses / does not add

- **Reuses:** `machine`, `Stream`, the `scan` render loop, named-args (`spring =`),
  records (`SpringCfg`), the `mut`/borrow machinery (an animated value is `mut`
  state — §7).
- **New surface (1):** the `animated` binding modifier.
- **New built-in type set (1):** `Interpolate` (trait later).
- **New host capabilities (2 in this note):** `frames` clock-stream;
  `prefers-reduced-motion` signal. (Geometry read-back / View Transitions / Rive are
  pillar-3+ and out of scope here.)
- **New stdlib (2):** `SpringCfg` + presets; the default `MotionPolicy` set.

---

## 7. Composition with the interaction/footprint model

An `animated` value is **`mut` state with a clock-driven self-update** — a node in
the entity model. Therefore, for free:

- **Retargeting is a write.** Under the no-ambient-write rule (`@interaction`), only
  a function holding the animated value as a `mut` param can retarget it. So
  "what is driving this animation?" is the *same* footprint query as "what can
  change this entity?" — the motion debugger and the state debugger are one tool.
- **An animation is a machine consuming `frames`** — the same self-update shape as
  any element's `on Tick`. Animated values sit in the interaction graph, not a
  parallel system.

No extra work is needed for this; it falls out of `animated` lowering to a machine.

---

## 8. Implementation plan

File references current as of 2026-06-09.

### 8.1 AST (`checker/src/ast.ts`)
- `SBind` already carries `mutable: boolean`. Add
  `animated?: { config: Expr | null } | null`. (`animated` implies `mutable`.)

### 8.2 Grammar (`grammar.js`)
- Add the `animated` modifier to the binding rule (sibling to the `mut` form), with
  an optional config arg `animated ( named_arg )` reusing the `named_arg` shape from
  the named-args work. No new glyph.

### 8.3 Lowering (`checker/src/lower.ts`) — the bulk
- For `animated let x = e`: synthesize the `Spring(T)` record, a `spring` machine
  instance seeded `#{ value: e, velocity: zero(T), target: e, cfg }`, and a
  subscription `frames |> each(dt -> x <- Tick(dt))`.
- Rewrite, within the binding's scope: reads of `x` → `x.value`; assignments
  `x = v` → `x <- Retarget(v)`; `x.jump(v)` → an instant `{value: v, velocity: zero}`
  set; `x.velocity`/`x.target`/`x.settling` → field/derived reads.
- Thread the `cfg` through; default `cfg = smooth` if omitted.

### 8.4 Inference (`checker/src/infer.ts`)
- Constrain the binding's type to the `Interpolate` built-in set; emit the
  "use a transition" error for non-interpolatable types.
- Type reads of `x` as `T`; type `.velocity`/`.target` as `T`, `.settling` as
  `Bool`. Flag reads of an animated value in a non-reactive (pure) context.

### 8.5 Evaluation (`checker/src/eval.ts`)
- The `integrate` step (semi-implicit Euler, mass 1) and `Retarget`/`Tick`/jump
  handling.
- **Apply the active `MotionPolicy.realize(cfg, env)` before integrating** — this is
  the §5 gate. `Instant` ⇒ snap value to target each retarget; `Snap` ⇒ discrete
  jump; `Spring` ⇒ integrate normally.

### 8.6 Host + stdlib
- `frames: Stream(Number)` (per-frame `dt`) and a `prefersReducedMotion: Signal(Bool)`
  from the platform.
- Stdlib: `SpringCfg`, `snappy`/`smooth`/`bouncy`, `reducedMotionPolicy` (default),
  and the `MotionPolicy`/`MotionEnv` types.

### 8.7 Fixtures
- `animated` over a `Number` (clean); over a `Bool`/enum (error → "use a transition");
  retarget vs `jump`; a derived `let y = x*2` (moves, not retargetable); read in a
  pure function (flagged); reduced-motion policy collapsing a spring to `Instant`.

---

## 9. Decisions

**Locked (2026-06-09)**
- One motion surface: the `animated` binding modifier; implies `mut`.
- Assignment retargets (carries velocity); `x.jump(v)` is the instant escape; reads
  sample the live value and are frame-context-only.
- `Interpolate` = compiler-known built-in set for v1 (trait later);
  non-interpolatable types are rejected and routed to transitions (pillar 3).
- Spring config = perceptual (`bounce`/`duration`) + raw (`stiffness`/`damping`) +
  presets, as stdlib; default `smooth`.
- Momentum is owned by the assigned binding; derived values move but own no spring.
- **Motion policy is a mandatory, unbypassable chokepoint, but the policy itself is
  pluggable.** Default = `reducedMotionPolicy` (honors `prefers-reduced-motion`,
  WCAG 2.3.3). Reduced-motion lives in the accessibility/policy layer, **not** baked
  into `animated`'s runtime — because realization is context-dependent (VR wants
  `Snap`, not `Instant`).
- Animated values are nodes in the interaction model; retarget = write ⇒ footprint
  query covers "what drives this animation" for free.

**Open (confirm before implementing)**
- (a) Modifier spelling and config form (`animated(spring=…)` vs `@animated`).
  Recommendation: `animated(spring=…)`.
- (b) Policy installation/scoping — global vs nestable `MotionEnv` context.
  Recommendation: nestable context, shared with theming tokens (so a VR subtree
  re-policies locally).
- (c) Keep `Interpolate` as a built-in set only for v1 (recommended) vs ship a trait
  system now (no — out of scope).
- (d) Exact `Realization` set — `Spring | Instant | Snap`, or also a
  `Reduced(scale)` partial-collapse? Defer to the policy stdlib.

---

## 10. Evidence basis

Honest split. **Spring-over-duration as the default** is strong convergent industry
evidence (SwiftUI, Jetpack Compose default to springs; Material 3 is migrating off
easing+duration) and a structural argument (springs are interruptible, duration
tweens are not) — not a controlled human study, but well-supported. **Reduced-motion
as an accessibility requirement** is established (WCAG 2.3.3; vestibular-disorder
prevalence). **The VR inversion** (smooth locomotion causes sickness, snap/teleport
mitigates) is established VR-comfort practice. The **modifier spelling**, the
**perceptual 2-param knobs**, and the **policy API shape** are defensible design
rationale, not measured findings — recall that stated preference does not track
measured outcomes, and do not relitigate the spelling on taste. Do **not** market
`animated` as "fewer bugs"; market it as "motion you can't write inaccessibly" and
"one construct, interruptible by default."

---

## 11. Intended direction (planned, out of scope here)

This note specs pillars 1–2 + the policy layer. The rest of the motion story is
**planned, not yet spec'd** — recorded here so it isn't lost. All of it is expected
to ride the same clock-stream/machine/`scan` spine, so the working assumption is
**few or zero new primitives** beyond what each item explicitly calls out.

- **Pillar 3 — enter/exit + layout transitions (reconciler work).** Semantic
  identity promoted from a perf hint to a two-scope relation (sibling-local `key` +
  document-global transition-name), plus **tombstone retention** (the render tree may
  outlive the state tree during an exit). Shared-element/FLIP morphs lower onto the
  **View Transitions API**; mount/unmount uses a presence mechanism
  (`AnimatedVisibility`/`<AnimatePresence>` equivalent). New cost is in the
  *reconciler/substrate + host bindings* (View Transitions, geometry read-back), not
  the surface language — user surface is a `key`/`transition`/`enter`/`exit` *prop*.
  This is also where non-interpolatable `animated` types (§4.1) are routed.

- **Pillar 4 — imperative timeline (stdlib).** A `Timeline` module for the
  GSAP-class 10%: explicit parameterized time (`t ∈ [0,1]`), sequence, stagger,
  scrub. Same machine + clock-stream as `animated`, but samples keyframes at `t`
  instead of integrating physics. Kept out of the common path; no new primitive
  expected.

- **Rive binding (host).** A `.riv` file *is* a state machine, so it imports as a
  machine-shaped component (inputs → events, states → machine states). Pure host
  binding — the payoff of "animation = machine."

- **Gestures + scroll-linked animation (the motion×gesture seam).** The other half
  of "motion," and the natural next pass.
  - *Gesture **input*** is already designed — see `multitarget-design.md`
    (`inputmap`, `std/gesture`, gesture as an event source) and the `Dragged`
    interaction state in `styles-design.md`. That half exists.
  - *Scroll-linked / scrub animation* (a timeline whose `t` is **scroll position**
    rather than the clock) is **not yet specified anywhere** — this is the one
    genuinely-undocumented direction. It is where pillar 4's timeline meets gesture
    input; expected to slot onto the same clock/machine spine at ~zero new
    primitives (swap the `t` source from `frames` to a scroll/gesture stream).

Build-order recommendation unchanged: ship pillars 1–2 + the policy gate first
(this note), then pillar 3 (reconciler), then pillar 4 + Rive + the gesture/
scroll-linked pass as additive layers.
