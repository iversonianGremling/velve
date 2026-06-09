// Shared call-argument resolution: maps positional + named arguments onto a
// function's declared parameters, fills defaults, and reports the standard
// diagnostics. Used by both the type-checker (A = Type) and the interpreter
// (A = Value), parameterised over the argument payload type `A`.
import type { Expr } from "./ast.js";

export interface ParamSlot {
  name: string;
  keywordOnly: boolean;
  default_?: Expr;
}

// Resolve a call against `params`, returning the fully-ordered positional
// argument vector (with defaults materialised via `fromDefault`). Errors are
// reported through `pushErr`; on error the returned vector may be short, which
// the caller's normal arity handling then surfaces too.
export function resolveNamedCall<A>(
  params: ParamSlot[],
  positional: A[],
  named: { name: string; value: A }[],
  fromDefault: (e: Expr) => A,
  pushErr: (msg: string) => void,
): A[] {
  const slots: (A | undefined)[] = new Array(params.length).fill(undefined);

  // 1. Bind positional args left-to-right. A positional landing on a
  //    keyword-only parameter (declared after `*`) is an error.
  for (let i = 0; i < positional.length; i++) {
    if (i >= params.length) { pushErr(`too many positional arguments (expected ${params.length})`); break; }
    if (params[i]!.keywordOnly) { pushErr(`'${params[i]!.name}' is keyword-only`); continue; }
    slots[i] = positional[i];
  }

  // 2. Bind named args by parameter name.
  for (const { name, value } of named) {
    const idx = params.findIndex(p => p.name === name);
    if (idx < 0) { pushErr(`unknown argument '${name}'`); continue; }
    if (slots[idx] !== undefined) { pushErr(`argument '${name}' supplied twice`); continue; }
    slots[idx] = value;
  }

  // 3. Fill defaults; any still-unbound parameter with no default is missing.
  const out: A[] = [];
  for (let i = 0; i < params.length; i++) {
    if (slots[i] !== undefined) out.push(slots[i]!);
    else if (params[i]!.default_) out.push(fromDefault(params[i]!.default_!));
    else pushErr(`missing argument '${params[i]!.name}'`);
  }
  return out;
}

// Whether a call needs full named/default resolution at all. A pure positional
// call to a function with no defaulted parameters takes the fast path and keeps
// currying / partial application untouched.
export function needsResolution(params: ParamSlot[] | undefined, namedCount: number): boolean {
  return !!params && (namedCount > 0 || params.some(p => p.default_ !== undefined));
}
