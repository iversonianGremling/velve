# Entity/interaction model & confinement (`@interaction` / `@confined`) — design note

Status: **PROPOSED** (2026-06-09). Not yet implemented. This note specs how Velve
models stateful entities and their interactions for games *and* general UI/UX, and
adds two enforcement markers — `@interaction` (no ambient **writes**) and
`@confined { … }` (full object-capability isolation) — that make the resulting
interaction graph queryable, debuggable, and sound.

It reuses, and is deliberately parallel to, the **two-tier ownership** work
(`@low`/`@kernel` decorators + the borrow checker). The enforcement here is a new
*mode* layered onto the same decorator + borrow machinery, **not** new grammar or a
new primitive. Read the ownership/tier notes first; this assumes the `@low`
decl-decorator plumbing (`lower.ts` decorator detection, `borrow.ts` `Ctx` mode
flag) exists.

---

## 1. Guiding principle

> Model a reactive system as **nodes that hold state** and **edges that change
> state**, and make every edge's reach *visible in its signature*. Behaviour lives
> on the edges between entities, not inside the entities — so the system is a
> queryable relation, not a pile of methods.

Two consequences fall out and drive everything below:

1. **No new primitives.** An entity is a `machine`; an interaction is a plain
   function; a "scene" is just the root element. The only additions are two
   *enforcement markers*.
2. **Soundness comes from one structural rule** — no ambient authority over
   mutable state — which makes "what can change `X`?" answerable for the whole
   program, by construction, with zero bookkeeping.

This is **not OOP** in the class/inheritance sense (behaviour is on edges, dispatch
is multi-party, composition is by capability not hierarchy). It *is* OOP in the
Kay/messaging sense (encapsulated stateful identity). It is the
data-oriented / ECS / functional-relational family — the architecture game
development migrated *to*, away from deep inheritance, for exactly the reason this
model targets: combinatorial interaction explosion.

---

## 2. The model

| Concept | Realized as | New construct? |
|---|---|---|
| **Element / entity** (node) | a `machine` — `const`+`mut` state, `on Tick` self-update, capability tags (`Set(Trait)`) | no |
| **Interaction** (edge) | a plain function taking **≥ 2** elements, transferring effects | no |
| **Self-update** | a unary function / the element's own machine transition (1 element) | no |
| **Scene** | the top-level/root element (the page on web; the root that runs the frame loop in a game) | no |
| **Membership / scope** | lexical **scope** — which interaction functions are in scope | no |
| **The interaction graph** | a *derived projection* over the interaction functions in scope — never written | no |
| **Confinement / footprint enforcement** | `@interaction` (no ambient writes) / `@confined { }` (full ocap) | **markers only** |

Node vs edge is decided by **arity**: 1 element ⇒ a node's self-update; ≥ 2
elements ⇒ an edge. An interaction is defined **once, on the edge** (keyed by
capability), and the per-entity views are *projections* of it — so "mirror
interactions" (the wall's view vs the mover's view of a collision) are never two
things and never need deriving or consistency-checking.

```velve
machine Player                       -- NODE
  const class:  Class                -- immutable from the scene's POV (scope-bounded const)
  const maxHp:  Number
  mut   hp:     Health
  mut   traits: Set(Trait)
  on Tick(dt) -> …                   -- unary self-update lives on the node

@interaction
def collide(mut a: Solid, b: Solid)  -- EDGE: ≥2 elements, capability-keyed (Solid, not a class)
  when overlaps(a.box, b.box) and not a.traits.has(Phasing)
  do   halt(a); play(b.thud)         -- body may touch ONLY a and b
```

(`when`/`do` shown for illustration; an interaction may also be an ordinary
function body. The capability-keyed dispatch — `Solid × Solid` rather than a method
on a privileged receiver — is multiple dispatch, see §4.3.)

---

## 3. Footprint = parameter mutability

The set of state an interaction may change — its **write-footprint** — is **not a
separate declaration**. It is exactly the `mut` parameters, which Velve's ownership
model already tracks:

```velve
def collide(mut p: Player, w: Wall)   -- writes: p   reads: w
```

- **Read-only by default**: a non-`mut` param is a shared/read borrow. The body
  cannot mutate it (the borrow checker already rejects this).
- **`mut` param = write capability** over that element.
- **Element-level footprint** = the `mut` params. **Exact**, free, drift-proof.
- **Field-level footprint** (`.hp` vs `.pos`) = inferred from the body by static
  analysis as a conservative **may-write over-approximation**. It fails *safe*:
  the inferred set may list extra suspects, never miss a real one — the correct
  direction of error for a debugger.

> **Reachability caveat.** The footprint is the *transitive closure of mutable
> state reachable from the `mut` params*, not literally the named params. If
> `Player` holds a back-reference `p.target: Enemy`, then `collide(mut p, …)` can
> reach `enemy` through `p.target`. Dense back-references balloon footprints —
> "design data without back-references" is the corresponding style guidance (it
> keeps footprints tight, same rationale as the existing borrow notes).

The invariant this buys (with §4): **every mutation a function can perform is named
in its signature.** = read-only-params-by-default (already true) + no-ambient-writes
(§4.1).

