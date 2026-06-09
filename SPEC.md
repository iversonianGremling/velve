# Velve Language Specification v0.5
> Working title: placeholder

---

## 0. What this spec does NOT cover yet

- SSR/hydration
- Complex physics animations
- WASM compilation details
- Package registry design
- Native target platform specifics
- Runtime memory implementation details
- LSP and dev tooling internals
- Module versioning
- Type checker implementation (grammar complete, checker pending)

---

## 1. Core Design Principles

1. **Minimal surface, maximal inference** — the compiler knows more than you write
2. **Errors are loud and early** — compile-time over runtime, always
3. **Security is structural** — injection prevention is the type system, not a library
4. **Local by default** — state, scope, and effects are contained unless explicitly exported
5. **No magic** — every behaviour has an explicit, findable cause
6. **Boring tooling** — one binary, one command per task, no configuration required for standard use
7. **Effects are honest** — every side effect is declared in the type signature

---

## 2. Type System

### 2.1 Primitive types

```
Number    -- unified numeric type, compiler picks Int/Float internally
String    -- UTF-8, immutable
Bool      -- true | false
Char      -- Unicode scalar value
Bytes     -- raw byte sequence
()        -- unit type, the empty value
```

### 2.2 Composite types

```
-- Records
{ name: String, age: Number }

-- Tuples (two or more elements)
(Number, String)
(Number, String, Bool)

-- Lists (homogeneous, immutable)
List(Number)
List({ name: String })

-- Result (the only absent-value type)
Result a e = Ok a | Error e
```

There is no `Maybe` type. Absence is always a named failure:

```
-- Dictionary lookup
get : Key -> Dict Key a -> Result a String

-- Optional fields
{ nickname: Result String String }
-- Error "field missing" if absent
```

### 2.3 Algebraic Data Types

```
type Shape
  = Circle   { radius: Number }
  | Rect     { width: Number, height: Number }
  | Triangle { base: Number, height: Number }

def area(shape: Shape): Number
  match shape
    | Circle   { radius }        -> 3.14159 * radius ^ 2
    | Rect     { width, height } -> width * height
    | Triangle { base, height }  -> 0.5 * base * height
-- exhaustiveness enforced at compile time
```

### 2.4 Atom literals

Lightweight symbols for message names, status flags, and dispatch keys.
Not strings. Not enums. Just names.

```
status = :ok
status = :error
status = :pending

match status
  | :ok      -> "all good"
  | :error   -> "something failed"
  | :pending -> "in progress"
```

### 2.5 Recursive types

Recursive positions are automatically boxed by the compiler.

```
type Tree(a)
  = Leaf
  | Node { value: a, left: Tree(a), right: Tree(a) }
```

### 2.6 Refinement types

Constrained by a predicate. Literals checked at compile time (free).
Runtime values require an explicit parse at the boundary.

```
type Email    = String where matches /^[^\s@]+@[^\s@]+\.[^\s@]+$/
type Url      = String where matches /^https?:\/\/.+/
type Age      = Number where 0 <= value <= 150
type SqlParam = String where escaped
type NonZero  = Number where value != 0

-- Compile-time (literal): free
email : Email = "user@example.com"

-- Runtime: explicit parse, runs once at boundary
Email.parse : String -> Result Email String
```

**Implemented behavior.** A refinement type is *transparent to its base* — `Age`
unifies with `Number`, so it's usable anywhere `Number` is — while still carrying
its predicate. Two enforcement points:

- **Compile time, free.** A *constant* argument passed to a parameter of refinement
  type has its predicate constant-folded at check time. `birthday(200)` for
  `Age = Number where 0 <= value && value <= 150` is a check error
  (`value 200 does not satisfy refinement 'Age'`); `birthday(0 + 150)` folds to the
  boundary `150` and passes. The folder covers literals, arithmetic, comparison and
  logical operators, `!`/unary-minus, and `matches(value, "regex")`. Non-constant
  arguments (`birthday(someVar)`) are skipped — they type-check via the transparent
  base and are guarded at the runtime boundary instead.
- **Runtime, explicit.** `T.parse : Base -> Result Base String` runs the predicate
  on a dynamic value, returning `Ok(value)` or `Error(msg)`.

### 2.7 Dependent types

Types can depend on values:

```
type Vec n a       = List(a)   where length value == n
type NonEmpty a    = List(a)   where length value > 0
type InBounds n    = Number    where 0 <= value && value < n

def firstOf(xs: NonEmpty(Number)): Number      -> xs[0]
def at(xs: List(Number), i: InBounds(length xs)): Number -> xs[i]
```

**Implemented behavior.** A dependent type is a *parameterized refinement*: the
predicate of `type T p = Base where …` may reference value-parameters `p` in addition
to the subject `value`. At a use site the parameters are bound from **value
arguments** written in the type application — `InBounds(length xs)` supplies `length xs`
for `n`. (Declarations take parameters parenless, `type InBounds n`; uses apply them in
parens. A *bare* identifier argument stays a type variable, so ordinary generics like
`List(a)` are unchanged; a *compound* expression argument is a dependent value.)

Like all refinements (§2.6) a dependent type is **transparent to its base** — `InBounds(n)`
is `Number`, `NonEmpty(a)` is `List(a)` — and is checked at compile time when the call is
constant. The folder resolves each dependent argument against the call's other
arguments, so `at([10, 20, 30], 3)` is a check error (`value 3 does not satisfy
refinement 'InBounds'`: the bound `n` folds to `length [10,20,30] = 3`), and
`firstOf([])` fails (`length [] = 0` is not `> 0`). The folder additionally understands
list literals and `length`/`listLength` of a constant list. When a dependent argument
isn't constant-foldable (e.g. the list comes from a variable) the check is conservatively
skipped — the value still type-checks via the transparent base.

### 2.8 Tainted types

`Tainted a` marks values that carry external structure — data whose shape
is not controlled by this program.

Transport is not the boundary. `Bytes` from `Http.send` or `Fs.read` is clean.
Taint enters when parsing an arbitrary external structure: `Json.parse`,
`postMessage` payloads, `localStorage` reads, JS interop returns, env vars.
Decode clears it.

Taint is contagious. Validation clears it.

```
type Any
  = AString  (Tainted String)
  | ANumber  (Tainted Number)
  | ABool    (Tainted Bool)
  | AObject  (Tainted {})
  | AArray   (Tainted (List Any))
  | ANull

-- Compiler generates User.decode : Tainted Any -> Result User String
-- After Ok branch: clean User, no Tainted
```

### 2.9 Stream type

A `Stream(a)` is a store-backed channel for push-based values.
Used for LLM streaming, event feeds, async sequences.
Produced by `send Stream (Push value)`, consumed by `await`.

```
store Stream(a)
  state
    buffer : List(a) = []
    done   : Bool    = false
  messages
    Push (value: a) -> { buffer: buffer ++ [value], done }
    Done            -> { buffer, done: true }
  pub
    isDone = done
```

### 2.10 Async state

```
type Async(a)
  = Before       -- not yet started
  | During       -- in progress
  | After(a)     -- completed successfully
  | Error String -- failed
```

### 2.11 Pointer types (std/low)

For low-level code. Lifetime-annotated pointers:

```
Ptr Number        -- pointer to Number, no lifetime
Ptr ~a Number     -- pointer with lifetime ~a

buf.*             -- dereference
buf.&             -- address-of
buf.~             -- extract lifetime
```

Lifetime constraints go in the function body as the first statement:

```
def firstHalf(buf: Ptr ~a Number): Ptr Number
  where (buf.~ = result.~)
  buf[0..(buf.length / 2)].*
```

**Status (implemented).** `Ptr T`, `.&` (address-of / borrow) and `.*` (dereference)
are fully wired through the checker and interpreter:

- **Typing.** `e.&` where `e : T` has type `Ptr T`; `p.*` requires `p : Ptr T` and
  yields `T` (dereferencing a non-pointer is a type error).
- **Runtime.** A pointer to a binding *aliases* it: `let p = x.&; p.*` reads the
  current value of `x`, and a write through `p` (`p.* = v`) is observable at `x`. The
  same applies to **aggregates**: `xs[i].&` (list), `d[k].&` (dict), `s[i].&` (string
  char), and `rec.f.&` (record field) all alias the element in place (the container is
  held by reference), so `p.* = v` mutates the original. Direct `xs[i] = v` / `d[k] = v`
  / `s[i] = "c"` writes go through the same path (`d[k] = v` inserts if absent; a string
  char-write rebuilds the buffer). An address of a non-lvalue (`(1 + 2).&`) snapshots
  into a private cell. Indexing is type-directed: `d[k]` keys a `Dict(K,V)` by `K`→`V`,
  `s[i]` yields a one-char `String`, `xs[i]` a `List(El)` element.
