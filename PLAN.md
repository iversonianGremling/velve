# PLAN — Surface-consistency refactor (v0.6)

Ordered execution plan derived from `TODO.md` and the design decisions taken in
review. Goal: fix the surface-syntax inconsistencies (the "mental-model breakers")
*before the surface freezes*, behind the editions system so existing code keeps
working. Each breaking step ships with a codemod and a green corpus run before the
next begins.

**Decision log (locked):** `Outcome` rename · `for…in` + kill `%` · delete ternary →
`if/then/else` · glue `?` / `?:` · `#{}` records · `:`/`=` honesty rewrite ·
editions-first · multi-clause exhaustiveness · trait naming · spread last-wins +
explicit-dup error · delete `pipe` block · keep `let` / `Char` · delete `saga` ·
prop-only `Responsive` collapse · static cycle pre-flag · close effects
unchecked-mode hole · §6 "what's built" table + SPEC drift sweep.
**Dropped:** `user? a | b` postfix eliminator (use `match` / `is Ok` / `?:`).

Codemod templates already exist: `checker/scripts/parens_codemod.mjs`,
`checker/scripts/corpus_codemod.mjs`.

---

## Track A — Surface consistency (the breaking refactor, edition-gated)

### Phase 0 — Editions scaffolding  ✅ DONE (2026-06)
SPEC §17. Nothing breaking lands until this exists.
- [x] Edition pragma `@edition "YYYY.M"` in the grammar (`program` → `edition_pragma`);
      parser regenerated + native binding rebuilt.
- [x] Edition resolver (`checker/src/edition.ts`): dated editions `2026.1` (baseline)
      / `2026.6`, `DEFAULT_EDITION`, `parseEdition`, `atLeast` gate helper.
- [x] `Module.edition` field; lowerer reads the pragma (strips it from decls),
      rejects unknown editions as a checker error, falls back to default.
- [x] Default absent→`2026.1` so the existing corpus compiles untouched (flips to
      latest once migrated). Superset grammar, edition-gated *semantics* (per SPEC §17).
- [x] **Deliverable shipped:** no-op gate. `edition_test.velve` (clean) +
      `edition_bad.velve` (unknown-edition error) added; original 83 fixtures
      byte-identical baseline (zero regression). SPEC §17 updated to as-built.
      Edition-gating of Phase 2/3 breaks rides `2026.6`.

### Phase 1 — Non-breaking foundations (land in current edition)  ✅ FOUNDATIONS DONE
No migration needed; additive checks (fix any fixtures they legitimately surface).
Enforcement value delivered (1b shipped, 1d/1e resolved). 1c + 1a deferred as
**edition-gated focused builds** (non-blocking — neither breaks any edition).
- [x] **1b. Close the effects unchecked-mode hole** (§3.6). ✅ DONE. A pure function
      calling an effectful one is now a violation — **warning in baseline `2026.1`,
      error in `2026.6`** (SPEC §17 deprecation lifecycle). First real use of the
      edition gate: `Ctx.edition` threaded from `Module.edition`; `atLeast(ed,
      "2026.6")` picks warning vs error (`infer.ts`). Blast radius = 1 fixture
      (`effects_test.velve` gains the documented warning); zero new errors corpus-wide.
      Declared-effect fns were already checked — this only closes the escape hatch.
- [x] **1e. Spread-conflict rule** (§5). ✅ RESOLVED (no code change). The
      *enforcement rule* already exists: `callresolve.ts:38` reports `argument '<name>'
      supplied twice` for any explicit duplicate (named/named **and** positional/named
      collision), verified live (`f(name="a", name="b")` → error). **There is no
      call-arg spread in the grammar** — `_arg_list` is `commaSep1(choice(named_arg,
      _expr))`; the only spreads are `record_spread` (`#{...base, …}`) and the UI `prop`
      spread. So `f(...rec, name=val)` doesn't parse → the last-wins half is a
      *feature-add*, not a rule. **Reclassified to Track B** (call-arg spread support).
- [x] **1d. Trait/constraint naming** (§5). ✅ DONE (SPEC honesty fix). Premise was
      wrong: there are **no compiler-known constraint sets** to name. `where a: X`
      parses but is a **no-op** — even a fabricated constraint name checks clean
      (verified). Comparison/equality type as `(a, a) -> Bool` for any matching `a` (no
      orderability check); `toString`/interpolation are `∀a. a -> String`. Velve has no
      typeclass system. SPEC §3.4 now carries a ⚠ "not yet enforced" block stating the
      real built-in signatures; a constraint solver is a deferred build.
- [x] **1c. Multi-clause head exhaustiveness** (§5). ✅ DONE, edition-gated.
      **Key simplification vs the original plan:** no `TypeRef→Type` resolution needed —
      for the safe subset the dispatch ADT is recovered *from the head constructor names*
      (`adtForCtors`), and only when they belong to **exactly one** known ADT (shared
      ctors like `Ok`/`Error`, in both `Result` and `TxResult`, are ambiguous → skipped).
      `checkClauseHeads` in `exhaust.ts` walks each multi-clause `DFn`, and per parameter
      position made entirely of `PCtor`s + optional catch-all binders, checks the closed
      ADT is fully covered. **Soundness:** a missing ctor at any position (no catch-all
      there) is *always* a genuine gap independent of other positions, so per-position
      checking yields **zero false positives** — it only under-reports correlated
      multi-axis dispatch (safe). Atom/literal/record dispatch is out of subset (skipped),
      sidestepping the atom-union modeling the plan feared. Warning 2026.1 / error 2026.6.
      New fixtures: `clause_heads_test.velve` (exhaustive + catch-all, green) and
      `clause_heads_bad.velve` (missing `Low`, 1 intended error). **Verified:** zero
      corpus false positives (no green fixture trips it; `fib`/`yesno`/`describe` are
      literal/atom dispatch → skipped); corpus 32→33 (the +1 is the new intended-error
      fixture only). SPEC §3.4 documents the rule; §0.5 table updated.
- [ ] **1a. Static convergence cycle pre-flag** (§3.1). ⚠ Lowest ROI / own pass. The
      runtime `converge.ts` check already catches literal cycles (just later, as a
      `RuntimeError` — verified `styles-design.md §6.6`). A static AST pass would only
      move the error earlier for the *literal* case; dynamic-list cycles stay runtime.
      Defer until 1c/1e land.

