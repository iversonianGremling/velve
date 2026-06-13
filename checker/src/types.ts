// The Velve type algebra. Every node in the typed AST carries a Type.
// Type variables (Var) are filled in during unification.

import type { Expr } from "./ast.js";

export type Effect = string; // capability name: "payment", "io", "memory", etc.

export type Type =
  | { tag: "Prim";       kind: "String" | "Number" | "Bool" | "Unit" }
  | { tag: "Atom";       name: string }                                   // :ok, :err, :pending …
  | { tag: "Var";        id: number; name?: string }                      // inference variable
  | { tag: "Named";      name: string; args: Type[] }                     // List(a), Result(a,e), Dict(k,v)
  | { tag: "Fn";         params: Type[]; ret: Type; effects: Effect[]; effectTail?: number }  // effectTail (S4c/E1): a quantified var id — the fn's full effect row is `effects` ∪ whatever the tail absorbed at the call (see EFFECT_TAILS in infer). Present only on builtin HOF signatures; a tailed signature accounts for its fn arguments' effects explicitly, so the conservative §12.4 latent rule defers to it. Check-time only.
  | { tag: "SagaFn";     name: string; params: Type[]; ret: Type }        // first-class saga — `go`/`resume`/call; name doubles as handle type
  | { tag: "Inputmap";   name: string; stream: string }                   // inputmap decl (SPEC §10.5) — nullary-callable (drain loop → Unit), accepted by `help`, layerable with `++` (same-stream only — the stream field makes cross-stream layering a check error). Like SagaFn, type-ness survives aliasing. Name is provenance: any two inputmaps unify.
  | { tag: "Tuple";      elems: Type[] }
  | { tag: "Record";     fields: Field[] }
  | { tag: "Tainted";    inner: Type; source: string }                    // §2.8
  | { tag: "Async";      inner: Type }                                    // Async(a) §2.10
  | { tag: "Stream";     inner: Type }                                    // Stream(a) §2.9
  | { tag: "Refinement"; base: Type; pred: string; args?: (Expr | null)[]; width?: { bits: number; signed: boolean } }  // transparent to `base`; `pred` is the refinement type's name (look up predicate AST in REFINEMENTS). `args` carries dependent value-arguments aligned with the refinement's params, e.g. InBounds(listLength xs) → [listLength xs]. `width` (B3, numeric-dimension-design §3.1): the IR width tag a canonical sized-integer name (`u8`…`i32`) carries — inert at runtime (a `u8` IS a `Number` on JS), but the native emitter (Phase D) lowers it to a machine width and the `overflow` obligation (B3(ii)) reads it. Its check-time teeth: two refinements with DIFFERENT width tags don't silently unify (no coercion across a width boundary, §4).
  | { tag: "United";     base: Type; dims: Dims; name?: string }            // units of measure (B2, numeric-dimension-design.md): a `Number` carrying a dimension. UNLIKE Refinement, NOT transparent to `base` — `m + s` errors. The solver never sees `dims`; it is a structural shape discipline (like effects). `dims` is the canonical identity (`m/s` ≡ Velocity); `name` is the alias the user wrote (for friendlier printing), dropped after arithmetic so a computed dimension prints as `m/s`.
  | { tag: "ErrRow";     entries: RowEntry[]; owner: string; tails: number[] }  // inferred error row (error-rows-design v1, row tails v2/S4b): the ctor set a `Result T _` def raises. ONE shared instance per def — `?` accumulates entries in place; rows never unify, they are inclusion-checked at pins. `tails` are the def's quantified type vars whose bindings flow into the row (a callback's error type); each USE of a tailed def gets a per-call-site clone whose tails are judged after inference. Check-time only (eval never sees it).
  | { tag: "Unknown" }                                                    // pre-inference placeholder

// One raised constructor in an inferred error row. `prose: true` marks the
// `String` pseudo-entry — a callee whose error type is prose; uncoverable by
// any pin (rows must not launder prose back into names).
export interface RowEntry {
  name: string;
  payload: Type | null;
  prose?: boolean;
}

export interface Field {
  name: string;
  type: Type;
  optional: boolean;
}

// A dimension vector (units of measure, B2): base-unit atom → integer exponent,
// NORMALIZED so a zero exponent is never stored. The empty map is dimensionless
// (it collapses to bare `Number`). This is the canonical identity of a unit type
// — `m/s` and a declared `Velocity` share one Dims, regardless of the alias name.
export type Dims = { readonly [atom: string]: number };

