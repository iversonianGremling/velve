# Named arguments & the unified call notation — design note

Status: **MOSTLY SHIPPED** (2026-06-09). The core of this note — named (keyword)
arguments, defaults, the `=` glyph, keyword-only `*`, and currying/saturation,
plus the `Call.named` / `Param.default_` AST changes and the infer/eval
resolution — **is implemented**. See `call-syntax-design.md` for the as-built
record (`checker/src/callresolve.ts`). **Still open:** the element side — having
UI elements desugar to named-argument constructor calls (children → `children=`,
element-as-`Call` lowering); that is the "phase 2" deferred in
call-syntax-design.md.

This built on the "call-syntax overhaul" (parens-only calls, killing function
juxtaposition — see the application-redesign track) and **revised** that track's
decision to keep space-form constructors (`Ok res`), resolving its open question
about a strict no-space rule.

---

## 1. Guiding principle

> One notation per genuinely-distinct concept. "Apply a name to arguments" is one
> concept — whether the name is a function, a data constructor, or a UI element.
> Therefore there is exactly one surface form: `Name(args…)`. Distinct *kinds*
> (call vs construct) are disambiguated by an orthogonal, always-visible cue
> (capitalization), not by a second syntax.

The thing that made elements *look* like they needed their own syntax — named
props (`size=12`) and a children block — is just **named arguments plus one piece
of sugar**. Once calls support named arguments, an element is not special.

---

## 2. The model

Every application is `Name(positional…, name=value…)`:

| Surface | Kind | Disambiguator |
|---|---|---|
| `f(a, b)` | function call | lowercase head |
| `f(a, color=blue)` | call with named args | lowercase head |
| `Ok(res)` | data constructor, positional | Uppercase head |
| `Row(size=12, color=blue)` | constructor with named args | Uppercase head |
| `Row(size=12) { …children… }` | element (constructor + children sugar) | Uppercase head + children block |

`size=12` is a **named argument**: `size` is a parameter label, `12` is the value
bound to it. It is *not* a tuple element and *not* a destructuring — there is no
tuple in the parentheses. `f((a, b))` (one tuple arg) stays distinct from
`f(a, b)` (two args) purely by the inner parens, independent of whitespace.

Precedent for "elements = named-arg constructors": Flutter/Dart widgets
(`Container(width: 100, color: Colors.blue, child: …)`), SwiftUI argument labels,
Python/Kotlin/C#/Ruby keyword arguments.

---

## 3. Surface syntax

### 3.1 Binding glyph: `=`

Named arguments use `=`:

```
Row(size=12, color=blue, on_click=close)
```

Rationale: `name=value` already means "bind name to value" in **element props**
(`prop` rule, grammar.js) and **decorator args** (`decorator_arg`, grammar.js).
Generalizing the same glyph to call sites keeps one binding notation.

**LOCKED (2026-06-09).** The language-wide invariant is:

> `=` binds a value to a name. `:` ascribes a type (and, by deliberate exception,
> labels a record-literal field). Nothing else uses `:`.

So `=` is used by: `let`/assignment, named arguments, element props, decorator
args. `:` is used by: type annotations and record-literal fields **only**. This
means a named-arg call `Row(size=12)` and a record `#{ size: 12 }` differ by `=`
vs `:` — intentional, and the record-field `:` is the one conscious sacrifice
(a record field is value-binding but reuses the type glyph; everywhere else
value-binding is `=`). `==` remains equality.

### 3.2 Ordering: positional first, then named

```
f(a, b, color=blue)        -- OK: positional a, b; then named
f(color=blue, a)           -- ERROR: positional arg after a named arg
```

Python's rule. Eliminates "which param does this positional fill?" ambiguity once
any name appears.

### 3.3 Bare flags

A bare identifier in argument position is sugar for `name=true`, valid only when
the parameter's type is `Bool`:

```
Button(label="Save", disabled)     ≡  Button(label="Save", disabled=true)
```

### 3.4 Children block → `children=` argument

An indented block (or `{ … }`) after an Uppercase call is sugar for a `children`
named argument holding the list of child elements:

```
Row(size=12, color=blue)
  Text("hello")
  Text("world")
```

desugars to

```
Row(size=12, color=blue, children=[Text("hello"), Text("world")])
```

The receiving constructor must declare a parameter `children: List(Element)` (or
compatible). `key=`/`id=` auto-injection on keyed children (current lower.ts
behavior, ~line 1216) is preserved by operating on the desugared `children` list.

