# Unified call syntax — functions, constructors, elements

**Status:** ✅ **PHASE 1 SHIPPED (2026-06-09)** — functions + constructors unified on
`Name(positional…, name=value…)`; named args, defaults, and `*` keyword-only all live and
verified (81/81 fixtures preserved, 182/182 corpus, 79 runnable fixtures eval-clean). Design
fully locked (§6). **Phase 2 (deferred):** elements still parse via their own grammar (not yet
lowered to `Call`), and constructor *patterns* keep space form (`| Ok v ->`) — construction
already uses parens (`Ok(res)`). See "Phase boundary" below.

## Phase boundary — what shipped vs deferred

**Shipped (phase 1):** one `call` grammar rule replacing `function_call`/`paren_call`/
`qualified_call`/`adt_call` (callee = any expr; `token.immediate('(')`, plus an
`token.immediate('()')` zero-arg form so `f()`/`Inc()` beat the `unit` token / element rule);
`Call.named` + `Param.default_`/`keywordOnly`; `param_list` grammar with `*` separator;
named/default resolution in both infer (with diagnostics) and eval (currying preserved via
`callresolve.ts` + `resolveArgs`); codemod migrated 980 call sites across `.velve` + corpus.

**Deferred (phase 2):** `element`/`element_leaf`/`element_content`/`child` grammar + `Element`
AST node + `lowerElement` still exist (elements are orthogonal and unambiguous, so they kept
working untouched); folding them into `Call` with a `children=[…]` named arg is the remaining
work. Constructor *patterns* (`| Ok v ->`) also still use space form pending a pattern codemod.

## 1. The model — one notation

Every application — function call, ADT construction, UI element — is written as one form:

```
Name(positional…, name=value…)
```

**Capitalization is the *only* call/construct cue.** Lowercase head = call a function;
Uppercase head = construct a value (ADT constructor or element). There is no other
distinction — no `new`, no special element grammar, no juxtaposition.

| Surface | Head case | Means | Lowers to |
|---|---|---|---|
| `f(a, b)` | lower | function call, 2 positional | `Call{fn:Var f, args:[a,b], named:[]}` |
| `clamp(x, lo=0, hi=1)` | lower | call, 1 positional + 2 named | `Call{fn:Var clamp, args:[x], named:[lo=0,hi=1]}` |
| `Ok(res)` | Upper | construct ADT variant, 1 positional | `Call{fn:Var Ok, args:[res], named:[]}` |
| `Point(x=1, y=2)` | Upper | construct record-payload variant by field | `Call{fn:Var Point, args:[], named:[x=1,y=2]}` |
| `Row(size=12, color=blue)` | Upper | construct element, named props | `Call{fn:Var Row, args:[], named:[size=12,color=blue]}` |
| `Column(gap=8)` + indented children | Upper | element with children block | `Call{… named:[gap=8, children=[…]]}` |

There is exactly **one** AST node (`Call`) for all four rows. `Element` ceases to exist as
a node and as a grammar category.

### Why this drops the strict no-space rule

The earlier plan needed `token.immediate('(')` (no space before `(`) to keep `f(a,b)` from
colliding with juxtaposition `f` applied to a tuple `(a,b)`. **Once juxtaposition application
is removed, that collision is gone** — an expression followed by `(…)` can only ever be a
call, because nothing else attaches args to a callee. So `f(a, b)` and `f (a, b)` are both
unambiguously the same call. We keep the no-space form as the idiom (and `velve fmt` will
enforce it), but the *grammar* no longer needs to forbid the space. `f((a, b))` is still one
tuple argument; a bare `(a, b)` in expression position is still a tuple.

## 2. Named arguments — full specification

- **`name=value`** is a keyword argument. The `=` glyph (see §6 for `=` vs `:`). It is *not*
  a tuple, *not* destructuring, *not* a record field — it binds a value to a parameter by name.
- **Ordering:** all positional args must precede all named args. A positional after a named
  arg is a parse/resolve error (`positional argument after named argument`).
- **Keyword-only params:** a `*` separator in a *definition* (`def render(node, *, theme=Dark)`)
  forces every later parameter to be supplied by name at the call site — a positional arg can
  never fill it. Call sites are unchanged (`name=value` as usual); this only constrains them.
- **Bare-flag sugar:** a lone `name` (no `=value`) desugars to `name=true`. So
  `Button("Save", disabled)` ≡ `Button("Save", disabled=true)`. (Already how `prop` works:
  `lower.ts:1280` defaults a value-less prop to `Bool true`.)
