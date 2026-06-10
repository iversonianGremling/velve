# Blocks, `pipe`, `try`, and value lifetimes — design note

Status: **IMPLEMENTED** (2026-06). `drop`, `{}` brace blocks, `pipe`, `try` are
live; `do` is removed and migrated. See §10 for the as-built notes and the one
semantics change from this design (`try` is explicit-`?`, not implicit-per-line).

This note captures the conclusion of the "what does `do` actually buy us" discussion.
Short version: **`do` does not earn a keyword and should be removed.** Plain
statement grouping already comes for free from the constructs that open an
indented block; the only block *keywords* worth keeping are the ones that change
what the lines *mean* — `pipe` and `try`.

---

## 1. Guiding principle

> A block keyword is justified only when the block **does something** a plain
> expression can't — thread a value, short-circuit on error, bound a lifetime.
> Grouping statements is not, by itself, a reason for a keyword.

In an off-side-rule language, plain grouping is already provided by:

- function bodies, lambda bodies
- `if` / `match` / `loop` branch bodies
- a binding right-hand side, which opens an indented block by layout:

  ```
  area =
    w = 3
    h = 4
    w * h          -- block value = last line; w, h are local
  ```

C-family languages get the same grouping from `{ }`; we get it from indentation.
Neither needs a `do` keyword. Haskell only needs `do` because it overloads it
for *monadic bind*; we have unbundled that into `|>` (pipe) and `?` (propagate),
so the keyword has nothing left to carry. **Remove `do`.**

Optional `{}` (§6) may be written around any of these for explicit grouping —
they are never required, only available when indentation is ambiguous or when an
inline/single-line block reads better. Layout stays the default. **Remove `do`.**

---

## 2. The four landing fates of a block's value

Every block is an *expression*. Its value has exactly four possible fates — there
is no fifth where it floats free:

1. **Bound** — `x = <block>` — the binding owns it.
2. **Returned** — it is the tail expression of a function — ownership **moves** to the caller.
3. **Consumed inline** — passed as an argument, or used as a `match` scrutinee: `match (try …)`.
4. **Dropped** — block sits in statement position; value discarded at end of statement.

Under the borrow checker this is not bookkeeping: the landing fate decides **who
owns the value and when it drops**.

---

## 3. `pipe` — one exit

A `pipe` block threads each line's result into the next. It **cannot fail**, so
it has a single exit and its value is a plain `T`.

```
pipe
  loadItems source
  sortBy score ret       -- `ret` = result of the previous line
  listTake n ret
```

- Desugars to `loadItems source |> sortBy score |> listTake n`.
- **`ret`** is the threaded-value keyword (the "result so far"). Chosen over `it`
  and unified with `~ret`: `ret` is the result *value*, `~ret` is its lifetime.
  Never collides with the `Result` type (lowercase term vs uppercase type).
- Value lands via one of the four fates. One exit edge ⇒ one drop path.

---

## 4. `try` — collapses on error (two exits)

A `try` block puts an implicit `?` after each line: success threads forward, the
first `Error` **collapses the whole block** to that `Error`. Because it can fail,
it has **two exit edges**, and that forces the one real design choice in this note.

### Design A — `try` is a `Result`-valued expression (block-scoped)

Both exits land **locally**. The block evaluates to `Result T E`; you store or
`match` it right there.

```
outcome =                  -- outcome : Result Balance E
  try
    u = fetchUser id
    fetchAccount u
match outcome
  Ok b    -> ...
  Error e -> ...           -- caught HERE; the function continues
```

### Design B — propagate (function-scoped) — already exists as `?`

The error does not land locally; it leaves via early return, so the error
*becomes the end of the function*. This is the current `?` operator
(`eval.ts:598` throws `ReturnSignal` on `Error`; `infer.ts:1031` unifies the
enclosing return type to `Result _ e`).

```
def f(id): Result Balance E
  try
    u = fetchUser id
    fetchAccount u         -- on Error: function returns that Error
```

### Resolution

**DECIDED: keep both — they are different jobs, and they already half-exist.**

- `?` operator → Design B, function-level propagation (unchanged).
- `try` block → **Design A** (confirmed): block-level, collapses on `Error` to a
  `Result`, caught by `match`.

Use `try` when you want to handle the failure *here*; use `?` when you want it to
bubble to the caller.

### Retry — not built for arbitrary blocks (gap)

"Keep trying until it succeeds" is **not** covered for plain code. What exists:

- `transaction within { maxRetry: N }` — auto-retry on conflict, then `Conflict` (eval.ts:635).
- saga `:retry` step-goto — first-class FSM retry, wired by hand (SPEC.md:760).
- `loop` + `match … break` — manual retry-until-success.

A general **retry combinator over a `try` block** is unbuilt. Natural shape, given
`try` now yields a `Result`: loop the `try`; `Ok` → break with value; `Error` →
retry, optionally bounded / with backoff. **[DECIDE — future]** whether to spec a
`retry`/`try … until ok` construct; do not bolt it onto `try` itself.

---

## 5. Drop-on-each-exit (borrow-checker rule)

Model: **NLL borrows** (a borrow ends at its last use) + **lexical `Drop`** (an
owned value is dropped at the end of its lexical scope). This combination is what
makes early-release meaningful while keeping borrows ergonomic.

Consequence for blocks:

- `pipe` and the binding-RHS block have **one** exit edge — run destructors for
  live locals once, at the dedent.
- `try` has **two** exit edges. On the early-`Error` path, every local created
  inside the block *so far* must be dropped **before** the `Error` escapes. The
  type/eval layer must treat the short-circuit as a real scope exit, not a goto.

---

## 6. Optional `{}` blocks — explicit grouping, on demand

Layout is the default block syntax. `{}` is an **optional** explicit alternative,
available everywhere a block can appear and required nowhere — the Haskell /
Scala 3 model (layout normally, braces always permitted). It serves two jobs:

1. **Explicit multi-statement RHS** — replaces `do`'s one genuine job cleanly:

   ```
   area = { w = 3; h = 4; w * h }     -- unambiguous opener, no keyword
   ```

2. **Disambiguation escape hatch** for layout ambiguity (e.g. the right-extending
   body bug — `fn x -> x*2`). `{ x*2 }` reads as "this is the body," where the
   current paren-workaround `(x*2)` misleadingly reads as grouping.

### How it parses (no scanner rewrite)

Add a `brace_block` rule using **literal** `{`/`}` tokens (not virtual
indent/dedent), lowering to the same `Do` node. Declare a GLR conflict against
`record_literal`; tree-sitter forks on `{` and commits by content. This is sound
**because records have no shorthand and require `key:`** (grammar.js:1039,
`commaSep1` ⇒ no empty record):

| After `{` | Verdict |
|---|---|
| `lower_id :` … / `...` | record |
| `{}` | not a record → empty block / unit |
| `x = …`, a call, `x` then `}` | block |

> NOTE: the Haskell trick of having the *scanner* insert virtual braces does **not**
> work here — the scanner can't tell a record-`{` from a block-`{` after `=`, since
> that is a content decision. Braces must reach the grammar as real tokens.

Add `;` as an optional same-line statement separator inside `{}` (newlines already
separate statements).

### Caveat: escape hatch, not a cure

Optional braces let you *opt out* of layout ambiguity where it bites; the
brace-free default path **still has** the right-extending-body bug. Eliminating it
everywhere is separate work — fix the layout algorithm in `scanner.c`, or go
mandatory-braces. Tracked in §9, not solved here.

---

## 7. `scope` / early release — do NOT add a free block

The only practical motivation for a bare, control-flow-free block (à la Rust's
`{ }` out of nowhere) is **deterministic release of a `Drop` value** — a lock,
file, or transaction freed at a precise mid-body point. NLL already handles the
borrow-ending case, so that is the whole remaining job.