- **Lifetimes / regions (borrow checker, §6.1).** Each pointer is labelled with the
  region it points into. `.&` always borrows *this frame's* storage, so returning
  `local.&` **or** `param.&` (directly or via `let p = …; p`) is rejected as a
  dangling pointer. A pointer **parameter** (`buf: Ptr ~a T`) is caller-owned, so
  returning it (pass-through) is fine — and if its lifetime `~a` differs from the one
  the signature promises (`: Ptr ~x T`), that mismatch is reported:

  ```
  def pick(a: Ptr ~x T, b: Ptr ~x T, c: Bool): Ptr ~x T  -- ok: both ~x
    c ? a : b
  def bad(a: Ptr ~x T, b: Ptr ~y T, c: Bool): Ptr ~x T   -- error on `b`: ~y ≠ ~x
    c ? a : b
  ```

  Dropping a value while a live pointer still borrows it (`drop x` after
  `let p = x.&`) is also rejected. A pointer into an aggregate borrows its **container**,
  so `xs[i].&` into a local `xs` dangles if returned, and `drop xs` while it is borrowed
  is rejected — exactly as for `xs.&`.

Region labelling handles the param/local distinction, explicit-lifetime matching, and
`where (~a >= ~b)` / `(~a = ~b)` / `buf.~` outlives constraints (§6.1).

**Slice-extraction (implemented).** A *range index* `buf[lo..hi]` (`..` exclusive, `..=`
inclusive) extracts a sub-region of the same container:

- **Typing.** `xs[lo..hi]` yields the container type unchanged — `List(T)→List(T)`,
  `String→String`, `Ptr T→Ptr T`. (The slice is recognised syntactically: the index must
  be a literal range, not a range *value* bound to a name.)
- **Runtime.** A `List`/`String` slice is a value **copy** of the sub-range. A **pointer**
  slice is an aliasing **view**: reading it reads the parent's sub-range live, and writing
  it (`slice.* = newRegion`) splices straight back into the parent buffer — so the slice
  genuinely shares the parent's storage.
- **Lifetimes (borrow checker, §6.1).** Because a pointer slice borrows the parent's
  storage, it carries the parent's region. A slice of a pointer **parameter**
  (`buf: Ptr ~a List(T)`) lives in the caller, so it is returnable under
  `where (buf.~ = result.~)`; a slice of a pointer into a **local** dangles if returned
  (rejected), exactly as `local.&` would. A plain `List`/`String` slice is a value copy,
  so it never dangles.

```
def firstHalf(buf: Ptr ~a List(Number)): Ptr ~a List(Number)
  where (buf.~ = result.~)
  buf[0..3]                 -- sub-region pointer; lifetime ~a survives the return
```

This was the last notional piece of the ownership system; it is now end-to-end. (Pointers
here are modelled as `Ptr List(T)` — a pointer to a buffer — rather than C-style
array-pointers with `Ptr T`/`buf.length` arithmetic, which the runtime does not model.)

---

## 3. Syntax

### 3.1 Naming conventions

```
Types, Elements    -- Capitalized:  User, Report, Column, Text
Modules            -- lowercase:    http, parallel, gpu
Functions          -- lowercase:    deleteReport, updateStatus
Bindings           -- lowercase:    report, user, items
Fields             -- lowercase:    name, age, status
Atom literals      -- colon-lower:  :ok, :error, :pending
```

### 3.2 Three core symbols

**`:`** — here comes a type:
```
items : List(Report)
def foo(): Number
{ name: String }
```

**`->`** — here comes code:
```
| Ok x   -> process x     -- match branch body
fn x     -> x * 2         -- lambda body
def foo(): Number -> 42   -- single-line function
:idle    -> ()             -- saga terminal step
```

**`|`** — here comes a branch:
```
| Ok x   ->    -- match case
| ->           -- catchall
| ()           -- nothing case
```

### 3.3 Bindings

```
-- Immutable (default)
x = 5
const x = 5          -- explicit immutable
let x = 5            -- block-scoped immutable

-- Mutable
mut x = 5
let mut x = 5        -- block-scoped mutable

-- With type annotation
x : Number = 5
```

### 3.4 Functions

```
-- Block form
def deleteReport(id: Number): Effect [network] Result () String
  netDelete("/admin/reports/{id}")

-- Single-line form
def double(x: Number): Number -> x * 2

-- No params
def greeting(): String -> "hello"

-- Type signature only (multi-clause declaration)
def describe(Atom, Number): String
```

**Calling functions and constructors — paren form.** A call applies a name to a
parenthesized argument list: `f(x)`, `f(x, y)`, `Ok(v)`, `Error(msg)`. This one form
covers functions *and* data constructors. Two consequences worth stating:

- **Constructors in expression position need the parens.** Write `Ok(x)`, not `Ok x`.
  A capitalized name followed by a space-separated value (`Ok x`) parses as a UI
  *element*, not a constructor call, so it will not type-check as a `Result`.
- **Space juxtaposition is reserved.** `add 1 2` works only as currying/saturation of
  an already-curried function (equivalent to `add(1)(2)`); and at the *type* level,
  juxtaposition is how type application is written — `List Number`, `Result a e`,
  `Async a` (the paren forms `List(Number)`, `Result(a, e)`, `Async(a)` are also
  accepted). For ordinary calls, prefer `f(x)`.

Module-qualified calls (`Math.sqrt(x)`) do **not** resolve yet — import the name
(`import { sqrt } from "Math"`) and call it unqualified. See §14.

**Multi-clause function heads** — pattern dispatch without match:

```
def describe(:circle, r: Number): String -> "circle r={r}"
def describe(:rect, w: Number, h: Number): String -> "rect {w}x{h}"
def describe(:triangle, b: Number, h: Number): String -> "triangle b={b} h={h}"

def fib(0): Number -> 0
def fib(1): Number -> 1
def fib(n: Number): Number -> fib(n - 1) + fib(n - 2)
```

Pattern params: atom literals (`:name`), type patterns (`Rect`), wildcard (`_`),
typed (`r: Number`), and constant literals (`0`, `true`) for dispatch on a value.

**Generic constraints** in body via `where`:

```
def sort(items: List(a)): List(a)
  where a: Comparable
  items |> sortBy identity
```

> ⚠ **Not yet enforced (as of edition 2026.1).** The `where a: Constraint` clause
> parses but is currently a no-op — *any* constraint name is accepted, including
> undeclared ones, and nothing is checked against it. Velve has **no typeclass /
> trait system** today, so there is no `Comparable`/`Interpolate` set to satisfy.
> What the built-ins actually require:
> - **Comparison & equality** (`== != < > <= >=`) type as `(a, a) -> Bool` for any
>   *matching* `a` — operands must unify, but `a` is otherwise unconstrained (you can
>   structurally compare records or functions; there is no orderability check).
> - **`toString` / string interpolation** type as `∀a. a -> String` — fully
>   polymorphic, no `Show`/`Interpolate` bound.
>
> The clause is kept as forward-compatible *documentation of intent*; a real
> constraint solver is a deferred build. Until then, treat `where a: X` as a comment.

### 3.5 Pattern matching

```
match report.status
  | :resolved -> Text "Resolved"
  | :ignored  -> Text "Ignored"
  | ->           Text "Pending"
```

**Multi-pattern branches:**
```
match event
  | Click _ | KeyDown _ | KeyUp _ -> true
  | Scroll _ | Resize _           -> false
```

**As-binding** — bind whole value AND destructure:
```
match result
  | Ok response { value, rest } -> process(value, rest)
  | Error msg                   -> Error(msg)
```

**Guard patterns:**
```
match x
  | n if n > 0 -> "positive"
  | 0          -> "zero"
  | ->           "negative"
```

**If-pattern** — pattern match as condition:
```
if getUser = Ok x
  showProfile x
else
  showLogin
```

### 3.6 Lambdas

`fn` is dropped after `|>` — the pipe implies a lambda:

```
items |> map report -> report.id
items |> filter report -> report.status == :resolved
```

Full lambda form:
```
fn x -> x * 2
fn (a b c) -> a + b + c    -- multi-arg: space-separated names in parens
fn (a, b)  -> a + b        -- single tuple arg (commas), destructured
fn         -> "no param"

-- Multi-branch
fn
  | Ok x    -> process(x)
  | Error e -> Error(e)
```

**Currying & over-application.** A function that returns a function can be applied to
all its arguments in one expression — by repeated parens or by juxtaposition — and a
parenthesized lambda literal can be applied directly (an IIFE):

