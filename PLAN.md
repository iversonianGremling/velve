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

---

## Track B — Decided semantic gaps (independent of Track A; medium)
Endorsed in review; not part of the surface refactor but cleared to build.
- [ ] **Backpressure per-stream policy** (§3.2): `drop | buffer N | block` at the
      declaration site (not "drop by default"). SPEC §10.1 + checker.
- [ ] **Machine `await`→step-goto grammar gap** (§3.2): close it so machines can
      consume streams idiomatically (`SPEC §4.3` note).
- [ ] **`try` soundness fix** (§3.5): polymorphic try line resolved to `Result` later
      — monomorphize-before-try, reject, or warn (`blocks-design.md §12`).
- [ ] **Named error ADTs** (§3.5): stdlib support + `T.parse`/decoders return a
      structured error type, not `String`.
- [ ] **Effect polymorphism** for higher-order fns (§3.6): effect of `map(f, xs)`
      when `f` is effectful. Currently unspecified.
- [ ] **Module-qualified resolution** (§3.6): `Math.sqrt` still doesn't resolve while
      stdlib docs are written qualified.
- [ ] **`Responsive(Length)` prop-only auto-collapse** (§3.1): collapse a
      `Responsive(Length)` against the current breakpoint *in prop position only*
      (same shape as the bare-number→`Px` coercion). Enables declare-once-reuse.
- [ ] **Accessibility-as-proof** (`OnSurface` contrast refinement, styles-design §14.1):
      enforce `Color where contrast(self, bg) >= Lc` at compile time — an unreadable
      foreground/background pairing fails to compile. **Conservative scope is binding
      (readability constraint, see §14.1):** static check ONLY when the background is a
      literal on a statically-visible ancestor (reuse the §9.5 parent walk), reporting
      the *computed* contrast (`#777 → Lc 38 vs #fff, needs ≥ 60`), never a proof
      obligation. Convergence-resolved / theme-inherited backgrounds are NOT chased
      statically — they stay with the runtime `uiModel` linter. Mostly wiring: `contrast`
      into `constEval` + bind the ancestor bg as the refinement's value-arg (§4.2 path).
      Lifts UI/styling toward A− when done; no new logic-model concept.
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
- `inputmap` (locked-but-unbuilt, `multitarget-design.md §4`).

---

## Cross-cutting discipline
- Every breaking step (Phase 2/3) = codemod + full `.velve` fixture + corpus run
  green before the next step. No silent caps — `log` anything a codemod skips.
- All breaks ride edition `2026.2`; prior-edition corpus must stay green throughout.
- Do **not** relitigate the Track A "don't change" set (`TODO.md §7`): four-primitive
  state taxonomy, transparent refinements, taint-at-parse, no-Maybe, motion-policy
  chokepoint, footprint=`mut`, Duration-as-dimension, indentation blocks.