### Phase 1.5 — Prerequisite bug fix (non-breaking, baseline edition)  ✅ DONE
- [x] **Reserved keywords as field names.** `field_access`/`optional_chain` used
      `$.lower_id` for the member after `.`/`?.`, so the lexer tokenized keyword-named
      fields (`x.after`, `x.until`, `x.state`, `x.type`) as keywords → **syntax error**.
      Broke SPEC's own `"{user.name}"` interpolation pattern and kept
      `transaction_test/bad.velve` from parsing. Fix: shared `RESERVED_WORDS` const +
      new named `member_name` rule (`choice(lower_id, ...RESERVED_WORDS)`) in both `.`
      and `?.` positions; parser regenerated + native binding rebuilt; lowerer unchanged
      (reads `.text`). **Result:** `transaction_test` → green, `transaction_bad` → its
      *intended* semantic error (`missing record field 'attempts'`); corpus 33→32
      failing, **zero regressions**. Unblocks 2a's verification fixtures.

### Phase 2 — Surface breaks (gated on edition `2026.2`)
Largely independent; this order keeps the corpus green between steps. Each ⇒ its own
codemod + full fixture/corpus run before moving on.
- [x] **2a. `Outcome` rename** (§2.7). ✅ DONE, edition-gated. `TxResult`→`Outcome`;
      `Ok/Error`→`Committed/Aborted`; `Conflict/Timeout/Cancelled` stable. Implemented
      as an edition-keyed `OutcomeAdt` descriptor (`infer.ts`): 2026.1 keeps the
      `Ok/Error` constructor-sharing (disambiguated by expected type); 2026.6 uses the
      unique names so the collision is **gone** — match resolves by name (the
      "delete constructor-sharing" goal, realized for 2026.6; legacy path survives only
      while 2026.1 does). `exhaust.ts` registers both `TxResult`+`Outcome` typedefs;
      `resolve.ts` BUILTINS gains `Committed/Aborted`. No runtime change (transactions
      are check-only in eval.ts). **Verified:** new `outcome_test.velve` (2026.6) green;
      legacy `transaction_test/bad.velve` (2026.1) unchanged; gate enforced both ways —
      2026.6 exhaustiveness covers `Committed/Aborted/…`, and old `Ok/Error` against an
      `Outcome` is a type error (`got Result(...)`). Corpus 32→32, zero regressions.
      SPEC §8 outcome table rewritten with both editions + the why-rename rationale.
      No corpus codemod needed (existing fixtures stay on 2026.1 with legacy names).
