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

> **AS BUILT (2026-06, C1(vi)).** `lsp.ts` ships and serves five capabilities over
> stdio — diagnostics, hover, go-to-definition (incl. **cross-file**, via the
> binding's own `span.source`), completion, and semantic tokens for atom/step
> labels. What it shares with the batch compiler today is the **passes**, not yet a
> query cache: each `didChange` re-runs the whole frontend (lower → resolve → infer
> → exhaust → totality → handled → the four fact floors) on the open file's program.
> The "dependency cone" claim *does* hold — the server is **loader-aware** (C1):
> `analyzeText` calls `loadProgram(file, openDocs)` with the live, possibly-unsaved
> buffer overriding disk, so an `import` resolves its transitive cone in-editor
> exactly as the CLI does, and a brand-new file with no disk copy still type-checks
> against the saved libraries it imports. Diagnostics are scoped to the open file
> (`span.source === abs`), so a library's own errors don't smear onto the importer's
> lines; the four Z3-backed obligations surface as their **conservative floors** (the
> LSP pipeline is sync — the CLI's Z3 verdict is authoritative and only ever removes
> floor errors). **Not yet built:** lazy per-symbol queries, debounce, incremental
> reuse of §5's firewall, and the shared query cache — a `didChange` is a full
> re-analysis. The query functions (`analyzeText`/`hoverAt`/`definitionAt`/
> `completionsAt`/`semanticTokensFor`) are exported pure, and the connection wiring
> sits behind a main-module guard, so `scripts/lsp_smoke.mjs` drives them headless
> (8 checks: import resolution in-buffer, hover, both same- and cross-file
> definition, completion of imported names, semantic tokens, two error cases).

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

> **DECIDED (D0, 2026-06 — §11).** Velve Core is a **fresh distinct IR**, not an
> annotated AST: ~13 nodes, ANF, elements lowered to `Call`, patterns compiled. One
> correction to the earlier sketch — refinements are **not** "erased to runtime
> checks"; they are proof obligations *already discharged*, so they erase to
> **nothing** (§11.5 erasure law). A smaller, stabler contract is easier for five
> backends to target than the full AST.

> **DECIDED (D0, 2026-06).** Hashing granularity is **per top-level symbol** — it
> matches the dependency graph and the signature firewall (§5); per-expression
> bookkeeping rarely pays off below the function level.

---

## 11. Velve Core IR — the node grammar and the erasure contract (D0)

**Status: DECIDED (D0, 2026-06).** §§2–10 fixed the *architecture* — where the IR
sits, the cache split, the analyzer registry. This section fixes the *IR itself*:
its node grammar, the exact erasure frontier, how the width tag rides, and what
reaches runtime. It is the contract D1 builds the first emitter against, and it
honors endgame-plan Decisions **2** (sized-types-as-range-refinements with a
target-split) and **3** (JS now, IR stays neutral).

### 11.1 Fresh distinct IR, not annotated AST (resolves the §10 DECIDE)

Velve Core is a **separate, smaller normalized IR**, not the lowered AST with extra
fields. The AST `Expr` carries 40+ forms (`ast.ts`) — `Propagate`, `Try`, `Retry`,
`For`-comprehensions, the `Element` DSL, `TypeTest`, four saga/race/join statement
sorts. Most are *surface sugar* that desugars to a handful of computational
primitives. Targeting five backends against the full AST means re-implementing that
desugaring per backend — the exact bloat §2 forbids. Velve Core collapses the
surface to **~13 nodes**; a backend author reads one small grammar.

### 11.2 ANF, effects as explicit nodes — generators are an emitter choice, not an IR primitive (resolves OQ#4)

Velve Core is in **A-Normal Form**: every non-trivial subexpression is named by a
`Let`, and every operand is an **atom** (a variable or a literal). Evaluation order
is explicit in the `Let` spine.

ANF over the alternatives:
- **vs CPS** — CPS bakes a control representation into the IR that a native/LLVM
  backend (which wants SSA + basic blocks) would have to *undo*. ANF is direct-style,
  reads like the source, and is the standard input to both a tree-walking JS emitter
  and SSA construction. (GHC Core, Kotlin IR, MIR are all closer to normalized
  direct-style than to CPS.)
- **vs generators-as-a-primitive** — a generator node would make D2
  (sagas/streams/`go`) trivial *on JS* and **violate Decision 3**: it hard-codes a JS
  control construct into the neutral middle. Forbidden at the IR level.

So effects do **not** get a control-flow node in the IR. Every effectful operation —
a saga `goto`/`yield`, `go`, `send`, a store message, a stream `push`/`next`,
`await`, a transaction boundary — lowers to a single explicit
**`Perform { cap, op, args }`** node carrying its **capability name**. How a run of
`Perform`s is *scheduled* is the backend's call: the JS emitter realizes them as
**generators** (cheap, idiomatic — the JS-ism lives here and only here), the
native/WASM backend as an explicit **state machine**, BEAM as **processes**. The
neutrality lives in the IR; the platform realization lives in the emitter — precisely
the Kotlin-IR / Gleam split (§3).

> One consequence worth stating: because `Perform` carries `cap`, §7's
> target-portability check ("does target T provide every capability this symbol's
> closure needs?") reads the **IR**, not the AST — the capability honesty §7 demands
> is structurally enforced.

### 11.3 The node grammar

Two sorts. **Atoms** are trivial — pure, no naming needed:

```
IRAtom = Lit (Str | Num | Bool | Unit | Atom)   -- Duration folds to Num(ms); width/unit erased, a Num is just a Num
       | Var name
```

**Computations** — everything with a value to name. In ANF each is the RHS of a
`Let`, or sits in tail position:

```
IRExpr = Atom   IRAtom                              -- tail / trivial return
       | Let    name IRComp IRExpr                  -- the ANF spine
       | If     IRAtom IRExpr IRExpr                -- sugar over a 2-arm Match; emitters may special-case
       | Match  IRAtom [IRArm]                      -- pattern-COMPILED decision tree (11.4)

IRComp = Call    IRAtom [IRAtom]                    -- saturated; currying/defaults/named-args resolved at lowering
       | PrimOp  op [IRAtom] {width?}               -- BinOp/UnOp + the pure builtin surface; width tag rides here
       | Ctor    name [IRAtom]                      -- ADT value → VCtor
       | Tuple [IRAtom] | List [IRAtom] | Record [(name,IRAtom)]
       | Field   IRAtom name | Index IRAtom IRAtom  -- projections
       | Lambda  [param] IRExpr {captures:[name]}   -- closure with EXPLICIT free-var capture set
       | Perform cap op [IRAtom]                    -- the sole effect node (11.2)
```

`IRArm = { test: ctor-tag | lit | tuple-arity | wildcard, binds: [(name, projection)], body: IRExpr }`.

Thirteen nodes. The explicit `captures` list on `Lambda` is for the native/WASM
backends (closure conversion needs it); JS gets capture for free but the IR states it
so the contract stays target-neutral.

### 11.4 What AST→IR lowering desugars (the normalization list)

Everything not in 11.3 is *gone* by the time D1's emitter runs:

| AST surface | Lowers to |
|---|---|
| `Propagate` (`e?`), `PropWith` (`e?: alt`), `Try`, `Retry` | `Match` on `Result` + early-return in ANF |
| `If`, `TypeTest` (`is`, `is Ok(a)`) | `If` / `Match` (the C2 binder becomes an arm `bind`) |
| `For` comprehension, `Range`, `Loop`, `Break`/`Continue` | fold/loop prims + `Match` filters |
| `BinOp`, `UnOp` | `PrimOp` |
| `List`/`Tuple`/`Record` (+ spread), dict/set literals | heap-constructor nodes |
| `Element` DSL, `Handler`, props | `Call`s to render primitives (re-aim `render.ts` at IR; §2) |
| `Go`, `Await`, `Send`, `Machine`, saga steps, `Transaction` | `Perform` |
| `AddrOf`/`Deref`/`Drop` (low-level tier) | IR pointer ops — emitted only on memory-capable backends; JS lowers `VPtr` as eval does (closure read/write) |

Two honest carve-outs: **convergence** (`VDeferred`, styles §6) stays a *runtime*
pass — the IR keeps a deferred prop expr as a `Lambda` thunk the runtime `converge()`
resolves in topological order, exactly as eval does today (C3's sound home). And
**`@js{}` / `import js`** opaque foreign code passes through as an emitter-target
literal — neutral only in the trivial sense that non-JS backends reject it via the §7
capability gate.

### 11.5 The erasure contract — Decisions 2 & 3, made precise

Every type-level judgment the **solver** reasons about is discharged at the AST→IR
frontier and **does not exist below it**. The IR is the *proven* program — every
obligation already met — so it carries only what *computes*:

| Type-level thing (`types.ts`) | Discharged at | In the IR? | At JS runtime? |
|---|---|---|---|
| **Units** (`United.dims`) | infer (dimensional algebra) | **erased** — a `Meters` is a bare `Num` | no |
| **Refinement predicates** (`Refinement.pred`, `where value …`) | facts/Z3; `constEval` fold | **erased** — *proof obligations*, already discharged; no runtime check emitted | no |
| **Error rows** (`ErrRow`) | infer + `handled` pin | **erased** — only `Ok`/`Error`/user ctors survive, as `Ctor` | no |
| **Effect / capability rows** (`Fn.effects`) | `handled` / capability check | **as `Perform.cap` tags only** — the row *discipline* is discharged; the op's capability name rides for §7 | the op runs; the row is not a value |
| **Taint** (`Tainted`), **`Async`/`Stream`** wrappers | infer | **erased** wrapper; the *operations* become `Perform` | runtime future/stream values exist; the type wrappers don't |
| **Totality** (`@total`) | totality engine | **erased** (a proof) — but it *licenses* §8 compile-time folding | no |
| **Width tag** (`Refinement.width = {bits,signed}`) | B3 check (no-coerce-across-width; `overflow` proof) | **SURVIVES** — rides `PrimOp` arith nodes + numeric IR vars as inert metadata | **no on JS** (Number); **yes to native/WASM** (selects machine width) |

> **The erasure law.** *Everything the solver reasons about — units, refinement
> predicates, error rows, effect rows, taint, totality — is discharged at the frontier
> and absent below it. The single survivor is the **width tag**, which is not a proof
> but a **representation choice deferred to the backend** — so it alone rides the IR as
> inert metadata: consumed by native/WASM, ignored by JS.*

This is not an aspiration — **`eval.ts` already proves it sound.** The runtime
`Value` union (`value.ts`) has *no* member for a unit, a refinement, a width, or a
row: eval never sees a type. eval is the existing witness that the erasure frontier is
real; Velve Core simply *formalizes for the compiled path the erasure the interpreted
path already does for free*. That is also why the differential harness (11.7) is
trustworthy: compiled output is checked against a reference (eval) that itself lives
below the erasure frontier.

The width tag's lone survival is the concrete face of Decision 2's "one surface, two
representations": the JS emitter maps every numeric to a double and **drops** `width`;
a future native emitter reads the *same* IR and lowers `PrimOp +{u8}` to an 8-bit
machine add. Same IR, target-chosen representation — the proof that Velve Core is
genuinely neutral rather than JS-shaped.

### 11.6 What survives to runtime — the Value-set anchor

The compiled JS target must produce values `display`-equivalent to eval's
(`value.ts`), so the IR's surviving constructs map onto the existing `Value` union:

| IR node | JS runtime | eval `Value` |
|---|---|---|
| `Lit` Num/Str/Bool/Unit/Atom | number / string / boolean / unit / tagged atom | VNum/VStr/VBool/VUnit/VAtom |
| `Ctor` | tagged object | VCtor |
| `Tuple`/`List`/`Record` | array / array / map-or-object | VTuple/VList/VRecord |
| `Lambda` | JS closure | VFn |
| `PrimOp` | inline op / builtin call | (immediate) |
| `Perform` | scheduler / runtime call (D2) | VFuture/VSaga…/VStream |
| render `Call`s | DOM build (D3), convergence preserved | VElement/VDeferred |
| width / unit / refinement / row | — *nothing* — | — *(no Value member)* — |

### 11.7 D1's contract, restated

D1 builds: (a) the AST→Velve-Core lowering for the **compute core** — Fns, ADTs,
pattern-compiled `Match`, lists/records/closures, the pure builtin surface
(endgame §5 D1 scope), no `Perform` yet; (b) a Velve-Core→JS emitter for that core;
(c) the **differential harness** — the baseline capture generalized to three columns
*(check / run-eval / run-compiled)*, with `eval.ts` the never-deleted reference
semantics. The IR specified here is frozen for that work; `Perform` and the effect
realization land in D2.

**D1(i) shipped (2026-06) — the compute spine.** The first vertical slice of this
contract is built and green: `core.ts` (the §11.3 IR datatypes + AST→Core ANF
lowering for the pure spine — single-clause defs, `Lit`/`Var`, arithmetic/comparison
/equality `PrimOp`s, saturated `Call`, tail-`if` and else-if ladders, `Do` blocks),
`emitjs.ts` (Core→JS), the `compile`/`runc` CLI commands, and `scripts/diff.mjs` —
the three-column harness this section called for. Forms outside the spine (`Match`,
heap constructors, closures-as-values, all effects) are refused by `CompileUnsupported`
rather than miscompiled — the frontier is explicit and loud. Over the whole corpus the
harness reports **15 match / 0 mismatch / 0 js-crash / 116 unsupported**. The erasure
law (§11.5) is thereby *witnessed empirically*: among the matches are unit-carrying
(`uom_test`, `std/units`), refinement-carrying (`refinement_compile_test`,
`std/refined`), and totality-carrying (`proof_terminates_test`) programs — each
compiles to JS that drops the judgment entirely and prints byte-identically to eval.
**D1(ii) shipped (2026-06) — scalar `match`.** `Match` does not survive into the IR:
it lowers *here* to the `If`/`Let` decision-spine (the subject named once, branches
folded back-to-front into nested `If`s ending in a new `Fail` fall-through), so the
backend never grows a pattern node. This slice covers the **scalar** patterns —
`PWild`/`PVar`/`PTyped` (irrefutable, optional bind) and `PLit` (`==`, mirroring eval's
strict equality) — plus guards. The `Fail` node is a hard `throw` the `exhaust` pass
proves unreachable on valid programs, so it is witnessed but never differentially
exercised. The frontier moved past scalar `match` to **heap-value destructuring**
(constructor/tuple/record patterns), now the loud-refusal edge. Harness: **16 match /
0 mismatch / 0 js-crash / 116 unsupported**. Honest deviation from D1(i)'s forecast:
scalar `match` shipped on its own (pure control flow), and the heap-value core slid to
**D1(iii)**.

**D1(iii) shipped (2026-06) — tuples (the heap-value core opens).** The first heap
value to clear all three differential columns. Two new IR computations — `Tuple`
(build from atoms) and `Proj` (read element *i*) — plus one runtime convention that
every later heap value reuses: heap values carry a `$t` tag (`$tuple(...) → {$t:"T",
es}`) so the JS `$show` reproduces `value.ts` `display`'s `(a, b)` form byte-for-byte.
The scalar pattern compiler generalized to a flat `MatchStep[]` (ordered binds +
truthy-tests); a `PTuple` projects each slot and **recurses**, so nested tuples and
fallible sub-patterns fold into the same `If`/`Let` spine (tuple shape itself is no
test — arity is type-guaranteed). Tuple was the thinnest cut: positional, fixed-arity,
**no `type` decl or constructor-name resolution**. Harness: **17 match / 0 mismatch /
0 js-crash / 116 unsupported** (238 files). Honest deviation: D1(iii) was forecast as
the whole heap-value core; tuples shipped alone, the rest slid forward. The frontier
twin (constructor destructuring) is unchanged — it flips when ctors land.

**D1(iv) shipped (2026-06) — ADT constructors (the frontier twin flips).** Variants are
built — applied (`Ok(5)`) or nullary (`None`) — and destructured via `PCtor`, nesting
freely (`Error(Rect((w, h)))`). The runtime reuses tuples' `$t` scheme: `$ctor(name,
payload) → {$t:"C", name, payload}` (nullary ⇒ `null`), so `$show` reproduces value.ts
VCtor display — `Name(x)` or bare `Name`. Three IR comps — `Ctor` (build), `CtorName`
(read tag; the match test rides an existing `==` PrimOp), `CtorPayload` (read to
bind/recurse). A `PCtor` discriminates on the tag, then projects+recurses into the same
`MatchStep[]` spine (arity is type-guaranteed, so the tag test is the whole refutation —
eval's redundant payload-null checks are elided). Supported ctor names = the module's
own `type` variants ∪ the prelude data ctors eval defines globally (Ok/Error/Some/None);
a unary ctor used unapplied is refused as a first-class function. Harness: **19 match / 0
mismatch / 0 js-crash / 115 unsupported** (239 files). The flip landed as forecast: the
frontier twin was repointed to build a **record** (the next unrepresented heap value) and
still refuses; enabling ctors also flipped the pre-existing `ctor_pattern_test.velve`
green (honest baseline movement, byte-identical to eval).

**D1(v) shipped (2026-06) — records (the frontier twin flips again).** Records are built —
`#{ x: a }`, including `...spread` — field-read (`p.x`), and destructured via `PRecord`.
The runtime extends the `$t` scheme: `$record(fs) → {$t:"R", fs}` where `fs` is a plain
object whose key-insertion order is the display order, so `$show` reproduces value.ts
VRecord display — `{ k: v, … }`, empty as `{  }`. The order is load-bearing: eval builds a
`Map` (spread first, then explicit; a shadowing key updates in place, keeping its slot), and
JS `{ ...base.fs, k }` matches exactly — so `#{ ...p, y: 99 }` displays in the original
field order. Two IR comps — `Record` (build; optional spread atom + ordered fields) and
`Field` (read). `PRecord` is pure projection like `PTuple` (no shape test — the checker
guarantees the fields are present); `record_pattern` is shorthand-only, so each field binds
a `PVar`. Harness: **20 match / 0 mismatch / 0 js-crash / 115 unsupported** (240 files). The
flip landed as forecast: the frontier twin was rolled to build a **list** (the next
unrepresented heap value) and still refuses. Unlike D1(iv), no pre-existing corpus file
flipped — the only new green is the fixture (the `&&` in an early draft of its guard was the
short-circuit frontier, not records; split into a nested `if`).

**D1(vi) shipped (2026-06) — lists (the frontier twin flips again).** Lists are built —
`[a, b, …]`, including the empty `[]` — element-read (`xs[i]`), and measured
(`length`/`isEmpty`). The runtime extends the `$t` scheme: `$list(...es) → {$t:"L", es}`,
an array tagged so `$show` reproduces value.ts VList display — `[a, b, …]`, empty as `[]`,
elements shown by the same `$show` so a list of heap values nests. Two IR comps — `List`
(build; each element an atom) and `Index` (read element `i` — `.es[i]`); `length`/`isEmpty`
join the pure-builtin whitelist (`length` mirrors eval: list element count or string char
count). eval bounds-checks `xs[i]` at runtime — OOB is an eval-error in BOTH columns, never
a miscompile; in-bounds reads are byte-identical. Velve has no list PATTERN (`PList` does not
exist in the grammar), so destructuring is by index/builtin — the earlier `PList` forecast
was a mis-recollection, corrected here. Harness: **22 match / 0 mismatch / 0 js-crash / 114
unsupported** (241 files). The frontier twin was rolled to bind a **closure** (`fn x -> …`)
and call it (the next unrepresented value) and still refuses. Honest baseline movement: one
pre-existing file flipped — `dependent_test.velve`, a dependently-typed program
(`InBounds(length(xs))`) whose refinement machinery erases upstream, leaving exactly the
list spine the compiler now lowers (+2 match = fixture + flip, −1 unsupported).

**D1(vii) shipped (2026-06) — closures (the frontier twin flips again).** A `fn x -> …`
lowers to a JS arrow function that closes over its enclosing `const`s by lexical scope,
exactly as eval's single-clause VFn closes over its captured `env` — no explicit capture
list is computed. A closure is bound by `let`, returned from a `def` (capturing that def's
param), passed as an argument, written inline, called through a local name, and displayed
`<fn:<lambda>>` (value.ts VFn display). One IR comp — `Lambda` (params + a body lowered in
tail position with the params in scope); no `$t` tag — the arrow is callable directly and
`$show` maps any `typeof === "function"` to `<fn:<lambda>>` (the only functions reaching
`$show` are lowered lambdas). The `Call` guard gained one clause: a name in local scope is
a closure value, called with identical `fn(args)` syntax (JS lexical scope shadows a
same-named def/builtin as eval's lookup does). A free name in a lambda body refuses
identically to eval's missing-from-capture-env. Harness: **23 match / 0 mismatch / 0
js-crash / 114 unsupported** (242 files) — +1 match (fixture `compile_closure_test.velve`,
byte-identical across 5 lines), no corpus flip. The frontier twin was rolled to a
**first-class `def` reference** (`let f = double` — naming a def without calling it; eval
has it as a VFn in the env, the compiler refuses it as a free variable) and still refuses.
Destructuring `let`/params from the prior forecast are SYNTAX errors — neither exists in
the grammar (like `PList`) — corrected here.

**D1(viii) shipped (2026-06) — first-class `def` references (the frontier twin flips
again).** A named `def` mentioned without calling it is now a value. eval has it for free
(a top-level def is a VFn in the env); the compiled def is a hoisted JS `function` —
itself a value — so the reference lowers to a bare `Var` atom naming it, with NO
eta-expansion wrapper and no capture (the JS shortcut; a native backend would eta-expand
to a closure). It is bound by `let`, passed to a HOF, returned from a `def`, and called
like any closure. Display became faithful: eval shows a named function `<fn:name>` and a
lambda `<fn:<lambda>>`, so `$show` (hard-coded to `<fn:<lambda>>` since D1(vii)) now reads
the JS function's own `.name` — empty ⇒ `<lambda>`, set ⇒ the def name — and every lambda
is wrapped in an identity `$lam(…)` so JS infers no `.name` for it (a let-bound arrow would
otherwise inherit its binding's name). Two lowering touch-points: a `userFns` branch in the
`Var` normalizer plus a `norm` fast-path (a def reference is an atom, not a redundant `Let`
temp). Harness: **24 match / 0 mismatch / 0 js-crash / 114 unsupported** (243 files) — +1
match (fixture `compile_defref_test.velve`, byte-identical: `10 / 42 / 30 / 12 /
<fn:double>`), no corpus flip. The frontier twin rolled to a **builtin reference** (`let f =
abs` — eval has it as a VBuiltin, the first-class path admits user defs only, so it refuses
`abs` as a free variable) and still refuses.

**D1(ix) shipped (2026-06) — first-class BUILTIN references (the frontier twin flips
again).** A whitelisted builtin mentioned without calling it is now a value, exactly as a
user `def` (D1(viii)): eval has it as a VBuiltin, the compiled builtin is an inlined
prelude `const` (itself a value), so the reference lowers to a bare `Var` atom — a `BUILTINS`
branch in the `Var` normalizer plus the `norm` fast-path. One display trap: `$show` reads a
function's `.name`, and every prelude const already carries its Velve name except `int`
(impl was bare `Math.trunc`, `.name === "trunc"`); a printed `int` would show `<fn:trunc>`
vs eval's `<fn:int>`, so the impl is wrapped `(x) => Math.trunc(x)` whose assigned const
infers `.name === "int"` (identical for calls, faithful for the value). Harness: **25 match
/ 0 mismatch / 0 js-crash / 114 unsupported** (244 files) — +1 match (fixture
`compile_builtinref_test.velve`, byte-identical: `9 / 4 / 7 / <fn:abs> / <fn:int> /
<fn:floor>`), no corpus flip, the `int` rewrite perturbed no `int`-calling program. The
frontier twin rolled to a **short-circuit `&&`** (`true && false` — eval is lazy; the spine
lowers only strict PrimOps, `&&`/`||`/`|>` need control flow) and still refuses.

**D1(x) shipped (2026-06) — short-circuit `&&`/`||` (the frontier twin flips again).** `&&`
and `||` are now lowered, and crucially LAZY in the right operand (eval returns `false`/`true`
without evaluating the right when the left decides it). `a && b` ≡ `if a then b else false`,
`a || b` ≡ `if a then true else b`. New IR comp `Cond` (a value-producing conditional): the
left is an atom, each branch a value-`IRExpr`; emitjs emits a **JS ternary** (itself
short-circuit), a non-trivial branch wrapped in an arrow-IIFE so its spine runs only when
selected. `Cond` is an ordinary comp, so a `&&` nested in an argument/operand composes for
free. Laziness is verified under a guard — `guard(n) = n != 0 && 100 / n > 9` puts the
division inside the then-branch, so `guard(0)` is `false` with no div-by-zero, byte-identical
to eval. Harness: **26 match / 0 mismatch / 0 js-crash / 114 unsupported** (245 files) — +1
match (fixture `compile_shortcircuit_test.velve`), no corpus flip. Forecast corrected: pipe
`|>` was never a frontier — it desugars to a saturated `Call` (`5 |> double` ≡ `double(5)`)
and has compiled since D1(i). The frontier twin rolled to a **non-tail `if` as a value**
(`let x = if …` — `if` lowers in tail position only; as a `let` RHS it reaches `normComp`'s
default) and still refuses.

**D1(xi) shipped (2026-06) — non-tail `if` as a value (the frontier twin flips again).** An
`if` whose value is consumed (bound by `let`, nested in an expression, a function argument,
or an else-if ladder) now lowers, reusing the `Cond` comp from D1(x): cond→atom, each
branch→value-`IRExpr` emitted as a ternary arm (IIFE-wrapped when it has its own spine). A
one-case addition to `normComp`, the value-position mirror of the tail `if` `tail()` already
lowered. Harness: **27 match / 0 mismatch / 0 js-crash / 114 unsupported** (246 files) — +1
match (fixture `compile_ifvalue_test.velve`, byte-identical `10 / 6 / 7 / A / B / C`), no
corpus flip. The frontier twin rolled to a **non-tail `match` as a value** (`let s = match …`
— `match` lowers in tail position only) and still refuses.

**D1(xii) shipped (2026-06) — non-tail `match` as a value (the frontier twin flips again).**
A `match` whose value is consumed now lowers: `matchE` already builds the `If`/`Let`/`Fail`
decision-spine, and in value position that spine is reified by a new `Block` comp — emitjs
wraps it in an arrow-IIFE returning the taken arm's value (the n-way generalization of
`Cond`). `Block` is an ordinary comp, so a value-`match` composes wherever a value is
wanted; a one-case `normComp` addition plus the `Block` emitter (reusing the `exprValue`
IIFE helper). Harness: **28 match / 0 mismatch / 0 js-crash / 114 unsupported** (247 files) —
+1 match (fixture `compile_matchvalue_test.velve`, byte-identical `many / 300 / 16 / round /
37`), no corpus flip. The frontier twin rolled to a **multi-clause `def`** (`fib(0)`/`fib(1)`/
`fib(n)` — eval dispatches across clauses; the lowerer emits one JS `function` per `def`).
String interpolation `"{x}"` confirmed never a frontier (desugars to `++` upstream, like
`|>`).

**D1(xiii) shipped (2026-06) — multi-clause `def`s (honest baseline movement, 4 corpus
flips).** A `def` with more than one clause now compiles. eval dispatches by trying each
clause in order and taking the first whose param patterns all match — clause dispatch is a
`match` whose subject is the parameter tuple. The compiler emits one JS `function` per def
over fresh names `_a0..`, folding each clause's patterns (reusing the `MatchStep[]`/`pattern()`
machinery) into an `If`/`Let` chain falling through to the next clause, ending in `Fail`.
Dispatch is pattern-only, matching eval (`where_`/`using` run after selection and a failure
throws, so they are body bindings, not guards — a clause carrying them is refused). Harness:
**33 match / 0 mismatch / 0 js-crash / 110 unsupported** (248 files) — +5 match (fixture
`compile_multiclause_test.velve`, byte-identical `55 / 9 / 61 / zero / neg / pos`, plus FOUR
pre-existing corpus flips: `clause_heads_test`/`constfold_total_test`/`literal_param_test`/
`vocab_cleanup_test`, each verified byte-identical), −4 unsupported (the flips). The frontier
twin rolled to **reassignment** (`let mut x = 1; x = x + 5` — the spine lowers `let` to a
`const`; `block`'s `SBind` refuses a reassigning bind). Velve clause params are literal/binder
only (not ctor/tuple — a parse limit), so payload destructuring stays a body `match`.

**D1(xiv) shipped (2026-06) — reassignment of a `mut` binding (1 corpus flip).** A mutable
binding and its reassignment lower: eval mutates the binding (env.set) yielding Unit, so a
`let mut x = v` becomes a reassignable JS `let` (a new `mut` flag on the IR `Let`, `const`
otherwise) and a bare `x = e` becomes a new `Assign` IR statement. Only a simple in-scope
variable reaches the reassignment path — a field/index target is a separate `SAssign` (still
frontier). Harness: **35 match / 0 mismatch / 0 js-crash / 109 unsupported** (249 files) —
+2 match (fixture `compile_reassign_test.velve`, byte-identical `12 / abc / 105 / 7`, plus
one corpus flip `move_ok` — a `mut` Copy-scalar reassigned in place, whose affine machinery
erases on the JS tier), −1 unsupported. The frontier twin rolled to an **atom literal**
(`:red` — `lowerLit` refuses it; needs a `$atom`-tagged value with `:name` display).

**D1(xv) shipped (2026-06) — atom literals (the frontier twin flips again).** An atom
`:name` now lowers: eval compares VAtoms by name, so the compiler folds `:name` to a tagged
`$atom("name")` value that is INTERNED (one singleton per name, via a module `Map`), making
JS `===` — what `==`/match `PLit` lower to — agree with eval's by-name equality. A new
`IRLit` variant `{t:"Atom", name}` (rides `IRAtom`), an interning `lit()` emit, and a
`$show` `$t:"A"` branch. Harness: **36 match / 0 mismatch / 0 js-crash / 109 unsupported**
(250 files) — +1 match (fixture `compile_atom_test.velve`, byte-identical `:red / :teal /
true / false / go / unknown`), no corpus flip. A bare `let c = :red` has the singleton type
`:red`, so a concrete `c == :green` is a type error — false-equality runs through an
`Atom`-typed parameter. The frontier twin rolled to a **duration literal** (`5s` — eval folds
to its ms count `5000`; `lowerLit` still refuses the fold).

**D1(xvi) shipped (2026-06) — duration literals (the thinnest cut of the erasure law).** A
duration (`5s`, `250ms`, `3m`, `1h`) now lowers: the AST carries the computed `ms`, eval
folds `Duration → VNum(ms)`, and the Duration *type* erases at the IR frontier (§11.5), so
`5s` is simply the Number `5000`. A one-line `lowerLit` fold, no emitter/runtime change.
Harness: **37 match / 0 mismatch / 0 js-crash / 109 unsupported** (251 files) — +1 match
(fixture `compile_duration_test.velve`, byte-identical `5000 / 250 / 2500 / 180000 /
3600000 / 30000 / 35000`), no corpus flip. The checker keeps the Number/Duration type line
upstream, so the fixture exercises durations as literals and among themselves. The frontier
twin rolled to a **`for` comprehension** (`for (x in xs) -> x * 2` — the spine has no
comprehension lowering, the `For` AST node is refused).

**D1(xvii) shipped (2026-06) — `for` comprehensions (nested generators × filters → a list).**
A comprehension now lowers. eval evaluates its clauses left-to-right — generators NEST (a
cartesian product), bare-Bool clauses PRUNE as filters, the body runs at the innermost depth
and each result is pushed. The compiler mirrors it: a new `For` IRComp over `IRForClause[]`
(`Gen{name, iter}` / `Filter{cond}`, each holding a full value-`IRExpr` so a later generator
can read an earlier binding), emitted as an arrow-IIFE that folds the clauses into nested
`for…of` over each source's `.es` with an `if` per filter, accumulating `$acc` and returning a
fresh `$list`. Simple-binder generators only (a destructuring binding trips `patName`; a
`break`/`continue` body trips `tail`) — either refuses, never miscompiles eval's signals.
Harness: **39 match / 0 mismatch / 0 js-crash / 108 unsupported** (252 files) — +2 match
(fixture `compile_comprehension_test.velve`, byte-identical across map / filter / cartesian /
dependent-generator / interpolated-guard cases, plus one legit corpus flip), −1 unsupported.
The one flip — `for_in_test.velve` (an edition-grammar comprehension fixture) — moved
`unsupported` → `match`, verified byte-identical. The frontier twin rolled to a **RANGE**
(`for (x in 1..n) -> x` — the spine has no range lowering, `Range` hits `normComp`'s `default`).

**D1(xviii) shipped (2026-06) — integer ranges (`1..n` / `1..=n` → a list).** A range now lowers.
eval requires both bounds numeric and fills `[from, end]` stepping +1, where `end = inclusive ? to
: to - 1` — `1..5` is `[1,2,3,4]`, `1..=5` is `[1,2,3,4,5]`, a descending pair is empty. The
compiler adds a `Range` IRComp (two pure number atoms + an `inclusive` flag) emitted as a
`$range(from, to, inc)` runtime fill building the very same `$list` value a literal `[…]` does — so
a range bound directly, driving a `for` generator, or measured by a builtin composes with no special
case. Harness: **40 match / 0 mismatch / 0 js-crash / 108 unsupported** (253 files) — +1 match
(fixture `compile_range_test.velve`, byte-identical across exclusive / inclusive / computed /
empty-descending / comprehension-driven / `length`-measured cases), no corpus flip. (A bare range
carries the distinct *type* `Range(Number)` upstream though its runtime value is the same list — so
the range-returning defs ascribe it; a type distinction, not a compiler one.) The frontier twin rolled
to a **FIELD/INDEX ASSIGNMENT** (`xs[1] = 99` — the spine lowers only a bare-name reassignment; an
lvalue `SAssign` is a distinct statement node it refuses).

**D1(xix) shipped (2026-06) — index assignment (`xs[i] = v`, an in-place list-element write).**
eval mutates the list IN PLACE (`elems[i] = v`) and yields Unit; the JS value model already backs
a list with a real `.es` array, so a new `IndexSet` statement emits `xs.es[i] = v` — the same
mutation, byte-identical. The RHS `value` is hoisted before the target's obj/index (eval's order;
the atoms left are pure). Index is the only grammar-reachable lvalue write besides a pointer
`p.* = v` (refused); **the surface has no record-field-assign form** (`p.x = v` is a syntax error —
eval's `Field` branch is defensive/unreachable), so the slice is list-index only. No bounds check
(an OOB index is eval-error in both columns, as the D1(vi) READ path leaves it). Harness: **41 match
/ 0 mismatch / 0 js-crash / 108 unsupported** (254 files) — +1 match (fixture
`compile_assign_test.velve`, byte-identical across literal / computed / read-modify-write / aliasing
cases — `let mut ys = xs` shares the list, both writes see it, matching eval), no corpus flip. The
frontier twin rolled to the **`loop` construct** (`loop … break` — the spine has no loop lowering).

**D1(xx) shipped (2026-06) — the `loop` construct (the pure-compute surface closes).** An unbounded
imperative loop now lowers. eval runs the body forever in one shared env (a `mut` declared outside
persists and mutates across iterations), `break` escapes, `continue` re-iterates, falling off the end
loops again. The compiler adds a `Loop` IRComp (an IIFE around a labeled `while (true)` returning a
break value — bare `break` leaves the `$unit` default) plus `Break`/`Continue` IR nodes, and a new CPS
pass `loopBlock`/`loopBranch` that threads the "iterate again" terminator INTO each branch — so a
`break`/`continue` buried in an `if` becomes real labeled control flow (a value-position `Cond` can't
express it). The per-loop IIFE scopes the `$loop` label, so nested loops never collide; `return` inside
a loop refuses (it escapes the def, not the loop). Harness: **42 match / 0 mismatch / 0 js-crash / 108
unsupported** (255 files) — +1 match (fixture `compile_loop_test.velve`, byte-identical across a counting
break-loop / a `continue` skipping evens / nested loops / a loop mutating a list in place), no corpus
flip (every corpus `loop` is entangled with `await`, still refused). `loop` is statement-position only
and `break` is bare in compilable contexts, so the loop's value is always the discarded-then-Unit case;
the `$r` machinery stays correct for it and is simply never exercised. The frontier twin rolled to a
**TYPE TEST** (`r is Ok(v)` — a runtime tag check binding the payload; `TypeTest` hits `normComp`'s
`default`). **The pure value / literal / control-flow / data / imperative-loop surface is now fully
compiled.**

**D1(xxi) shipped (2026-06) — type tests (`e is Ctor(b)`).** A runtime type test now lowers in both
of eval's shapes. A **binder** test in an `if` condition (`if e is Ok(v) then T else E`) eval desugars
to a one-armed ctor match binding the payload; the compiler does the same via a new `typeTestIf` that
reuses the D1(iv) `PCtor` decision-spine (tag test + payload bind) — `T` runs in the bound scope, a tag
mismatch falls to `E` (value position reifies the spine in a `Block`). A **binder-less** `e is Name` is
a Bool: eval's `v.tag === "VCtor" && v.name === name` becomes a `CtorTest` comp →
`(e != null && e.$t === "C" && e.name === "Name")`. The `!= null` guard (not `&&`) keeps a falsy
primitive subject returning a proper `false` rather than leaking the operand. Harness: **43 match / 0
mismatch / 0 js-crash / 108 unsupported** (256 files) — +1 match (fixture `compile_typetest_test.velve`,
byte-identical across binder/bare/nullary/value-position/falsy-payload cases), no corpus flip. The
frontier twin rolled to the **PROPAGATE operator** (`e?` — unwrap-or-early-return on Result).

**D1(xxii) shipped (2026-06) — the propagate operator `e?`.** eval yields an `Ok`'s payload, or throws
a ReturnSignal that early-returns the whole `Error` from the enclosing function. The compiler hoists the
subject to a temp marked a **`guard` bind** (a new optional flag on `Bind` that `wrap` renders as a `Let`
+ a `PropGuard` IR node → `if (_t.name === "Error") return _t;`), the value being the payload. The
early-return is a real JS `return`, so `?` is valid only where its guard lands in the function body
(statement / tail / lambda — a lambda's arrow is itself a function boundary). Inside a **value IIFE** (a
`Cond`/`Block`/`Loop` body, where `return` would escape only the IIFE) it refuses cleanly via a
`containsPropGuard` walk at those sites — a precise `unsupported`, never a miscompile. Harness: **44 match
/ 0 mismatch / 0 js-crash / 108 unsupported** (257 files) — +1 match (fixture
`compile_propagate_test.velve`, byte-identical across single/chained/payload-threading/nested-arg cases),
no corpus flip. The frontier twin rolled to the **PROP-WITH operator** (`e ?: alt` — unwrap-or-fallback, a
pure conditional with no early-return).
**Remaining for D1(xxiii)+**: prop-with (`e ?: alt`); then the D2 effects wall (`Perform`/`await`).

---

**Evidence basis:** the enabling pieces exist today — `resolve()` already yields the
dependency edges, `converge.hasConvRef` is the feature-gate pattern, stdlib is
already lazy-by-module, and multitarget §0 already commits to *semantic layer +
per-target lowering*. The IR, the cache, and the analyzer registry are not built;
this note specifies how they compose — and deliberately stages them so each step is
shippable on its own.
