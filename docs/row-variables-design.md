# Row variables (error rows v2 / S4) — design note

*Status: S4a + S4b + S4c built (2026-06) — the v2 slice family is complete
(E2 user-spelled effect tails deferred, see §4). This is
`error-rows-design.md` §6 worked out against the as-built v1 (S1–S3, all
shipped) to the level where implementation can be sliced. The headline correction to §6's sketch: v2 is
NOT full row-polymorphic HM. It is **row-polymorphic signatures over the v1
flow core** — tails are quantified type vars judged by the machinery v1
already has (ROW_DEPS fixpoint + `pendingRowContribs` step 0.5), and the only
genuinely new unification is none at all.*

## 1. The gap, measured against the real code

Three layers, verified by probe (2026-06):

1. **There is no function-type ascription surface.** `lower.ts` produces only
   `TRExpr | TRNamed | TRPtr | TRRecord | TRTuple` — never `TRFn`. The
   checker is already TRFn-ready (`resolveRef` infer.ts:295 resolves it,
   `refTypeVars` infer.ts:556 walks it for user generics), but no grammar
   production reaches it. `def step(f: Unit -> Result a e): ...` is a parse
   error today. Every existing user HOF takes UNASCRIBED params (fresh vars,
   e.g. `def applyTwice(f, x): Number`); the effect-checked HOFs (`map`,
   `filter`, `pmap`) are builtins typed in resolve, not spellable in Velve.