- **Spread:** `...expr` in arg position spreads a record/list of named values (already the
  `prop` spread form, `grammar.js:1531`).
- **Children-block desugar:** an Uppercase call in statement/child position may be followed by
  an indented block; each child becomes an element of a synthesized `children=[…]` named arg.
  `children` is the chosen param name (see §6). Everything else about the element is just
  named args, so `Column gap=8 \n  Text("hi")` ≡ `Column(gap=8, children=[Text("hi")])`.

## 3. Type model — signatures, defaults, resolution

### Parameter signatures with defaults

`Param` (`ast.ts:113`) gains an optional default:

```ts
interface Param { pat: Pat; ascription: TypeRef | null; default_?: Expr; keywordOnly?: boolean; span: Span }
```

Grammar `param` (`grammar.js:633`) gains default forms:

```
param: choice(
  seq(lower_id, ':', _type, '=', _expr),   // n: Number = 0
  seq(lower_id, '=', _expr),               // n = 0  (inferred type)
  …existing forms…
)
// param-list := commaSep(choice(param, '*')). A bare `*` marks every parameter
// AFTER it keyword-only: def render(node, *, theme=Dark). Lowering sets
// keywordOnly=true on the trailing params.
```

Constructors get their parameter list from the ADT/record payload definition; element
"parameters" are the component's declared props (a component is just a function returning an
element, so this is uniform).

### Call-resolution algorithm

Given a call `head(p₁…pₖ, n₁=v₁…)` against a parameter list `params`:

1. Split args into **positional** (the `pᵢ`) and **named** (the `nⱼ=vⱼ`). Error if any
   positional follows a named arg.
2. **Bind positional** left-to-right onto the parameters *before* the `*` keyword-only
   separator. A positional arg that would land on a keyword-only parameter is an error
   (`'name' is keyword-only`).
3. **Bind named** by matching `nⱼ` to a parameter name. Diagnostics:
   - *unknown* — `nⱼ` matches no parameter → `unknown argument 'nⱼ'`.
   - *duplicate* — parameter already bound (by a positional or an earlier named) →
     `argument 'nⱼ' supplied twice`.
4. **Fill defaults** for any still-unbound parameter that has `default_`.
5. **Unbound, no default** → depends on the head:
   - **Constructor / element:** error `missing argument 'name'`.
   - **Function:** see currying rule below.
6. **Per-arg type-check:** unify each bound value's type against its parameter's `ascription`
   (this is also where compile-time refinement checks already fire — `infer.ts:1271–1293`
   folds args under param names, so dependent/refinement predicates keep working).

This single algorithm covers functions, record-payload constructors, and elements — they
differ only in where `params` comes from and in step 5's "missing" behavior.

### Currying × defaults (the resolved tension)

Velve keeps currying / partial application (`eval.ts:1277` `applyFn`). The rule that makes
defaults and currying coexist:

> **A parameter with a default does not participate in currying.** A function call is
> *complete* once every *non-default* parameter is bound; defaults fill the rest. Partial
> application fires only when the call is a pure positional prefix that leaves a *non-default*
> parameter unbound and supplies *no* named args.

Consequences (teachable, Python-like):
- `def add(a, b)` → `add(1)` is **partial** (returns a closure) — unchanged from today.
- `def add(a, b=10)` → `add(1)` is **complete**, returns `11`. Adding a default opts `b` out of currying.
- `add(a=1)` (named, missing positional `b` with no default) → error `missing argument 'b'`,
  *not* a partial — naming disables the positional-prefix currying path.

## 4. What this replaces / reverses

- **Elements stop being a grammar category.** Delete `element`, `element_leaf`,
  `element_content`, `child` (`grammar.js:1495–1551`); keep only the indented `children_block`
  as call-trailing sugar. Delete the `Element` AST node (`ast.ts:67`) and `lowerElement`
  (`lower.ts:1261`); elements lower to `Call`.
- **Reverses the space-constructor decision.** `Ok(res)`, `Push(10)` — uniform parens, no
  more `Ok res`. Pattern arms become `| Ok(v) ->`.
- **Drops the strict no-space rule** (§1) — unnecessary once juxtaposition is gone.
- **Removes all four juxtaposition call rules** — `function_call` (`grammar.js:1283`),
  `paren_call` (1290), `qualified_call` (1296), `adt_call` (1129) — replaced by one postfix
  `call` rule. The `lowerCallArgs` tuple-unwrap hack (`lower.ts:1289`, which exists *only*
  because `f(a,b)` currently parses as "f applied to tuple (a,b)") is deleted.

