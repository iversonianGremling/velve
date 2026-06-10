# Validation — collecting every error, not just the first

Status: **DESIGN — not built.** This note proposes a `validate` form that runs a
batch of fallible steps and reports **all** their failures at once, as the
companion (dual) to `?`, which stops at the first failure. The motivating case is
the one velve cares about most — UI forms — where "tell me everything that's wrong"
beats "tell me the first thing that's wrong."

Companion to SPEC §3.9 (`?` / `?:` / `try`), §3.5 (named error types), and the UI
`Interaction` validation states (styles-design §12.1).

---

## 0. The problem

`?` is short-circuit: the first failure propagates and the rest never runs.

```
def signup(form): Result User String
  name  = validName(form.name)   ?   -- if this fails…
  email = validEmail(form.email) ?   -- …this never runs
  age   = validAge(form.age)     ?   -- …nor this
  Ok(User(name, email, age))
```

A bad name hides a bad email and a bad age. For a form that is exactly backwards:
the user fixes the name, resubmits, *now* learns the email is wrong, fixes it,
resubmits, learns the age is wrong. Three round-trips for three problems that were
all knowable at once.

`?` cannot express "run all three and collect the failures" — it's short-circuit by
construction. That's the gap.

---

## 1. Guiding principle

> `?` answers "did this fail?" `validate` answers "what are *all* the ways this
> failed?" Forms, decoders, and config loaders want the second question; the
> language should have a first-class way to ask it.

---

## 2. The construct

A `validate` block: every step runs, failures accumulate, and the block yields
either all the values or all the errors.

```
def signup(form): Result User (List FieldError)
  validate
    name  = validName(form.name)     -- all three run regardless of each other
    email = validEmail(form.email)
    age   = validAge(form.age)
    Ok(User(name, email, age))       -- reached only if every step succeeded
```

- If **every** step is `Ok`, the bindings are in scope for the final expression and
  the block succeeds.
- If **any** step is `Error`, the block does *not* run the final expression; it
  yields `Error([…all the failures…])`.

It is the exact dual of `try` (SPEC §3.9): `try` catches the *first* failure
locally; `validate` collects *every* failure. Same block shape, opposite policy —
so there's nothing new to learn about the syntax, only about the policy.

> **The result type is `Result a (List e)`** — a list of errors, not a single one.
> This is the one type difference from `?`, and it's the honest one: a batch of
> checks has a batch of errors.

---

## 3. Why a block, not a combinator

The alternative is a library function — `gather([validName(…), validEmail(…)])`.
Rejected for two reasons:

1. **Heterogeneous results.** The three checks have *different* success types
   (`Name`, `Email`, `Age`). A list combinator forces one element type; a block
   binds each result at its own type, exactly like normal `=` lines.
2. **It reads like the code it replaces.** The `validate` block is the `?` code with
   the `?` removed and one keyword added — a reader already fluent in `?` reads it
   instantly. (Prior art for the underlying idea is "applicative validation" in
   Haskell/Scala; the block form hides that machinery behind plain bindings.)

---

## 4. Structured errors, not strings

`validate` is the feature that makes the §3.5 "name your errors" push pay off.
Accumulating `List String` would give you a pile of prose; accumulating a named
error ADT gives you something the UI can place next to the right field:

```
type FieldError = Invalid(field: String, reason: String)

validName : String -> Result Name FieldError    -- Error(Invalid("name", "too short"))
```

The form layer then maps each `FieldError.field` onto the matching input's
`Interaction.Invalid` state (styles §12.1) — so "collect all errors" connects
end-to-end to "show each error in place." That closure is the whole point: today
the validation *states* exist in the UI but nothing produces a complete set of
errors to drive them.

> **DECIDED (proposal):** `validate` yields `Result a (List e)` where `e` is
> whatever the steps' `Error` payloads are (must unify to one error type). Pair it
> with the named-error-ADT convention from §3.5; recommend `T.parse` / decoders
> return structured errors so they drop straight into a `validate` block.

---

## 5. Interaction with `?`, `try`, taint

- **`?` stays.** Short-circuit is the right default for *sequential* pipelines where
  step 2 needs step 1's value (you can't validate the email column of a row you
  failed to parse). Keep `?`; add `validate` for the *independent-checks* case. They
  are duals, not competitors — pick by whether the steps depend on each other.
- **`try` stays.** `try` = catch the first failure locally and match it; `validate`
  = collect all failures. Same block family, three policies (`?` propagate-first,
  `try` catch-first, `validate` collect-all).
- **Taint.** SPEC §5.3 says "validation clears taint." `validate` is the natural
  home for that clearing on a whole record at once: a `Tainted` form goes in, and
  either a fully-cleared value or the complete list of why-not comes out — taint is
  removed only on the all-`Ok` path.

---

## 6. Open questions

> **DECIDE:** error-type unification. All steps' `Error` payloads must share a type
> to accumulate into `List e`. Options: (a) require the programmer to use one error
> ADT per `validate` block (simple, recommended); (b) auto-wrap mismatched errors in
> a sum (magic, rejected); (c) allow `List (variant)` (defers the problem).

> **DECIDE:** nested `validate`. A `validate` whose step is itself a `validate`
> yields `Result a (List (List e))`. Flatten to one list (recommended) or keep
> nested (preserves grouping but complicates the type)?

> **DECIDE — future:** a `..rec` spread form for validating a record field-by-field
> against a schema without writing one line per field. Useful for decoders; defer
> until the block form is in use (rule of three).

---

**Evidence basis:** the pieces this leans on are real — `Result a e` (SPEC §3.2),
`?`/`?:`/`try` (§3.9, built), the UI `Interaction.Invalid` validation state
(styles §12.1, built), and "validation clears taint" (§5.3). The accumulation form
itself is not built; this note specifies it.
