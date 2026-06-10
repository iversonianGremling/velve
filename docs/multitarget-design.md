# Velve — multi-target design notes (color · theme · layout · input · i18n · terminal)

Status: **DESIGN / in-progress.** Running record of an extended design conversation.
What is actually *built* is marked ✅; everything else is a sketch/decision to revisit.

## 0. The spine: semantic layer + per-target lowering + exhaustiveness

The single idea under everything here. For each concern, velve has:
1. a **typed semantic layer** (named, closed where possible),
2. **per-target lowering** (web / GPU / terminal),
3. **exhaustiveness/typing** over the semantic set.

| Concern | Semantic layer | Lowers to |
|---|---|---|
| Color | `Color` (OKLCH, perceptual) | web `css`/`hex`, GPU `toLinear`, terminal nearest-ANSI/slot |
| Layout | flow (`Row`/`Column`/`Stack` + `gap`/`align`) | DOM nodes, GPU quads, terminal cells |
| Input | **actions** (functions) + `inputmap` | keyboard / MIDI / gamepad / gesture event sources |
| Strings | locale catalog (auto-extracted) | per-locale render |
| Terminal output | the element DSL | cell rasterizer (caps-aware) |

This is why "build for web, port to terminal" is nearly free: only the lowering changes.
It is also where velve differs from SwiftUI / Photoshop / Max — **none of them type the
semantic layer**; velve does (HM + refinements + exhaustiveness).

## 1. Color ✅ (the `Color` stdlib module is built)

A `Color` is the record `{ l, c, h }` (OKLCH). Module is data-first so it pipes.
Built (`std/Color`): construct (`oklch`/`hex`/`gray`), adjust (`lighten`/`darken`/
`saturate`/`desaturate`/`rotate`), harmony (`complement`/`analogous`/`triad`/`tetrad`/
`splitComplement`), `mix` (OKLab), `cusp` (gamut cusp — the lime/amber fix), `contrast`
(APCA Lc), `legibleOn`, `toHex`/`css`, `toLinear` (GPU). In progress (subagent):
`deltaE`, `ramp`/`tints`/`shades`, `simulate` (CVD), `nearestAnsi`, named-hue constants.

Color science adopted (the "respect perception" stack):
- **OKLCH** as the canonical, device-independent space (perceptual — the "Mel scale" of color).
- **Gamut cusp**: each hue is most-saturated at a *different* lightness (lime ~0.92, blue ~0.55).
  Seat vivid roles at the cusp so lime/amber don't read as muddy olive.
- **APCA** (WCAG-3 perceptual contrast, Lc) for legibility — not the flat WCAG ratio.
- **ΔEOK** for distinguishability (subagent).
- Per-mode **vibrancy**: keep accents bold in light, soften in dark (Helmholtz–Kohlrausch,
  halation, dilated pupil). Verified in the devtool.

Interactive design artifacts (NOT language features — mockups): `checker/web/theme-playground.html`,
`checker/web/theme-devtool.html` (dials for hue/vividness/contrast/vibrancy, words/numbers/hex/
import/target tabs, gamut-cusp toggle, APCA badges).

## 2. Theme system (SKETCH — built on Color)

A theme is **scoped + derived + proven + composable**. Not `dark:bg-gray`.
- **Roles, not colors**, at call sites: `Surface raised`, `Text role=text`, `Button primary`.
  Most elements carry no color prop; foreground is auto-derived.
- **Derived from a small seed** (1–2 colors) via tone steps — the only literals in the app.
- **Scoped** (`Surface using app` / `using dark`) — a subtree re-themes; resolves via the
  convergence layer (`parent.theme`). No prefixes.
- **Proven**: `OnSurface(bg) = Color where contrast(self, bg) >= <target>` (APCA) — an
  illegible theme doesn't type-check.
- **Composable value**: `let dark = app with { polarity: Dark }` — light/dark are
  *instantiations*, not enum cases to `match` at every site.
- **Tone/accent split** (Solarized): light↔dark flips the neutral tone ramp; accents stay.
- **Target color / anchor**: pin `primary` to an exact brand hex; `onPrimary` is *solved*.

New primitives this needs: a `theme` decl (sibling to `store`), `oklch`/`tone` (have `oklch`),
`Surface using …` scoping, auto-foreground defaulting. Tweak metric already exists.

## 3. Layout (flow; SwiftUI's cousin)

Shared with SwiftUI: declarative `view()`, stacks, **environment** (theme/viewport =
`@Environment`), semantic colors, exhaustive-state UI, reconciliation. velve goes further with
refinements/exhaustiveness + the explicit, cycle-checked **convergence** layer.

