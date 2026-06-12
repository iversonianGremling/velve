# Totality — functions that are guaranteed to finish

Status: **Tier 1 SHIPPED (2026-06)** — `checker/src/total.ts`, SPEC §12.6,
`total_test`/`total_bad` fixtures. The structural check below is built as
specced; see §9 for the as-built deltas. Tier 2 (`proof.terminates`) and the
realtime-implied marker remain future work.

This note proposes a `@total` marker: an opt-in
promise, checked by the compiler, that a function always finishes (never loops
forever). It generalizes two things velve already does in isolation — the acyclic
convergence graph (styles §6) and the `proof.terminates` line in the realtime
kernel (SPEC std/proof) — into one feature usable anywhere.

Companion to SPEC §3.10 (loops), the effect system (§12.3), and refinement
constant-folding (§3.5).

---

## 0. What exists today (baseline)

| Piece | Where | What it already guarantees |
|---|---|---|
| Acyclic convergence graph | styles-design §6 | element props can't reference each other in a cycle — a "this resolution finishes" guarantee, by topological sort |
| `proof.terminates` | SPEC std/proof (PROPOSED) | a theorem-prover (Z3/CVC5) obligation that one function halts |
| `@kernel` / `@audioKernel` "no allocations, real-time guaranteed" | SPEC §std/audio (PROPOSED) | realtime code already *needs* termination, asserted in prose, not checked |
| Refinement constant-folding | SPEC §3.5 (`constEval`) | runs user code at compile time to check `n > 0` etc. — only sound if that code finishes |

So termination is already load-bearing in three corners, proven by hand in each.
This note makes it one named, reusable thing.

---

## 1. Guiding principle

> A function that might loop forever is poison in a frame, an animation tick, or
> an audio buffer — one stuck call freezes the whole program. `@total` lets a
> function *promise* it finishes, and the compiler holds it to the promise.

This is the same shape as the rest of the language: the easy thing to write should
be the safe thing, enforced at compile time, with a loud escape hatch when you
genuinely need the unsafe version.

---

## 2. The marker

```
@total
def damage(hp: Number, hit: Number): Number
  if hit > hp then 0 else hp - hit
```

The compiler proves it finishes and accepts it. Edit it into something that can
hang and it stops compiling:

```
@total
def damage(hp: Number, hit: Number): Number
  damage(hp, hit)          -- error: @total function may not terminate
                           --        (recursive call does not make progress)
```

