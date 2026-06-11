// The Velve type algebra. Every node in the typed AST carries a Type.
// Type variables (Var) are filled in during unification.

import type { Expr } from "./ast.js";

export type Effect = string; // capability name: "payment", "io", "memory", etc.

export type Type =
  | { tag: "Prim";       kind: "String" | "Number" | "Bool" | "Unit" }
  | { tag: "Atom";       name: string }                                   // :ok, :err, :pending …
  | { tag: "Var";        id: number; name?: string }                      // inference variable
  | { tag: "Named";      name: string; args: Type[] }                     // List(a), Result(a,e), Dict(k,v)
  | { tag: "Fn";         params: Type[]; ret: Type; effects: Effect[] }
  | { tag: "SagaFn";     name: string; params: Type[]; ret: Type }        // first-class saga — `go`/`resume`/call; name doubles as handle type
  | { tag: "Inputmap";   name: string; stream: string }                   // inputmap decl (SPEC §10.5) — nullary-callable (drain loop → Unit), accepted by `help`, layerable with `++` (same-stream only — the stream field makes cross-stream layering a check error). Like SagaFn, type-ness survives aliasing. Name is provenance: any two inputmaps unify.
  | { tag: "Tuple";      elems: Type[] }
  | { tag: "Record";     fields: Field[] }
  | { tag: "Tainted";    inner: Type; source: string }                    // §2.8
  | { tag: "Async";      inner: Type }                                    // Async(a) §2.10
  | { tag: "Stream";     inner: Type }                                    // Stream(a) §2.9
  | { tag: "Refinement"; base: Type; pred: string; args?: (Expr | null)[] }  // transparent to `base`; `pred` is the refinement type's name (look up predicate AST in REFINEMENTS). `args` carries dependent value-arguments aligned with the refinement's params, e.g. InBounds(listLength xs) → [listLength xs]
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
    case "ErrRow":
      return t.entries.length === 0 ? "{}" :
        `{${t.entries.map(e => e.prose ? `prose ${e.name}` : e.payload ? `${e.name}(${typeToString(e.payload)})` : e.name).join(" | ")}}`;
    case "Unknown": return "?";
  }
}