> **Open:** is the children parameter name fixed (`children`), or may a component
> opt a different param to receive the block (e.g. Flutter's `child` vs
> `children`)? Recommendation: fixed `children: List(Element)`; single-child
> components take a 1-element list.

---

## 4. Type model

A function/constructor signature is an ordered list of parameters, each with a
name, a type, and an optional default:

```
def Row(size: Number = 0, color: Color = black, children: List(Element) = []): Element
```

Call resolution for `head(pos…, name=val…)`:

1. Bind positional args to params left-to-right.
2. Bind each named arg to the param of that name.
3. Error if a param is bound twice (positional + named collision, or duplicate
   named).
4. Error on a named arg whose name is not a parameter: `no parameter 'X' on 'head'`.
5. For each unbound param: use its default if present; else error
   `missing required argument 'X'`.
6. Type-check each bound value against its parameter's declared type.

Named arguments are an **alternate call syntax over the same signature** — every
`def f(a: T, b: U)` is callable `f(1, 2)`, `f(a=1, b=2)`, or `f(1, b=2)`. No
separate "keyword-only" declaration is required for v1 (every parameter name is a
usable label). A future `*`-style positional/keyword split is out of scope.

Data constructors: an ADT variant with a **record payload** accepts named args
matching the record fields:

```
type Shape = Circle { radius: Number } | Rect { width: Number, height: Number }

Circle(radius=5)        -- named
Rect(width=3, height=4)
```

A variant with a positional payload (`Ok(res)`) takes positional args as today.

### 4.1 Currying, defaults, and saturation

Velve already has currying / partial / over-application (`add(1)`, `add(1)(2)`).
Named arguments and defaults interact with it. The rules:

1. **Saturation.** A call *runs* when every **required** (non-default) parameter is
   bound. At that instant, any still-unbound **optional** (default-bearing)
   parameter takes its default. Until saturation the call is a **partial
   application** — it returns a function awaiting the remaining *required*
   parameters.
2. **Currying is over required params only.** For `def add(a, b)`, `add(1)` →
   partial fn awaiting `b`; `add(1)(2)` saturates and runs.
3. **Named partial application may bind out of order;** later positional args fill
   the remaining *unbound* params left-to-right. `f(c=3)(1, 2)` binds `c`, then
   `a`, `b`.
4. **Double-binding is an error** — a param bound twice, whether positional+named
   or across two curry steps (`add(1)(a=2)`).
5. **A function value is named without parens** (`add`); invocation always uses
   parens. `add()` invokes a zero-parameter function; `add` is the function value.
6. **Defaults resolve at saturation, not per partial step** — a default is never
   "half-applied," which avoids OCaml's "optional erased only when a positional
   follows" ambiguity. The trade: once required params are all bound the call has
   run, so you cannot partially apply and *later* override a default that
   saturation already filled.

**Why this matters for elements.** `Row(size=12)` must *render*, not return a
partial function waiting for `color`/`children`. Because every parameter of `Row`
has a default (`size=0, color=black, children=[]`), it has **zero required
params**, so `Row(size=12)` is immediately saturated → renders, with `color` and
`children` defaulted. The children-block sugar (§3.4) simply binds the `children`
param before saturation. This is the load-bearing reason elements need defaults
on (essentially) every prop.

---

## 5. What this replaces

- **Element syntax as a distinct grammar category** → gone. Elements lower to
  `Call` with named args + a `children=` arg. The `Element` AST node may be kept
  as a *parse* convenience (the children-block grammar is nice) but **lowering
  rewrites it to `Call`**, so `infer.ts`/`eval.ts` only ever see named-arg calls.
- **Space-form constructors (`Ok res`)** from the application-redesign track →
  superseded by `Ok(res)` (uniform parens). The reason space-form was proposed
  (elements need space+props) no longer holds: named args cover it.
- **The strict no-space `f(x)` rule** → unnecessary. With juxtaposition gone for
  *all* heads, `f (x)` can only be a call; allow optional space and let
  `velve fmt` canonicalize. Whitespace is never semantically load-bearing.

---

## 6. Implementation plan

Concrete touch-points (file references are current as of 2026-06-09):

### 6.1 AST (`checker/src/ast.ts`)
- Extend `Call`: add `named: { name: string; value: Expr }[]` alongside the
  existing positional `args: Expr[]`. (`Call` is at ~line 48.)
