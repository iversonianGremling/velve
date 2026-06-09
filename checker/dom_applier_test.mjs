// Unit test for the browser-host patch applier (domhost.ts APPLIER_JS) against a
// minimal DOM shim — verifies the protocol drives a real-shaped DOM without a
// browser. Run: node dom_applier_test.mjs  (after `npx tsc`).
import { APPLIER_JS } from "./dist/domhost.js";

class Style {
  constructor() { this.p = {}; }
  setProperty(k, v) { this.p[k] = v; }
  removeProperty(k) { delete this.p[k]; }
}
class El {
  constructor(tag) { this.tag = tag; this.children = []; this.style = new Style(); this.attrs = {}; this._t = ""; this.id = ""; this.parent = null; }
  get textContent() { return this._t; }
  set textContent(t) { this._t = t; this.children = []; }
  setAttribute(k, v) { this.attrs[k] = v; if (k === "id") this.id = v; }
  removeAttribute(k) { delete this.attrs[k]; }
  insertBefore(node, ref) { const i = ref ? this.children.indexOf(ref) : this.children.length; this.children.splice(i, 0, node); node.parent = this; }
  remove() { const i = this.parent?.children.indexOf(this); if (i >= 0) this.parent.children.splice(i, 1); }
}
const child = (parent, tag, id = "") => { const e = new El(tag); e.id = id; e.parent = parent; parent.children.push(e); return e; };

const { velveApply, velveNodeAt } = new Function(APPLIER_JS + "\nreturn { velveApply, velveNodeAt };")();

let pass = 0, fail = 0;
const eq = (got, want, msg) => { if (got === want) { pass++; } else { fail++; console.log(`FAIL ${msg}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`); } };

// Tree: root(div) > [ span#a, span#b, div > ... ]
const root = new El("div");
const a = child(root, "span", "a");
const b = child(root, "span", "b");
const box = child(root, "div");

// nodeAt
eq(velveNodeAt(root, ""), root, "nodeAt root");
eq(velveNodeAt(root, "1"), b, "nodeAt 1");
eq(velveNodeAt(root, "2"), box, "nodeAt 2");

// setText
velveApply(root, { op: "setText", path: "0", text: "hello" });
eq(a.textContent, "hello", "setText leaf");

// setProp — CSS prop with px, color without px, unknown -> attribute
velveApply(root, { op: "setProp", path: "1", name: "padding", value: "8" });
eq(b.style.p["padding"], "8px", "setProp px");
velveApply(root, { op: "setProp", path: "1", name: "background", value: "#000" });
eq(b.style.p["background"], "#000", "setProp color");
velveApply(root, { op: "setProp", path: "1", name: "role", value: "button" });
eq(b.attrs["role"], "button", "setProp unknown->attr");

// removeProp
velveApply(root, { op: "removeProp", path: "1", name: "padding" });
eq(b.style.p["padding"], undefined, "removeProp css");

// removeChild
velveApply(root, { op: "removeChild", path: "", index: 0 });
eq(root.children.length, 2, "removeChild count");
eq(root.children[0], b, "removeChild shifted");

// moveChild — move #b (now at 0) to index 1
velveApply(root, { op: "moveChild", path: "", key: "b", from: 0, to: 1 });
eq(root.children[1], b, "moveChild placed");

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