Designer-preferred model = **declarative flow (stacks + spacing + alignment), constraints as
escape** — Figma Auto Layout, SwiftUI VStack/HStack, flexbox. velve already has it
(`Row`/`Column`/`Stack` + `gap`/`align`, convergence as the opt-in constraint island). Because
it's *relative*, it ports to cells and quads; absolute-pixel layout would not.

## 4. Input (DESIGN — the big open area)

**Actions are ordinary functions.** The binding lives in an `inputmap` (a value), separate from
behavior → rebindable. A `keymap` = `inputmap` over the keyboard.

Declaration (chosen shape: aligned binding rows referencing functions, inline help label):
```
keymap
  Ctrl+S  -> save        "Save"
  j       -> selectNext  "Next item"
  ?       -> help        "Shortcuts"
```
Generalized:
```
inputmap
  Key Ctrl+S     -> save     "Save"
  Midi note(60)  -> playC
  Pad A          -> jump
```
Wins (no framework gives all of these): inline label → **auto-generated help overlay**;
**compile-time conflict check** (two actions, one chord = error); `inputmap` is a value →
layer `default ++ userOverrides`; **portable** web→terminal (only the source adapter differs).

### 4.0 `inputmap` design (decided 2026-06-09; core BUILT 2026-06)

> **Build status (2026-06, SPEC §10.5):** the core shipped — `inputmap Name over
> Stream`, `pattern -> action ["label"]` rows typed against the stream's event
> type, conflict analysis ("bound twice"/"shadowed"; guarded rows exempt),
> labels retained on the AST, and the drain-loop runtime (call the map, it
> drains until `Done`). Fixtures `checker/inputmap_test.velve` /
> `inputmap_bad.velve`. **Help-as-derived-data also shipped** (2026-06): a
> dedicated `Inputmap` type (aliasing-safe, like SagaFn) + `help(map)` →
> `List({pattern, label})`, labelled rows only, declaration order
> (`inputmap_help_test`/`_bad`). **Layering also shipped** (2026-06):
> `base ++ overrides` — unguarded override rows replace same-pattern base rows
> in place, others append; operands untouched; cross-stream layering is a
> check-time error since the `Inputmap` type carries its stream
> (`inputmap_layer_test`/`_bad`). **Chords also shipped** (2026-06), exactly as
> designed — no new grammar: `type Chord = String where matches(value, …)` + a
> literal-pattern refinement fold (a literal that fails the matched type's
> refinement can never match → check error, at every match site) + `Push(p)`
> against a stream of `T` checking `p` against `T`
> (`inputmap_chord_test`/`_bad`). **`keymap` also shipped** (2026-06): pure
> sugar for `inputmap Name over Key`, with a fix-it when no `Key` stream is in
> scope (`keymap_test`/`_bad`). **As-built deviation:** actions are *explicit
> calls* — a bare function-valued action (`-> save`) is a checker error with a
> fix-it (`save()`); this section's bare-reference rows predate the §2.1
> call-syntax unification. Still unbuilt: the physical-key prefix (`"@KeyW"`)
> + a std `Key` device library with a canonical chord refinement, focus-zone
> scoping, the *rendered* overlay element, device libraries (§4.1).

**Core realization: `inputmap` = a typed pattern-match over a merged input-event stream,
as a table.** Not a new mechanism — it composes three things that exist: **streams** (the
event source; lowers onto the `makeStream`/`externSource` unlock §4.1), **pattern matching**
(binding + overlap/exhaustiveness), and **event payloads**. Desugars to:
```
go loop
  await events | <pattern> -> <action> | … | _ -> ()
```
Everything else is static sugar over `match` + the input primitive. No new runtime.

- **Row:** `<pattern> -> <action> "label"`. Left = a *pattern* over the source's event type;
  right = a function (action), optionally taking values the pattern bound; label = help text.
- **Chords = compile-time-validated strings** (reuse refinements, no new grammar):
  `type Chord = String where validChord` → `"Ctrl+S"` is a literal pattern validated by the
  refinement folder. Logical-vs-physical as a prefix: `"Ctrl+S"` logical (char, AZERTY-safe),
  `"@KeyW"` physical (position).
- **Value-binding** for rich sources via ordinary match binding:
  `inputmap over Midi | CC 7 v -> setVolume(v) | Note n _ -> play(n)`. A chord-string is a literal
  pattern; an ADT ctor binds — same as `| 4 ->` vs `| n ->`. `keymap` = `inputmap over Key`.