Rather than resurrect a free block for it, provide an **explicit `drop`**
(DECIDED — `drop` over `release`):

```
drop acct               -- move-and-drop now, at this exact line
```

This is more intent-revealing than an implicit brace boundary and consistent with
§1. For releasing a *cluster* of resources together, factor them into a function
whose return drops its locals.

`~ret` is the lifetime of the function's return value (the return-value lifetime
name; lowercase `result` stays a free identifier, never forced next to the
`Result` type).

---

## 8. Net change list

| Construct | Decision |
|---|---|
| `do` block | **Remove.** Layout opens RHS/body blocks; `{}` (§6) is the explicit opener. |
| `{}` block | **Add.** Optional explicit block; literal-brace `brace_block`, GLR conflict vs records, `;` separator. |
| `pipe` block | **Add.** Threads `ret`; one exit; value `T`. |
| `try` block | **Add.** Implicit per-line `?`; collapses on `Error`; value `Result T E` (Design A). |
| `?` operator | **Keep.** Function-level propagation (Design B). |
| `\|>`, `?` ops | **Keep.** Expression-level pipe / propagate. |
| free `scope`/`do` block | **Do not add.** Use explicit `drop`. |
| `drop` | **Add.** Deterministic early drop of a `Drop` value. |
| retry combinator | **Future.** No general retry-until-ok for arbitrary blocks; see §4. |

---

## 9. Removal plan for `do` (blast radius)

`Do` is the **universal internal block node**; the `do` keyword is just one of
~8 producers of it. Removing the keyword touches the front-end only — `eval.ts:502`
and `infer.ts:953` (`case "Do"`) and every implicit-block lowering site stay
untouched.

**Keyword-only sites to remove:**

| File | Site |
|---|---|
| grammar.js:36 | `'do'` in reserved words |
| grammar.js:625 | `$.do_block` in `_statement` (free block as statement — also remove; use `drop`) |
| grammar.js:690 | `$.do_block` in `block_binding` RHS → replace with `brace_block` (and/or bare-layout block) |
| grammar.js:1312 | `do_block` rule |
| lower.ts:26,42 | `"do_block"` in kind-name arrays |
| lower.ts:614 | `case "do_block"` (statement) |
| lower.ts:800 | `case "do_block"` (expression) |

**Untouched (consume the shared `Do` node):** infer.ts:953, eval.ts:502,
lower.ts:236/302/857/936/1230, find.ts / resolve.ts / exhaust.ts `case "Do"`.

**Open parser work (separate from `do` removal):** the brace-free layout default
still carries the `[$._statement, $._expr]` ambiguity (grammar.js:69) and the
right-extending-body bug. §6's optional braces are a workaround, not a fix.
**[DECIDE]** whether to (a) leave the layout bug as a known papercut with `{}` as
the escape hatch, (b) fix `scanner.c`'s layout algorithm, or (c) go mandatory
braces language-wide.

---

## 10. As-built notes (implementation, 2026-06)

All four features landed; `do` is gone. Corpus: 165 tests pass. All runnable
`.velve` files run clean.

**Atom lexing changed (load-bearing).** To make `{ name: … }` = record vs
`{ … }` = block fully static (no GLR conflict), `atom_lit` became a single glued
token: `token(seq(':', /[a-z][a-zA-Z0-9_]*/))` (grammar.js). Consequence: an atom
is `:name` with the colon glued; a record/ascription `:` must be followed by a
space or an uppercase type. No existing code wrote `: name` atoms, so this was
safe; ~34 corpus trees collapsed `(atom_lit (lower_id))` → `(atom_lit)`. Anything
reading an atom's name now uses `node.text.slice(1)`.

**`try` is explicit-`?`, not implicit-per-line (semantics change from §4).** The
design said "implicit `?` after each line." That only works if *every* line is a
`Result`, which breaks on plain lines (e.g. `print`). As built, `try`:
- rescopes `?`/Propagate to the block boundary (infer swaps `ctx.returnType` to a
  fresh `Result a b`; eval catches the `ReturnSignal` at the block — eval.ts/`Try`);
- the block's value is its **last line**, which must itself be a `Result`
  (e.g. ends in `Ok …`); on any `?` failure the block collapses to that `Error`.
This is Rust `try {}` semantics. Implicit-per-line is deferred sugar.

**`pipe` threads `ret`.** Lowering rewrites all-but-last expr lines to
`ret = <line>`; last line is the value and still sees `ret`. Pure desugar to `Do`
(lower.ts/`lowerPipeBlock`) — no infer/eval changes. Explicit bindings pass through.

