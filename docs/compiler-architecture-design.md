# Compiler architecture — incremental checking, granular imports, many backends

Status: **DESIGN — architecture proposal, not built.** This note is about *compile
performance and retargetability*, not language semantics. It answers three worries
as the language and its `@`-rules grow: (1) keep the import surface tiny, (2) trace
a symbol's real dependencies and ship only those, (3) precompute so editing a
dependency doesn't redo a ton of work — and it does all three in a way that
survives **multiple backends** (JS today; machine code via Rust/LLVM, WASM, BEAM,
JVM later).

It extends the multitarget §0 spine (*typed semantic layer → per-target lowering →
exhaustiveness*) from per-concern (color, layout, input) to the whole compiler.

---

## 0. What exists today (baseline)

| Piece | Where | State |
|---|---|---|
| Pipeline | `index.ts` | **batch, whole-module, every-pass-every-time**: parse → lower → resolve → infer → exhaust → borrow, each walking all of `mod.decls` |
| Unit of compilation | `index.ts` | **one file** (`mod`); no cross-file dependency graph yet |
| Codegen | `render.ts` | emits HTML/JS **straight from the AST** — frontend and backend are coupled |
| Name graph | `resolve.ts` | `resolve()` already returns `resolutions: Map<name, target>` — *this is the dependency edge set*, currently discarded after each run |
| Feature gate (seed) | `converge.ts` | `hasConvRef(e)` — a cheap predicate that runs the expensive convergence pass only when the feature is present |
| Stdlib | `stdlib.ts` | lazy per-module factories (`makeColorModule`, …) keyed by alias |

Three of the right pieces already exist in embryo: the dependency edges
(`resolutions`), the feature-gate pattern (`hasConvRef`), and lazy module
construction. Two things are coupled that must be split: **codegen reads the AST
directly** (no IR), and **everything is batch** (no caching). This note is the plan
to grow the embryos and break the couplings — staged so it's additive, not a
rewrite.

---

## 1. Guiding principle

> A symbol's compile cost should scale with **what that symbol uses**, not with
> **how many features the language has**. And the **frontend runs once** no matter
> how many backends consume it.

The first half kills the "every `@` adds a global pass" fear. The second half is
what makes 5 backends affordable: type-checking `signup` must not happen five
times.

---

## 2. The shape: a target-independent middle, the IR as the contract

Three layers, with a **stable typed IR (call it Velve Core)** as the boundary:

```
  FRONTEND  (target-independent, runs once)
    parse → lower → resolve → infer → @-analyses (effects, footprint, totality, …)
       │
       ▼   Velve Core IR  ← the contract: typed, desugared, backend-agnostic
       │
  SHARED LOWERINGS  (once, on the IR: elements→Call, pattern compilation, …)
       │
       ▼
  BACKENDS  (per target — the ONLY per-target code)
    JS   WASM   native(Rust/LLVM)   BEAM   JVM
```

Everything *above* the IR is computed once and shared by every backend. Only
backends are per-target. This is the multitarget §0 spine, generalized: the
semantic layer is the frontend, "per-target lowering" is the backend set, and the
IR is what makes "build for web, port to terminal is nearly free" true for the
*whole language*, not just color/layout/input.

> **The one coupling to break first:** `render.ts` lowers AST→JS directly. Re-aim
> it at AST→IR→JS. Until the IR exists, every new backend re-walks the AST and
> re-implements desugaring, which is exactly the bloat this note prevents.

---

## 3. How other languages handle this

Two problems, well-trodden. Prior art worth copying:

**Fast incremental rebuilds — "cache the summary, not the body":**