- `Param` (~line 113) gains an optional `default_: Expr | null` for defaults.
- Keep `Element`/`Prop` as parse nodes, or delete after lowering rewrites them —
  implementer's call. If kept, they become lower-only.

### 6.2 Grammar (`grammar.js`)
- Extend the call-argument list (the paren arg-list introduced by the
  application-redesign parens-only work) to accept, after zero+ positional args,
  zero+ `named_arg`: `seq($.lower_id, '=', $._expr)`. Reuse/rename the existing
  `prop`/`decorator_arg` shape (`prop` at ~line 1518, `decorator_arg` at ~577).
- Bare-flag and `...spread` forms already exist on `prop`; fold them into the
  shared `named_arg` so calls and elements share one rule.
- Children block (`children_block`, ~line 1536) stays; it now attaches to any
  Uppercase call.

### 6.3 Lowering (`checker/src/lower.ts`)
- Call lowering (~lines 919–943): split arg nodes into positional vs `named_arg`;
  emit `Call { fn, args, named }`.
- `lowerElement` (~line 1261): rewrite to a `Call` — name → `fn` (Var), props →
  `named`, positional content → first positional arg, children → a synthetic
  `named` entry `children = List[…]`. Preserve the keyed-child `key`/`id`
  injection (~line 1216) against the desugared list.
- Function signatures: parse `= default` in params into `Param.default_`.

### 6.4 Inference (`checker/src/infer.ts`)
- At `Call` inference: implement the §4 resolution (positional + named binding,
  duplicate/unknown/missing diagnostics, per-arg type-check). This is the bulk of
  the work. Constructors (Uppercase heads resolving to ADT variants / element
  components) reuse the same path against the variant's record fields.

### 6.5 Evaluation (`checker/src/eval.ts`)
- `applyFn`: accept named args; assemble the final positional vector by slotting
  named values into their parameter positions. Implement the §4.1 saturation rule:
  track which params are bound across curry steps; run when all *required* params
  are bound, filling unbound optionals with their defaults at that point; otherwise
  return a partial closure carrying the bindings so far. Out-of-order named binds
  plus later positional fills (§4.1.3) and double-bind errors (§4.1.4) live here.
  Existing positional currying/partial/over-application must keep working.

### 6.6 Migration / codemod
- A codemod over the 81+ `.velve` fixtures + corpus: rewrite element/prop and
  any space-constructor sites to the unified `Name(named=…)` form, and
  `Ok res` → `Ok(res)`. Coordinate with the application-redesign codemod
  (`checker/scripts/parens_codemod.mjs` per project notes) — ideally one pass.
- `test/corpus/*.txt` are **parse** tests: update expected trees for the new call
  arg-list and the (possibly removed) element node.

---

## 7. Decisions

**Locked**
- One notation: `Name(positional…, name=value…)`; lowercase = call, Uppercase =
  construct; capitalization is the only call/construct cue.
- Named args use `=`; positional-before-named ordering; bare flag = `name=true`
  (Bool only); children block desugars to a `children=[…]` arg.
- Glyph invariant (§3.1): `=` binds values to names (let/assign/named-arg/prop/
  decorator); `:` ascribes types and labels record-literal fields, nothing else.
- `Ok(res)` uniform parens; no space-form constructors; no whitespace-significant
  call rule (formatter canonicalizes spacing).
- Records stay `#{ field: value }` with `:` — distinct from named-arg calls.
- Currying/defaults/saturation rules (§4.1): saturation = all *required* params
  bound; defaults fill at saturation; partial application waits on required only.

**Open (confirm before implementing)**
- (a) Children parameter fixed as `children` vs component-configurable.
  Recommendation: fixed `children: List(Element)`.
- (b) Keyword-only / positional-only parameter markers — deferred, out of v1.

---

## 8. Evidence basis

Honest split (see the readability/writability research track): the **consistency**
and **reduced-notation-count** arguments rest on the working-memory/chunking
findings and the "one symbol → one concept" result; the **named-args-for-UI**
pattern rests on strong precedent (Flutter, SwiftUI), not a controlled study.
There is **no** controlled evidence on `=` vs `:` or on capitalization-as-
disambiguator — treat those as defensible design rationale, and recall the
meta-lesson that stated preference does not track measured readability, so do not
relitigate the glyph choice on taste alone.
