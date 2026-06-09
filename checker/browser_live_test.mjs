// End-to-end LIVE test: the real velve interpreter mounted into a (fake) DOM, with
// real dispatched events re-running view() and reconciling — no replay, no jsdom.
// Run: node browser_live_test.mjs   (after `npx tsc`)
import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { Lowerer } from "./dist/lower.js";
import { Evaluator } from "./dist/eval.js";
import { mountLive } from "./dist/browser.js";

// ── Minimal but faithful DOM shim ────────────────────────────────────────────
class Txt { constructor(t) { this.isText = true; this.text = t; this.parent = null; } get textContent() { return this.text; } set textContent(t) { this.text = t; } }
class Style { constructor() { this.props = {}; } setProperty(k, v) { this.props[k] = v; } removeProperty(k) { delete this.props[k]; } }
class El {
  constructor(tag) { this.tag = tag; this.childNodes = []; this.style = new Style(); this.attrs = {}; this.id = ""; this.parent = null; this.listeners = {}; }
  get children() { return this.childNodes.filter(n => n instanceof El); }
  get textContent() { return this.childNodes.map(n => n.textContent).join(""); }
  set textContent(t) { this.childNodes.forEach(c => c.parent = null); const x = new Txt(t); x.parent = this; this.childNodes = t === "" ? [] : [x]; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  removeAttribute(k) { delete this.attrs[k]; if (k === "id") this.id = ""; }
  _detach(n) { const i = this.childNodes.indexOf(n); if (i >= 0) this.childNodes.splice(i, 1); }
  appendChild(n) { if (n.parent) n.parent._detach(n); n.parent = this; this.childNodes.push(n); return n; }
  insertBefore(n, ref) { if (n.parent) n.parent._detach(n); n.parent = this; const i = ref == null ? this.childNodes.length : this.childNodes.indexOf(ref); this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, n); return n; }
  remove() { if (this.parent) this.parent._detach(this); this.parent = null; }
  replaceWith(n) { const p = this.parent; if (!p) return; if (n.parent) n.parent._detach(n); const i = p.childNodes.indexOf(this); p.childNodes.splice(i, 1, n); n.parent = p; this.parent = null; }
  addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  async dispatchEvent(ev) { for (const fn of (this.listeners[ev] || [])) await fn({}); }
}
const doc = { createElement: t => new El(t), createTextNode: t => new Txt(t) };

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL " + m); } };
const parse = src => { const p = new Parser(); p.setLanguage(Velve); return new Lowerer("t").lower(p.parse(src)); };

// ── 1. Counter: clicks re-run view() and the count updates live ────────────────
{
  const ev = new Evaluator();
  await ev.loadModule(parse(readFileSync("runtime_counter_test.velve", "utf8")));
  const body = new El("body");
  const { root } = await mountLive(body, ev, "view", doc);
  const span = root.children[0], btn = root.children[1];

  ok(root.style.props["display"] === "flex", "root is flex (styled)");
  ok(root.style.props["background"] === "#0d1117", "root background styled");
  ok(span.textContent === "count 0", "initial count 0");
  ok(btn.id === "inc", "button id wired");
  ok(btn.style.props["background"] === "#4FC1FF", "button background styled");
  ok(btn.textContent === "Increment", "button label");

  await btn.dispatchEvent("click");
  ok(span.textContent === "count 1", "live: count 1 after 1 click");
  await btn.dispatchEvent("click");
  await btn.dispatchEvent("click");
  ok(span.textContent === "count 3", "live: count 3 after 3 clicks");
  ok(span === root.children[0], "node identity preserved (reconciled, not rebuilt)");
}

// ── 2. Keyed list: Add inserts ONE new row node, keeping existing ones ──────────
{
  const ev = new Evaluator();
  await ev.loadModule(parse(readFileSync("runtime_list_test.velve", "utf8")));
  const body = new El("body");
  const { root } = await mountLive(body, ev, "view", doc);
  const addBtn = root.children[0];
  const list = root.children[1];
  ok(list.children.length === 2, "list starts with 2 rows");
  const alpha = list.children[0];
  await addBtn.dispatchEvent("click");
  ok(list.children.length === 3, "live: 3 rows after Add");
  ok(list.children[2].textContent === "gamma", "live: new row is gamma");
  ok(list.children[0] === alpha, "existing row kept (keyed reconcile, not rebuilt)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
