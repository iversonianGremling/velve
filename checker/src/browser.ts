// ── Live browser runtime (styles-design §8, live host) ────────────────────────
// The REAL live host: the velve interpreter runs in the browser (its AST shipped
// from a Node build step — parsing is native, evaluation is plain JS), so a DOM
// event re-runs the actual `view()` and the change is reconciled into the live DOM.
// This is what the replay host (domhost.ts) was a stand-in for.
//
// It depends only on a structural `document` (real `document` or a test shim), so
// it has no Node dependencies and is verifiable in Node with a fake DOM. Styling
// goes through the SAME prop→CSS helpers as the server renderer (render.ts), so the
// live DOM matches the SSR output exactly.

import type { Value } from "./value.js";
import type { Evaluator } from "./eval.js";
import { unitToCss, asText, propToCss, tagFor, isKnownTag, flexDir } from "./render.js";

type EVal = Extract<Value, { tag: "VElement" }>;
/* eslint-disable @typescript-eslint/no-explicit-any */ // DOM nodes are structural (no TS dom lib).

// `onClick` → `click`, `onMouseEnter` → `mouseenter`.
const domEvent = (e: string): string => e.replace(/^on/, "").toLowerCase();
const childVals = (v: EVal): Value[] => {
  const out: Value[] = [];
  for (const c of v.children) { if (c.tag === "VList") out.push(...c.elems); else if (c.tag !== "VUnit") out.push(c); }
  return out;
};
const elemChildren = (v: EVal): EVal[] => childVals(v).filter((c): c is EVal => c.tag === "VElement");
const combinedText = (v: EVal): string =>
  (v.text ? asText(v.text) : "") + childVals(v).filter(c => c.tag !== "VElement").map(asText).join("");
const keyOf = (v: Value): string | null => {
  if (v.tag !== "VElement") return null;
  const k = v.props.get("id") ?? v.props.get("key");
  return k && k.tag === "VStr" ? k.v : null;
};

// Marshal a DOM event into the velve `Event` record (matches infer.ts's typed param
// and eval.ts's `emptyEvent`): `value`/`checked` come from the target input, `key`
// from a keyboard event. Bound to an `on … e ->` handler's param.
function eventRecord(domEv: any, el: any): Value {
  const t = domEv?.target ?? el;
  return { tag: "VRecord", fields: new Map<string, Value>([
    ["value",   { tag: "VStr",  v: String(t?.value ?? "") }],
    ["key",     { tag: "VStr",  v: String(domEv?.key ?? "") }],
    ["checked", { tag: "VBool", v: !!(t?.checked) }],
  ]) };
}

// VElement → a live DOM node, applying styles/attrs/text and WIRING event handlers
// (each `on …` becomes an addEventListener that runs the velve thunk, settles the
// stores, then re-renders). The wiring is what makes inserted subtrees live.
export function buildDom(v: Value, doc: any, ev: Evaluator, onEvent: () => Promise<void>): any {
  if (v.tag !== "VElement") return doc.createTextNode(asText(v));
  const el = doc.createElement(tagFor(v.name));
  if (!isKnownTag(v.name)) el.setAttribute("data-component", v.name);
  const fd = flexDir(v.name);
  if (fd) { el.style.setProperty("display", "flex"); el.style.setProperty("flex-direction", fd); }
  for (const [k, val] of v.props) {
    if (k === "key") continue;   // reconciliation identity, not a DOM attribute (see keyOf)
    const s = unitToCss(val) ?? asText(val);
    const css = propToCss(k, s);
    if (css) el.style.setProperty(css[0], css[1]); else el.setAttribute(k, s);
  }
  for (const [event, thunk] of v.events) {
    el.addEventListener(domEvent(event), async (domEv: any) => {
      await ev.applyFn(thunk, [eventRecord(domEv, el)], "event");
      await ev.settle();
      await onEvent();
    });
  }
  const kids = childVals(v);
  if (kids.some(c => c.tag === "VElement")) {
    if (v.text) el.appendChild(doc.createTextNode(asText(v.text)));
    for (const c of kids) el.appendChild(buildDom(c, doc, ev, onEvent));
  } else {
    const t = combinedText(v);
    if (t) el.textContent = t;
  }
  return el;
}