- **Conflict-checking = match overlap analysis** (the dual of exhaust.ts): two rows matching the
  same event = a compile error ("bound twice"/"shadowed"). Free from the existing analysis.
- **Modes/zones** (the "keys change by zone" concern): an `inputmap` is a *value*, so —
  layering (`base ++ overrides`), modes (`match mode | Normal -> normalMap | Insert -> insertMap`,
  exhaustive), and **focus-scoped** maps that layer innermost-first (capture/bubble, like DOM +
  convergence scope).
- **Help overlay = derived data**: `Help(active)` renders the `{pattern, action, label}` table
  (filtered by mode/zone), chord labels localized via `navigator.keyboard.getLayoutMap()`. Same
  overlay on web + terminal (element DSL + cell rasterizer).
- **Per-target + capability gating**: `over Key` → host keyboard stream (DOM `keydown` / terminal
  raw-mode); `over Midi` requires the `Midi` capability (library) — effect-gated, caught on targets
  without it.

New work: a keyword-led `inputmap`/`keymap` block (safe grammar family) + wiring overlap-check and
help-gen onto the existing exhaustiveness/match analyses. Everything else reuses shipped machinery.

**Keyboard i18n** — two ways to name a key, need both:
- **Logical char** (`event.key`) = mnemonic; `Ctrl+S`=save binds the *character* so AZERTY/Dvorak
  still get the mnemonic. Default for modifier chords.
- **Physical position** (`event.code`) = spatial; WASD/`hjkl` bind position. Opt-in (`Pos KeyW`).
Missing keys → alternative bindings per action + a layered "layout pack"; help shows what exists;
labels via `navigator.keyboard.getLayoutMap()`.

### 4.1 Custom inputs + the primitive/library boundary (the hard question)

**An input device = a host resource that produces a typed STREAM of events.** velve already has
streams (push channels) + effects/capabilities + an FFI escape (`@js{}`, `extern`). So:
- **Core grammar/runtime provides** the small universal primitives: streams, effects, and an
  **FFI/extern source** (call a host API; register a callback that `send`s into a velve stream).
  This is the ONE thing the core must give — every language has a host boundary (Rust `extern`,
  Python C-API). velve's is `@js`/`extern` + stream injection.
- **A device is a LIBRARY**, not grammar: it wraps the host source into a typed
  `stream Midi : MidiEvent` + an event ADT + (optionally) `inputmap` pattern matchers.
  Built-in devices (MIDI/gamepad) and user devices use the *same* recipe — built-ins are just
  libraries we ship.
- **A user custom input**:
  ```
  extern openSerial : String -> Source(Bytes)      -- FFI to host (or @js{})
  stream Sensor : Reading
  def driveSensor():
    let port = openSerial("/dev/ttyUSB0")
    loop
      await port | Data b -> send Sensor (parse(b))
  ```
  then `inputmap … Sensor.over(threshold) -> action`. A *pure* derived input (webcam frames →
  gestures) is plain velve: `Webcam |> detectPose |> map(toGesture)` — a stream combinator.

Decision: **don't put devices in the grammar.** Put streams + effects + FFI in the core; express
devices as libraries that lift host sources into streams. Effects gate them (using `Midi` needs a
`Midi` capability, like `io`).

