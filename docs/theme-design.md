# Theme system — design note

> Status: **Slices 1–4 built (2026-06) — theme system COMPLETE.** This is the highest-leverage UI
> piece: `std/color` is fully built (`color_test.velve`, `color_ext_test.velve`) and, as
> of Slice 3, **folds at check time** so a derived theme role is its first real consumer;
> the accessibility-as-proof machinery (styles-design §4.3, §14.1) no longer fires only
> against *inline hex literals* — it proves token, `using`-surface, and *computed* colours.
> A theme system is the cheapest
> path to making real, themeable component code exercise both — it re-grades UI from
> B+/A− toward A (north-star-grades.md row 26). Builds on styles-design §4.2 (token
> tiers), §4.3 (`OnSurface`), §6 (read-only reactive roots: `viewport`, `theme`).

## 1. The gap, grounded

Every shipping UI fixture hardcodes colour:

```
-- ui_render_test.velve, as-built
Row gap=12 padding=8 background=#0d1117 radius=6
  Text (it.title) size=14 color=#ffffff
```

The §4.2 three-tier model (primitive → semantic → component) is documented but has no
working spelling. Probing the live checker shows *two* concrete blockers to the
simplest possible consumer — a module-level semantic token referenced in a prop:

```
type OnSurface = Color where contrast(value, surface) >= 60
let surface = #0d1117
def view(): Element
  Column background=surface
    Text "hi" color=#111111      -- near-black on dark: SHOULD fail OnSurface
```

1. **Name resolution.** `background=surface` reports `unresolved name: surface` — a
   top-level `let` does not bind into the env used for element props.