**`drop x`** yields Unit; runtime evaluates-and-discards (GC'd), so it's a
compile-time/borrow-checker concept at heart (`Drop` AST tag; infer→Unit;
eval→evaluate then VUnit).

**`{}` brace blocks** are single-line, `;`-separated (`brace_block` +
`brace_binding`, no inline `: type`), lowering to the existing `Do` node. Empty
`{}` and `{ name = … }` are blocks; `{ name: … }`/`{ ... }` are records. Multi-line
`{}` is deferred. `do`'s old binding-RHS job is served by `{ … }` via `binding`.

**`do` removal.** Reserved word, `_statement`/`block_binding`/`_expr` entries, the
`do_block` rule, and both lower.ts cases removed; the shared `Do` AST node and its
infer/eval stay (every body/branch/brace/pipe still lowers to it). 9 `.velve`
files (45 blocks) + 4 corpus entries migrated by unwrapping `do` (delete keyword,
de-indent body). `do` is now a free identifier again.

**Still open (unchanged):** the layout `[$._statement, $._expr]` ambiguity /
right-extending-body bug (§9) — `{}` is the escape hatch, not a fix. Deferred:
multi-line `{}`, implicit-per-line `try`, a `retry` combinator (§4).

---

## 11. Follow-on work (2026-06, session 2)

**Lambda right-extension fixed.** `fn x -> x * 2` parsed as `(fn x -> x) * 2`. Added
a lowest `lambda` precedence and `prec.right` so the body shifts in trailing
operators (grammar.js). `fn x -> x*2+1` now binds the whole body.

**Ternary moved to `??`.** `?` was overloaded (ternary + propagate, both space-
tolerant), forcing ~25 GLR conflicts that mis-parsed `x > 0 ? 1 : 2` as
`x > (0?1:2)`. Per user decision, the conditional operator is now `??`
(`cond ?? a : b`); `?` is propagate-only, `?:` is propagate-with-default. With a
distinct token, precedence resolves the condition correctly. Migrated 2 corpus
tests + 5 example-file ternaries.

**Multi-line `{}` blocks: `;`-separated.** Newline-separated braces are NOT
supported because making NEWLINE valid inside `{}` breaks multi-line *records*
(the scanner only emits NEWLINE when the grammar marks it valid; records rely on
it staying invalid). Resolution — a clean disambiguation rule: **`,` ⇒ record,
`;` ⇒ block**. `{ a=1; b=2 }` works single- and multi-line.

**`retry [N]` shipped.** Loops a `try`-style body on failure, up to `N` times (or
until `Ok`). Value is the first `Ok` or the last `Error`. Reuses the `Try` eval
path (catch `?`-collapse at the boundary) inside a bounded loop. `Retry` AST tag;
count must be `Number`.

**Implicit-per-line `try`: NOT built (deliberate non-goal).** Auto-`?`-ing every
line breaks non-`Result` lines (e.g. `print`). Selectively `?`-ing only
`Result`-typed lines needs type-directed lowering, but lowering runs *before*
inference — wrong architecture for it. Explicit `?` inside `try` (Rust-style)
covers the use case; not worth the murky semantics.

**SPEC sync.** §3.9 rewritten (no `do`; indentation + `{}` blocks; comma/semicolon
rule). Ternary refs → `??`. §3.11 gained `try`/`retry`/`pipe`/`drop`.

### Gap review (SPEC vs implementation)

Async is **solid** — `go`/`race`/`after`/`until`/`await`/`send`/streams are fully
implemented (grammar+lower+infer+eval). Real gaps, for future work:
- **Borrow checker** — the big one. Pointer types (§2.11) have grammar but no
  lower/infer/eval; lifetime `where` constraints are a lowering stub. `drop`/`~ret`
  stay runtime-no-ops until this lands. (§4–5 of this doc is the design.)
- **Stream combinators** (§10.2: filter/debounce/throttle/take/merge/fold) — spec-only.
- **`ask`** is field-read, not message-dispatch as §3.12 implies (decide: fix or document).
- **Effect capabilities** declared but not enforced.
- **std/parallel, gpu, db, audio, proof, http, fs, process, web** — spec-only / aspirational.

---

## 12. Session 3 (2026-06): ternary reversal, implicit try, retry syntax

**Ternary back to `?` via glued/spaced lexing (user call).** Reverted `??` → `?`.
Disambiguation is now lexical, like atoms: **propagate `?` is glued** (`value?`,
`token.immediate`), **ternary `?` is spaced** (`cond ? a : b`). A space before `?`
⇒ ternary; none ⇒ propagate. Precedence then resolves `a > b ? c : d` as
`(a > b) ? c : d`. `?:` stays a distinct token. Migrated 18 spaced-propagate
usages to glued. This gives the familiar `?` ternary AND zero ambiguity — strictly
better than both the `??` token and the parens-method.

**`try` is now implicit (the original §4 vision — user pushed back, correctly).**
Each line auto-unwraps: a `Result` line unwraps (`Ok v` → `v`), the first `Error`
collapses the block, a non-`Result` line (e.g. `print`) passes through. No `?`
needed. Block value is `Ok(last)`. Implemented as `evalTryBody`/`inferTryBody`
(peel each line; infer checks `subst.apply(t)` for a concrete `Result`). Explicit
`?` inside still works (caught at the boundary). **Known limit — CLOSED 2026-06**
(`try_sound_test`/`_bad`): if a line's type was an *unresolved* type variable that
only later resolved to `Result`, infer passed it through (no unwrap) while eval
would unwrap at runtime — a soundness gap. Fixed by a **deferred
monomorphize-then-decide sweep**: each Var-typed line is recorded at peel time and
judged again once the whole module is inferred. Resolved to a concrete non-Result
type → accepted retroactively (not unwrapping was right); resolved to Result too
late, or never → check error. Riders the fix needed: a call to an *Unknown* callee
(unresolved / not-yet-typed builtin) now returns `Unknown` instead of leaking a
fresh leniency var — the same discipline as a failed call — so such lines stay
lenient and outside the net (residual: Unknown-typed lines remain
unwrap-undecidable, as Unknown is everywhere); `print`/`println` got typed
(`forall a. a -> Unit`) so the most common pass-through line is concrete — which
surfaced wrong `: String` ascriptions on print-bodied compensations in
`saga_demo` (fixed to honest returns); `identity`/`listHead` (already typed) were
made real in resolve+eval, and `listHead`'s free error var became the concrete
`String` it actually fails with.

**`retry [N] [D]` — juxtaposed duration, no `after` keyword.** `retry 5 200ms`
(5 attempts, 200ms apart), `retry [100ms, 1s]` (backoff schedule), `retry 3`,
`retry`. The delay is a bare `duration_lit` (which also required making durations
first-class literals — `100ms` is now a valid expression everywhere). Uses the
scheduler's deterministic `sleep`. retry bodies are implicit-try too.

168 corpus tests pass; all runnable `.velve` files green; SPEC §3.2/§3.9/§3.11 synced.

### Computed backoff (exponential) for retry

`retry for (n = 0..5) -> (2 ^ n) * 100ms` — a comprehension generates the backoff
schedule, so exponential/custom backoff is one line (a server pattern). Enabling
this surfaced and fixed three incidental gaps:
- **for-comprehension bodies didn't right-extend** (`for (..) -> a * b` parsed as
  `(for (..) -> a) * b`). Fixed with `prec.right('lambda', …)` on `for_expr`, the
  same fix as `lambda_simple`. Latent bug — existing corpus tests had parenthesized
  bodies so never caught it.