**✅ Shipped (2026-06-09) — the input FFI primitive.** Two doors onto the same mechanism
(`VStreamQueue.push` from outside the velve scheduler; a parked `await` consumer resumes, driven by
the *real* host event loop, not the virtual clock):
- **Host API** `Evaluator.makeStream()` → `{ stream, push, pushJs, done }`. The embedder/device
  runtime (browser host, `std/midi`'s JS) creates an injectable stream and feeds it from real
  async callbacks. Also `Evaluator.defineGlobal(name, value)` to bind a host stream into velve scope.
- **Velve-facing builtin** `externSource(setup) : Stream(a)` — `setup` gets `push : a -> Unit` and
  `done : () -> Unit` to wire a producer; returns the Stream. This is how user code defines custom
  inputs (wire a host source via `@js{}`, or a pure producer).
Verified: `extern_source_test.mjs` (host pushes `[10,20,30]` via `setImmediate` → velve consumer
parked on `await` receives them, no virtual clock); `extern_velve_test.velve` (`externSource` +
recursive consumer → `[10,20,30]`). 180 corpus, all stream/color fixtures clean.

> **BUG found (pre-existing, separate from this):** `mut` reassignment *inside a `match`/`await`
> branch body* does not propagate to the outer binding (`| Push v -> total = total + v` leaves
> `total` at 0), though plain `if/break` + reassign works. Workaround: accumulate via a recursive
> arg (functional style) or a store. Worth a real fix — branch bodies likely reassign in a child
> env instead of walking up. (The `externSource` consumer pattern uses recursion to sidestep it.)

### 4.2 Modularity / accessibility
Most programmers don't need every device/a11y feature. Split into opt-in libraries
(`std/midi`, `std/gamepad`, `std/gesture`, `std/a11y`). A11y inputs (switch access, dwell, sticky
keys, screen-reader hooks) live in `std/a11y`. Keep the core minimal.

### 4.3 Remap UI (planned artifact)
A "press your controller to bind it" screen (like an emulator's config): show a MIDI keyboard/pad/
knob layout, listen via WebMIDI, light pressed controls, click a target then press to assign — for
when auto-mappings are wrong. Buildable web artifact; deferred.

## 5. Internationalization (DESIGN — velve has an unfair advantage)

The compiler already knows *which strings are user-facing* (they reach `Text`/`Button`/`print`/
keymap labels) and *what component they're in*. So extraction can be **automatic** (gettext/Fluent
require manual marking):
1. Walk every string literal reaching a user-facing sink → catalog entry keyed by
   **component path + position** (`Watch.digest.title`), with an auto-comment naming the component.
2. Interpolations → **ICU/Fluent placeholders** (`"count {n}"` → `count {$n}`) so translators get
   real templates + plural/gender rules.
3. **Locale is an environment root** (like `theme`/`viewport`); strings resolve through the active
   catalog at render — `print` included.
Caveats: provide an **opt-out** (`raw"…"`) for user-facing-typed-but-constant strings; the catalog
format must be **Fluent-like, not key=value** (plurals/gender).

## 6. Terminal output (DESIGN — `print` is the cell rasterizer)

`print` of a string → text; `print` of an **Element** → render through the terminal backend.
`Table`/`Panel`/`Tree` are *elements*, styled by the same props, rasterized to cells +
box-drawing + role-mapped ANSI color. `print(Table(rows))`, `Table border=rounded padding=1`.
**Capabilities** (unicode box chars? 256/truecolor? width?) = a **terminal `viewport`** environment
root; degrade gracefully (ASCII borders, color downsample). Same idea as `rich`/`Textual`, but
unified with the view DSL instead of a separate library. So `print`, the ncurses port, and tables
are all "the element DSL + a cell rasterizer."

## 7. Creative-tools mapping (the "seamless, not a substitute" goal)

velve's purity/derivation **is** the non-destructive, token-driven model designers already use:

| Creative tool | velve |
|---|---|
| Global swatches (edit once → all update) | roles / tokens |
| Adjustment layers (non-destructive) | derivations (change seed → re-derive) |
| Recolor Artwork (remap palette) | theme swap / palette import |
| Layers + blend modes | `Stack` + `blend=` (a `BlendMode` ctor exists) |
| Color profiles (sRGB/P3/CMYK) | OKLCH canonical + per-target encode |
| History / snapshots / time-lapse | `@debug{}` time-travel (proposed) |
| Components / symbols | functions |

## 8. Debug mode (DESIGN — make the devtool a projectional editor)

The dev-mode theme devtool should gain **persistence + codegen**: a "Copy as velve" that emits the
`theme app / seed / roles …` block from the current dials (design visually → get real source,
lossless because the source *is* the model), plus localStorage persistence, plus the `@debug{}`
time-travel timeline. This turns the devtool from a toy into a projectional editor over velve
source. Highest-value concrete next build.

## Open decisions / TODO
- `inputmap` exact grammar (keyword-led block, like `keymap`); logical-vs-physical key syntax.
- ~~The FFI/`extern source` primitive~~ ✅ shipped (`makeStream` host API + `externSource` builtin).
  Follow-up: ergonomic `@js{}` for device wiring (the no-`}` + expression-only limits), and a
  `std/midi`/`std/gamepad` built on `makeStream`.
- **Fix `mut` reassignment inside `match`/`await` branch bodies** (found while testing the unlock).
- i18n catalog format (Fluent-like) + the `raw"…"` opt-out + `locale` env root.
- Terminal: capability detection env root; `Table`/`Panel` elements + cell rasterizer.
- Theme decl + `Surface using` scoping + `OnSurface` (APCA) refinement.
- Devtool → velve-source export + persistence.