2. **Const-folding.** Even once resolved, the contrast proof calls
   `constEval(p.value, EMPTY_ENV)` (infer.ts:1914) with an env that holds no module
   bindings. `constEval`'s `Var` case (infer.ts:319) returns `undefined` for any name
   not already in the map, so a token reference folds to nothing and the proof is
   **silently skipped** — the dangerous failure mode (looks checked, isn't).

So the contrast guarantee, today, is real *only* for `color=#111111 background=#0d1117`
written inline on the same subtree. Themeable code defeats it. That is the thing to fix.

## 2. The model

Two concerns, kept deliberately separate (user steer, 2026-06): **declaring** a surface's
value, and **applying** it globally. Declaration is type-gated; application is explicit.

### 2a. Declaration — a typed `Surface` role
A surface is not "any colour binding" — it is a `Color` *typed* `Surface`. The type is the
marker, so there is no new `token` keyword and no implicit sweep of every `let`; behaviour
keys on `type == Surface`.

A hex literal is a `String` in this checker (the nominal `Color` is the `oklch` *record*
type used by `std/color`), so the role types rest on the existing fixture convention
`type Color = String` — the hex-string form colours take in props. `toHex` bridges a
computed `std/color` value back to that string (Slice 3).

```
type Color     = String                                 -- hex form colours take in props
type Surface   = Color                                  -- a Color designated a background role
type OnSurface = Color where contrast(value, surface) >= 60   -- the readable foreground (§4.3, unchanged)

let panel: Surface = #0d1117      -- a surface role, by type
let sunk:  Surface = #010409
```

A richer **theme groups roles** into one value — surfaces plus the foreground/accent roles
derived from them via `std/color`:

```
type Theme = {
  panel:    Surface,
  text:     Color,            -- onAccent-style roles derived: legibleOn(panel)
  accent:   Color,
  onAccent: Color,            -- = legibleOn(accent)
}
```

`std/color` is the theme's constructor: derived roles are *computed*, not hand-picked
(`onAccent = legibleOn(accent)`, `sunk = shades(panel, 1)`), so a theme authored this way
is correct-by-construction on the axis §4.3 checks. This is the first consumer of the
built-but-unused colour science (`legibleOn`, `mix`, `lighten`, `shades`, `contrast`).

### 2b. Application — explicit, via `using`
Global application is **opt-in and visible at the signature**, not an ambient
`background=` prop-walk. An element-returning function declares the surface it renders onto:

```
def card(): Element using panel        -- `panel` is the ambient surface for this subtree
  Column
    Text "Title"  color=text           -- proven readable against `panel`, at check time
    Text "Body"   color=#8b949e        -- folded + APCA-checked vs panel too
```

`using S` sets the ambient surface for the function body — it is exactly what feeds the
existing surface-threading (`surfaceBg`, infer.ts:919/1939) and therefore the §4.3 APCA
proof, but established *explicitly by the author* instead of inferred from a `background`
literal walked down the tree. (`using` is the vocabulary already reserved in TODO §3.1 for
this; `with` was considered and set aside to keep one keyword.)

**Inline declare-and-apply (sugar).** For a one-off surface you don't want to name
separately, `using` accepts a binding directly:

```
def splash(): Element using surface = #000000     -- declares + applies in one breath
  Text "Hello"  color=#ffffff                      -- proven against #000000
```

`using surface = <expr>` desugars to "introduce a `Surface`-typed binding `surface` scoped
to this body, then apply it" — i.e. it is exactly `let surface: Surface = <expr>` immediately
followed by `using surface`, collapsed. The named form (`using panel`) stays the idiom for a
*shared* role pulled from a theme; the inline form is for the local, throwaway case. Both
land at the same place: `surfaceBg` set for the body, contrast proven against it.

Swapping the theme swaps what the roles resolve to. Dark→light is one binding, and *every*
`using`-scoped component re-proves contrast against the new surfaces — the property no CSS
framework offers (silent no-op there; type error here).

## 3. Slices (each independently shippable + verifiable)

Staged so the highest-leverage, lowest-risk change lands first and each slice leaves a
green fixture behind. Edition discipline: roles are *additive* surface (a new way to
spell a colour); no existing spelling changes, so no edition gate needed until/unless we
*forbid* raw hex in component position (a §4.2 "DECIDE", deferred to a later edition).

### Slice 1 — typed `Surface` tokens fold into the contrast proof ✅ DONE (2026-06)
Make a module-level constant binding resolvable in prop position **and** foldable by
`constEval`, so a role reference (`background=panel`, `color=ink`) participates in the
existing APCA proof. **As-built:**
- **Module-level bindings now exist.** There was *no* top-level `let` at all — the lowerer
  silently dropped it (`lowerTopDecl` returned `null`), so the §4.2 token tier was
  unreachable. Added a `DLet` decl (`ast.ts`), lowered from a top-level `binding` node
  (`lower.ts`), registered in resolve (`collectDecls`/`resolveDecl`) and in the type
  pass (`collectDecls` + a new `inferLet`), and evaluated in `eval.ts` (`evalDecls`
  placeholder + `evalDecl`). Top-level `let panel: Surface = #0d1117` now resolves,
  type-checks against its ascription, and binds at runtime.
- **The fold.** A new `moduleConsts: Map<string, ConstVal>` on the inferrer is populated
  (in declaration order) by `constEval`-ing each immutable `DLet`, then threaded into the
  three element-prop `constEval` sites (ambient-bg, scale, contrast) in place of
  `EMPTY_ENV`. `constEval`'s `Var` case already reads its env, so a token reference folds
  to its hex and the §4.3 proof fires against it.
- **Proof:** `theme_token_test.velve` — tokens for surface + foreground, nested surface,
  all legible → 0 err, and `run` prints the resolved hexes. `theme_token_bad.velve` —
  an illegible role pairing (`#9aa0a6` on the white `panel`, dark `ink` on dark `sunk`)
  fires two `fails 'OnSurface'` errors via the *token-resolved* background. Corpus
  baseline unchanged (294 err / 0 CRASH): the change is inert on any file without a
  top-level `let`, and the corpus has none. No grammar, no edition.
  Converts "built but no consumer" into "consumed and proven."

### Slice 2 — the `using` clause (explicit application + inline sugar) ✅ DONE (2026-06)
The headline ergonomics: an element-returning function declares the surface it renders
onto, and that — not a `background=` prop-walk — drives the ambient surface and the proof.
**As-built:**
- **Grammar.** Added a `using_clause` (`using lower_id` with optional `= <expr>`) as an
  optional tail on both forms of `function_def` (grammar.js). Regenerated the parser
  (`tree-sitter generate`) and rebuilt the native binding (`node-gyp rebuild`). Purely
  additive — no existing spelling changed.
- **Lowering.** Added a `surface: { name; value: Expr | null } | null` field to `FnClause`
  (ast.ts); `lowerFnClause` now pulls the `using_clause` out of the body node list (so it
  never leaks in as a statement) via `lowerUsingClause`. Named form leaves `value` null;
  the inline `using surface = <expr>` carries the bound expr.
- **Resolve.** `resolveClause` resolves the named role against the enclosing scope (a typo
  → `unresolved surface role: …`, never a silent no-op) and, for the inline form, resolves
  the value then defines the name into the body scope.
- **Checker.** `inferClause` sets `this.surfaceBg` from the clause's surface before
  inferring the body and restores it after — the named form reads the role's already-folded
  hex from `moduleConsts`; the inline form infers + folds + temporarily registers its name.
  This reuses the *exact* `surfaceBg` threading the `background` walk feeds, so the §4.3
  APCA proof runs against the `using` surface with **zero new proof logic**.
- **Runtime.** `runClause` binds the inline surface name in the body env (eval.ts), so a
  body may reference it. The lambda-built `FnClause` carries `surface: null`.
- **Proof:** `theme_using_test.velve` — a `using panel` component and a `using surface =
  #000000` component both prove their `color` props readable → 0 err, runs. `theme_using_bad.velve`
  — a dark role under `using night` and a dark literal under the inline `using surface =
  #000000` both fail, the errors reporting `against background #101418` and `#000000`
  respectively — proving *both* forms reach the proof, with the surface coming purely from
  `using` (no `background=` on the body). Corpus baseline unchanged (294 err / 0 CRASH).
  This is the slice that realises the user's "explicit global application" requirement.

### Slice 3 — a `Theme` record + derived roles via `std/color` ✅ DONE (2026-06)
Group roles into one value (`theme.panel`, `theme.text`, `theme.onAccent`) instead of
loose `let`s, with the foreground/accent roles *computed* from the surfaces at check
time — making `std/color` the first real consumer of the built-but-unused colour science.
**As-built:**
- **Shared colour maths (`src/color.ts`).** The OKLCH/APCA implementation was extracted
  out of `eval.ts` into one module imported by *both* the runtime (`COLOR_RT`) and the
  compile-time fold (`infer.ts constEval`). This is load-bearing, not tidiness: the §4.3
  guarantee is only honest if a derived role folds at check time to the *exact* hex the
  runtime renders — one implementation makes divergence impossible. `eval.ts`'s colour
  builtins now wrap the pure ops; colour-test output is byte-identical post-refactor.
- **Record + field folding.** `ConstVal` gained a record form (`ConstRec`); `constEval`
  gained a `Record` case (fold field-by-field, `...spread` first) and a `Field` case
  (key lookup on a constant record; `.l/.c/.h` on a folded colour). So a module-level
  `let dark: Theme = #{ … }` folds into `moduleConsts` and `dark.panel` resolves.
- **Colour-builtin folding.** A folded `Color` is its OKLCH triple `[L,C,H]`; `constEval`
  folds `oklch`/`hex`/`gray`/`lighten`/`darken`/`saturate`/`desaturate`/`rotate`/
  `complement`/`cusp`/`mix`/`legibleOn`/`shades`/`tints`/`ramp` over constant colours, and
  `toHex` re-stringifies for props. `contrast` also folds over triples now. So
  `toHex(legibleOn(panel))` resolves to a concrete hex at check time.
- **Application = Slice 2's inline form, no new grammar.** A component renders
  `using surface = dark.panel` (and a button `using surface = dark.accent`); the `Field`
  fold feeds `surfaceBg`, so the §4.3 proof runs against the *theme role*. (The named
  dotted sugar `using theme.panel` is deferred — purely cosmetic; the inline form already
  reaches the same place, keeping Slice 3 grammar-free as §5 predicted.)
- **Proof:** `theme_record_test.velve` — a `dark` and a `light` `Theme` built from base
  surfaces via `std/color`, with `text = legibleOn(panel)` / `onAccent = legibleOn(accent)`
  derived; components proven against their panel **and** accent surfaces → 0 err, and `run`
  prints the computed hexes (`dark panel=#141822 text=#f8f8f8`, `light panel=#f2f5fc
  text=#0b0b0b`) — the *same* hexes the proof checked. `theme_record_bad.velve` — a
  hand-picked grey `text` on the derived light panel (`Lc 56 against #f2f5fc`) and a dark
  literal on the derived accent (`Lc 28 against #4a81eb`) both fire: the backgrounds are
  std/color-*computed*, proving the fold reaches the proof. This is the slice that makes a
  theme correct-by-construction on the axis §4.3 checks. Corpus baseline unchanged.

### Slice 4 — `theme` as a read-only reactive root (runtime swap) ✅ DONE (2026-06)
styles-design §9.1 / line 705 **DECIDED** `theme` is a read-only reactive root
(store-like), the sibling of `viewport`: anything may read `theme.*`, nothing writes
back from a view. This slice makes `theme` a live, swappable root and proves the active
theme's legibility at check time. **As-built:**
- **`theme` is a built-in root, mirroring `viewport`.** Defined in all three passes —
  a `VRecord` of role→hex in the eval prelude, a `Record` type in the infer prelude, and
  a reserved name in resolve. Its default roles are **derived via std/color** from one
  shared source (`color.ts DEFAULT_THEME` — `text = legibleOn(panel)`, `onAccent =
  legibleOn(accent)`), so the active theme is correct-by-construction on the §4.3 axis and
  the hex the runtime renders is the exact hex the fold proved. No grammar; no edition.
- **Check-time contrast against the live root.** `moduleConsts` is pre-seeded with the
  default `theme` (an existing `ConstRec`), so `theme.panel`/`theme.text` fold through the
  Slice 3 `Field` path: `using surface = theme.panel` + `color = theme.text` is **APCA-proven
  (§4.3) against the ambient theme itself** — not an inline literal, not a hand-named token,
  but the root. This is the new capability over `viewport` (which doesn't feed the proof):
  *"compile-time contrast proven for each statically-known theme."* A theme swapped to a
  genuinely dynamic value is the documented §14.1 escape (proof falls back to runtime).
- **Runtime swap = one host write channel.** `setTheme(theme)` overwrites the global
  `theme` slot (`defineGlobal`); because every captured env reaches that global via its
  parent chain, the next `view()` render resolves `theme.*` to the new roles — runtime
  theming, reads staying read-only (the single writer is `setTheme`, store-action-style).
- **No convergence-pass code change needed — and that's the point.** A `theme.*` read adds
  **no inbound edge** to the (element,prop) graph, so a theme-driven layout is acyclic by
  construction (§9.1). The *only* way back into a cycle is a container query — an element
  that picks its surface by measuring the box that surface then sizes (measure→theme→measure)
  — and the **existing** §6.2 cycle-checker already rejects that, unchanged.
- **Proof:** `theme_root_test.velve` — components render `using surface = theme.panel` /
  `theme.accent`, every `color` proven against the live root → 0 err; then `setTheme(light)`
  re-renders the SAME `view()` and the surviving leaf's colour swaps `#f8f8f8 → #0b0b0b`
  (runtime swap, fold==runtime preserved). `theme_cycle_bad.velve` — a self-measuring
  container query (`padding` off `self.width`, `width` back off `self.padding`) is rejected
  with *"convergence cycle … involving 'padding' on Box"*; the `background=theme.panel` read
  adds no edge, so the cycle is purely the measure-feedback, proving theme's acyclicity.
  Corpus baseline unchanged (294 / 0 CRASH); colour tests byte-identical.

## 4. Non-goals / deferred

- **Forbidding raw hex in component position** (§4.2 "DECIDE: components may only
  reference semantic tokens"). Powerful but needs a visibility/capability rule on
  bindings; defer to a later edition as an opt-in lint first, then an edition gate.
- **Responsive × theme interaction** (a role that varies by breakpoint) — both are now
  read-only roots and responsive prop-site auto-collapse has **landed** (TODO §3.1,
  styles §9.3 *As-built*), so this is now unblocked; still deferred as future work
  (a role authored as `Breakpoint -> Color` would collapse the same way a `Length` does).
- **Per-component theme override / nested themes** — single ambient theme first.

## 5. Why this order

Slice 1 alone closes the credibility gap (the a11y proof currently can't see themeable
code) with a localized change to two `constEval` call sites — no new pass, no grammar,
no edition — so it lands first and de-risks the rest. Slice 2 adds the one piece of
grammar (the `using` clause + its inline sugar) but reuses Slice 1's fold path and the
existing `surfaceBg` threading verbatim, so the *proof* logic stays untouched. Slice 3 is
pure `constEval` extension (record fields, pure colour builtins) over the same path.
Slice 4 was scoped as "the convergence-pass slice," but the as-built finding is sharper:
because a read-only root adds **no** edge to the (element,prop) graph, `theme` needed
*zero* convergence-pass code — it rides the §6.2 cycle-checker that already exists, and
the only new wiring is seeding the root into the same `moduleConsts` fold Slices 1–3 use.
The decision it rides was locked in §9.1. Risk and blast radius grow strictly down the
list; value is front-loaded — the distinctive a11y guarantee starts firing on real code
at the end of Slice 1, and by Slice 4 it proves a *live, swappable* theme.