// Reconcile (oldV → newV) against the live DOM node; returns the current node
// (possibly replaced). New subtrees are built with `buildDom`, so their listeners
// are wired — this is reconciliation against a REAL DOM, not a string replay.
export function patchDom(dom: any, oldV: Value, newV: Value, doc: any, ev: Evaluator, onEvent: () => Promise<void>): any {
  if (oldV.tag !== "VElement" || newV.tag !== "VElement") {
    if (oldV.tag !== "VElement" && newV.tag !== "VElement") {
      if (asText(oldV) !== asText(newV)) dom.textContent = asText(newV);
      return dom;
    }
    const nd = buildDom(newV, doc, ev, onEvent); dom.replaceWith(nd); return nd;
  }
  if (oldV.name !== newV.name) { const nd = buildDom(newV, doc, ev, onEvent); dom.replaceWith(nd); return nd; }

  const sv = (val: Value) => unitToCss(val) ?? asText(val);
  for (const [k, val] of newV.props) {
    if (k === "key") continue;   // identity, not a DOM attribute
    const o = oldV.props.get(k);
    const s = sv(val);
    if (o === undefined || sv(o) !== s) { const css = propToCss(k, s); if (css) dom.style.setProperty(css[0], css[1]); else dom.setAttribute(k, s); }
  }
  for (const k of oldV.props.keys()) if (k !== "key" && !newV.props.has(k)) { const css = propToCss(k, ""); if (css) dom.style.removeProperty(css[0]); else dom.removeAttribute(k); }

  const oldKids = elemChildren(oldV), newKids = elemChildren(newV);
  if (newKids.length === 0) {
    const t = combinedText(newV);
    if (dom.textContent !== t) dom.textContent = t;
    return dom;
  }
  const allKeyed = (xs: EVal[]) => xs.length > 0 && xs.every(x => keyOf(x) !== null);
  if (allKeyed(oldKids) && allKeyed(newKids)) {
    const domByKey = new Map<string, any>();
    oldKids.forEach((c, i) => domByKey.set(keyOf(c)!, dom.children[i]));
    const oldByKey = new Map(oldKids.map(c => [keyOf(c)!, c] as const));
    for (const [key, dnode] of domByKey) if (!newKids.some(c => keyOf(c) === key)) dnode.remove();
    newKids.forEach((c, i) => {
      const key = keyOf(c)!;
      const prevV = oldByKey.get(key);
      const ref = dom.children[i] || null;
      if (!prevV) { dom.insertBefore(buildDom(c, doc, ev, onEvent), ref); return; }
      const node = patchDom(domByKey.get(key), prevV, c, doc, ev, onEvent);
      if (dom.children[i] !== node) dom.insertBefore(node, dom.children[i] || null);
    });
  } else {
    const n = Math.min(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++) patchDom(dom.children[i], oldKids[i]!, newKids[i]!, doc, ev, onEvent);
    for (let i = n; i < newKids.length; i++) dom.appendChild(buildDom(newKids[i]!, doc, ev, onEvent));
    while (dom.children.length > newKids.length) dom.children[dom.children.length - 1].remove();
  }
  return dom;
}

// Reconciliation moves/replaces DOM nodes, which the DOM spec says blurs a focused
// element and resets scroll. So before patching we snapshot the focused element (by
// its `id`, with its text-selection range) and the scroll offsets of every id'd
// element, then restore them after — keying off `id` so the *new* node that occupies
// the same logical slot regains focus/scroll, exactly like React's preservation.
interface FocusSnap { id: string; start: number | null; end: number | null }
function captureFocus(doc: any): FocusSnap | null {
  const a = doc.activeElement;
  if (!a || a === doc.body || !a.id) return null;
  return { id: a.id, start: a.selectionStart ?? null, end: a.selectionEnd ?? null };
}
function restoreFocus(doc: any, snap: FocusSnap | null): void {
  if (!snap) return;
  const next = doc.getElementById(snap.id);
  if (!next || doc.activeElement === next) return;
  next.focus?.();
  if (snap.start != null && next.setSelectionRange) {
    try { next.setSelectionRange(snap.start, snap.end ?? snap.start); } catch { /* not a text input */ }
  }
}
function captureScroll(doc: any): Map<string, [number, number]> {
  const m = new Map<string, [number, number]>();
  for (const el of doc.querySelectorAll?.("[id]") ?? [])
    if (el.scrollTop || el.scrollLeft) m.set(el.id, [el.scrollTop, el.scrollLeft]);
  return m;
}
function restoreScroll(doc: any, m: Map<string, [number, number]>): void {
  for (const [id, [t, l]] of m) {
    const el = doc.getElementById(id);
    if (el) { el.scrollTop = t; el.scrollLeft = l; }
  }
}