// Build a normalized Dims from raw signed factors (lower produces these from the
// grammar's `unit_clause`), summing repeats and dropping anything that cancels.
export function mkDims(factors: ReadonlyArray<{ atom: string; exp: number }>): Dims {
  const acc: Record<string, number> = {};
  for (const { atom, exp } of factors) acc[atom] = (acc[atom] ?? 0) + exp;
  for (const k of Object.keys(acc)) if (acc[k] === 0) delete acc[k];
  return acc;
}

export function isDimensionless(d: Dims): boolean {
  return Object.keys(d).length === 0;
}

export function dimsEqual(a: Dims, b: Dims): boolean {
  const ka = Object.keys(a), kb = Object.keys(b);
  return ka.length === kb.length && ka.every(k => a[k] === b[k]);
}

// `*` adds exponents, `/` subtracts — the multiplicative algebra of units.
export function dimsMul(a: Dims, b: Dims): Dims {
  const acc: Record<string, number> = { ...a };
  for (const k of Object.keys(b)) acc[k] = (acc[k] ?? 0) + b[k]!;
  for (const k of Object.keys(acc)) if (acc[k] === 0) delete acc[k];
  return acc;
}
export function dimsDiv(a: Dims, b: Dims): Dims {
  const neg: Record<string, number> = {};
  for (const k of Object.keys(b)) neg[k] = -b[k]!;
  return dimsMul(a, neg);
}

// Print a Dims as a unit expression: `m`, `m/s`, `m/s^2`, `m^2`, `1` (empty).
export function dimsToString(d: Dims): string {
  const term = (atom: string, e: number) => (e === 1 ? atom : `${atom}^${e}`);
  const pos = Object.keys(d).filter(k => d[k]! > 0).sort();
  const neg = Object.keys(d).filter(k => d[k]! < 0).sort();
  const numer = pos.length ? pos.map(k => term(k, d[k]!)).join("*") : "1";
  if (neg.length === 0) return numer;
  return `${numer}/${neg.map(k => term(k, -d[k]!)).join("*")}`;
}

// Helpers

let _nextId = 0;
export function freshVar(name?: string): Type & { tag: "Var" } {
  const id = _nextId++;
  return name !== undefined ? { tag: "Var", id, name } : { tag: "Var", id };
}

export function resetVarCounter(): void {
  _nextId = 0;
}

export function isMono(t: Type): boolean {
  switch (t.tag) {
    case "Var": return false;
    case "Prim": case "Atom": case "Unknown": case "Inputmap": case "ErrRow": return true;
    case "Named": return t.args.every(isMono);
    case "Fn": return t.params.every(isMono) && isMono(t.ret);
    case "SagaFn": return t.params.every(isMono) && isMono(t.ret);
    case "Tuple": return t.elems.every(isMono);
    case "Record": return t.fields.every(f => isMono(f.type));
    case "Tainted": return isMono(t.inner);
    case "Async": case "Stream": return isMono(t.inner);
    case "Refinement": return isMono(t.base);
    case "United": return isMono(t.base);
  }
}

export function typeToString(t: Type): string {
  switch (t.tag) {
    case "Prim": return t.kind;
    case "Atom": return `:${t.name}`;
    case "Var": return t.name ? `'${t.name}` : `'t${t.id}`;
    case "Named":
      return t.args.length === 0 ? t.name : `${t.name}(${t.args.map(typeToString).join(", ")})`;
    case "Fn": {
      const eff = t.effects.length ? ` Effect [${t.effects.join(", ")}]` : "";
      return `(${t.params.map(typeToString).join(", ")}) ->${eff} ${typeToString(t.ret)}`;
    }
    case "SagaFn": return `saga ${t.name}(${t.params.map(typeToString).join(", ")}) -> ${typeToString(t.ret)}`;
    case "Inputmap": return t.name ? `inputmap ${t.name}` : "inputmap";
    case "Tuple": return `(${t.elems.map(typeToString).join(", ")})`;
    case "Record": return `{ ${t.fields.map(f => `${f.name}: ${typeToString(f.type)}`).join(", ")} }`;
    case "Tainted": return `Tainted(${typeToString(t.inner)}, ${t.source})`;
    case "Async": return `Async(${typeToString(t.inner)})`;
    case "Stream": return `Stream(${typeToString(t.inner)})`;
    case "Refinement": return t.pred;   // the refinement type's name (e.g. `Age`)
    case "United": return t.name ?? dimsToString(t.dims);   // `Meters` if declared, else the computed dimension `m/s`
    case "ErrRow":
      return t.entries.length === 0 ? "{}" :
        `{${t.entries.map(e => e.prose ? `prose ${e.name}` : e.payload ? `${e.name}(${typeToString(e.payload)})` : e.name).join(" | ")}}`;
    case "Unknown": return "?";
  }
}