2. **Row defs are monomorphic, so rows × generics = unusable.** The row
   branch (infer.ts:1232) registers `env.define(name, mono(fnT))` and never
   composes with `generalizeSig` — a type var in a row def's other slots is
   accidentally rigid (`Named "a"` everywhere, including the signature), so
   `def wrap(x: a): Result Number _` fails at EVERY call site ("expected a,
   got String"). The row branch also requires all params ascribed — combined
   with (1), a user HOF row def is unspellable from both ends.

3. **`rowContribution` cannot tell a skolem from an opaque error name.**
   Clause bodies resolve signature type params as rigid `Named` skolems
   (infer.ts:1347 — empty tp map), and `rowContribution`'s zero-arg `Named`
   fallback (infer.ts:206) treats any unknown name as a single-ctor opaque
   error. If a skolem ever reaches a row (an `Error(x)` whose payload is a
   type-var param), the row gains a bogus pseudo-ctor named after the
   variable (`{a}`), and a pin reports "missing: a" — a diagnostic about a
   type variable masquerading as a constructor. Unreachable from the surface
   today only because layer 2 errors first.

What plain HM generics ALREADY give (once layer 1 is fixed): single-source
pass-through. `def attempt(f: (Unit -> Result a e)): Result a e` needs no
rows at all — `e` unifies with the argument's error ADT at the call site and
the caller's pin sees a concrete `Named`. The row-variable cases are exactly
the ones unification-as-equality cannot express:

- **union**: thread `f`'s errors AND `g`'s errors (`e` can't equal both);
- **extension**: thread `f`'s errors AND add my own `Error(Mine)` on top.

Both are "my row ⊇ the argument's row, plus local entries" — ⊇ being
precisely the relation v1's flow core already computes.

## 2. v1 invariants this design preserves

These are load-bearing and the design is shaped around NOT breaking them:

- **ErrRow is identity-shared and never rebuilt by substitution.**
  `Subst.apply` and `substVars` return rows untouched (infer.ts:67-68);
  entries mutate in place. Every consumer (pins, matches, ctor-use judging,
  closure) relies on holding THE row, not a copy.
- **Rows accumulate, they never unify.** Generic unify treats row-vs-named
  as contribute, row-vs-row as ⊇-edges both ways (infer.ts:926-936); the
  directional pin check lives in Propagate + finalize.
- **Defer-then-judge.** Everything row-shaped is judged in `finalizeRows`
  after the module completes: step 0 shared-ctor uses, step 0.5 late
  contributions, step 1 cycle DFS, step 2 closure fixpoint over ROW_DEPS,
  step 3 pins (with fix-its), step 4 row-matches.

## 3. The design: tails as quantified vars, judged by step 0.5

A row gains **tails** — the quantified type vars whose eventual bindings
flow into it:

```
ErrRow = { entries: RowEntry[], owner: string, tails: number[] }   // tails new
```

Nothing about `entries` changes. The lifecycle:

- **Decl side** — the row branch composes with `generalizeSig`: the tp map
  carries both `_ → row` and each type-var name → fresh quantified var; the
  def's scheme is `forall ids` as for any generic def. The row instance in
  the scheme is the def's BASE row.
- **Body side** — `rowContribution` (and the row-vs-other unify case) learns
  the def's type-param names. A skolem (`Named "e"` where `e` is a declared
  type param) in contribution position records the tail BY NAME on the base
  row instead of fabricating the bogus pseudo-ctor (layer 3 fixed);
  generalization maps tail names → forall ids. Non-param unknown names keep
  the opaque single-ctor behavior unchanged.
- **Call side (the one controlled clone)** — `instantiate` on a scheme whose
  type contains a tailed row REBUILDS that row once, per call site:
  `clone = { entries: [], owner, tails: fresh ids }`, plus
  `ROW_DEPS.push([clone, base])` (the clone inherits everything the base
  accumulates, via the existing closure fixpoint) and, for each fresh tail
  var, `pendingRowContribs.push({ row: clone, errType: freshVar, span })`.
  This is the ONLY place a row is ever rebuilt; `Subst.apply` stays
  untouched. (Implementation note: `substVars` is a pure free function and
  the pending list lives on the Inferencer — registration happens in the
  caller of `instantiate`, or via a module-level hook like ROW_DEPS already
  is.)
- **Binding** — no new unification. The fresh tail var is bound by the
  ORDINARY argument unify: passing `helper` to `f: (Unit -> Result a e)`
  unifies `e_fresh` with `AppError` (or with another def's ErrRow — vars
  bind rows via the existing Var-first rule, infer.ts:916).
- **Judging** — step 0.5 already does everything tails need, verbatim:
  a tail resolved to an ErrRow becomes a real ⊇-edge (before the cycle
  check, so occurs-over-tails IS the existing step-1 DFS); resolved to a
  named ADT contributes its ctors; still-a-Var or a ctor-less concrete type
  is rejected with the existing messages (reworded to name the parameter:
  "the error type of 'f' never resolved at this call"). `Unknown` stays
  lenient.
- **Boundaries stay closed.** A pin over a clone whose tails all resolved is
  the existing step-3 inclusion check — tails are gone by then. A row-match
  (step 4) over a row with an UNRESOLVED tail requires a catch-all arm (an
  open row's entry set is a lower bound; matching it exhaustively without
  catch-all would be unsound). Pins never accept open rows — the unresolved
  tail is already an error at step 0.5.

The pleasant surprise of working this through against the code: **v2 needs
no new judging machinery and no surface change to rows.** `_` keeps meaning
"infer my row"; what changes is that a def like

```
def step(f: (Unit -> Result a e)): Result a _
  v = f()?              -- tail e, not bogus ctor "e", not "never resolved"
  w = lookup("k")?      -- row += Missing (as today)
  if w > 0 then Ok(v) else Error(Boom(w))   -- row += Boom (as today)
```

gets a quantified scheme whose per-call-site row is `{Missing, Boom} ∪ e@site`
— union and extension both fall out of clone + edge + pending contrib.

## 4. Effects (the §6 convergence) — second wave, honestly scoped

Effects are `string[]` on `Fn` with `null` = unchecked, and **unification
does not touch effects** (infer.ts:1848's comment is explicit). The §12.4
conservative latent-argument rule charges a call with every fn argument's
effects because, without rows, the checker can't see whether the callee
invokes the argument.

Effect tails mirror error tails — `effects: { names: string[], tail?: id }`
— but the lift is bigger than the error side because Fn-unify must learn to
bind effect tails at all (today it skips effects entirely), and `null`
(unchecked mode) must survive as distinct from "empty closed row". So the
convergence ships as its own slice family, after error tails prove the
shape:

- **E1 — effect tails on builtin HOF signatures only** (`map`, `filter`,
  `pmap`: `(a -> b ! e, List a) -> List b ! e`). Replaces the conservative
  charge with precision exactly where it stings: a HOF that does NOT invoke
  its argument (stores it, returns it) stops charging the caller. The
  conservative rule REMAINS as the fallback for Unknown-typed callees —
  unchanged behavior wherever tails aren't present.
- **E2 (deferred)** — user-spelled effect tails. Needs surface design
  (`Effect [io | e]`?) and is not scheduled; E1 must prove the unify
  extension first.

## 5. Build plan (fixture-provable slices)

1. **S4a — function-type ascriptions (grammar + lower).** Parenthesized
   arrow types in ascription slots: `(A -> B)`, n-ary `(A, B -> C)`,
   lowering to `TRFn` — the checker side already exists. Parens are
   MANDATORY: a bare arrow in the return slot is ambiguous with the
   single-line def body (`def idy(x: a): a -> x` — that `->` starts the
   body), and `tuple_type` already owns parenthesized comma lists, so the
   arrow form needs a precedence carve-out inside parens. Grammar work =
   native rebuild (`npx node-gyp rebuild` — the stale-binding trap).
   Fixtures: green — a typed HOF with plain-HM pass-through error
   polymorphism (`def attempt(f: (Unit -> Result a e)): Result a e`,
   consumed under a pin: precise, zero rows — the case §1 notes needs no
   tails); bad — arity and param-type mismatches against the ascription,
   which unascribed HOF params can't catch today.
   **✅ BUILT 2026-06** (SPEC §2.14, `fn_type_test`/`_bad`). As-built notes:
   no grammar conflict declaration was needed — `function_type` shares its
   `( type...` prefix with `tuple_type` and they diverge cleanly at `->` vs
   `)`. One lowering decision the sketch missed: a lone `()` param lowers to
   an EMPTY param list (zero-param defs type as `() -> T` with no Unit
   argument at calls), so `(() -> T)` is the thunk type; `()` among several
   params stays a Unit argument. Effects on the ascription stay unspellable
   (`effects: []`) until S4c. Pass-through error polymorphism, n-ary params,
   generic fn params (`(a -> a)`), and return-slot fn types all proved green;
   the bad fixture pins 4 boundary errors including the wrong-pin case
   ("expected OtherError, got AppError" arriving through `e`).
2. **S4b — row tails (the core).** §3 in full: `tails` on ErrRow,
   skolem-aware `rowContribution`, row branch composing with
   `generalizeSig`, instantiate-time clone + edge + pending contrib,
   reworded step-0.5 messages, catch-all rule for open-row matches.
   Fixtures: green — the §3 def (union + extension) called with two
   different callbacks, pinned precisely at each call site, plus a row-match
   over a closed clone; bad — an escapee arriving through the tail listed at
   the pin (with fix-its naming it), an unresolved tail (HOF arg whose error
   type never resolves), an open-row match without catch-all. Also closes
   layer 2: a generic NON-HOF row def (`wrap(x: a)`) becomes callable.
   **✅ BUILT 2026-06** (SPEC §2.13 v2 block, `row_tails_test`/`_bad`).
   As-built deltas from §3's sketch:
   - **Tail registration is deferred, not instantiate-time.** A caller can be
     inferred BEFORE the row def's body has recorded its tails (defs check in
     module order), so reading `base.tails` eagerly at instantiate would miss
     them. Instead `instantiateAtUse` records `{clone, base, forall-id →
     fresh-var map, span}` on a `pendingCloneTails` list, and a new finalize
     step **0.4** expands it — after all bodies, before 0.5 — into ordinary
     `pendingRowContribs` entries. Judging is step 0.5 verbatim, as designed.
   - The skolem test is a lookup, not a `rowContribution` rewrite: a
     module-level `ROW_TAIL_PARAMS` (row → type-param name → quantified id)
     feeds a `tailContribution(row, t)` check tried BEFORE `rowContribution`
     at the three contribution sites (unify's row case, Propagate regime (a),
     and step 0.5 itself, for a deferred Var that resolves to a skolem).
     Foreign zero-arg names keep the opaque single-ctor fallback untouched.
   - Openness propagates with closure: a row ⊇ an open clone is itself open
     (one extra flag in the step-2 fixpoint), and open rows suppress
     "can never match" arm errors — the entry set is only a lower bound.
   - Residual: a row def that FORWARDS its callback to another row def
     without invoking it (`def outer(f) -> inner(f)?` with no direct `f()`
     call) resolves the inner clone's tail to the outer def's skolem one
     level deep; that lands as the v1 opaque pseudo-ctor, not a tail.
     Two-level tail threading is out of scope (call the callback directly,
     or pin the intermediate def).
3. **S4c — effect tails E1 (builtins).** §4: effect-tailed signatures for
   `map`/`filter`/`pmap`, Fn-unify learns tails, conservative rule kept as
   Unknown fallback. Fixtures: green — a pure def maps a pure fn (allowed
   today, stays allowed) AND a def that merely returns a received effectful
   fn without calling it is NOT charged (today's conservative rule errors);
   bad — `map(netGet, urls)` in a pure def still errors, now via the tail
   (the §12.4 fixture keeps failing for the right reason).
   **✅ BUILT 2026-06** (SPEC §12.4 effect-tails block,
   `effect_tails_test`/`_bad`). As-built deltas from §4's sketch:
   - **The tail is an optional id, not a row struct**: `Fn` gains
     `effectTail?: number` (a quantified var id); `effects: string[]` stays
     as the closed names and `null`-vs-`[]` never arises (`null` lives only
     on Ctx). The full row = `effects` ∪ `EFFECT_TAILS[effectTail]`, a
     module-level accumulate map (the row discipline: bindings only grow,
     never unify). `substVars` remaps the id, so instantiation gives each
     call site its own binding — no clone machinery needed because there are
     no entries to share, just names.
   - **Binding is eager, not deferred**: Fn-unify's one effect rule — a side
     that declared a tail absorbs the other side's full row. The per-call
     charge reads the tail right after the call's unify (which is what bound
     it), matching the existing eager effect checks rather than S4b's
     finalize step; an arg still a Var at the call contributes nothing, the
     same leniency the latent rule already had.
   - **Tailed = accounted**: the conservative latent rule is skipped exactly
     when the callee's own Fn carries `effectTail`. The id sits on the OWN
     row for invoking HOFs (`pmap`, `pfilter`, typed `listMap`/`listFilter`
     — charged via the binding) and on `identity`'s own row with nothing
     ever binding it (bare-var param) — the "returns it without calling it"
     case, now uncharged. The skip keys on the callee's own tail, NOT a
     param's: a user def whose param absorbed a tailed builtin type still
     takes the conservative rule (no laundering through forwarding).
   - **Surface `map`/`filter` stay untailed**: they are resolve/eval
     builtins with no infer-side type (Unknown callee) — the conservative
     fallback governs them byte-identically (`hof_effects_bad` cases 1–3);
     only its `pmap` case now fails via the tail (same count, right reason).
     The prelude's `listMap`/`listFilter` typed forms got tails but are not
     reachable from the surface (not in resolve's BUILTINS).
   - Residuals: other fn-taking builtins (`sortBy`, `listReduce`,
     `streamMap`, …) keep the conservative charge until tailed (mechanical);
     partial/over-application paths preserve the tail on the residual fn but
     still skip effect checks (pre-existing); an aliased builtin
     (`m = pmap`) shares one tail binding across its uses
     (generalize doesn't re-quantify tail ids — conservative union, sound).
4. **Out of scope for v2**: anonymous union pins (unchanged from v1), open
   rows escaping a module boundary (pins close them or error), prose tails,
   E2 user-spelled effect rows, and the eval-side mixed-arity residual
   (runtime-ambiguous; documented in error-rows-design §7.3).

Each slice keeps corpus baselines untouched: arrow ascriptions are new
syntax, tailed rows only arise from them, and E1 only RELAXES the
conservative rule (plus `error_rows_*`/`row_*`/`ctor_shadow_*` fixtures pin
the v1 behaviors that must not regress).