// Mount a live app: render `view()`, build + wire the DOM, and keep the current
// tree so each event re-runs `view()` and reconciles. Returns the root node and a
// manual `rerender` (handy for tests / external state changes).
export async function mountLive(rootEl: any, ev: Evaluator, viewName: string, doc: any): Promise<{ root: any; rerender: () => Promise<void> }> {
  const view = ev.global(viewName);
  if (!view) throw new Error(`mountLive: no '${viewName}' binding in module`);
  let tree = await ev.converge(await ev.applyFn(view, [], viewName));
  let dom: any;
  const rerender = async () => {
    const focus = captureFocus(doc);
    const scroll = captureScroll(doc);
    const next = await ev.converge(await ev.applyFn(view, [], viewName));
    dom = patchDom(dom, tree, next, doc, ev, rerender);
    tree = next;
    restoreScroll(doc, scroll);
    restoreFocus(doc, focus);
  };
  dom = buildDom(tree, doc, ev, rerender);
  rootEl.appendChild(dom);
  return { root: dom, rerender };
}

// Walk an existing server-rendered DOM node in lockstep with a freshly-evaluated
// VElement, attaching the `on …` handlers and recursing — reusing every node instead
// of rebuilding. Element children align by position (`elemChildren` matches the
// element-only `.children`); text nodes — including the server's pretty-print
// whitespace — are left untouched, consistent with how `patchDom` reconciles.
function hydrateDom(dom: any, vel: Value, ev: Evaluator, onEvent: () => Promise<void>): void {
  if (vel.tag !== "VElement") return;
  for (const [event, thunk] of vel.events)
    dom.addEventListener(domEvent(event), async (domEv: any) => {
      await ev.applyFn(thunk, [eventRecord(domEv, dom)], "event");
      await ev.settle();
      await onEvent();
    });
  const velKids = elemChildren(vel);
  const domKids = dom.children;
  const n = Math.min(velKids.length, domKids.length);
  for (let i = 0; i < n; i++) hydrateDom(domKids[i], velKids[i]!, ev, onEvent);
}

// SSR hydration: the page already holds the markup from `html(view())`. Re-run
// `view()`, then attach handlers + seed the reconciler against the EXISTING nodes
// (no rebuild, no flash) — fast first paint. velve's view is pure+deterministic, so
// the server and client trees match by construction (same AST + same initial store
// state). After hydration, events reconcile exactly as in `mountLive`.
export async function hydrate(rootEl: any, ev: Evaluator, viewName: string, doc: any): Promise<{ root: any; rerender: () => Promise<void> }> {
  const view = ev.global(viewName);
  if (!view) throw new Error(`hydrate: no '${viewName}' binding in module`);
  let tree = await ev.converge(await ev.applyFn(view, [], viewName));
  let dom = rootEl.firstElementChild ?? rootEl.children?.[0];
  if (!dom) return mountLive(rootEl, ev, viewName, doc); // nothing to hydrate → build fresh
  const rerender = async () => {
    const focus = captureFocus(doc);
    const scroll = captureScroll(doc);
    const next = await ev.converge(await ev.applyFn(view, [], viewName));
    dom = patchDom(dom, tree, next, doc, ev, rerender);
    tree = next;
    restoreScroll(doc, scroll);
    restoreFocus(doc, focus);
  };
  hydrateDom(dom, tree, ev, rerender);
  return { root: dom, rerender };
}