---

## 4. Confinement: the two markers

### 4.1 `@interaction` — no ambient **writes** (the cheap one)

`@interaction` is a decl-level decorator (same shape as `@low`) that flips the
borrow checker into **no-ambient-write** mode for that function:

> The function may **read** ambient state freely (globals, `static`, captured
> bindings, `store`s), but may **write** only to state reachable through its `mut`
> parameters.

Rationale — the **read/write asymmetry**. The query the whole model exists to
answer ("what can change `X`?") is *write-shaped*. A function that reads twenty
stores changes nothing, so it never appears in the "what changed `X`" map; only
*writes* pollute it. Therefore forbidding ambient **writes alone** yields the full
footprint/debug guarantee — without the prop-drilling tax of forbidding reads.

This is cheap in practice because well-formed `store`s are already mutated through
**transactions/actions**, not raw field pokes — so "no ambient write" mostly
formalizes existing discipline. It is therefore a **candidate global default**
(every function behaves as if `@interaction`), with an opt-out for the rare
ambient-write site, rather than an opt-in. (Decision left Open, §7.)

### 4.2 `@confined { … }` — full object-capability isolation (the heavy one)

`@confined { … }` is a **region/block** form. Inside it, a function has **no
ambient authority at all** — neither reads nor writes of ambient state. All
authority over elements comes *only* through parameters. This forbids, transitively:

- globals / `static` / module-level mutable bindings,
- **closure capture** of elements from an enclosing scope (the commonly-forgotten
  channel — a lambda closing over `player` has ambient authority),
- **laundering**: a confined body may only call confined (or pure) functions; it
  cannot reach authority through an unconfined callee,
- any registry / service-locator / singleton path to an element.

`@confined` is the opt-in isolation boundary, mirroring the `@low` philosophy
(strictness you reach for, never imposed). It is strictly stronger than
`@interaction` (`@confined` ⟹ `@interaction`).

### 4.3 Capability-keyed multiple dispatch

Interactions dispatch on **capabilities/traits, not concrete types**:
`collide(a: Solid, b: Solid)` matches any pair carrying `Solid`. Asking
`other.traits.has(Phasing)` rather than `other.kind == Ghost` is what keeps the
rule table from becoming an O(types²) hand-maintained matrix (the expression
problem): new entity kinds declare traits and match existing rules with **zero**
edits to the rules. Keep the *verb* set closed (an ADT — `Collide | Damage | …`) so
exhaustiveness checking can **prove the rule table has no holes** (see §5);
keep the *entity* side open (traits) so content extends freely. Exhaustive on
verbs, open on entities.

---

## 5. What this enables

- **A sound "what can change `X`?" query, program-wide** — group the in-scope
  interaction functions by write-footprint (§3), filter to those whose `when`
  currently holds, snapshot their read/write values in debug mode. The graph gives
  the suspect list; debug mode gives the evidence. Both come from the footprint,
  never from reading an (opaque) body.
- **Invertible views.** Because interactions are a *relation* (declarative
  functions in scope), not scattered methods, every view is a projection / GROUP BY:
  entity-centered (group by participant), action/input-centered (group by verb;
  the action *set* is derivable, the key *assignment* is a separate authored
  keymap), effect/debug-centered (group by write-footprint). No view is primary in
  the data; the **graph view is primary for humans** because it is the part that is
  statically checkable, while bodies are local and swappable.
- **Provable interaction completeness** — closed verb sum + exhaustiveness-as-hard-
  error (already in `exhaust.ts`) proves every verb is handled. No mainstream
  engine checks this.
- **Opaque-but-leashed bodies.** A body may be as messy as needed; its *interface*
  (footprint) is enforced and queryable, so you only open the body when something is
  wrong. Modular-reasoning / information-hiding, made compiler-checked.

Non-game payoff (value = interaction-density × cost-of-unexplained-mutation):
- write-footprint → complex forms/wizards, **financial/ledger auditability** (fits
  sagas/transactions), spreadsheets/reactive dataflow;
- invertible graph → **workflow/orchestration** (saga = machine persisted), design
  tools/canvases/node editors, dashboards;
- confinement → **plugin/extension sandboxes**, multi-tenant isolation,
  robotics/IoT/control-system capability safety, deterministic replay / time-travel
  debugging, collaborative editing (CRDT).
Overkill for blogs/marketing/thin-CRUD → markers stay opt-in.

---

## 6. Implementation plan

Reuses the `@low` tier machinery almost entirely. File references current as of
2026-06-09.

### 6.1 AST (`checker/src/ast.ts`)
- Mirror the existing `DFn.lowLevel?: boolean`: add `confinement?: "interaction" |
  "confined" | null` to `DFn` (or a small flags object if combining with
  `lowLevel`). No new node kinds.

### 6.2 Grammar (`grammar.js`)
- **No change.** `@interaction` is already parseable as a `decorator` on a
  `function_def` (`decorator_def` = `@name decl`). `@confined { … }` reuses the
  block-decorator shape used by `@kernel{…}`/`@unsafe{…}`/`@comptime{…}` (region
  form). Confirm `@confined` resolves to the region rule, not the decl-decorator.