- **`^` (power) was unimplemented in eval** (grammar had it, runtime didn't) — added.
- **Duration arithmetic.** First pass aliased `Duration` to `Number` (too loose —
  allowed `Duration * Duration`). Final design: `Duration` is a distinct
  **dimension** with dimensional rules in `inferBinOp` — `Duration * Number →
  Duration` (scale), `Duration / Duration → Number` (ratio), `Duration ± Duration
  → Duration`, while `Duration * Duration`, `Duration + Number`, `Number / Duration`
  are compile errors. Runtime is unchanged (durations are ms numbers); the rules
  live entirely in the type checker. Convert a raw `Number` to `Duration` with
  `n * 1ms`.

---

## 13. Duration module + stream combinators (2026-06)

**`Duration` module.** `import { fromMs, fromSeconds, toMs } from "Duration"` —
`fromMs : Number -> Duration`, `fromSeconds : Number -> Duration`,
`toMs : Duration -> Number`. Runtime is identity (durations are ms numbers);
the module just crosses the Number/Duration type boundary explicitly, complementing
the `n * 1ms` idiom.

**Stream combinators** (the §10.2 gap — were spec-only, now real). Data-first so
they chain with `|>`:
- `streamMap : Stream a -> (a->b) -> Stream b`
- `streamFilter : Stream a -> (a->Bool) -> Stream a`
- `streamTake : Stream a -> Number -> Stream a`
- `streamFold : Stream a -> b -> ((b,a)->b) -> b` (terminal — drains to a value)

Each transformer spawns a consumer task that drains the source's queue, transforms,
and pushes to a fresh stream, propagating `Done` (eval.ts `patchHOF`). Types in the
infer prelude; names added to the resolver's `BUILTINS`. `fold`'s reducer takes a
tuple `(acc, x)` because lambdas bind a single (possibly tuple) pattern — written
`fn (acc, x) -> …`. `debounce`/`throttle`/`merge` remain unbuilt.

Two ergonomic notes discovered: pipe inserts the left value as the **first**
argument (so combinators must be data-first), and multi-line pipe chains need
**trailing** `|>` (a leading `|>` can't continue a line — it would clash with
match-branch `|`).

---

## 14. Borrow checker (v1) + lambda/scanner ergonomics (2026-06)

**Borrow checker (`borrow.ts`).** A flow-sensitive pass that makes `drop` a real
compile-time check. Tracks the set of dropped locals per program point and reports:
use-after-drop, double-drop, and drop-of-an-outer-variable-inside-a-loop (would
double-free). Branches (`if`/`match`/`await`) merge by union (dropped on any path
⇒ dropped after); re-binding a name revives it; lambda bodies are checked against
captures but their drops don't escape. Wired into `check` after exhaustiveness.
No false positives on the suite. Pointers (§2.11), lifetimes, and full move-tracking
of affine resources remain future work — this is the foundation that gives `drop`
teeth.

**Multi-arg lambdas.** `fn (a b c) -> …` — space-separated names in parens, distinct
from the comma tuple `fn (a, b) -> …`. The AST/infer/eval already supported
`params[]`; only grammar + lowering needed it. `streamFold`'s reducer went back to a
clean 2-arg `fn (acc x) -> …`.

**Leading `|>` continuation (scanner).** A line starting with `|>` now continues the
previous line (multi-line pipe chains read top-down), while a bare `|` (match branch)
still starts a statement. The scanner peeks the 2nd char after `|`: tree-sitter resets
the lexer to the scan start when `scan` returns false, so the `|` consume is
speculative; for the non-pipe case `mark_end` preserves the `|` for the parser.

## 16. Pointers and lifetimes — making `Ptr`/`.&`/`.*` real

The grammar already had the full §2.11 surface (`Ptr [~a] T`, `.&` address-of,
`.*` deref, `~` lifetime extraction, `where` constraints), but the lowerer threw it
all away — `deref_expr`/`addr_of_expr` passed straight through to their inner
expression, so the checker never saw a pointer. This wires them end-to-end and gives
the borrow checker its first *lifetime* teeth.

**AST + lowering.** New `AddrOf`/`Deref` expression nodes. `pointer_type` lowers to
`Ptr(T)` (the `~a` annotation is metadata for the checker, not part of the value
type).

**Typing.** `e.& : Ptr T` when `e : T`; `p.*` unifies `p` against `Ptr 't` and yields
`'t` — dereferencing a non-pointer is a unification error.

**Runtime (`VPtr`).** A pointer to an lvalue closes over the env binding (`read`/
`write`), so `let p = x.&; p.*` reads the live value of `x` and writes alias back.
A pointer to an rvalue (`(1+2).&`) snapshots into a private cell. `x.&.* == x`.

**Lifetime checks (`borrow.ts`).** Two new diagnostics on top of the drop tracker:

- *dangling return* — a function whose result (tail position, or any `?`/`return`
  value) is a pointer into a local declared in its own body. Caught directly
  (`local.&`) and through a binding (`let p = local.&; p`), via a per-body
  `borrows: ptr → source` map and a `bodyLocals` set. Params are deliberately
  excluded (their referents live in the caller).
- *drop-while-borrowed* — `drop x` while some live `p` still borrows `x`.

Conservative within a function (a recorded borrow stays live to end of body — no
liveness/NLL yet), so it errs toward rejecting, never toward missing a dangle. The
`buf.~` extraction operator and `where` lifetime constraints still only parse;
region inference is the next layer. No false positives on the suite; 174 corpus
tests pass.

## 17. Region labelling — lifetimes that mean something

`Ptr ~a T` annotations used to be discarded at lowering. Now the lifetime survives
into a `TRPtr { lifetime, inner }` TypeRef (the value-level type stays `Ptr T`; the
`~a` is borrow-checker metadata), and the borrow checker labels every returned
pointer with the *region* it points into:

- **`frameLocal`** — `local.&`: storage in this frame, dies at return → dangling.
- **`frameParam`** — `param.&`: address of a by-value parameter's frame copy →
  dangling. (This closes the old "params excluded" gap — previously `n.&` returned
  from a function was silently accepted.)
- **`caller(~a)`** — a pointer *parameter* (or a copy of one): the referent lives in
  the caller, so returning it is fine. If the parameter's lifetime `~a` differs from
  the lifetime the signature promises on its result, that's a **lifetime mismatch**.

The classic example now type-checks correctly:

```
def pick(a: Ptr ~x T, b: Ptr ~x T, c: Bool): Ptr ~x T   -- ok
  c ? a : b
def bad (a: Ptr ~x T, b: Ptr ~y T, c: Bool): Ptr ~x T   -- error: `b` is ~y, not ~x
  c ? a : b
```

Deliberately conservative: mismatch only fires when *both* the returned param and the
result carry explicit lifetimes, so unannotated `Ptr T` code is never flagged. This is
region *labelling*, not full inference — there's no outlives lattice or constraint
solver yet, and `buf.~` / `where (a.~ = b.~)` still only parse. But `~a` is no longer
decoration: it changes what the checker accepts. 174 corpus tests pass; no false
positives on the suite.

## 18. Affine moves — `mut` is single-owner

Velve's memory model (SPEC §6.1) ties ownership to mutability: *immutable values are
freely cloneable; mutable values have a single owner.* So `mut` bindings are the affine
resources, and the borrow checker now enforces it.

The threaded drop-state went from `Set<string>` (dropped names) to
`Map<string, "drop" | "move">` — a consumed local carries *why* it's gone, so the same
flow machinery (branch-union merge, rebind-revives) covers both. A **move** is
rebinding a `mut` resource to a new owner:

```
mut x = makeBuf()
let y = x        -- moves x → y
x                -- error: use of 'x' after it was moved
drop x           -- error: cannot drop 'x': it was already moved
```

Deliberately narrow to avoid false positives on ordinary code:

- **Only `mut` bindings move.** `let`/`const` are cloneable — `let y = x` on an
  immutable `x` is just aliasing (the SBind now carries a `mutable` flag, set from the
  `mut` keyword in lowering).
- **Function arguments are borrows, not moves** (per spec) — `f(x)` leaves `x` usable.
  Only a direct `let y = x` rebinding transfers ownership.
- A move both consumes the source *and* transfers `mut`-resource status to the new
  binding, so chains (`let y = x; let z = y`) track correctly and `let z = x` after the
  first move is flagged.

Verified: `move_ok.velve` (immutable aliasing, in-place mutation, arg-borrow) is clean
and runs; `move_bad.velve` fires use-after-move, drop-after-move, and double-move.
174 corpus tests, no false positives on the suite. (§19 then makes the move decision
type-driven, so a mutable `Number` no longer counts.)

## 19. Type-driven moves — Copy vs affine

§18 scoped moves to mutability alone: *any* `mut` rebinding moved, even a `mut Number`.
That over-counts — a scalar is cheap to copy, so `mut n = 0; let m = n; n + m` should be
fine. The fix threads the inferrer's `Map<Expr, Type>` into the borrow checker
(`checkBorrows(mod, types)`) and consults it at the move decision.

A new `isCopy(t)` predicate splits the type algebra:

- **Copy** (clone, never moves): `Number`, `Bool`, `Unit`, atoms, and — conservatively —
  type variables, `Unknown`, and function/closure types. Tuples and records are Copy iff
  every component is.
- **Affine** (move): `String` and `List`/`Dict`/named ADTs (they own heap data), plus
  `Stream` and `Async` (live resources). `Tainted`/`Refinement` follow their inner type.

The move now fires only when the source is a `mut` resource **and** its inferred type is
non-Copy. The bias is deliberate: anything whose type we can't pin down (an unresolved
`Var`, a node missing from the type map) is treated as Copy, so the checker never invents
a move it can't justify — preserving the zero-false-positive property.

```
mut n = 7
let m = n          -- Number is Copy → clone, NOT a move
n + m              -- both usable ✓

mut xs = [1, 2, 3]
let ys = xs        -- List is affine → moves xs into ys
length(xs)         -- error: use of 'xs' after it was moved
```

Verified: `move_ok.velve` gained a `copyScalar` case (`mut n; let m = n; n + m`) that now
type-checks and runs (`copy 14`); `move_bad.velve` was rewritten onto Lists and still
fires exactly three move errors. 174 corpus tests, tsc clean, zero false positives across
every `.velve` in the repo. (§20 then solves the `where` outlives constraints that were
the last parse-only piece.)

## 20. Lifetime outlives-constraint solving — `where (~a >= ~b)`

The region pass (§16–17) rejected any returned pointer whose lifetime didn't *equal* the
declared result lifetime — so `def pick(a: Ptr ~x, b: Ptr ~y): Ptr ~x` could never
return `b`, even when the caller knows `~y` lives longer. The grammar already parsed a
`where` clause of lifetime constraints (`where_stmt` → `lifetime_constraint` →
`lifetime_ref`, with `~a` vars and `buf.~` lifetime-of-binding refs), but lowering threw
it away (`lowerWhereBindings` returned `[]`). This wires it end-to-end.