## 5. Implementation plan — concrete touch-points

1. **`ast.ts`**
   - `Call` (line 48): add `named: { name: string; value: Expr }[]` (reuse the `Prop` shape,
     line 90).
   - `Param` (line 113): add `default_?: Expr`.
   - Delete `Element` (line 67) and `Prop` once elements are gone (or keep `Prop` as the
     named-arg record type — likely keep and rename to `NamedArg`).
2. **`grammar.js`**
   - New shared `named_arg` rule, generalized from `decorator_arg` (line 577, `lower_id '=' _expr`)
     and `prop` (line 1518). One rule used by calls, decorators, and the children sugar.
   - New postfix `call`: `seq(callee, '(', commaSep(choice($._expr, $.named_arg)), ')')` with
     `callee ∈ {lower_id, upper_id, qualified, grouped(IIFE)}`. Remove the four juxtaposition
     rules.
   - `param` (line 633): add the two default forms (§3).
   - Reduce element grammar to the `children_block` trailing sugar on an Uppercase call.
   - Regenerate parser; update `test/corpus/`.
3. **`lower.ts`**
   - In the call cases (lines 916–945, currently four), split children into positional vs
     `named_arg`; populate `Call.args` and `Call.named`. Delete `lowerCallArgs` tuple hack
     (line 1289).
   - Rewrite `lowerElement` (line 1261) → emit `Call{fn:Var(name), args:[content?], named:
     props ++ (children ? [children=List[…]] : [])}`. `lowerProp` (line 1274) becomes
     `lowerNamedArg` (its bare-flag→true logic is already correct).
4. **`infer.ts`**
   - `Call` cases (lines 325, 1262): implement the resolution algorithm (§3) — positional then
     named binding, the three diagnostics, default-fill, per-arg unify. Keep the existing
     refinement arg-folding (1271–1293) but key it off resolved parameter binding rather than
     positional index.
5. **`eval.ts`**
   - `Call` eval (line 665): resolve `named` into positional slots *before* `applyFn`, using
     the callee's parameter order + defaults; then call `applyFn` with the fully positional
     arg vector so currying (lines 1288–1318) is untouched. Element/constructor heads resolve
     to builtins/`VFn` returning the value.
   - Remove `Element` eval (line 1044); element builtins (`Column`, `Text`, …) become ordinary
     builtins accepting the slotted args.
6. **Codemod coordination** — `checker/scripts/parens_codemod.mjs` already converts the four
   juxtaposition call forms to parens. Extend it: (a) **now also convert `adt_call`** (the
   space-constructor reversal — earlier it skipped them), and (b) rewrite element syntax
   `Name prop=val \n children` → `Name(prop=val, children=[…])`. Run it against the *current*
   grammar (before removing the rules) over all 81 fixtures + corpus, then do the grammar/
   checker swap.

## 6. Decisions table

| # | Decision | Status | Choice / rationale |
|---|---|---|---|
| 1 | One notation `Name(pos…, name=value…)` | **locked** | — |
| 2 | Capitalization = sole call/construct cue | **locked** | — |
| 3 | Elements lower to `Call`; no element grammar | **locked** | — |
| 4 | Uniform parens for constructors (`Ok(res)`) | **locked** | reverses space-ctor |
| 5 | Drop strict no-space rule | **locked** | unneeded once juxtaposition is gone (§1) |
| 6 | Positional-before-named ordering | **locked** | — |
| 7 | Bare flag `x` ≡ `x=true` | **locked** | matches current `prop` |
| 8 | Defaults opt out of currying (§3) | **locked-by-rationale** | only coherent rule; Python-like |
| 9 | Named-arg glyph | **locked: `=`** | `prop`+`decorator_arg` already use it; `:` stays record-field/ascription, keeping "bind arg" visually distinct from "record field" |
| 10 | Children param name | **locked: `children`** | React/Flutter precedent |
| 11 | Keyword-only marker | **locked: add `*` now** | `def render(node, *, theme=Dark)` — params after `*` must be named at the call site; positional binding skips them |

## 7. Evidence basis (honest)

- **Consistency / reduced notation** (one form, capitalization cue): rests on working-memory
  load and one-symbol-one-concept findings — reasonably supported.
- **Named arguments for UI** (`Row(size=12, color=blue)`): rests on Flutter/SwiftUI precedent
  and practitioner consensus, **not** a controlled study. Strong prior, not proof.
- **`=` vs `:` glyph** (decision 9): **no evidence either way.** Decide on internal-consistency
  rationale (above) and do not relitigate on taste.