Functions are **partial by default** (today's behaviour — unchanged). `@total` is
opt-in. The error only ever fires on a function that *asked* for the guarantee.

---

## 3. What the checker proves

Two tiers, cheap first:

**Tier 1 — structural check (no prover, always available).** The same discipline
total functional languages (Agda, Idris, Lean, Dhall) use:

- **Recursion must make progress.** A recursive call must be on a structurally
  *smaller* argument — the tail of a list, `n - 1` under a base case — so the chain
  can't go forever. `factorial(n - 1)` with an `n == 0` base is fine; `f(n)` calling
  `f(n)` is not.
- **Loops must be bounded.** `for x in xs` over a finite collection terminates by
  construction. A bare `loop` / `while` (SPEC §3.10) needs a decreasing measure the
  compiler can see, or it's rejected inside `@total`.
- **No unbounded waiting.** A `@total` function may not `await` an external stream
  or input — that can block forever by design. Totality is a promise about
  *compute*, not about IO. (Effect-carrying functions are partial; see §6.)

**Tier 2 — `proof.terminates` (prover-backed, opt-in).** For the rare function
whose progress is real but not *syntactically* obvious (e.g. recursion on `n / 2`,
or a measure that needs arithmetic), fall through to the existing std/proof Z3
obligation. Tier 1 is free and covers the common case; Tier 2 is the escape valve
that keeps Tier 1 from having to be clever.

---

## 4. Where it's required vs. optional

- **Required** in realtime contexts: `@kernel` / `@audioKernel` bodies, the
  per-frame update function, and `animated` interpolators (animated-design). These
  *cannot* be allowed to hang, so the marker is implied — a hanging frame is
  unrepresentable, which is exactly the "motion you can't write inaccessibly"
  spirit applied to "frames you can't write hangingly."
- **Optional** everywhere else — pure helpers, refinement predicates, anything you
  want to lean on.
- **Impossible** for the things that are *supposed* to run forever: the game's main
  loop, a `store`/`machine` process, a server. Those are partial by nature. `@total`
  is for the inner work functions they call, not the outer loop.

---

## 5. Why it pays off in velve specifically

1. **It makes refinement folding honest.** §3.5 already runs user predicates at
   compile time (`constEval`) to check `n > 0`. Today the folder is "conservatively
   skipped" when it can't evaluate — partly because arbitrary code might not halt.
   A refinement predicate marked `@total` is *safe to fold every time*, shrinking
   the conservative-skip set the type-system grade is currently capped by.
2. **It backs the realtime claims.** The games/animation/audio pitches all assume
   bounded per-tick work. `@total` turns that assumption into a checked fact instead
   of a comment.
3. **It's one concept for three existing guarantees.** Convergence acyclicity,
   `proof.terminates`, and "no-alloc realtime" stop being three special cases and
   become one marker — the SPEC §4.0 "one primitive per concept" razor, applied.

---

## 6. Relationship to effects

Totality slots beside the effect system, not on top of it. The effect checker
already gates "a pure function may not call an effectful one" (warn 2026.1 / error
2026.6). `@total` is the same gate for a different axis: **a `@total` function may
not call a partial one.** So the two compose — the strongest guarantee is a pure,
total function (`Effect []` + `@total`): no side effects *and* finishes. That pair
is exactly what a refinement predicate or an audio kernel wants.

> **DECIDED (as built, 2026-06): standalone marker.** `@total` is not a
> pseudo-effect — non-termination isn't a side effect, and the two gates run in
> opposite directions (effects flow *up* to callers; totality flows *down* into
> callees, north-star §3.4). The call-gate *shape* is shared; the machinery is a
> separate pass (`total.ts`), not the effect checker.

---

## 7. The escape hatch

There is none beyond *not marking the function*. A function with no `@total` is
partial, like all code today — no new restriction, nothing to suppress. The only
way to "fail" totality is to ask for it and not deliver, which is a real bug at the
call sites that trusted the promise. (Contrast with effects, which need a `@unsafe`
escape because the default is checked; totality's default is permissive, so it
needs no escape.)

---

## 8. Rollout (editions)

Purely additive, so no edition break is required to introduce `@total`. The only
edition-gated step is **making it implied in realtime contexts** (`@kernel` etc.),
which can turn an unmarked hanging kernel from accepted → warning (2026.x) → error,
the same gating cadence used for the pure-calls-effectful gate.

> **DECIDED (proposal):** ship Tier 1 (structural check) first, gated to functions
> that opt in with `@total`; wire `proof.terminates` (Tier 2) to the same marker as
> a fall-through once std/proof lands; make the marker implied for `@kernel` /
> per-frame / `animated` bodies in a later edition.

**Evidence basis:** termination is already enforced in two shipped/-proposed
corners (convergence acyclicity is built and cycle-checked, styles §6.6;
`proof.terminates` and the no-alloc kernel are written into SPEC std/proof and
std/audio). This note generalizes them; Tier 1 is now built (below).

---

## 9. As built (2026-06) — Tier 1 deltas

Shipped as `checker/src/total.ts` (a standalone syntactic pass beside
`exhaust.ts`, keyed on the resolver's bindings, run after borrow checking);
SPEC §12.6; fixtures `total_test.velve` (6 accepted shapes, runs) and
`total_bad.velve` (8 pinned rejections). Deltas from the sketch above:

- **No list patterns exist in velve**, so "the tail of a list" isn't a spellable
  measure. Structural descent is ctor-payload / tuple-element / record-field
  destructuring (clause heads and `match` branches over a param alias); numeric
  descent is `x - k` for positive literal `k`. `n / 2` stays Tier 2, as specced.
- **Mutual recursion is rejected** (one error per fn in the cycle): each fn
  passes the other's total→total call gate, so a dedicated cycle pass catches
  what the per-fn decrease check can't see. Restructure or drop the marker.
- **HOF builtins** (`map`/`filter`/`foldl`/…) are allowed iff the fn argument is
  a lambda, a local `let`-bound lambda, or a known-total name — the latent-effect
  rule's shape (SPEC §12.4) run in reverse. Recursion *inside* a lambda is
  rejected (the structural check can't bound closure calls). Calling a fn
  *parameter* is rejected (argument totality unknown — Tier 2's job).
- **Element trees are rejected** in total bodies, not just IO: `@total` is for
  the compute helpers of §4, and elements pull in handlers and convergence.
- **The `Number`-domain caveat is documented, not patched**: `factorial(-1)`
  passes the literal-floor rule and diverges at runtime. §3's blessed idiom
  assumes integer descent; the honest fix is `Natural` (north-star §3.3), not a
  cleverer syntactic rule.
- **Deferred follow-on (recorded in TODO):** §5.1's payoff — folding refinement
  predicates whose call-closure is `@total` — touches `constEval` corpus-wide
  and ships as its own slice.