**Lowering.** `lowerLifetimeConstraints` reads each `lifetime_constraint` into a
`LifetimeConstraint { lhs, op: "outlives" | "eq", rhs }` (new AST types `LifetimeRef =
{LVar ~a} | {LOf buf}`), stored on the `FnClause` as `lifetimeConstraints`. The operator
(`>=` vs `=`) comes from the constraint node's raw children.

**Solver.** `buildOutlives(clause, ptrParams)` turns the constraints into a reachability
relation over lifetime labels:

- `~a >= ~b` adds an edge `a → b` ("a outlives b"); `~a = ~b` adds both directions.
- `buf.~` resolves to buf's declared pointer lifetime (or a frame-bound `buf.~` label
  that only relates through explicit constraints).
- `outlives(a, b)` is reflexive (`a` always outlives itself) and transitively closed via
  DFS, so `where (~z >= ~y), (~y >= ~x)` admits a `~z` pointer for a `~x` result.

The return-lifetime check changes from `region.region !== retRegion` (reject) to
`!outlives(region.region, retRegion)` (reject) — sound because a pointer is valid wherever
a *shorter-or-equal* lifetime is expected. The error now reads "…has lifetime '~y', which
is not known to outlive it." Functions with no `where` clause are unchanged (the relation
is just reflexive), so the prior `ptr_region_bad` cases still fire.

```
def pick(a: Ptr ~x T, b: Ptr ~y T): Ptr ~x T where (~y >= ~x)
  cond ? a : b        -- a: ~x (reflexive) ✓   b: ~y outlives ~x by the clause ✓
```

Verified: `where_ok.velve` (outlives, equality, `b.~`, transitive `~z>=~y>=~x`, reflexive)
checks clean; `where_bad.velve` fires two mismatches (wrong-direction `~x>=~y`, and an
unrelated `~z>=~y` constraint). 174 corpus, tsc clean, zero false positives repo-wide. The
ownership system — drop, pointers/borrows, region lifetimes, type-driven moves, and now
outlives solving — is feature-complete; `buf.~` *extraction into a value* and per-field
region projection remain the only notional pieces.

## 21. Pointers into aggregates + write-through (`xs[i].&`, `p.* = v`)

§16 made `x.&`/`p.*` real for *bindings*, but two things were missing: a pointer to a
list element or record field (`xs[i].&`) only ever hit the rvalue-snapshot path (so writes
didn't propagate), and there was **no write syntax at all** — `VPtr.write` was never
called, and even `xs[i] = v` silently no-op'd (`index_assign` fell through `lowerStmt`'s
default, which kept only the LHS expr and dropped the assignment).

**Aliasing into containers.** `AddrOf` now special-cases `Index` and `Field`: it evaluates
the container (a `VList`'s JS array / a `VRecord`'s `Map`, both held by reference) and
returns a `VPtr` whose `read`/`write` close over that slot — `() => obj.elems[i]` /
`v => obj.elems[i] = v`. Because the container is the same object the binding holds,
write-through is observable at the original name with no copy. Bounds are re-checked on
every access (the list may have shrunk).

**Write syntax.** A new `deref_assign` grammar rule (`p.* = v`) joins the existing
`index_assign`, and both now lower to a single `SAssign { target, value }` statement
(also fixing the dropped `xs[i] = v`). `evalAssign` dispatches on the target: `Deref` →
`ptr.write(v)`, `Index` → mutate the list slot, `Field` → set the record field. `SAssign`
was threaded through every walker — resolve (resolve both sides), infer (`unify(targetT,
valueT)` → Unit), exhaust, find/LSP, and the borrow checker.

**Borrow tracking.** A pointer into an aggregate borrows its *container*. The region pass
peels through `Index`/`Field` to the root binding (new `rootVar` helper, shared by
`regionOf` and `borrowSource`), so `xs[i].&` borrows `xs` exactly as `xs.&` does: returning
it from a local dangles, and `drop xs` while it's borrowed is rejected.

```
mut xs = [1, 2, 3]
let p = xs[1].&
p.* = 99            -- xs is now [1, 99, 3]   (write-through)
xs[0] = 7           -- direct index assign now works too → [7, 99, 3]

mut rec = { count: 0 }
let q = rec.count.&
q.* = 5             -- rec.count is now 5
```

Verified: `ptr_aggregate.velve` (element/field write-through, read-back aliasing, direct
index assign) type-checks and runs (`[1,99,3]` / `77` / `[1,2,3]` / `5`);
`ptr_aggregate_bad.velve` fires three borrow errors (dangling element ptr, drop-while-
borrowed, dangling field ptr). 175 corpus (added a `deref_assign` parse test), tsc clean,
zero false positives repo-wide.

**Dict and string indexing (follow-up).** The same write-through path now covers two more
container kinds. `Index` typing became type-directed (it dispatches on the resolved
container): `d[k]` keys a `Dict(K,V)` by `K` yielding `V`, `s[i]` on a `String` yields a
one-char `String`, otherwise `List(El)` by `Number`. (String indexing was previously a
latent type error — it unified `String` against `List` — now it's correct.) At runtime,
`d[k].&` aliases the dict slot (`read`/`write` over the `entries` Map, keyed by the shared
`dictKey`); `d[k] = v` inserts-or-updates. `s[i].&` aliases the character; the write
rebuilds the `VStr` buffer in place (`obj.v = obj.v.slice(0,i) + c + obj.v.slice(i+1)`),
sound because a `mut` String is affine (single-owner) so no alias observes the splice.
`ptr_aggregate2.velve` verifies dict update+insert, dict-pointer write, direct string-char
write, and string-pointer write (`dict a=99 c=3 / 50 / bat / ban`), all type-checking and
running. Borrow tracking is automatic — `rootVar` already peels `Index` to the base
binding, so `d[k].&`/`s[i].&` into a local dangle if returned.

## 22. Currying / over-application + IIFE application

Function application previously required *exact* arity in two places, so two natural
forms were broken: applying a curried function to all its arguments at once
(`add(10)(5)`, curried juxtaposition `add 10 7`), and applying a parenthesized lambda
literal directly (an IIFE: `(fn x -> x * 2)(3)`).

**Over-application (runtime).** `applyFn` now runs in two passes. The first keeps the old
exact-arity dispatch (so multi-arity / multi-clause functions are unaffected and win when
they match). If none match and args remain, a second pass lets a clause consume its first
*N* args and recursively applies the resulting value to the rest. The shared per-clause
binding logic was extracted into a `runClause` helper that returns `{ok}` on a pattern
mismatch (try the next clause) and throws only for genuine body errors.

**Over-application (types).** The `Call` inferrer gained a currying branch *before* the
exact-arity unify (which is left untouched). When the resolved function type has positive
arity strictly less than the number of supplied args, it peels arguments one `Fn` level at
a time — unifying each level's params, then re-resolving the result — until the args are
exhausted. Under-applying the final level yields a smaller `Fn` (partial application of a
curried function), and a non-function result with args remaining falls back to a single
unify so the mismatch is reported normally.

**IIFE (grammar).** Function-call heads were restricted to a bare `lower_id`, so a
`grouped` expression could not be a callee. A narrow additive rule
`paren_call: prec.left(seq($.grouped, repeat1($.atom)))` (one conflict, `[$._expr,
$.paren_call]`) handles `(expr)(args)` / `(expr) arg` without disturbing the rest of the
call grammar — the earlier `qualified_call`/`member_atom` attempts cascaded precisely
because they touched the shared `atom` category; this one only adds a `grouped`-headed
form. It lowers to a plain `Call { fn: <inner expr>, args }`, so no new AST node and no
changes to resolve/infer/exhaust/borrow/find/eval are needed.

```
let add = fn a -> fn b -> a + b
add(10)(5)            -- 15   (over-application)
add 3 4               -- 7    (curried juxtaposition)
add(100)              -- partial application → a fn
(fn x -> x * 2)(3)    -- 6    (IIFE)
(fn x -> x + 1) 9     -- 10   (grouped head, juxtaposition arg)
```

Verified by `curry_test.velve` (type-checks clean and runs). 176 corpus (added a
`paren_call` parse test), all demos check/run with no new diagnostics, every `_bad`
file still fires its expected borrow errors.

**Partial application (under-application).** The companion case — supplying *fewer* args
than a function's arity — is now supported too. `applyFn` gained a third pass (after exact
and over-application): when `args.length` is below every clause's arity, it returns a
`VBuiltin` closure that captures the given args and, when later called, re-invokes the
*original* function with the concatenated full set. Re-invoking the original (rather than
selecting a clause early) keeps multi-clause dispatch correct — `greet(:formal)` defers
the `:formal`/`:casual` choice until the name argument arrives. The inferrer mirrors this:
a `Call` whose resolved `Fn` type has more params than args unifies the leading params and
returns a `Fn` over the remaining ones. Partial and over-application compose —
`add3(100)(20)(3)` partially applies then over-applies. Verified by `partial_test.velve`
(`r1=11 r2=11 r3=123 | Good day, Ada | Hey Bob!`), checks clean. (Numeric literal params
in clause heads — `def f(0, ...)` — remain unsupported: the grammar's `param` rule admits
`:atom`/`UpperId`/`_` but not number literals, so such a head is an `ERROR` node.)