- [x] **2b. Delete ternary + glue `?`/`?:`** (§2.2). ✅ DONE (core), edition-gated.
      **Plan premise was wrong**: `if c then a else b` did **not** exist (only the
      indented-block `if`; `then` wasn't even a keyword; SPEC:1953 was unrelated). So
      this *built the replacement first*, then deprecated the ternary:
      • New inline `if_then_expr` (`if c then a else b`) — reserved `then`, lowers to the
        same `If` node, right-assoc (else-if ladders), `prec.right` on the two block-`if`
        rules resolves the dangling-else. Grammar regenerated + native rebuilt.
      • Ternary `cond ? a : b` kept in the superset grammar but flagged at lower time:
        **warning 2026.1 / error 2026.6** (lowerer now carries `this.edition`). Verified
        both ways; new `if_then_test.velve` (2026.6) green; corpus zero regressions
        (ternary fixtures gain a warning only). SPEC §3.10/§3.11 rewritten.
      • **`?:` glue — reclassified to fmt (2e).** Once the ternary is gone, the only
        whitespace-keyed meaning (spaced-`?`=ternary vs glued-`?`=propagate) is already
        killed: `?` propagate is `token.immediate` (glued), and spaced `?` has no meaning
        in 2026.6. `?:` is a *distinct* token with no ambiguity either way, and the corpus
        writes it spaced (`x ?: y`) — forcing `token.immediate('?:')` would break those for
        zero semantic gain. Gluing `?:` is a **formatter** preference → folded into 2e.
      • Codemod ternary → `if/then/else`: TODO when migrating the example files (Phase 4).
- [x] **2c. `for…in` + kill `%`** (§2.5, generators). ✅ DONE (core), edition-gated.
      Comprehension generator changed `x = source` → **`x in iter`**, unifying with the
      UI keyed-list `for r in rows` (which already used `in`). **Findings:** the `%`
      sigil was *semantically dead* — `lowerForGen` always dropped it, so `for (r = %rs)`
      ≡ `for (r = rs)`; killing it is pure surface cleanup. And `%` is overloaded — the
      **modulo operator** `x % 2` is untouched (only the for-source sigil died).
      Grammar keeps both generator forms (superset); the lowerer (now edition-aware)
      warns 2026.1 / errors 2026.6 on `=`/`%`, with a `%`-specific message. Multi-gen
      cartesian + guards verified; UI `for_child` intact; new `for_in_test.velve`
      (2026.6) green; corpus zero regressions; SPEC §3.8 rewritten + two stale sites
      fixed. **Deferred:** no-paren single-gen sugar `for x in xs -> e` (ergonomic; the
      parenthesized `for (x in xs) -> e` covers the semantics — adding the bare form
      risks a conflict with `for_child`'s `for x in xs <newline>` and isn't worth the
      grammar risk late in the pass). Codemod for the example files → Phase 4.
- [x] **2d. `#{}` records + SPEC drift** (§2.3/2.4). ✅ DONE (core), edition-gated.
      Record literals + spreads gain the `#{ … }` opener (the form LOCKED in
      `named-args-design.md:282`); bare `{ k: v }` stays in the superset grammar but is
      deprecated (lowerer warns 2026.1 / errors 2026.6), so from 2026.6 `{ … }` is
      **always** a block — the record-vs-block trap is dissolved. **Finding:** record
      *types* (`{ name: Type }`) are a *separate* grammar rule (`record_type`),
      unambiguous in type position → left on bare braces (no change needed). No grammar
      conflicts (the `#{` token is distinct from `{`, hex `#rgb`, and `{`-interpolation).
      The 2d gate caught a real bare-brace record in `outcome_test.velve` (a 2026.6
      fixture) — fixed it to `#{}`, proving the enforcement end-to-end. New
      `record_hash_test.velve` (2026.6) green; corpus zero regressions (the ~110
      bare-brace literals are all on 2026.1 → warn only); SPEC §3.9/§3.17 rewritten.
      Codemod `{k:v}` → `#{k:v}` for the example files → Phase 4.
- [x] **2e. Paren-collapse** (§2.1). ✅ DONE (as a codemod). **Finding:** there is no
      `velve fmt` (CLI has only `check`/`run`/`ast`/`tweaks`) — building a full
      pretty-printer for two cosmetic transforms is disproportionate. Delivered the
      valuable half as `scripts/paren_collapse_codemod.mjs`: unwraps a `grouped` `(E)`
      that is a *direct call argument* (`print((x))`→`print(x)`, `f((a+b), y)`→`f(a+b,
      y)`), leaving tuple args (`f((a, b))` — a `tuple_literal`, not `grouped`) and
      callee parens (`(fn..)(3)`) untouched. **Provably inert**: a grouped call-arg
      lowers identically to its inner expr, verified by byte-identical diagnostics
      (md5) on the 114-collapse file and a byte-identical full-corpus baseline after
      applying. Collapsed **608 parens across 73 files**; corpus now reads clean.
      **`?:` glue dropped:** no formatter to host it, no ambiguity to fix (established
      in 2b) — purely a style nicety, not worth a tokenization break.

### Phase 3 — Deletions (§4)  ✅ DONE (2026-06)
- [x] **3a. Delete `pipe` block** + the `ret` magic identifier. ✅ DONE, edition-gated.
      **Finding:** zero corpus/example uses of the `pipe` block keyword (all matches were
      substrings — `pipeline`, "pipes" in comments) → no codemod needed. The magic `ret`
      has no meaning outside the desugar, so deprecating the block removes both. Kept the
      block in the superset grammar; `lowerPipeBlock` now warns 2026.1 / errors 2026.6
      (SPEC §17 lifecycle), pointing at the multiline `|>` chain as the replacement.
      New fixtures: `pipe_block_2026_1.velve` (warn-only, green) + `pipe_chain_2026_6.velve`
      (the `|>` replacement, clean). Gate verified both ways; corpus 32→32, zero
      regressions. SPEC §3.11 `pipe` entry rewritten with the deprecation + `|>` form.
- [x] **3b. Finish `saga` removal.** ✅ DONE. Kept the deprecated alias path
      (`saga_def`/`saga_alias_test.velve` still warn + run identically — that's the
      alias *test*, left in place). Migrated the last aspirational user
      `examples/checkout.velve`: the expr-form `def checkout … saga CheckoutState` became
      a top-level `machine Checkout(cart: Cart): … persisted over CheckoutState` (steps
      dedented one level; Effect return type rides through since `_type` ⊇ `effect_type`).
      Parses as `DSaga deprecated:false` (canonical machine path); the `saga` keyword is
      gone from `examples/`. Baseline byte-identical (checkout's 14 errs are its
      undefined helpers — Phase 4c, unchanged here).
- [x] Keep `let` and `Char` — **no code change**; documented the `let`/`const` vs bare
      `x =` distinction in SPEC §3.3. **Finding:** the difference is real and
      borrow-checked (`borrow.ts:267,599` keys on `SBind.declares`): `let`/`const`/`mut`
      *declare* a new block-scoped, shadow-capable binding; bare `x =` *reassigns* the
      binding in scope. Documented exactly that (not "redundant sugar").

### Phase 4 — SPEC / example hygiene (§6, §2.3) 🔴 highest leverage  ✅ MOSTLY DONE (2026-06)
This is the root cause of the "I thought we already did X" surprises — decisions
locked in `docs/` never propagated to `SPEC.md`.
- [x] **4a. "What's built ✅/❌" table.** ✅ DONE for `SPEC.md` — new §0.5 build-status
      table (grounded in which fixtures are green), and removed the stale §0 line
      "Type checker implementation (… checker pending)" (the checker exists). Examples
      now carry an "⚠ Aspirational sketch" header (the table points at them).
      **Deferred:** per-design-doc status headers (lower leverage; SPEC is the
      authority and is now reconciled — APCA, message/step rules below).
- [x] **4b. SPEC §3.2 `:`/`=` honesty rewrite.** ✅ DONE. §3.2 retitled "Core symbols";
      `:` documented with its three non-type meanings (record-literal field, atom/step
      label, keyed-list entry) and `=` added with its honest scope (binding + named arg,
      never a type/record field; the `{}=` vs `{}:` trap noted as dissolved by `#{}`).
- [x] **4c.** ✅ DONE (kept examples in place, clearly marked, instead of moving):
      • **Example surface migration** via new `scripts/edition_migrate_codemod.mjs`
        (examples-only): `{ }`→`#{ }` (65), ternary→`if/then/else` (8), `for =/%`→`in` (9).
        **81 deprecation warnings → 0** across all 8 examples; every error count
        byte-identical (type-checker-inert); `?:` Elvis correctly left untouched.
      • **Refinement-in-use:** `taskflow.velve`'s dead `ValidAge` is now used
        (`ageNextYear(a: ValidAge)` + `demoAge`), with an accurate comment (call-site
        literal fold; `.parse` runtime guard; transparent-to-base). Error count unchanged.
      • **Message constructors + implicit-step-match** documented in SPEC §7.2 / §4.1;
        stale `{…}` message/next-state records in SPEC fixed to `#{…}`.
      • **README WCAG→APCA:** the `uiModel` inspector honestly reports the *WCAG ratio*
        today (that's what `render.ts` computes), with APCA Lc named as the color
        system's target; `docs/styles-design.md` `OnSurface` threshold corrected from
        `>= 4.5 -- WCAG AA` to an APCA Lc value.
      **Open structural choice (not done):** physically moving `examples/` →
      `docs/sketches/`. Left in place + marked aspirational; user's call whether to move.
      Corpus stays at 32 error-fixtures; examples now warning-free.

### Phase 5 — Call-syntax phase 2 (§2.1, the last surface inconsistency)
The remaining "three application syntaxes" item. Split into the self-contained
**pattern** unification and the larger **element** surface change.
- [x] **5a. Constructor pattern space→paren** (`| Ok v ->` → `| Ok(v) ->`). ✅ DONE,
      edition-gated. **Finding:** paren-form patterns *already parse* to the identical
      `PCtor` AST (`Ok(v)` ≡ `Ok` + parenthesized `(v)`), so destructuring-as-construction
      needed **no grammar change** — only deprecating the bare form. `checkCtorPatternForm`
      in `lower.ts` flags a ctor pattern with a single *undelimited* payload (warning
      2026.1 / error 2026.6); delimited payloads (`Ok(v)`, `Ok (Chunk c)`, `Ok {body}`) and
      the binding+record triple (`Ok r {body}`) are left untouched. New codemod
      `scripts/ctor_pattern_codemod.mjs` (examples-only, tree-sitter render/stitch) wrapped
      **38 bare patterns across 7 examples**, type-checker-inert (byte-identical error
      counts). Migrated the 2026.6 fixture `outcome_test.velve` by hand (the gate caught its
      bare `Committed n`/… end-to-end). New fixtures: `ctor_pattern_test.velve` (2026.6,
      paren-form, green + runs) and `ctor_pattern_bad.velve` (2026.6, bare form, 2 intended
      errors). **Verified:** check + runtime baselines byte-identical for all 95 prior
      fixtures (only the 2 new files added). SPEC §3.5 documents the rule; SPEC bare-ctor
      *pattern* examples swept to paren-form (19 branch patterns; step-body *constructions*
      like `:abort Error e` left for the separate construction-drift sweep).
- [x] **5b. Element surface space→paren** (`Text "hi" size=12` → `Text("hi", size=12)`).
      ✅ DONE (core), edition-gated. The reader-facing §2.1 win. **As-built:**
      • **Single source of truth** `checker/src/elements.ts` (`PRIMITIVE_MODE` + derived
        `PRIMITIVE_ELEMENTS`), shared by the lowerer and `infer.ts`. The ~20 primitive names
        are **reserved** (a user ADT ctor may not shadow them).
      • **Childless paren elements** are disambiguated from ADT ctors at **lower-time**: a
        `call` whose head is a primitive (`Text(…)`) lowers to an `Element`, not a `Call`
        (`elementFromCall`); `Ok(x)` etc. stay calls. The `Element` AST node is **kept**, so
        infer/eval are byte-identical (no element logic relocated).
      • **Children-bearing paren elements** (`Column(gap=8)` + block) get a dedicated grammar
        rule (`element_args` on `element`/`element_leaf`, `token.immediate('(')`), unambiguous
        vs `call` (which carries no children block). Parser regenerated + native binding rebuilt.
      • **Space-form deprecation** (`checkElementForm`): warning 2026.1 / error 2026.6.
      • Migrated the 2026.6 fixtures (`accessibility_test`/`bad`) by hand — the gate caught
        their space-form end-to-end (and the contrast check correctly re-fires through the
        paren-form tree). New fixtures: `element_paren_test.velve` (childless + children-bearing
        + nested, green + renders HTML) and `element_paren_bad.velve` (space-form in 2026.6, 2
        intended errors).
      • **Verified:** full check + runtime baselines vs post-2B — only intended deltas:
        accessibility error *column* shifts (paren is 1 char wider), the 2 new fixtures, and
        `taskflow` 49→46 (its glued `Text(…)` now resolve as elements instead of
        `unresolved name: Text` — a correctness win). **Zero** new tree-sitter corpus-test
        failures (the 9 pre-existing failures are `member_name` drift, confirmed identical on
        the committed grammar). SPEC §11.1/§11.1.1/§11.3 + scattered examples rewritten to
        paren-form with the deprecation note.
      **Deferred (logged, not silent):** (1) the **examples** codemod
      (`scripts/element_paren_codemod.mjs` exists, migrates 48 elements / skips 12 with
      spread+handler props) is **not applied** — the aspirational examples have *pre-existing
      syntax errors*, so the partial-parse migration isn't byte-identical (±1 error shifts).
      They stay space-form (a 2026.1 warning) until first made syntactically clean.
      (2) **Inline handler props** (`onClick -> body`) and **spread props** (`...rec`) don't map
      to paren `name=value` — they need call-arg-spread + handler-arg grammar (a separate
      build); handlers already attach via the `on …` children block.
- [x] **5c. Delete curried (value-level) juxtaposition** (`add 1 2`). ✅ DONE. **As-found:**
      value juxtaposition was *already* gone — phase 1's unified postfix `call`
      (`token.immediate('(')`) left no spaced-application rule, so `add 1 2` and the juxtaposed
      IIFE `(fn x -> x + 1) 9` are hard syntax errors in **every** edition (not an edition gate).
      This step closed the **doc/reality gap**: SPEC "Calling functions and constructors" and
      "Currying & over-application" no longer claim `add 1 2` is legal; currying is now shown
      only through parens (`add(1)(2)`, partial `add(1)`). New fixtures `juxtaposition_test`
      (green — currying + type-juxtaposition, runs `11766`) / `juxtaposition_bad` (2 syntax
      errors). **Type-level juxtaposition kept** (the locked asymmetry): built-in parametric
      types keep `Result a e` / `Async a` / `Tainted a`; generic types use parens `List(Number)`.
      Corrected a pre-existing SPEC error that listed `List Number` as valid — there is no
      generic `Name T` type juxtaposition (`List Number` is a syntax error). **Verified:**
      baseline delta is exactly the 2 new fixture rows; zero crashes, no source/grammar change.

---

## Track B — Decided semantic gaps (independent of Track A; medium)
Endorsed in review; not part of the surface refactor but cleared to build.
- [x] **Backpressure per-stream policy** (§3.2): ✅ DONE (2026-06). `stream Name : T
      [drop | buffer N | block]` at the declaration site; SPEC §10.1 rewritten (the old
      "drop by default" line was fiction — the as-built queue was an unbounded buffer,
      which stays the no-policy default so every existing stream fixture is untouched).
      `drop` = deliver-to-waiter-else-discard; `buffer N` = bounded, evicts oldest
      (positive-integer literal enforced in the lowerer); `block` = rendezvous — `send`
      parks the producer until a consumer takes the value (deterministic under the
      cooperative scheduler; zero scheduler changes). `Done` is policy-exempt. Surface:
      `buffer`/`block` are CONTEXTUAL words (lower_id in policy position, validated at
      lower time) — making them grammar keywords reserved them globally and broke
      `buffer` as a store state field (`examples/llm_agent.velve`), caught by the corpus
      diff and reverted. Fixtures `stream_policy_test` (ordering/eviction/rendezvous
      proven, runs) + `stream_policy_bad` (2 errors); baselines byte-identical otherwise.
- [x] **Machine `await`→step-goto gap** (§3.2): ✅ DONE (2026-06). Not a grammar
      gap as-found — `await_stmt` parsed inside steps and `_branch_body` already
      admitted `step_goto`; the lowerer's default case silently dropped the statement
      (empty step body). Fixed with one `lowerSagaStmt` case: `await` in a step lowers
      to a `SagaMatch` on a branch-less `Await` subject, so branch bodies get the full
      saga-branch grammar (goto/rollback/blocks) and existing infer/eval/reachability
      walk them unchanged. Self-goto drain loop works (`| Push(e) -> :collect (acc+e)`).
      Fixtures `machine_await_test` (runs, drains a stream to 60) + `machine_await_bad`
      (2 unknown-state errors from await branches); baselines byte-identical otherwise.
- [x] **`try` soundness fix** (§3.5): ✅ DONE (2026-06, `try_sound_test`/`_bad`).
      Deferred monomorphize-then-decide sweep after whole-module inference: Var-typed
      try lines accepted retroactively if they resolve to a concrete non-Result, errors
      if they resolve to Result too late or never. Unknown-callee calls return `Unknown`
      (no leaked leniency vars); `print`/`println` typed; `identity`/`listHead` made real
      (blocks-design §12 updated).
- [x] **Named error ADTs** (§3.5): ✅ DONE (2026-06, SPEC §2.6, `error_adt_test`/`_bad`).
      Prelude single-ctor ADT `ParseError { expected, got, detail }` (registered in
      resolve/infer/exhaust/eval); refinement `T.parse : Base -> Result Base ParseError`;
      `parseNumber` made real end-to-end (was typed-only — neither resolved nor ran) with
      whole-string semantics and the structured error; `Json.parse` structured at runtime.
      Stringly error use is now a check error; SPEC documents the map-at-the-boundary
      domain-ADT convention. Residual: `parseInt`/`parseFloat`/`String.toNumber` still
      stringly; inferred error rows are the separate A+ mechanism (north-star §4).
- [x] **Effect polymorphism** for higher-order fns (§3.6): ✅ DONE (2026-06,
      SPEC §12.4, `hof_effects_test`/`_bad`). The effect of `map(f, xs)` is the
      effect of `f`, charged at the call that supplies it: a function value
      carries latent effects on its `Fn` type, and passing it as an argument
      requires them (conservative — the callee may invoke it). Fires for
      untyped (`map`) and typed (`pmap`) callees; aliasing doesn't launder;
      edition-gated like the pure-hole (1b). Effect rows subsume this later.
- [x] **Module-qualified resolution** (§3.6): ✅ DONE (2026-06, SPEC §5.5,
      `qualified_test`/`_bad`). Capitalized stdlib namespaces are ambient —
      `Math.sqrt(x)` checks (fully typed members) and runs with no import;
      user bindings shadow; lowercase/path forms stay import-only; ambient and
      namespace-import forms share one record type.
- [x] **Error rows v1, S1** (north-star §4; design: `docs/error-rows-design.md`):
      ✅ DONE (2026-06, SPEC §2.13, `error_rows_test`/`_bad`). `Result T _`
      infers a transitive ctor-set row, `?` accumulates by union inside `_`
      defs, a named-ADT ascription pins via ctor-set inclusion (escapees
      listed), recursion among `_` defs rejected; rows close by end-of-module
      fixpoint; prose `String` is uncoverable. Zero corpus impact.
- [x] **Error rows v1, S2**: ✅ DONE (2026-06, `error_rows_match_test`/`_bad`).
      Rows directly matchable — payloads from ctor schemes, match never widens
      the row, exhaustiveness over the ACTUAL raised set: missing ctors named,
      never-raised arms rejected, prose needs catch-all; judged post-closure.
      Error handling re-graded **A → A+**.
- [x] **Error rows S3, shadowing slice**: ✅ DONE (2026-06,
      `ctor_shadow_test`/`_bad`). Shared ctor names resolve by EXPECTED type
      in expression position (deferred behind fresh vars, judged in
      finalizeRows step 0 once the substitution shows the demanded ADT) and
      by scrutinee type in patterns; a row-entry match types the payload from
      the contributing ADT. Declaration order of sharing ADTs no longer
      matters. Remaining S3: mixed-arity shared names, fix-its. Then S4/v2
      (row variables).
- [x] **Error rows S3, late-contribution slice**: ✅ DONE (2026-06,
      `row_late_test`/`_bad`). The S1 Var leniency closed — a `?` whose callee
      error type is still a Var when the line is checked (forward call to an
      unascribed-param def or `let` lambda) is deferred and re-judged in
      finalizeRows step 0.5; the late contribution reaches the row, its pins,
      and its match verdicts. Never-contributable types are rejected (still
      polymorphic → "annotate or pin"; concrete non-ADT → named); only
      `Unknown` stays lenient. S1 dropped these silently — pins passed
      vacuously over under-approximated rows.
- [x] **Error rows S3, fix-it slice**: ✅ DONE (2026-06,
      `row_fixit_test`/`_bad`). A failing pin names the smallest edit that
      makes it hold: re-pin with an already-declared covering ADT (smallest
      ctor count wins) and/or add the missing variants, spelled in
      declaration syntax. Green fixture = the suggestion applied. S3 closed
      except mixed-arity shared names, which turned out to be
      runtime-ambiguous (eval binds each ctor name once — function if
      payloaded, bare value if nullary) and waits on an eval redesign.
      Next: S4/v2 row variables.
- [x] **Row variables (S4/v2) design note**: ✅ DONE (2026-06,
      `docs/row-variables-design.md`). v2 worked out against the as-built
      v1: row-polymorphic SIGNATURES over the v1 flow core — tails are
      quantified vars cloned per call site at instantiate and judged by the
      existing finalize step 0.5; no new unification on the error side.
      Probes exposed the real prerequisite: NO function-type ascription
      exists in the surface (lower never produces TRFn; checker is ready),
      and row defs are mono (rows × generics unusable). Sliced: S4a fn-type
      ascriptions, S4b row tails, S4c effect tails on builtin HOFs (the
      §12.4 replacement; Fn-unify must learn effect tails). Next: S4a.
- [x] **Function-type ascriptions (S4a)**: ✅ DONE (2026-06, SPEC §2.14,
      `fn_type_test`/`_bad`). `(A -> B)` / `(A, B -> C)` / `(() -> T)` in
      any ascription slot; parens mandatory (bare return-slot `->` is the
      single-line body); lone `()` = empty param list (the zero-param def
      shape); composes with user generics. Grammar + lower only — the
      checker was TRFn-ready. Green: pass-through error polymorphism under
      a pin, n-ary, thunk, return-slot closure. Bad: 4 boundary errors
      unascribed params could never surface. Zero corpus impact.
- [x] **Row tails (S4b)**: ✅ DONE (2026-06, SPEC §2.13 v2 block,
      `row_tails_test`/`_bad`). The v2 core: row defs compose with generics,
      a callback's error var is a TAIL on the row, and each use judges a
      per-call-site clone (⊇ base) — the same def pins differently at each
      call, row-matches are exhaustive over THIS call's set, and generic
      non-HOF row defs are callable (layers 2+3 closed). Union + extension
      green; bad fixture pins 4 errors (tail escapee with covering-pin
      fix-it, unresolved tail ×2, open-row match without catch-all).
      As-built delta: tails register via a deferred finalize step 0.4
      (callers can check before the def's body fills its tails); judging is
      the existing step 0.5 verbatim. Zero corpus impact.
- [x] **Effect tails (S4c)**: ✅ DONE (2026-06, SPEC §12.4 effect-tails
      block, `effect_tails_test`/`_bad`). Builtin HOF signatures carry an
      effect tail (`Fn.effectTail?: number`, a quantified id; `EFFECT_TAILS`
      accumulates per-call bindings; Fn-unify's one effect rule: a declared
      tail absorbs the other side's row). `pmap`/`pfilter` charge the
      argument's row precisely per call site; `identity` (tail on own row
      only — never invokes) accepts an effectful fn uncharged, with no
      laundering (the value keeps its row for the per-call check). The
      conservative §12.4 rule defers to tailed signatures and governs
      untailed callees (surface `map`/`filter`, user HOFs) unchanged.
      Zero corpus impact (`hof_effects_bad` stays 4 — its pmap case now
      fails via the tail). S4/v2 complete; E2 user-spelled tails deferred.
- [x] **User-spelled effect rows (E2)**: ✅ DONE (2026-06, SPEC §12.4 E2
      block, `effect_spell_test`/`_bad`). The S4c tails handed to user code:
      `..e` inside the existing `Effect [...]` bracket — a param fn-type
      (`f: (String -> Effect [..e] String)`) BINDS the argument's row per
      call site; the def's own clause (`Effect [..e]` / `Effect [io, ..e]`)
      CHARGES the caller. Zero new syntax concepts (effect_type was already
      a _type — one grammar extension admits the tail in the bracket) and
      zero new checker rules (tail names quantify in generalizeSig beside
      type vars, namespaced "..e"; substVars/bindEffectTails/fnEffectRow run
      verbatim). Latent-rule skip widened to tail-AWARE (own or param Fn),
      making the identity pattern spellable: `keep(netGet)` uncharged, the
      value keeps its row. Guardrails: ≤1 tail per row; unbound clause/
      return tails error; a tail-only clause is a declared-EMPTY pool (the
      tail never licenses the body). Baseline diff = the new fixtures only.
      Found (pre-existing): untailed fn-type ascriptions erase effects —
      effects don't unify; documented as its own future slice.
- [x] **Ascription effect-coverage**: ✅ DONE (2026-06, SPEC §12.4 coverage
      block, `effect_ascribe_test`/`_bad`). The E2 dig's laundering hole
      closed: a concrete fn-type ascription must COVER the value's effect
      row — directional (declared ⊇ actual; over-approximating is legal),
      checked at the ascription boundaries (def returns, let bindings in
      both block and try bodies) rather than inside unify
      (accumulate-never-unify stays law). Walks covariant structure (fn
      rets, type args, tuples, record fields, Stream/Async inners) so the
      row can't hide in a record field or list element; error names the
      missing row + both fix-its. Tail-spelled returns exempt at top level
      (the tail owns the row); fn params stay with the conservative §12.4
      rule (contravariant — direction flips). Caught a genuine erasure in
      effect_tails_test's `keep` (S4c-era) — fixture corrected to spell
      `(String -> Effect [io] String)`. Baseline diff = the new bad
      fixture only.
- [x] **Tier-1 `@total` structural totality (proof-gradient slice 1)**: ✅ DONE
      (2026-06, SPEC §12.6, totality-design §9 as-built, `total_test`/`_bad`).
      The north-star §3 gradient's first checked obligation: `@total def f`
      (parses via the existing decorator rule — zero grammar changes) is held
      to its promise by a standalone syntactic pass (`total.ts`): recursion
      must decrease at ONE position (ctor/tuple/record destructuring descent,
      or `n - k` under a literal/comparison floor with a recursion-free path),
      and totality flows DOWN the call graph — total calls only total fns +
      terminating builtins; HOF builtins need a checkable fn (lambda /
      local-let lambda / total name); `loop`/`await`/spawn/host/elements
      rejected in total bodies. Conservative rejects (pinned in `_bad`, 8
      errors): mutual recursion (cycle pass, one error per fn), closure
      recursion, fn-param calls, non-total builtins. §3.5 finding recorded:
      module-private ctors = language change (flat resolver scope) — gates
      the refined-type tier only. Deferred follow-on: §5.1 constEval folding
      of @total predicates (corpus-wide, own slice). Baseline diff = the two
      new fixture rows.
- [x] **`Proof [...]` module scope (proof-gradient slice 2)**: ✅ DONE
      (2026-06, SPEC §12.7, `proof_scope_test`/`_bad`). `proofs: [total,
      exhaustive]` in module heads — `proofs_decl` mirrors `capabilities_decl`
      in the grammar (additive; corpus case added; the 9 pre-existing corpus
      failures unchanged). The dual of capabilities: effects flow UP, proofs
      flow DOWN into every def the module contains. Vocabulary CLOSED at
      lower time (`total bounds nonzero arith overflow exhaustive handled`);
      declared = enforced — unknown obligation → error; not-checkable-yet
      obligation (`bounds` etc.) → error naming what IS checkable; never a
      silent skip. `total`: lower marks each contained DFn implicitly @total
      (total.ts untouched — decrease check + downward gate fire as if the
      decorator were present); `exhaustive`: clause-head gaps harden to
      errors in EVERY edition (a `hardened` flag through checkClauseHeads;
      the bad fixture is deliberately baseline-edition to prove the
      obligation beats the 2026.6 gate). Found while fixturing: payload-ctor
      clause heads (`def f(Rise(n))`) are grammar-ambiguous with
      function_sig types — the exhaustive fixture dispatches on nullary
      ctors (the safe subset's shape anyway). `proof_scope_bad` = exactly 5
      errors; run-mode refuses it (vocabulary errors are lower-stage —
      correct: a module promising an unknown obligation shouldn't run).
      Baseline diff = the two new fixture rows. North-star §3.6 items 1, 2,
      4 ✅.
- [x] **§3 + Security re-grade (proof-gradient slice 3, completes the plan)**:
      ✅ DONE (2026-06, docs-only — no code, no fixtures, baselines untouched
      by construction). Security row A → **A+** in both grade tables
      (north-star §1, TODO §1): the field's exemplars ship ONE gradient
      (capability security, effects up — Austral/Pony/Koka); Velve ships the
      dual pair under one declaration shape, both closed vocabularies, both
      declared = enforced, every known effect-laundering route closed +
      per-obligation proof rollout live. The §3.6 re-grade block argues the
      construct's A+ on four grounds: vocabulary held through two slices of
      compiler contact (zero obligations added/renamed); rollout promise
      kept loudly (no-checker obligations are errors, never skips — a
      partially-implemented gradient that's SOUND); the direction rule
      survived contact (proofs-flow-down IS the downward gate, reused
      untouched by the module scope); every unshipped obligation has a named
      blocker — and `handled`'s (§4 error rows) has since shipped, making it
      the cheapest next obligation (§3.4 table updated). Honesty items: the
      ambient-stdout DECIDED hole is now on record in both Security rows;
      §10 evidence basis updated (the gradient is no longer "design-on-design,
      none built"); §9 reading guide updated. Explicitly NOT bought: the
      Type-core row stays A− — its named gap (the conservative skip) is
      untouched; its promoted next lever is §5.1 constEval widening (fold
      predicates whose call-closure is @total), now named in the Type-core
      row itself. Remaining recorded levers after this plan: §5.1 (own
      slice, corpus-wide inference), refined-type library (gated on
      module-private ctors — language change), per-def/per-block proof
      scopes (PROPOSED), Tier-2 Z3.
- [x] **§5.1 constEval widening — fold `@total` predicates at check time
      (the promoted follow-on; Type-core A− → A)**: ✅ DONE (2026-06,
      SPEC §2.6 + §12.6, totality-design §9, `constfold_total_test`/`_bad`
      — exactly 3 errors; baselines unchanged except the two new rows; no
      grammar change). The totality promise is what makes running user code
      inside the checker safe, so `constEval` now applies `@total` functions
      (decorator or module `proofs: [total]` — both arrive via DFn.total) to
      constant arguments: clause dispatch over a DECIDABLE pattern matcher
      (literals/tuples/records; ctor/atom patterns sink the whole fold —
      an undecidable branch can't be skipped, it could select the wrong
      arm), bodies fold through if/match/straight-line immutable let blocks
      and recursion. Fuel-bounded (100k applications) because Number ≠ Nat
      (`factorial(-1)` must exhaust into a conservative skip, never hang
      the checker); named-arg calls, defaults, mut, control statements,
      module-const refs in bodies all bail. Engine: infer.ts — TOTAL_FNS
      registered in registerAliases; constEval became a fuel-resetting
      wrapper over the recursive `ceval`; new If/Match/Do fold cases +
      applyTotalFn/tryMatchConst. Builtin folds keep name priority. Honest
      find recorded in docs: runtime refinement enforcement is the explicit
      `T.parse` boundary ONLY, so pre-§5.1 `half(3)` against an
      `isEven(value)` refinement was accepted and ran unchecked — this fold
      is the only check such calls get. Type-core re-graded A− → **A** in
      both tables (north-star §1 + §3.6 closing block + §3.2/§10; TODO §1);
      remaining → A+: refined-type library (gated on module-private ctors)
      + Tier-2 Z3.
- [x] **`handled` — the third checkable proof obligation**: ✅ DONE
      (2026-06, SPEC §12.7, `proof_handled_test`/`_bad` — exactly 4 errors;
      baselines unchanged except the two new rows; no grammar change). Its
      §4 blocker (error rows) had shipped, making it the cheapest obligation
      on the board. `proofs: [handled]` = no def in the module silently
      discards a `Result`: a Result-typed expression in a dropped statement
      position (non-final in do/try/retry/transaction, ANY position in a
      loop body) is an error; match/`?`/bind/return are the sanctioned
      paths, and deliberate discards are rejected too (the escape hatch is
      not declaring the obligation — gradient-wide rule). New pass
      `checker/src/handled.ts` (mirrors exhaust's module walk; consumes the
      inference types map; conservative on unresolved Vars), wired into
      index.ts + lsp.ts; lower.ts PROOF_CHECKABLE += handled (the
      not-checkable error message now lists three). Design point recorded
      in SPEC §12.7 + north-star §3.4: obligations have two enforcement
      shapes — `total` is call-graph (downward gate), `exhaustive`/`handled`
      are scope-local (fault is syntactic to the scope) — so no downward
      gate for handled is principled, not a shortcut. Green fixture also
      witnesses scope-locality: the same discard OUTSIDE the module is
      legal. v1 scope: function bodies (store/machine/saga bodies
      documented out). Surface gap found: wildcard binds (`let _ = e`)
      don't parse — the PWild discard check in handled.ts is defensive
      for when they land. 3 of 6 obligations now checkable; remaining:
      `bounds`/`nonzero` (flow-sensitive fact env, §3.1 catch 1),
      `overflow` (sized types, §5).
- [x] **Canvas free positioning + legibility proof (svg-legibility S0+S1)**:
      ✅ DONE (2026-06, SPEC §11.1.2, `canvas_legible_test`/`_bad`).
      `at=(x, y)` children (Canvas-parent-only; paint order = child order →
      position:relative/absolute html) + the static proof, opt-in via the
      `Legible` refinement: text disjointness, occlusion-from-above, and
      per-region APCA over composited solid fills (exact box bisection —
      a half-dark/half-light label is judged per region); unfoldable
      geometry is a could-not-prove error when the proof is active. The S0
      dig fixed a substrate bug: paren-form elements' indented children
      parsed as SIBLINGS (2026.6 views silently rendered only their last
      leaf) — dynamic precedence on the children-bearing element branch;
      zero corpus baseline changes. Residual: bare call children
      (`card()`) still siblings — spell `{card()}`. S2–S5 deferred.
- [x] **Call children (`card()` composition)**: ✅ DONE (2026-06, SPEC §11.1,
      `call_child_test`/`_bad`). The Canvas slice's last residual closed: a
      bare lowercase component call is a `child` grammar form
      (`call_child` — lowercase-headed, so it never competes with
      element_leaf's Upper paren form; lowers straight to a Call). Composed
      views nest for real; `theme_root_test` un-flattened (and its
      `action()` now paints the accent it proves against — the flattening
      had hidden that the proof surface was never painted). Guardrails
      proven position-independent: a typo'd component resolves-errors, args
      type-check, and an effectful component child in a pure view is the
      same §12.3 violation as anywhere — which is also why the baseline
      diff is EMPTY even for the new fixtures under the old parser
      (statements vs children hit identical checks). `{card()}` still
      parses.
- [x] **Effect-typed builtin surface**: ✅ DONE (2026-06, SPEC §12.5,
      `builtin_effects_test`/`_bad`). `setTheme`/`setViewport` charge
      `[ui]`, `externSource` + the prelude network names charge `[io]` —
      the stdlib stops lying by omission, including through S4c tails
      (`pmap(setViewport)` charges `[ui]` in a pure def). Decided ambient:
      `print`/`println` (observation channel) and `sleep` (virtual time).
      `theme_root_test`/`responsive_prop_test` mains now honestly declare
      `Effect [ui]`. Security re-graded A− → A (the named coverage gap).
- [x] **`Responsive(Length)` prop-only auto-collapse** (§3.1): ✅ DONE (2026-06).
      A `Length` prop accepts a `Breakpoint -> Length` value and collapses it against
      the live `viewport.breakpoint` — a second prop-site coercion exactly beside
      bare-number→`Px` (type-gated: return must be a `Length`). Collapsed eagerly at
      eval, *not* in the convergence pass (the viewport is a §9.1 read-only root → no
      (element,prop) edge). Added `setViewport` (the viewport sibling of `setTheme`) so
      a resize re-collapses every responsive prop. Fixtures `responsive_prop_test`
      (320px@Desktop → 100%@Mobile on swap) + `responsive_prop_bad` (2 type errors).
      Enables declare-once-reuse; responsive is now built end-to-end (styles §9.2–9.4).
- [x] **Accessibility-as-proof** (`OnSurface` contrast refinement, styles-design §14.1).
      ✅ DONE (conservative scope). `Color where contrast(value, surface) >= Lc` is enforced
      at compile time — an unreadable foreground/background pairing fails to check.
      As-built: APCA Lc in `constEval` (`contrast(fg,bg)`); the `Element` walk threads the
      resolved background (`surfaceBg`) down the tree (own literal `background` wins, else
      inherited); the `color` prop folds against it **only when the project defines
      `OnSurface`** (`PROP_SURFACE` opt-in, mirrors the §4.2 token-scale pattern) and both
      colour + background are constant hex. Error reports the computed Lc, never a proof
      obligation. Non-literal / convergence-resolved backgrounds stay silent (runtime /
      `uiModel` linter), per the §14.1 binding scope. Fixtures: `accessibility_test`
      (green), `accessibility_bad` (Lc 51 < 60, 1 intended error). Corpus impact zero
      (inert unless `OnSurface` is defined). No new logic-model concept — it is the
      existing refinement mechanism. **Remaining for an A− UI grade:** call-syntax phase 2
      (§2.1) + theme/responsive, not this.
- [ ] **Unified numeric/dimension design note** (§3.4): reconcile `Number` /
      `Duration` / `Px·Fr·Pct` / planned sized types. Recommendation on the table:
      make *dimensioned numbers* the general mechanism (F#-style units), derive
      `Duration`/`Length`/angle from it. **Write the note before the compiled target.**
- [ ] *(optional)* `is Ok(a)` payload binding / flow-narrowing after `if x is Ok` —
      the terse "is this Ok and give me the value" sugar, replacing the dropped
      `user? a | b`.

---

## Track C — Large deferred builds (roadmap, not sequenced here)
Real, endorsed, but each is a major build and out of scope for the consistency pass.
- Games / interaction model: `@interaction` marker, capability-keyed dispatch,
  footprint = `mut` params (`interaction-model-design.md`).
- `frames` clock-stream host capability (blocks both the game loop and `animated`).
- `animated` modifier + motion-policy chokepoint (`animated-modifier-design.md`).
- Theme system (roles, `using`, `OnSurface` contrast) — `std/color` is built and has
  no consumer yet.
- `inputmap` — **core built 2026-06** (SPEC §10.5; `inputmap_test`/`_bad`):
  declaration + typed rows + conflict analysis + labels + drain-loop runtime;
  plus the `Inputmap` type + `help(map)` derived data
  (`inputmap_help_test`/`_bad`); plus `++` layering
  (`inputmap_layer_test`/`_bad`); plus chord-refinement literals
  (`inputmap_chord_test`/`_bad` — the literal-pattern refinement fold is
  general, not inputmap-only); plus `keymap` sugar (`keymap_test`/`_bad`).
  Remaining breadth (std `Key` device library + physical-key prefix,
  focus-zone scoping, the *rendered* overlay element, device libraries) stays
  Track C (`multitarget-design.md §4`).

---

## Cross-cutting discipline
- Every breaking step (Phase 2/3) = codemod + full `.velve` fixture + corpus run
  green before the next step. No silent caps — `log` anything a codemod skips.
- All breaks ride edition `2026.2`; prior-edition corpus must stay green throughout.
- Do **not** relitigate the Track A "don't change" set (`TODO.md §7`): four-primitive
  state taxonomy, transparent refinements, taint-at-parse, no-Maybe, motion-policy
  chokepoint, footprint=`mut`, Duration-as-dimension, indentation blocks.
