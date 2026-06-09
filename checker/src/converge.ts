// ── The convergence layer (styles-design §6) ──────────────────────────────────
// A prop's value may reference *another* element's resolved prop, as long as the
// (element, property) references form no cycle. References use a fixed vocabulary:
//
//   self.P        this element's own resolved P
//   parent.P      the containing element's P
//   prev.P/next.P the adjacent element sibling in flow order
//   children.P    aggregate over element children — wrap in sum()/avg()/min()/max()
//
// A prop expression that mentions any of these scope names is *deferred* at eval
// time (stored as a VDeferred) and resolved here, in topological order, after the
// concrete tree exists. The graph is over (element instance, prop) PAIRS — see
// §6.2 for why "same prop" is too narrow (diagonal cycles on different props also
// deadlock). A cycle is reported with the offending edge.
//
// This module is the *pure* half: scanning a prop expression for references and
// the scope vocabulary. The resolver (which must evaluate expressions) lives on
// the Evaluator as `converge()`.

import type { Expr } from "./ast.js";

export type ConvScope = "self" | "parent" | "prev" | "next" | "children";
export const CONV_SCOPES: ReadonlySet<string> = new Set<ConvScope>([
  "self", "parent", "prev", "next", "children",
]);

export interface ConvRef {
  scope: ConvScope;
  prop: string;
}

// Direct sub-expressions of an expr (enough to find references anywhere a prop
// value realistically nests them: calls, operators, fields, collections, match).
function subExprs(e: Expr): Expr[] {
  switch (e.tag) {
    case "Call":      return [e.fn, ...e.args];
    case "BinOp":     return [e.left, e.right];
    case "UnOp":      return [e.expr];
    case "Field":     return [e.obj];
    case "Index":     return [e.obj, e.index];
    case "Lambda":    return [e.body];
    case "Match":     return [e.subject, ...e.branches.map(b => b.body)];
    case "If":        return e.else_ ? [e.cond, e.then, e.else_] : [e.cond, e.then];
    case "Range":     return [e.from, e.to];
    case "Tuple":     return e.elems;
    case "List":      return e.elems;
    case "Record":    return [...e.fields.map(f => f.value), ...(e.spread ? [e.spread] : [])];
    case "Propagate": return [e.expr];
    case "PropWith":  return [e.expr, e.alt];
    case "Await":     return [e.expr, ...e.branches.map(b => b.body)];
    case "Go":        return [e.expr];
    case "Drop":      return [e.expr];
    case "AddrOf":    return [e.expr];
    case "Deref":     return [e.expr];
    case "Send":      return [e.msg];
    default:          return [];
  }
}

// Every convergence reference (`scope.prop`) appearing anywhere in `e`.
export function scanConvRefs(e: Expr): ConvRef[] {
  const out: ConvRef[] = [];
  const visit = (x: Expr): void => {
    if (x.tag === "Field" && x.obj.tag === "Var" && CONV_SCOPES.has(x.obj.name))
      out.push({ scope: x.obj.name as ConvScope, prop: x.field });
    for (const c of subExprs(x)) visit(c);
  };
  visit(e);
  return out;
}

export function hasConvRef(e: Expr): boolean {
  // Cheap short-circuit (no allocation on the common no-reference path).
  if (e.tag === "Field" && e.obj.tag === "Var" && CONV_SCOPES.has(e.obj.name)) return true;
  for (const c of subExprs(e)) if (hasConvRef(c)) return true;
  return false;
}