## 23. String brace escapes (`\{`, `\}`)

A bare `{` in a string starts interpolation, so JSON-shaped text (`"{a:1}"`) used to be
impossible — it parsed `a:1` as an interpolated expression and errored, and `\{` was *not*
honoured (the backslash survived into the output). The grammar already admitted a generic
`seq(\\, /./)` escape inside strings; the gap was purely in lowering — the escape's
backslash was never stripped.

A single `unescapeStr` helper now resolves all string escapes in one regex pass
(`\\(.)` → `\n \t \r \" \\ \{ \}`, unknown `\x` → `x`), replacing the old chained
`.replace` calls. It is applied in three places in `lower.ts`: the non-interpolated string
value, each text slice of an interpolated string (both the pre-`{` flush and the trailing
text), and the `lowerLit` string-pattern case. Escaped braces are hidden tokens (the
scanner's `_string_content` and the escape's `/./ ` consume them), so they never appear as
`{`/`}` children — `hasInterp` and the interpolation walker only ever see *real*
interpolation braces, and the escaped ones ride along inside the reconstructed text slices
where `unescapeStr` turns `\{`/`\}` into literal braces.

```
"plain \{ brace \}"        -- plain { brace }
"json \{\"k\": {v}\}"      -- json {"k": <v>}   (escape + interpolation together)
```

Verified by `string_escape_test.velve` (checks clean, runs). Lowering-only change, so the
176-test corpus is unaffected; all demos check/run with no new diagnostics.

## 24. Literal params in clause heads (`def fib(0)`, `def neg(true)`)

Multi-clause heads already dispatched on `:atom`, `UpperId`, and `_` patterns, but a
*constant value* head — `def fib(0)` — was an outright parse `ERROR`, and (worse) the
erroring clause was silently dropped, so a `def classify(0, x)` / `def classify(n, x)`
pair would route `classify(0, "a")` to the `n` clause with no diagnostic. The whole
downstream machinery for literal patterns already existed (`checkPat`'s `PLit` unifies the
param against the literal's type; `matchPat`'s `PLit` does `litMatch` at runtime) — only
two pieces were missing:

- **Grammar.** The `param` rule gained `$.number` and `$.bool` alternatives. This added no
  conflicts (a number/bool in param position is unambiguous against the existing
  `lower_id`/`:atom`/`UpperId`/`_` forms).
- **Lowering.** `lowerParam` maps a `number`/`bool` child to `{ pat: PLit, ascription:
  null }`, reusing `lowerLit`.

Because `checkPat` already constrains a `PLit` param to the literal's type, `def fib(0)`
types its parameter as `Number` for free, and runtime dispatch falls out of the existing
clause loop. Recursive base cases now read naturally:

```
def fib(0): Number -> 0
def fib(1): Number -> 1
def fib(n: Number): Number -> fib(n - 1) + fib(n - 2)   -- fib(10) = 55

def yesno(true): String  -> "yes"
def yesno(false): String -> "no"
```

Verified by `literal_param_test.velve` (`fib(10)=55 yesno(true)=yes yesno(false)=no`),
checks clean. 177 corpus (added a literal-param parse test to `functions.txt`), all demos
check/run with no new diagnostics. (String-literal params were left out — less useful in
heads and would widen the `param` rule further; add `$.string` the same way if wanted.)

## 25. Type aliases + refinement types (`type T = Base where p`)

Two related gaps closed together. **Type aliases didn't resolve at all** — `type UserId
= Number` left `UserId` as an opaque `Named "UserId"`, so `def inc(x: UserId): Number -> x
+ 1` errored ("`+` requires Number — got UserId") and `inc(5)` errored ("expected UserId,
got Number"). And **refinement predicates were dropped** — the `where` clause parsed but
`lowerTypeDef` never captured it.

**Alias resolution.** A module-level `TYPE_ALIASES` registry (name → `{params, body}`) is
populated once per `infer` run by `registerAliases` (descending into modules) *before* any
body is checked, so forward references work. `resolveRef`'s `TRNamed` case expands an
alias by substituting type args for params and recursing on the body, with an
`ALIAS_RESOLVING` cycle guard. Aliases are therefore **transparent**: `UserId` *is*
`Number` everywhere, including parameterized aliases (`type Pair(a) = (a, a)`).

**Refinements.** `TBAlias` gained a `pred: Expr | null` field; a non-null pred marks a
refinement. The predicate is located in `lowerTypeDef` via the `where` token (not by
"first expr child" — the type *name* is an `upper_id`, itself an expr-kind, which that
naive search wrongly grabbed). A refinement still resolves transparently to its base for
typing, but `collectType` additionally exposes `TypeName.parse : Base -> Result Base
String`, and the evaluator binds `TypeName` to a record `{ parse }` whose builtin binds the
candidate to `value`, evaluates the predicate, and returns `Ok(value)` / `Error(msg)`. A
`matches(value, pattern)` regex builtin was added so the canonical `type Email = String
where matches(value, "…")` works.

```
type UserId  = Number                                   -- plain alias → Number
type NonZero = Number where value != 0
type Age     = Number where 0 <= value && value <= 150
type Email   = String where matches(value, "^[^@ ]+@[^@ ]+.[^@ ]+$")