```
let add = fn a -> fn b -> a + b
add(10)(5)            -- 15
add 3 4               -- 7  (curried juxtaposition)

(fn x -> x * 2)(3)    -- 6  (IIFE)
(fn x -> x + 1) 9     -- 10
```

**Partial application.** Supplying *fewer* arguments than a function's arity returns a
closure that waits for the rest, then runs with the full set — so multi-clause dispatch is
chosen only once every argument is present:

```
def add(a: Number, b: Number): Number -> a + b
let inc = add(1)      -- a function Number -> Number
inc(10)               -- 11
add(5)(6)             -- 11  (partial, then applied)

def greet(:formal, name: String): String -> "Good day, {name}"
def greet(:casual, name: String): String -> "Hey {name}!"
let f = greet(:formal)
f("Ada")              -- "Good day, Ada"  (clause chosen when name arrives)
```

### 3.7 Pipes

`|>` threads values left to right. In effectful context: error-aware, short-circuits on `Error`:

```
Http.delete "/admin/reports/{id}"
  |> send Reports (Delete id)
  |> Ok ()
```

A `|>` may lead a continuation line (as above) or trail one — both chain across
lines. A leading `|>` is distinguished from a match-branch `|` by the scanner.

Multiline — trailing `|>` continues on next line:

```
result = items |>
  filter isValid |>
  map transform |>
  take 10
```

Leading binary operators also continue (scanner suppresses newline when next line starts with `+`, `*`, `/`, `%`, `^`, `&`, `?`):

```
total = price
  + tax
  + shipping
```

### 3.8 For expressions

A list comprehension `for (pat in iter, …clauses) -> body`. Each generator binds
with **`in`** (matching the UI keyed-list `for r in rows`, §9); a bare-`Bool` clause
is a guard; later generators may depend on earlier ones (cartesian nesting).

Range iteration + guard:
```
evens = for (x in 1..20, x % 2 == 0) -> x
```

List iteration:
```
names = for (user in users) -> user.name
```

Multiple generators with filter:
```
pairs = for (i in 0..n, j in i..n) -> (i, j)
```

Right side of `..` and output of `->` are atoms — wrap complex expressions in `()`:
```
half = for (i in 0..(n/2)) -> (i * 2)
```

> **`for (x = source)` and the `%` sigil — deprecated → removed in edition 2026.6.**
> Earlier editions wrote generators as `x = source` and marked list (vs range)
> sources with a `%` prefix (`for (user = %users)`). The `%` was always a no-op (the
> lowerer dropped it), and `=` collided visually with binding. Both are a **warning**
> in 2026.1 and an **error** in 2026.6; use `in`. (Arithmetic `%` — modulo — is
> unaffected; it was only ever the operator.) The codemod rewrites `x = src` / `x =
> %src` → `x in src`.

### 3.9 Blocks

Sequential computation. A function/branch body is an indented block; `=` binds
both pure values and effect results, and the block's value is its last line.
There is **no `do` keyword** — the indentation is the block:

```
def loadProfile(id: Number): Effect [session] AppState
  appSt   = ask Session GetState
  updated = { requestCount: appSt.requestCount + 1 }
  send Session (UpdateState updated)
  Ok updated
```

An explicit `{ ... }` block (`;`-separated items, value = last) is available
anywhere a block can appear — for a multi-statement binding RHS, or to make a
block boundary explicit. Record literals use the **`#{ … }`** opener, so the two
never collide:

```
area  = { w = 3; h = 4; w * h }    -- block  (semicolons, `=` bindings)
point = #{ x: 3, y: 4 }            -- record (`#{`, `:` fields)
```

> **Bare `{ x: 1 }` record literals — deprecated → removed in edition 2026.6.**
> Earlier editions distinguished a record from a block by *content* (`,` + `name:`
> ⇒ record; `;` / `name =` ⇒ block) — the "record-vs-block trap." From 2026.6 a
> record literal must be written `#{ … }`, and a bare `{ … }` is **always** a block.
> Bare-brace literals are a **warning** in 2026.1, an **error** in 2026.6; the codemod
> rewrites `{ k: v }` → `#{ k: v }`. (Record *types* — `{ name: Type }` in type
> position — are unambiguous and keep bare braces.)

Error propagation with `?` and `?:`:

```
def parseSeq(a: Result Parsed String, b: Result Parsed String): Result Parsed String
  r1 = a ?: Error("first parse failed")
  r2 = b ?: Error("second parse failed")
  Ok({ value: "{r1.value}{r2.value}", rest: r2.rest })
```

`?` short-circuits on failure (propagating to the enclosing function); `?:`
provides a fallback expression. To catch failure *locally* instead of propagating,
wrap steps in a `try` block (value is `Result T E`, matched in place); `retry [N]`
re-runs a `try`-style body on failure; `pipe` threads each line's result into
`ret` for the next.

### 3.10 Loop and control flow

```
def sumRange(n: Number): Number
  mut total = 0
  loop
    total = total + 1
    if total >= n
      break
  total
```

**if/else:**
```
if user.role == Admin
  Button "Admin Panel"
else
  Button "Home"
```

**Inline conditional:** `if c then a else b` — an expression (distinct from the
indented-block `if`, §3.10), right-associative so it chains as an else-if ladder:
```
report.status == :resolved ? "Resolved" : "Pending"   -- DEPRECATED (see below)
if report.status == :resolved then "Resolved" else "Pending"

if score > 90 then "A" else if score > 80 then "B" else "C"
```

> **Ternary `cond ? a : b` — deprecated → removed in edition 2026.6.** It existed
> only because there was no inline conditional, and it forced the language's one
> whitespace-keyed rule: a **spaced** `?` meant ternary, a **glued** `?` (`value?`)
> meant error-propagate. With `if…then…else` covering the inline case, the ternary is
> a **warning** in 2026.1 and an **error** in 2026.6 — at which point `?` has exactly
> one meaning (propagate), and the whitespace distinction is gone. The codemod
> rewrites `c ? a : b` → `if c then a else b`.

### 3.11 Error propagation

`?` — propagate error out of the function. The `?` is **glued** to the value
(no preceding space). (Through edition 2026.1 this also distinguished it from the
spaced ternary `?`; from 2026.6 the ternary is gone and `?` has only this meaning.)
```
x = fetchUser(id)?
```

`?:` — propagate with a specific fallback expression:
```
x = fetchUser(id) ?: Error("user not found")
x = validateAge(n) ?: Error("age out of range: {n}")
```

**`try`** — catch failure *locally* instead of propagating to the function. Inside
a `try`, **each line is implicitly checked**: a `Result` line auto-unwraps (`Ok v`
binds/yields `v`), the first `Error` collapses the whole block, and a non-`Result`
line passes through. No `?` needed. The block's value is `Result T E` (the last
line wrapped in `Ok`), matched in place — so the function may return any type:
```
def loadBalance(id: Number): String
  outcome =
    try
      u    = fetchUser(id)       -- Result → unwrapped (or collapse on Error)
      acct = fetchAccount(u)     -- Result → unwrapped
      acct.balance               -- plain value → block yields Ok(balance)
  match outcome
    | Ok b    -> "balance {b}"
    | Error e -> "unavailable: {e}"      -- caught here; function returns String
```

**`retry [N] [D]`** — run a `try`-style body; on failure, re-run, up to `N` times
(or until it succeeds if no count), sleeping the duration `D` between attempts. A
list of durations is a backoff schedule. Value is the first `Ok`, or the last
`Error` once attempts run out:
```
let conn = retry 3 200ms        -- 3 attempts, 200ms apart
  c = openSocket host           -- implicit check; no `?`
  Ok c

let r = retry [100ms, 1s, 5s]   -- backoff: 4 attempts with these delays
  fetchFlaky url

-- computed (exponential) backoff via a comprehension — useful for servers:
let conn = retry for (n in 0..5) -> (2 ^ n) * 100ms   -- 100, 200, 400, 800, 1600ms
  openSocket host
```

`Duration` (`100ms`, `30s`) is a distinct **dimension**, not a plain `Number`. It
scales by a number and adds to itself, but mixed/nonsensical operations are
rejected at compile time:

```
100ms * 3        -- Duration   (scaling)
100ms + 50ms     -- Duration   (sum)
400ms / 100ms    -- Number     (ratio)
100ms * 50ms     -- ERROR: two Durations would be time²
100ms + 5        -- ERROR: can't add a raw Number to a Duration
n * 1ms          -- Duration   (convert a Number `n` of ms into a Duration)
```