### 6.3 Lowering (`checker/src/lower.ts`)
- In `lowerDeclList`, alongside the existing `@low`/`@kernel` detection that
  populates `lowLevelFns`, detect `@interaction`/`@confined` and set
  `DFn.confinement`. Thread it through `lowerFnGroup` exactly as `lowLevel` is
  threaded today.

### 6.4 Enforcement (`checker/src/borrow.ts`)
- Extend `Ctx` with the confinement mode (analogous to `Ctx.lowLevel`).
  `analyzeFunction(clause, diags, types, …)` gains the mode.
- **`@interaction` (no ambient write):** flag any *assignment/mutation* whose target
  resolves to a binding **not** reachable from a `mut` parameter — i.e. a write to a
  global/`static`/captured/`store` binding. Reads are unrestricted. Diagnostic:
  `ambient write to 'X' — an @interaction may only write through its mut parameters`.
- **`@confined` (full ocap):** additionally flag ambient **reads**, captured
  elements, and calls to non-confined/non-pure functions (transitive laundering).
  Diagnostic: `'X' is ambient — a @confined region may only touch its parameters`.
- Reuse the existing addr/deref/move walkers as the traversal scaffold; this is a
  *binding-origin* check (is the mutated/read l-value rooted in a param or in
  ambient scope?), simpler than the lifetime pass.
- Element-level footprint = the `mut` params (already known). Field-level
  may-write = collect assigned field paths during the same walk (conservative).

### 6.5 Graph reflection (new, small — `checker/src/` or a tool)
- A pass that, given a scope, enumerates `@interaction`/`@confined` functions and
  emits the relation: nodes = element types in params, edges = functions, edge
  labels = (read params, `mut` params, may-write field set). This is what powers the
  "what affects `X`?" query and the invertible views. Can ship after the checker
  enforcement — the enforcement is the load-bearing part.

### 6.6 Entry (`checker/src/index.ts`)
- `checkBorrows()` already runs unconditionally; the confinement checks ride inside
  it. No new pipeline stage.

### 6.7 Fixtures
- New `.velve` fixtures: an `@interaction` that writes a `mut` param (clean), one
  that writes a global/store (error), one that reads a store (clean — reads
  allowed); a `@confined` that reads a store (error) and one that captures an outer
  element (error). Manual `node dist/index.js check <f>` fixtures, like the existing
  borrow fixtures (checker has no automated `.test.ts`).

---

## 7. Decisions

**Locked (2026-06-09)**
- No new primitives: entity = `machine`, interaction = function, scene = root
  element, membership = lexical scope, graph = derived projection.
- Node vs edge by arity (1 = self-update, ≥2 = interaction). Define on the edge,
  project to the nodes.
- Footprint = parameter mutability; element-level exact, field-level conservative
  (fails safe). Footprint = transitive reachable mutable state from `mut` params.
- `@interaction` = no ambient **writes** (reads free); `@confined { }` = full ocap
  (no ambient reads or writes; transitive; bans closure-captured elements).
  `@confined` ⟹ `@interaction`.
- Read/write asymmetry: the debug guarantee is write-shaped, so the cheap
  no-ambient-write rule suffices for it.
- Capability-keyed multiple dispatch; closed verb sum (exhaustiveness-checkable),
  open entity traits.
- This is data-oriented/ECS, not class/inheritance OOP.
- Reuse `@low` decorator + borrow-checker infra; **no grammar change**.

**Open (confirm before implementing)**
- (a) Is `@interaction` (no-ambient-write) the **global default** with an opt-out,
  or an opt-in marker? Leaning default (it's nearly free given store-via-actions),
  but this changes every existing fixture and needs a sweep decision.
- (b) Spelling of the markers — `@interaction`/`@confined` vs `@confined`/`@isolated`
  etc. (`@interaction` reads as intent; the *meaning* is "no ambient write").
- (c) Does `@confined` permit reading **immutable** ambient bindings (`const` of a
  value carries no authority)? Recommendation: yes — `const` values are not
  authority, only mutable reach is. Confirm.
- (d) An optional aggregate reach declaration on a `machine`
  (`affects Player, Enemy`) checked as the union of called interactions'
  footprints — useful subsystem blast-radius bound; deferred unless wanted.

---

## 8. Evidence basis

Honest split. The **object-capability** core (no ambient authority ⟹ reference
graph = effect graph) is established (E, Caja, Pony) and gives a real soundness
guarantee, not a preference. The **ECS-over-inheritance** claim for combinatorial
interaction is strong industry experience, not a controlled study. The
**read/write-asymmetry** argument is a logical consequence of the query being
write-shaped, not an empirical finding. There is **no** controlled evidence on the
marker *spelling* or on default-vs-opt-in — defensible design rationale; recall the
meta-lesson that stated preference does not track measured outcomes, and do not
relitigate names on taste. Do **not** market this as "fewer bugs" (per the
writability-research note, defect-rate claims do not survive reanalysis); market it
as "every mutation is named in its signature" and "the interaction graph is
queryable and provably complete" — both of which are true by construction.