NonZero.parse(5)            -- Ok(5)
NonZero.parse(0)            -- Error("NonZero: 0 failed refinement")
Age.parse(30) |> match | Ok a -> a | Error _ -> 0       -- 30
Email.parse("user@host.io") -- Ok(...)
```

Verified by `refinement_test.velve` (alias-as-Number, numeric/compound/regex refinements,
parse Ok+Error, refinement value used numerically after unwrap), checks clean. Lowering +
infer + eval change only, so 177 corpus is unaffected; all demos check/run with no new
diagnostics, every `_bad` file still fires. (Compile-time literal checking — deferred
here — landed in §26.) Still deferred: dependent refinements that reference other params
(`InBounds(n)`).

## 26. Compile-time refinement literal checking

SPEC §2.6 promises "literals checked at compile time (free)". §25 left this deferred —
refinements collapsed to their base in `resolveRef`, so the checker had no predicate to
fold. This closes it.

A refinement now resolves to the previously-unused `Refinement { base, pred }` type
variant (`pred` holds the refinement's **name**, the key into a new `REFINEMENTS`
registry of `{ baseRef, pred: Expr }`). The variant is made **transparent** in `unify`:
either side that is a `Refinement` peels to its `base` before matching, so `Age` is still
exactly `Number` for all of inference — assignment, arithmetic, return positions. The only
thing the variant adds is a place to hang the predicate.

At each `Call`, for every argument whose resolved parameter type is a `Refinement`, the
argument is run through a small constant-folder (`constEval`): literals, `+ - * / %`,
`== != < <= > >=`, `&& ||` (short-circuiting), `!`/unary-`-`, and `matches(value,
"regex")`. If the argument folds to a constant, the predicate is folded with `value` bound
to it; a `false` result is a check error with the argument's span:

```
def birthday(a: Age): Number -> a + 1          -- Age = Number where 0 <= value && value <= 150
birthday(200)        -- error: value 200 does not satisfy refinement 'Age'
birthday(0 - 1)      -- error: value -1 ...   (folded)
birthday(0 + 150)    -- ok (boundary)
birthday(someVar)    -- skipped: not constant → runtime `.parse` is the guard
```

The folder is deliberately partial: anything it can't fold (an unbound variable, an
unsupported call) returns `undefined` and the check is skipped — conservative, never a
false positive. Verified by `refinement_compile_test.velve` (all-valid: in-range literals,
folded boundary, non-constant arg skipped — checks clean + runs) and
`refinement_compile_bad.velve` (4 violating call sites → 4 errors). Type-checker-only
change: 177 corpus unaffected, all session tests green, every `_bad` file still fires.
Dependent refinements referencing other params (`InBounds(n)`) follow in §27.

---

## 27. Dependent types — parameterized refinements (`InBounds(length xs)`)

§26's deferred piece. A dependent type (SPEC §2.7) is a refinement whose predicate
references value-**parameters**, not just the subject `value`:
`type InBounds n = Number where 0 <= value && value < n`. At a use the parameters are
supplied as **value arguments** in the type application —
`def at(xs: List(Number), i: InBounds(length xs)): Number` binds `n = length xs`.

The grammar already parses both forms (no change): `type_def` takes parenless params
(`type InBounds n`), and `parameterized_type` already allowed `type_or_expr` arguments, so
`InBounds(length xs)` parses with the argument as a `function_call` expression. The whole
feature is in lower/infer:

- **New `TRExpr { expr }` type-ref** (ast.ts). In `lower.ts`, a `parameterized_type`
  argument that is a *compound* expression (not a bare identifier, not a type node) lowers
  to `TRExpr` via `lowerExpr`. Bare identifiers (`a`) and type nodes stay type refs, so
  ordinary generics (`List(a)`, `Result(a, e)`) are untouched — the one subtlety, since a
  lone lowercase identifier parses as `identifier_expr` inside `parameterized_type`.
- **`Refinement` gained `args?: (Expr | null)[]`** (types.ts) — the dependent value
  arguments, positionally aligned with the refinement's params. `resolveRef` now (a) binds
  the refinement's params into the base like a type alias, so a *type* argument flows
  through (`NonEmpty(Number)` → base `List(Number)`); and (b) captures the `TRExpr` args
  onto the resulting `Refinement`. A `TRExpr` reached elsewhere resolves to `Unknown`
  (a value-arg only matters for dependent refinements). Transparency in `unify` is
  unchanged — it still peels to `base`.
- **`REFINEMENTS` entries gained `params`**, and a new **`FN_PARAMS`** map (fn name →
  first-clause parameter names) is built in the same pre-pass. At a `Call`, the checker
  folds the call's arguments under their parameter names into a `callEnv`, then for each
  refinement parameter binds `value` = the argument and each dependent param = its argument
  expression folded against `callEnv` (so `n` ← `length xs` ← the folded list arg). The
  predicate is then folded as before. `constEval` was generalized from a single `value` to
  a `Map<string, ConstVal>` environment and taught **list literals** and
  `length`/`listLength` of a constant list.

```
at([10, 20, 30], 3)     -- error: value 3 does not satisfy refinement 'InBounds'  (n folds to 3)
at([10, 20, 30], 0 - 1) -- error: value -1 ...                                     (folded)
firstOf([])             -- error: value [] does not satisfy refinement 'NonEmpty'  (length 0)
at([4, 5, 6], idx)      -- skipped: index not constant → transparent base, runtime guard
```

Conservative as ever: if a dependent argument can't be folded (the list comes from a
variable rather than a literal), the whole check for that parameter is skipped — never a
false positive. Verified by `dependent_test.velve` (folded-pass, boundary, non-constant
skipped — checks clean + runs `a=10 b=30 c=1 d=5`) and `dependent_bad.velve` (4 violating
calls → 4 errors). Lower/infer-only: 177 corpus unaffected, tsc clean, all valid demos
green, every `_bad` file still fires (move=3, ptr=3, ptr_region=3, ptr_aggregate=3,
where=2, refinement_compile=4, dependent=4). Runtime treats dependent refinements as their
base (no `.parse` for parameterized refinements — its params aren't bound at parse time).

---

## 28. Stream combinators: merge / debounce / throttle (`§10.2`)

`streamMap`/`Filter`/`Take`/`Fold` shipped in §13; this closes the "Planned" three.
Each is a data-first builtin (chains with `|>`) that spawns a scheduler consumer draining
its source(s). Runtime in `eval.ts patchHOF`, types in the infer prelude, names in the
resolver `BUILTINS`.

- **`streamMerge a b`** — two drainers feed one output; a `live` counter emits `Done` only
  after *both* sources finish.
- **`streamThrottle src ms`** (leading edge) — emit a value, record `sched.now()`, then
  drop everything until `ms` virtual time has elapsed. No timer needed — it just compares
  the virtual clock at each arrival.
- **`streamDebounce src ms`** (trailing) — hold the latest value; emit it once `ms` passes
  with no newer value; a newer value supersedes; `Done` flushes the pending one. This is
  the only one that must *wait with a deadline*, which exposed a queue hazard:
  `Promise.race([q.next(), sleep(ms)])` leaves an **orphaned waiter** in the queue when the
  timer wins, stealing the next pushed value. Fixed with a new `VStreamQueue.nextWithin(ms,
  sched)` that removes its waiter on timeout, so no value is ever lost.

All timing is in **virtual-clock ms** (the same deterministic scheduler as `after`/`sleep`),
so a producer that `sleep`s between pushes drives reproducible behaviour. Verified by
`stream_combinators_test.velve` — producers drive the clock with `sleep`; checks clean and
runs `merged=33 throttled=4 debounced=5` (merge sums both sources; throttle keeps 1+3 and
drops the within-window 2; debounce collapses the 1,2 burst to 2 and keeps 3).

**Latent bug fixed in passing.** A `Stream(T)` (and `Async(T)`) *annotation* resolved via
`resolveRef`'s default branch to a generic `Named "Stream"`, which doesn't unify with the
canonical `{tag:"Stream"}` value type — producing the baffling `expected Stream(Number),
got Stream(Number)`. It never surfaced before because no demo annotated a stream parameter;
`def sumOf(s: Stream(Number))` is the first. `resolveRef` now maps both names to their
canonical variants.

**Still parse-limited.** `await EventStream` whose branches are *step-goto targets*
(`| Push e -> :handle e`) inside a `machine`/`saga` step does not parse — the await-branch
grammar doesn't admit step gotos (same family as the early if/match-in-step gaps; the
`atom`-tail grammar is fragile and has cascaded on every prior attempt). The `loop` + `await
… | Push v -> … | Done -> break` consumer form works everywhere and covers the use case.

## 29. Slice-extraction — `buf[lo..hi]` (the last ownership piece)

§16–20 made the ownership system feature-complete *except* one notional operator: SPEC
§2.11's `buf.~` slice-extraction — taking a sub-region of a buffer that *carries the parent
buffer's lifetime*. The grammar already parsed it (`array_index` is `$._expr '[' $._expr ']'`,
so the index can be a `range_expr`), but no stage handled a range index: `check` errored
("expected Range(Number), got Number" — the index was unified against `Number`) and `run`
crashed ("cannot index VList with [1, 2]" — `Range` materialises to a `VList`, which `Index`
then tried to use as a subscript). This wires it end-to-end across **infer / eval / borrow**
with no grammar change.

**Typing (`infer.ts`, `Index`).** When the index type resolves to `Named "Range"`, the
result is the container type *unchanged* — `List(T)→List(T)`, `String→String`, `Ptr T→Ptr T`
(an unresolved object defaults to `List`). So a slice is the same shape as what it slices.

**Runtime (`eval.ts`, `Index` + new `slice` helper).** A range index is detected
*syntactically* (`expr.index.tag === "Range"`) — necessary because a `Range` value is
indistinguishable from a plain `VList` once evaluated, so a range bound to a name (`let r =
1..3; xs[r]`) is *not* a slice (documented limitation). Bounds: `..` exclusive, `..=` adds 1
to the hi. `slice(v, lo, hi)`:
- `VList` → `{ elems: elems.slice(lo, hi) }` (copy)
- `VStr`  → `{ v: v.slice(lo, hi) }` (copy)
- `VPtr`  → a new `VPtr` whose `read()` slices the parent's current value and whose
  `write(v)` **splices** `v` back into the parent (`elems.splice(lo, hi-lo, ...v.elems)` for
  lists; substring rebuild for strings). So a pointer slice is a live aliasing **view**, not
  a copy — `slice.* = newRegion` mutates the original buffer.

**Lifetimes (`borrow.ts`, `regionOf`).** A new case: an `Index` whose index is a `Range`
roots at its base variable (`rootVar`). If the base is a **pointer parameter**, the slice's
region is the caller's (`caller(~a)`) — returnable, and checked against the declared result
lifetime through the existing `where`/outlives solver (§20). If the base is a binding that
**borrows a local** (`let p = local.&`), the slice is `frameLocal` → dangling if returned. A
slice rooted at a **plain `List`/`String`** (not a pointer, not a borrow) returns `null` —
it's a value copy and can never dangle, so it's freely returnable with **zero false
positives**. This reuses every existing region primitive; no new `Region` kinds.

Verified: `slice_test.velve` checks clean and runs (`mid=[20,30,40]`, inclusive
`hd=[10,20,30]`, `s=hello`, a pointer slice `firstHalf p` read back via `.*` = `[10,20,30]`,
and a write-through `fh.* = [99,98,97]` splicing the parent to `[99,98,97,40,50,60]`).
`slice_bad.velve` fires exactly two errors: a slice of a pointer into a local (`leak`,
dangling) and a `~y` pointer slice returned where `~x` is declared with no relating `where`
(`wrongLife`). 177 corpus, tsc clean, every prior `_bad` count unchanged, all valid demos
clean. **The ownership system — drop, pointers/borrows, region lifetimes, type-driven moves,
outlives solving, and now slice-extraction — is complete.**

**Scope note.** Pointers are modelled as `Ptr List(T)` (a pointer *to a buffer*, matching the
`VPtr`-aliases-a-binding runtime), not C-style array-pointers (`Ptr T` with `buf.length` and
`buf[i] : T` arithmetic). The SPEC's `Ptr ~a Number` / `buf.length / 2` half-buffer sketch
would need a distinct array-pointer value type; the slice *mechanism* and its lifetime rules
are identical either way.

## 30. `TxResult(T)` — the transaction-outcome ADT (constructor sharing)

§30 was the last item on the "Next" list and the one flagged *hard* — it needs **constructor
sharing**. A `transaction` (SPEC §8) yields one of five outcomes: `Ok v` (commit), `Error e`
(a bare transaction's abort), `Conflict { retries }` (retries exhausted), `Timeout { after }`
(deadline passed), or `Cancelled` (a `crash()` inside the body). The interpreter already
*produced* the right `VCtor`s (§ "transactions" entry), but the **type** was a stopgap
`Result(bodyT, e)`: the concurrency outcomes weren't registered constructors, so
`| Conflict c ->` matched leniently (`checkPat`'s `!env.lookup(name) → break`), `c.retries`
was an untyped fresh var, and a match missing arms wasn't flagged. This makes `TxResult(T)` a
genuinely distinct, closed ADT.

**The hard part — constructor sharing.** `TxResult` reuses the `Ok`/`Error` *names* that
already belong to `Result`. Naively looking `Ok` up in the type env yields `(a) -> Result(a,e)`,
which won't unify with `TxResult(T)`. Rather than reach for row types or rename the
constructors, the fix is **expected-type-directed constructor resolution**: which ADT a
`| Ok v ->` arm belongs to is decided by the *expected type* at the match site. In
`checkPat`'s `PCtor` case, before the normal env lookup, if the scrutinee type is
`Named "TxResult"` and the constructor name is one of the five, the ctor type comes from a
dedicated `txResultCtorType(name, t)` table instead of the env. `Result` matches are
untouched (their scrutinee is `Named "Result"`), so the two ADTs coexist with shared names and
no ambiguity.

**`txResultCtorType(name, t)`** (infer.ts) returns the per-`TxResult` constructor type:
- `Ok` → `(t) -> TxResult(t)`
- `Error` → `(e') -> TxResult(t)` (`e'` a fresh var — the abort payload is polymorphic)
- `Conflict` → `({ retries: Number }) -> TxResult(t)`
- `Timeout` → `({ after: Number }) -> TxResult(t)`
- `Cancelled` → `TxResult(t)` (nullary, a non-`Fn` type)

So `c.retries` / `t.after` are real `Number`s — accessing `c.attempts` is now a
"missing record field" error.

**The other three edits are small.** (1) `infer.ts` `Transaction` returns
`Named "TxResult" [bodyT]` instead of `Result`. (2) `exhaust.ts` registers `TxResult`'s
closed five-constructor set in its builtin type-def map, so a match missing (say) `Timeout`
and `Cancelled` is a non-exhaustive-match error. (3) `eval.ts` makes the `Cancelled` outcome a
true nullary `VCtor` (`payload: null`, was `VUnit`) so `matchInto`'s `| Cancelled ->`
(no inner → requires `payload === null`) matches it. `resolveRef` already turns the
`TxResult(Number)` annotation into `Named "TxResult" [Number]` via its default case (no change),
and `resolve.ts` gains `Conflict`/`Timeout`/`Cancelled` as builtins. The runtime is otherwise
structural (`VCtor`-by-name), so no other eval change is needed.

Verified: `transaction_test.velve` (functions now annotated `: TxResult(Number)`, matches
exhaustive over all five) checks clean and runs — commit → `Ok 30`, insufficient-funds →
`Error insufficient funds` with state rolled back, and `within { maxRetry: 2 }` that always
fails → `Conflict retries=2`. `transaction_bad.velve` fires exactly two errors the old lenient
typing *could not* catch: a non-exhaustive `TxResult` match (missing `Timeout`, `Cancelled`)
and a wrong payload field (`c.attempts` — `Conflict` carries `retries`). 177 corpus, tsc clean,
every prior `_bad` count unchanged, all valid demos clean.

This was the final "Next" item. The checker and interpreter now have no outstanding designed
features — ownership, effects/concurrency (stores, sagas, machines, streams, transactions),
the full type system (HM + aliases + refinements + dependent refinements + lifetimes), and the
stdlib are all implemented end-to-end.