| Language | Mechanism | Lesson for velve |
|---|---|---|
| **Go** | per-package precompiled **export data**; the compiler reads a compact *summary* of imported packages, never their source; no cyclic imports | the poster child for summaries; fast *by design*, not by cleverness |
| **OCaml / Ada / Modula** | interface files (`.mli`/`.cmi`) separate from bodies — change a body without changing the interface and **dependents don't recompile** | the "signature firewall" (§5) made physical |
| **Rust** | query engine + **red/green incremental**; `salsa` extracted for rust-analyzer; **MIR** is the target-independent IR, LLVM the backend | the model below — *and* the cautionary tale: the original batch rustc was too slow, queries fixed it |
| **Roslyn (C#)** | immutable red/green trees; **IDE and batch compiler share one model** | share the cache between LSP and CLI (§9) |
| **TypeScript** | `.tsbuildinfo` incremental + project references; the language service reuses the `Program` | **JS-hosted and still scales** — incrementality beats host-language speed (§7) |
| **Swift** | fine-grained cross-file dependency tracking; **SIL** IR; notoriously slow *expression* type-checking (operator-overload blowups) | cautionary tale for refinement folding (§8) |

**Many backends from one frontend:**

| Language | How | Lesson |
|---|---|---|
| **LLVM** | one typed IR, dozens of targets | a stable IR is the contract between frontend and many backends |
| **Kotlin Multiplatform** | **Kotlin IR** + *backend-independent lowerings*, then JVM / JS / Native(LLVM) | the closest precedent to velve's exact plan |
| **Gleam** | one typed frontend → **BEAM *and* JavaScript** codegen | literally velve's BEAM+JS case, shipping today |
| **GHC (Haskell)** | **Core** (typed IR) → STG → Cmm → native/LLVM, plus a JS backend | typed IR survives radically different targets |
| **.NET** | compile to **CIL** bytecode, JIT per target | the IR can even be the distribution unit |
| **Scala** | JVM / Scala.js / Scala Native, shared frontend | same split, three live backends |

The convergence of all of them: **a typed IR is the contract, summaries cross
module boundaries instead of source, and the IDE shares the compiler's cache.**
velve should land in the same place.

---

## 4. Granular imports + dependency tracing + tree-shaking

**Make the unit of import a *symbol* (`def`/`type`/const), not a file.** Then:

- **Tiny surface:** importing `String.trim` constructs only that symbol's scheme,
  not the whole string module. (stdlib is already module-lazy; extend to
  per-symbol for big modules.)
- **Dependency tracing is free:** persist the symbol→symbol edges `resolve` already
  produces. "What does `signup` depend on?" is graph reachability.
- **Tree-shaking falls out:** the build is the **reachable closure from the entry
  points**. Unreachable symbols are eliminated *by construction* — no special DCE
  pass at the velve level. (A backend can still lean on `esbuild`/LLVM DCE as a
  second net, but the IR-level closure is the cheap primary cut.)

Forbid cyclic *module* imports (Go-style) to keep the graph a clean DAG — it makes
both the build order and the cache invalidation deterministic. (Cyclic *value*
recursion within a module is fine; this is about the import graph.)

---

## 5. Incremental engine — content-addressed queries

The answer to "don't redo everything when I sneeze on a dependency." Structure the
compiler as **memoized queries** (`typeOf`, `effectsOf`, `footprintOf`,
`totalityOf`, `loweredIR`, `codegen(target)`), each keyed by a **content hash**:

- Hash each definition's AST **+ the hashes of everything it depends on + the
  edition** (semantics differ by edition, so it's part of the key).
- Edit one function → only its hash changes → only its transitive *users* recompute.
- **The signature firewall** (the part that actually saves you, from OCaml/Go): if
  a re-checked function's **public signature — type, effect row, footprint,
  totality — is unchanged**, its dependents don't re-check at all; you only re-lower
  that one body. Most edits don't touch signatures, so the blast radius of a typical
  edit is **one symbol**.

**Split the cache along the target boundary** — this is what makes 5 backends cheap:

| Cache layer | Keyed by | Shared across targets? |
|---|---|---|
| Frontend facts (type, effects, footprint, totality, IR) | symbol content hash | **yes — computed once** |
| Backend artifacts (emitted JS / WASM / BEAM / …) | (symbol hash, **target**) | no — per target |

Adding the JVM backend later recompiles **zero frontend**; it only fills the
per-(symbol, JVM) artifact column. Re-checking for a second target reuses the
entire frontend cache.

---

## 6. The `@`-rule registry — pay only for features you use

Make each `@`-analysis a **registered analyzer** that declares:

- **trigger** — the marker (`@interaction`, `@total`, `@kernel`) or a syntactic
  feature (`contains Ptr`, `contains Element`, `contains await`);
- **inputs read** — so the cache key is precise and invalidation is tight;
- **scope** — *local* (one function) or *interprocedural* (crosses calls).

The driver schedules an analyzer for a symbol **only when its trigger matches** —
generalizing `hasConvRef` to every pass. A pure arithmetic helper touches ~2
analyzers; a UI function touches convergence + contrast; a pointer function touches
borrow. **A new `@`-rule costs ~0 for code that doesn't use it.** That is the whole
defense against compiler bloat.

> **The interprocedural catch.** Effects, footprints, and totality are *summaries*
> that propagate across calls (`@total f` depends on the totality of everything `f`
> calls). Store the **summary** on each symbol; dependents read the summary, **not
> the body**. A leaf change ripples only when its summary changes — which the
> signature firewall (§5) already gates. Get this right and interprocedural analyses
> stay nearly as cheap as local ones.

---

## 7. Capabilities double as the target-portability checker

The effect/capability rows already in the language (multitarget §4 capability
gating; SPEC §12.3) are exactly the information that says **which backends a symbol
can run on**:

- a function with `[memory]` / `@kernel` → native/WASM, **not** BEAM or JVM;
- a function using DOM host capabilities → JS/WASM, not terminal;
- a function built on `store`/`machine`/`saga` processes → maps *natively* onto
  BEAM, and onto an actor runtime elsewhere.

So target compatibility isn't a new analysis — it's a **query over the effect
summary you already compute**: "does target T provide every capability this
symbol's closure requires?" A program that uses GPU on a BEAM target fails at
*compile* time with a precise reason, the same way `gap` on a non-flex box does.
Each backend declares the capability set it provides (Roc-style "platform"); the
checker does the rest for free.

This is also why the **IR must stay capability-honest**: don't bake a target's
assumptions into Velve Core. BEAM's process model and native's manual memory are
*backend lowerings* of the same capability-typed IR, not different IRs.

---

## 8. The one real hot spot — refinement folding

Refinement constant-folding (`constEval`, SPEC §3.5) **runs user code at compile
time** — the Swift expression-type-checker cautionary tale (§3). Bound it:

- only fold predicates marked `@total` (the concrete payoff of the totality note —
  totality is what makes compile-time folding safe to do *always* rather than
  conservatively skip);
- cap fold steps with a budget;
- cache fold results by input hash like any other query.

This keeps the most powerful frontend feature from becoming the slowest one.

---

## 9. The LSP shares the compiler's cache

One query database serves both `index.ts` (batch) and `lsp.ts` (interactive) —
Roslyn/rust-analyzer style, no second implementation to drift. The LSP then:

- runs queries **lazily on demand** — hover → `typeOf(thatSymbol)` only, never a
  whole-program pass;
- analyzes only the **open file's dependency cone**, not the world;
- debounces edits; reuses §5's firewall so a keystroke that doesn't change a
  signature re-checks one body.

The §6 feature-gating means hovering a pure function **never wakes the borrow
checker** — interactivity stays proportional to what you're actually looking at.

---

## 10. Build order — seams now, heavy machinery later

You do **not** need the incremental cache today; the fixtures are fine. You need the
**seams** cut so the cache slots in later without surgery.

> **DECIDED (proposal):**
> 1. **Introduce Velve Core IR** and re-aim `render.ts` at AST→IR→JS. Unblocks every
>    later backend and stops desugaring duplication. *(highest leverage)*
> 2. **Persist the resolve dependency graph** (symbol→symbol edges) instead of
>    discarding it. Unlocks tree-shaking (§4) and cache invalidation (§5).
> 3. **Generalize `hasConvRef` into a per-symbol feature set** and make passes
>    feature-gated via the analyzer registry (§6).
> 4. **Make the unit of import a symbol** (§4); forbid cyclic module imports.
> 5. *Later:* the content-addressed query cache (§5), split frontend/backend (§5
>    table), shared with the LSP (§9).
> 6. *Per backend, when added:* a codegen module IR→target + a declared capability
>    set (§7). Frontend untouched.

> **DECIDE:** whether Velve Core is a fresh IR or an annotated/normalized form of
> the existing lowered AST. Recommend a **distinct normalized IR** (elements already
> lowered to `Call`, patterns compiled, refinements erased to runtime checks) — a
> smaller, stabler contract is easier for five backends to target than the full AST.

> **DECIDE:** hashing granularity — per top-level symbol (recommended; matches the
> dependency graph and the firewall) vs. per-expression (finer, but the bookkeeping
> rarely pays off below the function level).

---

**Evidence basis:** the enabling pieces exist today — `resolve()` already yields the
dependency edges, `converge.hasConvRef` is the feature-gate pattern, stdlib is
already lazy-by-module, and multitarget §0 already commits to *semantic layer +
per-target lowering*. The IR, the cache, and the analyzer registry are not built;
this note specifies how they compose — and deliberately stages them so each step is
shippable on its own.
