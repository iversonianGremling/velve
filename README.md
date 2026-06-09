# Velve

A statically-typed language for building interactive applications, where the type
system carries the weight — from your data model all the way down to layout and
colour. If something can be wrong, Velve tries to make it a compile error rather
than a thing you discover in production.

> **Status: early and experimental (spec v0.5).** The grammar, type checker, and a
> tree-walking interpreter all work and run real programs, but the language is
> pre-1.0 and still moving. Expect sharp edges, and expect things to change.

```velve
type Email = String where matches(value, "^[^@ ]+@[^@ ]+\.[^@ ]+$")
type Age   = Number where 0 <= value && value <= 150

def greet(name: String, age: Age): String
  age < 18 ? "hi {name}" : "welcome, {name}"

def main(): Unit
  print(greet("Ada", 30))      -- ok
  -- greet("Ada", 200)         -- compile error: 200 fails refinement 'Age'
```

## What makes it different

- **Inference that pulls its weight.** Hindley–Milner type inference means you
  rarely annotate; the compiler usually knows more than you wrote.
- **Refinement & dependent types.** `type Age = Number where 0 <= value` isn't a
  comment — constant values are checked at compile time, and `Age.parse` guards the
  rest at runtime. Refinements can depend on other values (`InBounds(length xs)`).
- **An ownership model, type-driven.** Affine move-tracking, real pointers
  (`.&` / `.*`), region lifetimes with an outlives solver, and deterministic `drop`
  — copy types clone, resources move. It's the foundation a future GC-free compiled
  target will build on; today it runs on the interpreter.
- **Honest effects.** Every side effect is in the signature:
  `def save(): Effect [network, storage] ()`. The compiler checks them at the call
  site.
- **Stateful logic as first-class shapes.** `store` (Elm-style state + messages),
  `machine` and `saga` (statecharts with persistence, compensation, and a replay
  journal), `stream` combinators, and `transaction` blocks with rollback.
- **Security as structure.** `Tainted` values can't cross a trust boundary
  unchecked; injection prevention lives in the type system, not a linter.

## A type-checked UI

Velve ships a small declarative UI layer where the same type discipline reaches
into styling. Components are ordinary functions returning `Element`:

```velve
def card(title: String): Element
  Column gap=8 padding=16 background=#000000
    Text (title) size=24 color=#ffffff
    Button "Open"
      on onClick -> send App Open
```

Because props are typed, a surprising number of "looks fine, breaks later" bugs
become compile errors:

- **Wrong-typed props** — `gap=#ff0000` or `radius=true` don't type-check.
- **Real units** — `width=Fill`, `width={Px 320}`, `width={Pct 50}`; a bare number
  means pixels.
- **Context validity** — `gap` on a non-flex element, or `grow` on a child whose
  parent isn't flex, is an error (CSS just silently ignores these).
- **Opt-in design scales** — define `type Space = Number where value==0 || ...` and
  off-scale spacing is rejected, with `raw(n)` as the explicit escape. Don't define
  it and nothing is enforced.

There's also `uiModel(view())`, which renders the element tree to an annotated text
outline — layout modes, resolved props, contrast (the inspector reports the flat WCAG
AA ratio today; the color system's `contrast` builtin and `OnSurface` refinements use
perceptual **APCA Lc** — see `docs/styles-design.md`), and accessibility flags — so a
UI can be inspected and linted as plain text:

```
Column  [flex]  gap=16 padding=24 background=#000000
  Text "Reports"  [leaf]  size=24 color=#ffffff
    · contrast 21.0:1 vs #000000 ✓
  Button  [leaf]
    ⚠ interactive element has no label/text (a11y)
```

## How it's built

Velve is three pieces:

| Piece | Where | What it does |
|---|---|---|
| **Grammar** | `grammar.js`, `src/` | A tree-sitter GLR grammar with an external scanner (`src/scanner.c`). |
| **Checker** | `checker/src/` | Lowering (`lower.ts`), name resolution, HM inference + refinements (`infer.ts`), exhaustiveness (`exhaust.ts`), and the borrow/ownership checker (`borrow.ts`). |
| **Interpreter** | `checker/src/eval.ts` | A tree-walking evaluator with a deterministic scheduler, stores/sagas/machines, streams, transactions, and a runtime-backed standard library. |

The language spec lives in [`SPEC.md`](SPEC.md); deeper design notes (block
semantics, the UI styling system) are under [`docs/`](docs/).

## Getting started

You'll need Node.js and a C toolchain (for the tree-sitter parser).

```bash
# Build the checker + interpreter
cd checker
npm install
npm run build

# Type-check a program
node dist/index.js check ui_render_test.velve

# Run it (renders the UI to HTML)
node dist/index.js run ui_render_test.velve
```

The runnable, passing programs are the `*_test.velve` fixtures in
[`checker/`](checker/) — each exercises one feature (refinements, pointers, units,
the UI model, …). The files under [`examples/`](examples/) are broader,
aspirational demos of the *intended* full surface (an auth flow, a checkout saga, a
real-time dashboard, an LLM agent); they're works in progress and not all of them
type-check yet.

## A small tour

```velve
-- Algebraic data types + exhaustive matching
type Status = Todo | InProgress | Done

def label(s: Status): String
  match s
    | Todo       -> "todo"
    | InProgress -> "in progress"
    | Done       -> "done"
-- a missing arm is a compile error

-- Pipes thread a value left to right; lambdas, currying, and partial application work
def evens(xs: List(Number)): List(Number)
  xs |> filter(fn x -> x % 2 == 0)

-- Stores: local state, messages in, computed values out
store Counter
  state
    n : Number = 0
  messages
    Inc -> { n: n + 1 }
  pub
    current = n
```

See [`SPEC.md`](SPEC.md) for the full surface: pattern matching, lambdas, error
propagation with `?`, async/streams, effects and capabilities, the memory model,
and transactions.

## Status & roadmap

What works today: the grammar (177 parser-corpus tests), the type checker
(inference, type aliases, refinement and dependent types, exhaustiveness, the
ownership/borrow checker), the interpreter, and the UI layer described above.

In design or in progress (see `docs/` and the proposed sections of `SPEC.md`):

- A **convergence layer** for layout — elements referencing each other's resolved
  properties, with compile-time cycle detection.
- **Responsive** values over a `Breakpoint` type, and a richer **state taxonomy**.
- A **compiled, GC-free target** alongside the interpreter.
- `@debug { … }` causal tracing and a **language edition** system for evolving the
  syntax without breaking older code.

These are sketches, not promises — the language is young and the priorities shift.

## Contributing

Issues and discussion are welcome. Because Velve is changing quickly, it's worth
opening an issue to talk through larger ideas before sending a big change. Run the
parser corpus with `tree-sitter test` and the checker's `.velve` fixtures with the
`check`/`run` commands above before submitting.

## License

MIT.