**`pipe`** — thread each line's result into `ret` for the next line; value is the
last line (the point-free `|>` chain as a block):
```
result =
  pipe
    loadItems source
    sortBy score ret
    listTake n ret
```

**`drop x`** — deterministically release `x` now (compile-time ownership; runtime
evaluates and discards). See §6 Memory Model.

### 3.12 Effects: send / ask / await

**`send`** — deliver a message to a store, fire-and-forget:
```
send Reports (Delete id)
send Analytics (Track event)
```

**`ask`** — deliver a message, bind the result:
```
result = ask Session GetState
balance = ask AccountA GetBalance
```

**`await`** — wait for next value from a stream:
```
chunk = await ResponseStream
```

With branches:
```
loop
  await ResponseStream
    | Push chunk -> send UI (Append chunk)
    | Done       -> break
```

### 3.13 Numbers and literals

```
-- Standard
42
3.14
1_000_000       -- underscore separators

-- Binary
0b1010
0b1111_0000

-- Hex
0xFF
0xDEAD_BEEF

-- Duration (for after/until)
30s
100ms
5m
1h
```

### 3.14 Strings

```
"Hello {user.name}"                    -- interpolation
"literal \{ braces \}"                  -- \{ \} are literal braces (no interpolation)
"json \{\"k\": {v}\}"                   -- escapes + interpolation: json {"k": <v>}
r"no \n escaping here"                 -- raw string
rx/^[a-z]+$/                           -- regex literal
`multiline
 string`                               -- backtick multiline
```

A bare `{` starts interpolation; write `\{` / `\}` for literal braces (so JSON-shaped
text can be written directly). Other escapes: `\n \t \r \" \\`.

### 3.15 Ranges

```
1..10       -- exclusive (1 to 9)
1..=10      -- inclusive (1 to 10)
0..(n/2)    -- complex right side requires parens
```

### 3.16 Destructuring

```
{ name, age } = user
(a, b)        = tuple
```

### 3.17 Spread

```
#{ ...baseRecord, status: :resolved }
Row ...baseProps background=#fff
  Text "hello"
```

### 3.18 Optional chaining

```
report.user?.address?.city ? "Unknown"
```

### 3.19 Type tests

```
x is Ok
value is String
```

### 3.20 Decorators

```
@deprecated
@idempotent
@kernel
@audioKernel sampleRate=44100 bufferSize=256

def myFunc(): ()
  ...
```

---

## 4. State Machines

### 4.0 State primitives — and what we refuse

The design discipline: **capture a recurring abstract idea, reduce it to its
minimal conceptual core, and ship exactly one primitive per genuinely-distinct
concept.** Every candidate primitive that turns out to be a special case of
another is refused — collapsed into a modifier or a usage pattern instead. The
goal is the smallest set of concepts that still expresses everything.

Under that discipline, Velve's irreducible state primitives are **four**:

- **`store`** — identity + mutable state; an actor mailbox. A *current value*
  others read and update via messages.
- **`machine`** — control flow expressed as named transitions. A *process with
  named stages* that runs to a result.
- **`stream`** — values over time. A *sequence* you react to as elements arrive.
- **`transaction`** — atomic multi-store coordination, with no IO, that the
  runtime can auto-rollback.

…plus **one modifier**:

- **`persisted`** — applied to a `machine`, it adds a durable journal and
  explicit compensation. A durable/compensating machine is what other systems
  call a *saga*; in Velve it is not a fifth primitive, just `machine …
  persisted`.

Two distinctions are worth stating explicitly, because they are the ones people
most often get wrong:

- **transaction vs persisted-machine.** If the runtime can undo the work for
  free — because nothing escaped the process, no external effect happened —
  reach for a **transaction**; the runtime rolls back the touched stores
  automatically. If you touched the outside world (charged a card, shipped a
  parcel, sent an email), the runtime *cannot* undo that for you, so you need
  explicit compensation: a **persisted machine** with `? rollback :step`.
- **store vs stream.** If what you want is a *current value* others read and
  update, that is a **store**. If what you want is a *sequence of values over
  time* that you react to as they arrive, that is a **stream**.

| I need… | Reach for |
|---|---|
| a current value others read & update | `store` |
| a process with named stages that returns a value | `machine` |
| …and it must survive restarts / undo external effects | `machine … persisted` |
| values arriving over time I react to | `stream` |
| several stores changed all-or-nothing, no IO | `transaction` |

### 4.1 Machine — pure state machine

No store backing. Zero allocation. Deterministic.
Compiles to a jump table. Suitable for protocols, device drivers, parsers:

```
def tcpHandshake(): ()
  machine
    :listen
      until recvSYN
        | Ok syn -> :syn_received syn
        | Timeout -> :listen

    :syn_received syn
      send SYN_ACK
      race
        go until recvACK
        after 3s
      | Ok _ -> :established
      | Timeout -> :listen

    :established -> ()
```

### 4.2 Persisted machine — machine with persistence and compensation

A **persisted machine** is a `machine` plus two capabilities: a durable journal
(survives process restarts) and **compensation** (undo external effects on
failure). It is *not* a distinct primitive — it is the `machine` primitive with
the `persisted` modifier. (Historically this was a separate `saga` keyword; see
"Deprecated `saga` keyword" below.)

The canonical top-level form is `machine Name(...): T persisted [over Store]`
(see "First-class persisted machines" below). When nested inside a function, the
machine is backed to a named store with the deprecated `saga StoreName` inline
form (the inline statement form has not yet grown a `persisted` spelling):

```
def checkout(cart: Cart): Effect [payment, inventory] Result Receipt AppError
  saga CheckoutState
    :validate
      validate cart
      | Ok clean -> :reserve clean
      | Error e  -> :abort Error "invalid: {e}"

    :reserve clean
      reserve clean
      | Ok r     ->
        r ? rollback :stock
        :charge clean.total r
      | Error _  -> :abort Error "out of stock"

    :charge total reservation
      charge total
      | Ok payment ->
        payment ?: rollback :reserve
        :fulfill reservation payment
      | Error e -> :abort Error e

    :fulfill reservation payment
      createOrder reservation payment
      | Ok order -> :done (Ok (Receipt { order }))
      | Error _  -> :abort Error "order failed"

    :done result   -> result
    :abort e       -> e
```

**Step forms:**
```
:stepname args ->               -- single-line terminal
:stepname args                  -- block form with body
  statements...
```

**Step body statements:**
```
-- Implicit match (no match keyword):
validate input
  | Ok x -> :next x
  | Error e -> :failed e

-- Step transition:
:nextStep arg1 arg2

-- Rollback registration:
action ? rollback :step        -- success path compensation
action ?: rollback :step       -- failure path recovery
```

**First-class persisted machines (top-level declarations).** A persisted machine
may also be declared at the top level with constructor inputs and a result type,
instead of being nested inside a function. The `persisted` modifier follows the
return type:

```
machine Checkout(stockOk: Bool, payOk: Bool): String persisted over CheckoutState
  :validate
    :reserve
  :reserve
    reserve stockOk
      | Ok res ->
        res ? rollback :undoStock
        :charge res
      | Error e -> :abort "reserve failed ({e})"
  ...
  :done result -> result
  :abort e     -> "ABORTED: {e}"
```

`over CheckoutState` is the optional explicit backing-store hatch; omit it and
the machine auto-backs itself with a private store named after itself.

- `Checkout(true, true)` — **call it like a function** to run to completion and
  get its result.
- `go Checkout(true, false)` — **spawn a live instance**, yielding a *machine handle*.

The handle exposes **per-instance** state (so concurrent instances of the same
machine no longer share one store-keyed journal):

```
let h = go Checkout(true, false)
let r = await h        -- the machine's result
h.status               -- :running | :done | :aborted
h.step                 -- the current/last step atom
h.journal              -- List Atom — the transition history
```

`over StoreName` names an explicit backing store; omitted, the machine is
auto-backed by a store named after itself. `journalOf "StoreName"` still reads
the most recent run's journal for the named store.

**Crash recovery (`resume`).** The journal is a durable log of both step
transitions *and* registered compensations. `crash(msg)` aborts a running
instance mid-flight, but its journal survives — so a `resume` re-hydrates the
instance from that log:

```
let h = go Shipping(true)      -- crashes in :label
await h                        -- h.status == :crashed, h.journal == [:pack, :label]

resume Shipping(false)         -- re-hydrate from the journal and continue
```

`resume Machine(args)`:
- rebuilds the compensation stack from the journal's recorded `? rollback`
  registrations (so a compensation registered *before* the crash still fires if
  the resumed run aborts),
