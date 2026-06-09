// ── Retained runtime: reconciliation (styles-design §8) ───────────────────────
// `view = f(state)` is pure, so the runtime never mutates the DOM by hand: it
// re-runs `view()` after each event and DIFFS the new tree against the live one,
// emitting a minimal patch list. A browser host applies those patches (preserving
// focus/scroll/identity); the headless driver (`interactive` in eval.ts) prints
// them, which is how the loop is tested. This module is the pure diff — no eval,
// no I/O.

import type { Value } from "./value.js";
import { unitToCss, asText, renderHtml } from "./render.js";

type EVal = Extract<Value, { tag: "VElement" }>;

export type Patch =
  | { op: "setProp";     path: string; name: string; value: string }
  | { op: "removeProp";  path: string; name: string }
  | { op: "setText";     path: string; text: string }
  | { op: "replace";     path: string; html: string }
  | { op: "insertChild"; path: string; index: number; html: string }
  | { op: "removeChild"; path: string; index: number }
  | { op: "moveChild";   path: string; key: string; from: number; to: number };

// A prop value's flat string form (same path the HTML/model emitters use).
const propStr = (v: Value): string => unitToCss(v) ?? asText(v);
// A node's inline text content, or null if it has none.
const textOf = (el: EVal): string | null => (el.text ? asText(el.text) : null);
// Element children, flattening one level of VList (dynamic `{xs |> map …}`),
// dropping VUnit — the same normalization `converge`/`render` use.
const childList = (el: EVal): Value[] => {
  const out: Value[] = [];
  for (const c of el.children) {
    if (c.tag === "VList") out.push(...c.elems);
    else if (c.tag !== "VUnit") out.push(c);
  }
  return out;
};
// A stable identity for a child, from an `id` or `key` string prop (else null).
const keyOf = (v: Value): string | null => {
  if (v.tag !== "VElement") return null;
  const k = v.props.get("id") ?? v.props.get("key");
  return k && k.tag === "VStr" ? k.v : null;
};
const childPath = (path: string, i: number): string => (path === "" ? String(i) : `${path}/${i}`);
// One-line HTML summary for a patch payload.
const summary = (v: Value): string => {
  const s = renderHtml(v).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "…" : s;
};

export function diff(oldV: Value, newV: Value, path = ""): Patch[] {
  // Type/name mismatch → replace the whole node.
  if (oldV.tag !== "VElement" || newV.tag !== "VElement") {
    if (oldV.tag === "VElement" || newV.tag === "VElement" || asText(oldV) !== asText(newV))
      return [{ op: "replace", path, html: summary(newV) }];
    return [];
  }
  if (oldV.name !== newV.name) return [{ op: "replace", path, html: summary(newV) }];

  const patches: Patch[] = [];

  // Props: added/changed → setProp; dropped → removeProp.
  for (const [k, v] of newV.props) {
    const o = oldV.props.get(k);
    const nv = propStr(v);
    if (o === undefined || propStr(o) !== nv) patches.push({ op: "setProp", path, name: k, value: nv });
  }
  for (const k of oldV.props.keys())
    if (!newV.props.has(k)) patches.push({ op: "removeProp", path, name: k });

  // Inline text.
  const ot = textOf(oldV), nt = textOf(newV);
  if (ot !== nt && nt !== null) patches.push({ op: "setText", path, text: nt });
  else if (ot !== nt && nt === null) patches.push({ op: "setText", path, text: "" });

  // Children — keyed when every child carries an id/key, else positional.
  const oldKids = childList(oldV), newKids = childList(newV);
  const allKeyed = (xs: Value[]) => xs.length > 0 && xs.every(x => keyOf(x) !== null);
  if (allKeyed(oldKids) && allKeyed(newKids)) {
    const oldByKey = new Map(oldKids.map((c, i) => [keyOf(c)!, { c, i }]));
    const newByKey = new Map(newKids.map((c, i) => [keyOf(c)!, { c, i }]));
    for (const [key, { i }] of oldByKey)
      if (!newByKey.has(key)) patches.push({ op: "removeChild", path, index: i });
    newKids.forEach((c, i) => {
      const key = keyOf(c)!;
      const prev = oldByKey.get(key);
      if (!prev) { patches.push({ op: "insertChild", path, index: i, html: summary(c) }); return; }
      if (prev.i !== i) patches.push({ op: "moveChild", path, key, from: prev.i, to: i });
      patches.push(...diff(prev.c, c, childPath(path, i)));
    });
  } else {
    const n = Math.min(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++) patches.push(...diff(oldKids[i]!, newKids[i]!, childPath(path, i)));
    for (let i = n; i < newKids.length; i++) patches.push({ op: "insertChild", path, index: i, html: summary(newKids[i]!) });
    for (let i = n; i < oldKids.length; i++) patches.push({ op: "removeChild", path, index: i });
  }
  return patches;
}

// Soft warning (§8): a dynamic list (VList) of elements without keys reconciles
// positionally, which is fragile under reorder. Full affine enforcement (a keyless
// dynamic `for` as a compile error) is deferred.
export function keylessListWarnings(root: Value): string[] {
  const warns: string[] = [];
  const walk = (v: Value): void => {
    if (v.tag !== "VElement") return;
    for (const c of v.children)
      if (c.tag === "VList" && c.elems.some(e => e.tag === "VElement" && keyOf(e) === null))
        warns.push(`⚠ dynamic list under ${v.name} has no key — reconciliation falls back to position`);
    for (const c of childList(v)) walk(c);
  };
  walk(root);
  return warns;
}

export function patchLabel(p: Patch): string {
  const at = (path: string) => (path === "" ? "(root)" : path);
  switch (p.op) {
    case "setProp":     return `setProp     ${at(p.path)} ${p.name}=${p.value}`;
    case "removeProp":  return `removeProp  ${at(p.path)} ${p.name}`;
    case "setText":     return `setText     ${at(p.path)} ${JSON.stringify(p.text)}`;
    case "replace":     return `replace     ${at(p.path)} ${p.html}`;
    case "insertChild": return `insertChild ${at(p.path)}[${p.index}] ${p.html}`;
    case "removeChild": return `removeChild ${at(p.path)}[${p.index}]`;
    case "moveChild":   return `moveChild   ${at(p.path)} key=${p.key} ${p.from}->${p.to}`;
  }
}