- resumes at the last recorded step — **already-completed steps are not
  re-run** (their side effects happened once),
- re-runs only the crash-point step (at-least-once there), then continues to
  completion and returns the result.

Constructor inputs are re-supplied to `resume` (they are not persisted), which
also lets recovery vary behaviour (e.g. take a fallback path the second time).

**Deprecated `saga` keyword.** Persisted machines were originally written with a
dedicated `saga` keyword. That keyword is now a **deprecated alias** that lowers
to exactly the same construct and emits a compiler/LSP warning:

```
-- deprecated — emits: `saga` is deprecated; write `machine … persisted over Store`.
saga Checkout(stockOk: Bool, payOk: Bool): String
  over CheckoutState
  :validate
    :reserve
  ...
```

is equivalent to the canonical:

```
machine Checkout(stockOk: Bool, payOk: Bool): String persisted over CheckoutState
  :validate
    :reserve
  ...
```

Both parse to the same AST; runtime behaviour is identical. New code should use
`machine … persisted`.

### 4.3 Concurrency in state machines

**Parallel go** — launch concurrent tasks, join at `|` branches:
```
:fetch
  go ask Shipping (Estimate order)
  go ask Loyalty  (Calculate user order)
  | (Ok eta, Ok pts)  -> :done eta pts
  | (Ok eta, Error _) -> :done eta 0
  | _                 -> :abort Error "fetch failed"
```

**Race** — first wins:
```
:charge
  race
    go ask Payment (Charge amount)
    after 30s
    until ask Order IsCancelled
  | Ok receipt -> :done receipt
  | Timeout    -> :retry
  | Cancelled  -> :abort Error "cancelled"
```

**Standalone go** (fire-and-forget):
```
go send Analytics (Track event)
```

**Await** in machine steps:
```
:idle
  await EventStream
    | Push e -> :handle e
    | Done   -> :shutdown
```

> **Implementation note.** `await Stream` with *value* branches works everywhere,
> including the `loop`/`break` consumer form (§10.3). The variant above — `await` whose
> branches are *step-goto targets* (`:handle e`) — does not yet parse inside a `machine`
> step (the await-branch grammar doesn't admit step gotos, the same gap as if/match in
> early machine steps). Use the loop+await consumer form to drain a stream for now.

### 4.4 Rollback semantics

`expr ? rollback :step` — registers compensation on the success path.
If anything downstream calls `:abort`, compensations run in reverse order.
The saga store tracks registered compensations.

`expr ?: rollback :step` — explicit failure path: run this and go to `:step`.

`machine` has no `rollback` — no store to track compensations.
Use explicit error steps instead.

---

## 5. Effects and Capabilities

### 5.1 Effects in the type system

```
-- Fallible effects
getUsers  : Token -> Effect [network] Result (List User) String
openFile  : Path  -> Effect [fs]      Result Bytes String

-- Infallible effects
render    : Element -> Effect [render] ()
send      : Store -> Message -> Effect [pure] ()
```

Effects compose — capability sets merge:

```
loadAndCache : Token -> Effect [network, storage] Result (List User) String
```

### 5.2 Capability declarations

```
module Dashboard
  capabilities: [render, network]
```

### 5.3 I/O model

Transport and trust are separate concerns.

`Http.send` and `Fs.read` return clean `Bytes` — raw data you requested.
Taint enters at `Json.parse`, because JSON is an arbitrary external structure.
`T.decode` clears taint and is the only way to get a typed value out.

This means the same decoder works for every source:

```
-- User.decode is the same artifact regardless of where the data came from
user_from_api  = Http.get "/users/1" |> Http.send |> Json.parse |> User.decode?
user_from_file = Fs.read "user.json" |> Json.parse |> User.decode?
```

The pipeline reads as a story. Each stage does one thing. `?` propagates
failure without nesting. Convenience combiners collapse the common case:

```
-- Complete response
user   = Http.get "/users/1" |> Http.json User.decode?
config = Fs.json Config.decode "config.json"?

-- Streaming: Http.stream carries the decoder, returns Stream a not Stream String
tokens = Http.post "/llm/complete"
  |> Http.body (Json.encode prompt)
  |> Http.stream Token.decode     -- Stream Token

-- File streaming: lines are already clean, compose with map for structure
Fs.lines "access.log"
  |> Stream.map LogEntry.parse
  |> Stream.filter Result.isOk
```

`Http.json decoder` is exactly `Http.send |> Json.parse |> decoder`. Named
for readability, not for magic — the full pipeline is always available.

### 5.4 Available capabilities

```
render      -- produce UI elements
network     -- HTTP requests
storage     -- localStorage, IndexedDB
popup       -- browser popups
redirect    -- URL navigation
postMessage -- cross-origin messages
clipboard   -- clipboard read/write
camera      -- camera/microphone
geolocation -- location
fs          -- filesystem (native only)
memory      -- raw memory (std/low only)
process     -- spawn processes (std/process only)
audio       -- real-time audio (std/audio only)
pure        -- no effects (default)
```

---

## 6. Memory Model

### 6.1 Ownership

- All values are owned
- Immutable values: freely cloneable
- Mutable values: single owner, temporary borrows via function arguments
- Compiled mode: deterministic drop at end of scope, no GC
- Interpreter mode: GC-managed

#### Borrow checker

A flow-sensitive pass enforces ownership at compile time. Implemented checks:

| Check | Example | Diagnostic |
|---|---|---|
| use-after-drop | `drop x` … `x` | `use of 'x' after it was dropped` |
| double-drop | `drop x; drop x` | `'x' is dropped more than once` |
| drop-in-loop | `loop` … `drop x` (outer `x`) | `'x' is dropped inside a loop — …` |
| dangling return (local) | `def f(): Ptr T … local.&` | `returns a pointer to local '…', which does not live past the function` |
| dangling return (param) | `def f(n: Number): Ptr Number … n.&` | `returns a pointer into the frame via 'n.&'; the borrow does not live past the function` |
| lifetime mismatch | return `b: Ptr ~y` for `Ptr ~x` result with no `~y >= ~x` | `lifetime mismatch: result is declared '~x' but the returned pointer has lifetime '~y', which is not known to outlive it` |
| drop-while-borrowed | `let p = x.&; drop x` | `cannot drop 'x': it is still borrowed by 'p'` |
| use-after-move | `mut xs = [1,2,3]; let ys = xs; xs` | `use of 'xs' after it was moved` |
| drop-after-move | `mut xs = [1,2,3]; let ys = xs; drop xs` | `cannot drop 'xs': it was already moved` |

Branches (`if`/`match`/`await`) merge by union — a value consumed (dropped **or**
moved) on *any* path is consumed afterward. Re-binding a name (`let x = …`) revives it.

**Moves.** A `mut` binding of an *affine* type is a single-owner resource: rebinding it
to a new owner (`let y = x`) **moves** it, consuming the source. Whether a type is affine
is **type-driven**: heap-backed buffers (`String`, `List`/`Dict`/ADTs) and live resources
(`Stream`, `Async`) move; **Copy** scalars (`Number`, `Bool`, `Unit`) and atoms clone, so
`mut n = 0; let m = n; n + m` is fine. Tuples/records are Copy iff every component is.
Immutable `let`/`const` values are freely cloneable regardless of type, so aliasing them
never moves; and passing a value as a function *argument* is a borrow, not a move.
(Move detection consults inferred types via `isCopy`; unresolved/unknown types are treated
as Copy so the checker never invents a move it cannot justify.)

**Pointer borrows** (§2.11) carry a **region label**: `.&` borrows frame storage (a
local or a by-value param) and may not escape; a pointer *parameter* is caller-owned
and may be returned, subject to its lifetime *outliving* the result's. **Outlives
constraints** are solved: a `where (~y >= ~x)` clause (or `~x = ~y`, or `b.~ >= ~x`
naming a binding's lifetime) lets a longer-lived pointer satisfy a shorter declared
result. The relation is reflexive and transitively closed, so `where (~z >= ~y),
(~y >= ~x)` admits returning a `~z` pointer for a `~x` result. A return is rejected
only when the returned region is **not known** to outlive the declared one.

```
def pick(a: Ptr ~x T, b: Ptr ~y T): Ptr ~x T where (~y >= ~x)
  cond ? a : b        -- both arms OK: ~x is reflexive, ~y outlives ~x by the clause
```

### 6.2 Mutation

```
mut x = 5
x = x + 1    -- fine

x = 5
x = x + 1    -- COMPILE ERROR: x is immutable
```

---

## 7. Module System

### 7.1 Plain modules

Static namespace. Zero runtime cost. No mutable state:

```
module geometry
  const export pi = 3.14159

  def export circleArea(r: Number): Number -> pi * r ^ 2
```

### 7.2 Stores

Owns mutable state. Three explicit sections:

```
store Session
  state
    token : Result Token String = Error("not logged in")

  messages
    Login (raw: Tainted String) ->
      match Token.validate(raw)
        | t     -> { token: Ok(t) }
        | Error -> { token: Error("invalid token") }

    Logout -> { token: Error("not logged in") }

  pub
    isLoggedIn = token is Ok
    activeToken = token
```

**Migration on hot reload:**
```
store Session
  version: 2
  migrate
    | v1 { token: String } -> { token: Ok(token), expiresAt: Error("unknown") }
```

**Store rules:**
- Store pub values may not reference another store's pub values
- Store dependency graph must be acyclic
- Stores communicate exclusively via messages
- Exception: inside `transaction` blocks, stores may cross-reference

### 7.3 Imports

```
import session                 from "./session"
import { view, model }         from "./UserCard"
import http                    from "std/http"
import js "stripe-js"          as stripe
```

---

## 8. Transactions

Pure atomic coordination across stores. No IO allowed inside.
The runtime retries on conflict:

```
transaction within { from: now, to: now + 5000, maxRetry: 3 }
  balance = ask AccountA GetBalance
  ask AccountB (Deposit balance)
  ask AccountA Withdraw
|> match
   | Ok _               -> ()
   | Timeout { after }  -> send Logger (Log "timed out after {after}ms")
   | Conflict { retries } -> send Logger (Log "failed after {retries} retries")
   | Cancelled          -> ()
```

**Outcome type (implemented).** A `transaction` evaluates to a distinctly-typed
outcome ADT, where `T` is the type of the block's final expression — it is *not* a
plain `Result`. **Renamed in edition 2026.6** (the type and its commit/abort ctors;
the concurrency ctors are stable):

| Constructor (2026.6) | (2026.1 legacy) | Meaning                                   | Payload            |
|----------------------|-----------------|-------------------------------------------|--------------------|
| `Committed v`        | `Ok v`          | committed; `v : T`                        | `T`                |
| `Aborted e`          | `Error e`       | bare (un-`within`) transaction aborted    | the failing error  |
| `Conflict { retries }` | *(same)*      | `within { maxRetry: N }` exhausted retries | `{ retries: Number }` |
| `Timeout { after }`  | *(same)*        | `within { to }` deadline passed           | `{ after: Number }`  |
| `Cancelled`          | *(same)*        | aborted by `crash()` inside the body      | — (nullary)        |

The type name is `Outcome(T)` in 2026.6, `TxResult(T)` in 2026.1. Opt in with
`@edition "2026.6"` at the top of a module; absent that, a module is 2026.1 and the
legacy names apply. Mixing per module is allowed (editions are module-scoped).

**Why the rename:** under 2026.1, `TxResult` shared the `Ok`/`Error` *names* with
`Result` (**constructor sharing**) — which ADT a `| Ok v ->` arm belonged to was
decided by the **expected type** at the match site, the one name-overloaded corner
of the language. In 2026.6 `Committed`/`Aborted` are unique, so that ambiguity is
gone: a match resolves purely by name. (The checker still uses the expected type to
assign the typed payloads, but there is no longer a collision to break.)

Because `Conflict`/`Timeout` carry typed records, `c.retries` and `t.after` are
`Number`s (a wrong field is a type error), and a match over the outcome ADT is
**exhaustiveness-checked** over the closed five-constructor set. A function whose
body is a transaction is annotated `def transfer(amt): Outcome(Number)` (2026.6) /
`TxResult(Number)` (2026.1). A bare `transaction` (no `within`) can only commit or
abort, so the two commit/abort arms are exhaustive for it; a `within`-configured one
may produce any of the five.

---

## 9. JS Interop

### 9.1 Library imports

```
import js "stripe-js" as stripe

result : Tainted Any = stripe.createPaymentMethod config
```

### 9.2 Raw JS blocks

Synchronous only. Everything produced is `Tainted Any`:

```
result = @js{ someJsLibrary.doSomething({myValue}) }
```

### 9.3 Escape blocks

```
@js{ ... }          -- raw JS, Tainted Any output
@unsafe{ ... }      -- escape type/ownership checks
@comptime{ ... }    -- compile-time execution (same language)
@kernel{ ... }      -- GPU kernel context (implies unsafe)
```

---

## 10. Events and Streams

### 10.1 Event type

```
type Event(a) = Stream(a)
-- Push-based. Backpressure: drop by default.
```

### 10.2 Stream combinators

Implemented (data-first, so they chain with `|>`; each spawns a consumer that
drains the source and propagates `Done`):

```
streamMap    : Stream(a) -> (a -> b)        -> Stream(b)
streamFilter : Stream(a) -> (a -> Bool)     -> Stream(a)
streamTake   : Stream(a) -> Number          -> Stream(a)
streamFold   : Stream(a) -> b -> ((b, a) -> b) -> b      -- terminal: drains to a value
```

```
total = Source |>
  streamFilter (fn x -> x % 2 == 1) |>
  streamMap (fn x -> x * 10) |>
  streamFold 0 (fn (acc, x) -> acc + x)
```

Also implemented — combining and rate-limiting (data-first; the `ms` argument is in
virtual-clock milliseconds, so behaviour is deterministic in tests):

```
streamMerge    : Stream(a) -> Stream(a) -> Stream(a)   -- interleave; Done after BOTH done
streamDebounce : Stream(a) -> Number    -> Stream(a)   -- trailing: emit after `ms` of quiet
streamThrottle : Stream(a) -> Number    -> Stream(a)   -- leading: emit, then drop for `ms`
```

`streamMerge` emits `Done` only once both sources finish. `streamDebounce` holds the
latest value and emits it once `ms` passes with no newer value (a burst collapses to its
last element; `Done` flushes the pending value). `streamThrottle` emits a value then drops
everything for `ms` (leading edge). `debounce` waits without losing buffered values via a
queue-aware `nextWithin` (racing a plain `next()` against a timer would orphan its waiter).

### 10.3 Streams as stores

Streams are stores. Producers `send`, consumers `await`:

```
-- Producer
def streamResponse(prompt: String): Effect [network] ()
  for (chunk in openai.stream prompt)
    send ResponseStream (Push chunk)
  send ResponseStream Done

-- Consumer
def display(): Effect [ui] ()
  loop
    await ResponseStream
      | Push chunk -> send UI (Append chunk)
      | Done       -> break
```

### 10.4 Lifecycle events

```
onRender   : Event ()    -- element enters render tree
onDerender : Event ()    -- element leaves render tree
```

---

## 11. Layout System

### 11.1 Element syntax

```
Column gap=8 padding=16 background=#f9f9f9
  Text "Hello" size=12
  Input value=(Form.name)
    on onInput e -> send Form (SetName(e.value))   -- `e` : Event { value, key, checked }
  Button "Submit"
    on onClick -> send Form (Submit())
```

An `on <event> [param] -> …` child wires a handler. The optional param binds the DOM
event as `Event { value: String, key: String, checked: Bool }` (`value`/`checked`
from the target, `key` from keyboard events) — so form handlers read `e.value`.

### 11.1.1 Keyed lists

```
for r in rows           -- render one element per item, auto-keyed on r.id
  Row gap=8
    Text (r.title)
```

`for r in rows` renders the indented element for each item and gives each a stable
reconciliation **key** — `r.id` by default (a record's `id` is its primary key). Set
an explicit `id`/`key` prop on the element to override. An item type with no `id`
field is a compile error (it cannot be keyed) — so a keyless dynamic list is not
expressible this way. The key is identity only; it is stripped from rendered markup.
Distinct from the `for ( … ) ->` comprehension (§3), which produces a plain list.

### 11.2 Primitives

```
Text    : String -> List Attr -> Element
Image   : Url    -> List Attr -> Element
Column  : List Attr -> List Element -> Element
Row     : List Attr -> List Element -> Element
Stack   : List Attr -> List Element -> Element
Spacer  :                              Element
Divider :                              Element
```

### 11.3 Units

```
Column gap=8            -- Px 8
Column width={Fr 0.5}   -- fraction
Column width={Pct 100}  -- percentage
Column width=Fit        -- content
```

### 11.4 Styling

State-indexed, exhaustiveness enforced:

```
def buttonStyle(s: ButtonState): List Attr
  match s
    | Idle     -> [background=#eee, color=#333]
    | Hovered  -> [background=#ddd, color=#222]
    | Pressed  -> [background=#bbb, color=#111]
    | Disabled -> [background=#f5f5f5, color=#999]
-- missing case: compile error
```

---

## 12. Security Model

### 12.1 Trust boundaries

```
Always Tainted:                Always clean:
  Json.parse output              const declarations
  postMessage payloads           your typed constructors
  JS interop returns             Ok branch after T.decode
  raw JS block output            Bytes from Http.send / Fs.read
  localStorage reads
  URL parameters
  environment variables
```

### 12.2 Structural injection prevention

- Database queries require `SqlParam` — no string SQL
- HTML rendering requires `HtmlContent`
- All refinement types follow the same pattern

### 12.3 Capability enforcement

- Capabilities are part of the `Effect` type
- Compiler verifies all effectful calls at definition site
- Raw JS blocks opt out explicitly — `Tainted Any` is the enforced boundary

---

## 13. Tooling

```
velve new my-app    -- scaffold new project
velve dev           -- dev server, interpreter mode, live reload
velve build         -- production build
velve fmt           -- format (opinionated, non-configurable)
velve check         -- type check without building
velve test          -- run tests
velve add pkg       -- add dependency
```

### 13.1 Two runtime modes

**Interpreter (dev):** GC-managed, fast iteration, live reload.
**Compiled (prod):** Ownership-based, no GC, deterministic drop.

---

## 14. Open Questions

*(Resolved since the original list: the type checker, and the `machine`/`saga`
runtime including `persisted` saga-state serialization, are all implemented.)*

- Number internal representation (Number vs Int32/Float64 distinction)
- Streaming backpressure semantics in `send`/`await`
- Multi-clause function head exhaustiveness checking
- Module-qualified function calls (`Math.sqrt`, `low.atomicAdd`) — currently you must
  import the name and call it unqualified
- `---` doc comments vs `--` regular comments (LSP distinction)
- Multiline leading `|>` — currently requires trailing `|>` convention
- Element vs type ambiguity in certain positions
- Proof system integration for dependent types
- Z-index and paint order
- SSR/hydration strategy
- Unify `store`/`machine`/`saga` over one process core. They are the same primitive (a stateful actor) with orthogonal switches: persistence (store/saga yes, machine no), shape (store = message handlers, machine/saga = FSM steps), compensation (saga only), identity (store = named singleton, saga = per-instance, machine = none). Plan: share the machinery underneath, keep the three keywords as ergonomic presets/sugar (don't surface a raw `process` keyword — `saga Checkout` reads better than `process Checkout persistent fsm compensating`). Deliberately NOT building user-definable behaviours/process-templates (metaprogramming) yet — rule of three not met (no construct that fails to fit the presets), the soundness cost vs HM+effects+exhaustiveness is nonlinear, and `@comptime` is the natural home if real extensibility demand appears. Revisit when a concrete construct (pub/sub bus, supervisor, stream processor, resource pool) doesn't fit store/machine/saga.

---

## 15. Standard Libraries

**Implemented today** (runtime-backed in `checker/src/`): `String`, `Math`, `Dict`,
`Set`, `Json`, `Duration`, `IO`, and `Color` (§15.3), plus the `web` reactive root
(§15.1, partial). These are reached via bare imports — `import { sqrt } from "Math"`
— and called unqualified (`sqrt(x)`). Module-qualified calls (`Math.sqrt`) do **not**
resolve yet; that is an open item (§14).

Libraries that are **designed but not yet implemented** (http, fs, process, parallel,
low/sized-types, gpu, db, audio, proof) have moved to the *Planned standard libraries*
appendix at the end of this document, so this section documents only what exists.

### 15.1 std/web

Status: **partial** — `viewport` and the `Breakpoint` enum are defined; `onRender`/
`onDerender` lifecycle events and the `responsive | …` sugar are not yet wired.



```
onRender   : Event ()
onDerender : Event ()
viewport   : { width: Number, height: Number, breakpoint: Breakpoint }
-- read-only reactive root; `responsive | …` sugar = `match viewport.breakpoint`
type Breakpoint = Mobile | Tablet | Desktop | Wide
```

### 15.2 std/json

```
Json.parse      : String -> Result (Tainted Any) String  -- takes a String, not Bytes
Json.stringify  : a -> String                            -- compact encode
Json.prettyPrint : a -> String                           -- indented encode
```

`Json.parse` is where taint enters — parsing produces an arbitrary external
structure. `Json.stringify`/`prettyPrint` always produce clean `String`. (There is
no `Json.encode`; use `stringify`.)

### 15.3 std/color

A colour is the OKLCH record `{ l, c, h }`. The module is **data-first**, so it pipes
(`oklch(0.55,0.17,262) |> complement |> toHex`). Implemented (`std/Color`).

```
-- construct
oklch  : (Number, Number, Number) -> Color   -- lightness 0–1, chroma, hue 0–360
hex    : String -> Color                       -- "#5b6ef0" → Color
gray   : Number -> Color
-- adjust (perceptual — in OKLCH, so steps look even)
lighten / darken / saturate / desaturate : (Color, Number) -> Color
rotate : (Color, Number) -> Color              -- shift hue by degrees
-- harmony (colour-wheel relationships)
complement      : Color -> Color
analogous / triad / tetrad / splitComplement : Color -> List Color
-- mix + perception
mix       : (Color, Color, Number) -> Color    -- perceptual blend (OKLab midpoint)
cusp      : Color -> Color                      -- seat the hue at its most-saturated lightness
contrast  : (Color, Color) -> Number            -- APCA Lc (text, background)
legibleOn : Color -> Color                      -- the readable foreground for a background
-- output
toHex : Color -> String
css   : Color -> String                         -- `oklch(L C H)`
toLinear : Color -> (Number, Number, Number)    -- GPU: linear-sRGB floats 0–1
-- distance + tonal scales
deltaE : (Color, Color) -> Number               -- perceptual distance (ΔEOK, OKLab Euclidean)
ramp   : (Color, Number) -> List Color          -- n tones of the hue, dark→light, gamut-clamped
shades : (Color, Number) -> List Color          -- n steps darker (toward L=0.1), hue kept
tints  : (Color, Number) -> List Color          -- n steps lighter (toward L=0.98), hue kept
-- accessibility + terminal
simulate    : (Color, String) -> Color          -- CVD sim: protanopia/deuteranopia/tritanopia/achromatopsia
nearestAnsi : Color -> Number                    -- index 0–15 of the nearest standard ANSI colour
-- named hue constructors (values, each seated at its hue's gamut cusp)
rose / amber / lime / emerald / teal / cyan / azure / indigo / violet / plum : Color
```

`deltaE` is the modern distinguishability metric (palettes whose entries are all
≥ some ΔEOK apart stay legible); `ramp`/`shades`/`tints` generate tonal scales with
chroma clamped to the gamut per lightness; `simulate` previews colour-vision
deficiencies; `nearestAnsi` snaps a colour to the 16-colour terminal palette; the
named hues are vivid cusp-seated swatches. `cusp` fixes the "lime/amber look muddy" problem (each hue is most vivid at a
different lightness); `contrast`/`legibleOn` use **APCA**, the perceptual metric, not
WCAG. This is the foundation the theme system (§11) derives roles from.

> The libraries that used to be listed here as §15.4–§15.10 (http, fs, process,
> parallel, low/sized-types, gpu, db, audio, proof) are **designed but not yet
> implemented**. They now live in the *Planned standard libraries* appendix at the
> end of this document.

---

## 16. Debug blocks (`@debug { … }`) — PROPOSED

Status: **PROPOSED** (design note, not implemented). A `@debug { … }` block runs the
enclosed code in a **tracing evaluation mode** that records a causal trace —
intended for inspect-and-replay debugging.

Velve is unusually suited to this because the foundations already exist:

- **Purity + deterministic scheduler** (virtual clock) → every run is *replayable*
  (the precondition for time-travel debugging, à la Elm).
- **Sagas keep a journal** (`journalOf`) → step-sequence recording already exists.
- **Stores are message/state (Elm architecture)** → every state change is a discrete,
  recordable event.
- **Transactions roll back** → "restore a prior state" is already in the runtime.

A debug block records a **span tree**: each call with its arguments, result, and the
store snapshot at that point; on failure it walks the chain back to root cause.

```
@debug {
  checkout(cart)
}
-- on failure, emits a sequential causal trace:
--   checkout(cart)            state{ cart: 3 items }
--     validateStock(cart)     ok
--     charge(card, total)     Error "declined"      ← failure
--   traced: charge ← total=240 ← cart.sum ← item#2.price = 0   (root cause)
```

Output: which function failed, the `Error` value, and the ordered call+state chain
that led there (every step's inputs are recorded; the run replays identically).
Composes with `journalOf` (saga steps already traced) and the deterministic
scheduler. This is a **runtime/interpreter** feature (heavier than static passes),
but no new theory is required.

**Open:** trace granularity (every call vs. annotated boundaries); snapshot cost /
structural sharing; interaction with effects (I/O can't be replayed — record &
mock?); surface as a block keyword vs. a `velve debug` run mode.

---

## 17. Versioning and editions — SCAFFOLDING SHIPPED

Status: **SCAFFOLDING SHIPPED (2026-06)** — the per-module pragma, edition resolver,
and a no-op gate are built (`edition.ts`, `Module.edition`; `edition_test.velve` /
`edition_bad.velve`). No edition-specific *semantics* are gated yet; the
surface-consistency breaks (PLAN.md Phase 2) land on edition `2026.6`. Velve is
pre-1.0 and the surface language will change; editions are the insurance that lets it
change *without a flag day*. Precedent: **Rust editions** (2015/18/21/24), **Racket
`#lang`** (per-file language), **Python `from __future__`**.

**As-built — Rust-style editions:**

- **Edition names are dates** (`year.month`, ordered epochs). Shipped: `2026.1`
  (**baseline** — the pre-refactor language) and `2026.6` (the surface-consistency
  refactor). A module opts in with `@edition "2026.6"` on its first line.
- **Per-module edition pragma** (`@edition "2026.6"` at module top), read by
  `lower`/`infer`/`eval`, which **branch behavior on edition**. Absent → the pinned
  default, currently `2026.1` (baseline) so existing code keeps compiling untouched;
  this flips to *latest* once the corpus is migrated. An unknown edition name is a
  checker error (not a parse error) and falls back to the default.
- **A stable core IR is the interop boundary.** Editions differ in the *frontend*
  (surface syntax + lowering); they all lower to the same core AST, so a 0.5 module
  and a 0.7 module link. The existing AST is that chokepoint — the discipline is
  "edition-specific in the frontend, edition-agnostic in the core."
- **Deprecation lifecycle:** feature works → `warning` in edition N → illegal /
  changed-semantics in edition N+1. The diagnostics layer already has
  `warning`/`error` kinds, so this is mostly policy.
- **The grammar constraint (decide up front):** tree-sitter is a single grammar.
  **Recommended: a superset grammar + edition-gated *semantics*** (the checker
  rejects edition-illegal constructs) rather than versioning the grammar — this is
  how Rust keeps one lenient parser with edition rules enforced semantically.

This lets later releases change *anything* about the surface language (rename
keywords, flip a default, remove a construct, alter evaluation) behind a new edition
while old modules keep compiling. **Explicitly avoid the Elm approach** (break
between majors with a migration tool) — simplest, but most painful while the
language is still moving fast.

**Decided:** edition naming = date epochs (`year.month`); a project **may** mix
editions per module (the pragma is per-file). **Open:** automated `velve fix
--edition` migration; how `@comptime`/macros (if added) version.

---

## Appendix: Planned standard libraries — PROPOSED

Status: **PROPOSED** (design sketches, not implemented). These libraries were
previously listed inline in §15; they are collected here so §15 documents only what
exists today. Syntax in these sketches predates the current call notation (e.g. they
use `Http.get url` juxtaposition and `Json.encode`); treat them as intent, not as
runnable code.

### std/http — PROPOSED

```
-- Types
type Method = Get | Post | Put | Patch | Delete
type Header = (String, String)
type Request

-- Builder — each returns a new Request
Http.get    : Url -> Request
Http.post   : Url -> Request
Http.put    : Url -> Request
Http.patch  : Url -> Request
Http.delete : Url -> Request

Http.header  : String -> String -> Request -> Request
Http.body    : Bytes -> Request -> Request
Http.timeout : Number -> Request -> Request    -- milliseconds

-- Execution
Http.send : Request -> Effect [network] Result Bytes String

-- Combiners
Http.json   : (Tainted Any -> Result a String) -> Request -> Effect [network] Result a String
Http.stream : (Tainted Any -> Result a String) -> Request -> Effect [network] Stream a
Http.text   : Request -> Effect [network] Result String String
```

### std/fs — PROPOSED

```
-- Type
type Path = String where is_valid_path

Path.join : Path -> String -> Path

-- Read
Fs.read   : Path -> Effect [fs] Result Bytes String
Fs.text   : Path -> Effect [fs] Result String String
Fs.lines  : Path -> Effect [fs] Stream String
Fs.stream : Path -> Size -> Effect [fs] Stream Bytes

-- Write
Fs.write  : Path -> Bytes -> Effect [fs] Result () String
Fs.append : Path -> Bytes -> Effect [fs] Result () String

-- Combiner
Fs.json : (Tainted Any -> Result a String) -> Path -> Effect [fs] Result a String

-- Directory
Fs.list   : Path -> Effect [fs] Result (List Path) String
Fs.exists : Path -> Effect [fs] Bool
```

### std/process — PROPOSED

```
pid = process.spawn fn ->
  match receive
    | Ping -> send caller Pong
    | Stop -> ()

process.monitor : process.Pid -> Effect [process] Event ProcessEvent
```

### std/parallel — PROPOSED

```
items |> parallel.pmap item -> heavyComputation item
items |> parallel.pfilter item -> item.value > 0
```

`mut` inside a `pmap` lambda would be a compile error (data race).

### std/low — PROPOSED

Low-level memory access. Requires `memory` capability.

**Sized numeric types:**
```
Int8, Int16, Int32, Int64
UInt8, UInt16, UInt32, UInt64
Float16, Float32, Float64
```

**Extern types** (C-compatible layout):
```
type Vertex = extern
  { position : Vec4 align=16
  , normal   : Vec4 align=16
  }
```

**Comptime verification:**
```
@comptime{
  assert Vec4.size == 16
  assert offsetOf Vec4 .x == 0
}
```

**Memory operations:**
```
low.stackAlloc  : Type -> Effect [memory] a
low.heapAlloc   : Type -> Effect [memory] a
low.atomicAdd   : Atomic(UInt32) -> UInt32 -> Effect [memory] UInt32
low.fence       -- full memory barrier
```

### std/gpu — PROPOSED

```
@kernel
def vertexShader(
  position : Array(n, Vec4)
  mvp      : Mat4
  output   : Array(n, Vec4)
): Effect [memory] ()
  idx = gpu.threadId
  output[idx] = transform mvp position[idx]
```

**GPU intrinsics:**
```
gpu.threadId
gpu.blockId
gpu.syncThreads
```

### std/db — PROPOSED

Type-safe database. The type is the schema. No SQL strings.

```
type User =
  { id    : Id
  , name  : String
  , email : Email
  , role  : Role
  }

-- Queries as ADTs
admins = db.run
  Select
    from=users
    fields=[name, email]
    where=(Eq role :admin |> And (Gt age 18))
-- admins : Result (List User) String
```

Injection structurally impossible — no string to inject into.

### std/audio — PROPOSED

```
@audioKernel sampleRate=44100 bufferSize=256
def oscillator(
  output : Array(256, Float32)
  freq   : Float32
  phase  : Float32
): Effect [memory] Float32
  low.loopRange 0 256 (i ->
    output[i] = low.sin (phase + freq * i / 44100.0 * 2.0 * 3.14159)
  )
  phase + freq * 256.0 / 44100.0
```

Real-time guaranteed. No allocations inside kernel. No GC. Compiled mode only.

### std/proof — PROPOSED

Optional theorem prover integration (Z3, CVC5):

```
type SortedList(a) = List(a) where proof.sorted value

def factorial(n: Number): Number
  proof.terminates
  if n == 0 then 1 else n * factorial(n - 1)
```

---

## Appendix: Grammar at a Glance

The parser is a tree-sitter GLR grammar with an external scanner
handling indent/dedent/newline. 151 corpus tests pass.

Key parsing decisions:
- Newlines are significant (Python-style) via external scanner
- Continuation: binary ops leading on deeper-indented line suppress newline
- `|>` continuation: use trailing `|>` (scanner can't peek two chars for `|>`)
- `()` is unit in expression position, unit_type in type position
- `(a, b)` is always a tuple (two or more elements); `(a)` is grouped
- `:name` is always an atom literal
- Implicit match (no `match` keyword) only valid inside saga step bodies
- `await_stmt` with branches safe in all contexts (keyword-started)
- Saga-specific statements (`go`, `after`, `until`, `race`, `rollback`, `implicit_match`, `step_goto`) only valid inside `machine`/`saga` step bodies — kept in `_saga_stmt` to prevent scanner interference with regular code
