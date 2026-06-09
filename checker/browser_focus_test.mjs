// Live-host focus/scroll preservation, verified against a REAL headless DOM (jsdom).
// The interpreter mounts into jsdom; we focus an input + select text + scroll a
// container, then dispatch a click that REORDERS the keyed list (moving DOM nodes,
// which jsdom — like a real browser — blurs). mountLive must restore focus,
// selection, and scroll. Run from checker/: node browser_focus_test.mjs (after tsc).
import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Lowerer } from "./dist/lower.js";
import { Evaluator } from "./dist/eval.js";
import { mountLive } from "./dist/browser.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL " + m); } };
const parse = src => { const p = new Parser(); p.setLanguage(Velve); return new Lowerer("t").lower(p.parse(src)); };

const dom = new JSDOM("<!DOCTYPE html><body></body>");
const doc = dom.window.document;

const ev = new Evaluator();
await ev.loadModule(parse(readFileSync("browser_focus_fixture.velve", "utf8")));
await mountLive(doc.body, ev, "view", doc);

// Initial: [alpha, beta, gamma]
const list = doc.getElementById("list");
ok(!!doc.getElementById("alpha"), "input alpha mounted");
ok([...list.children].map(c => c.id).join(",") === "alpha,beta,gamma", "initial order");
ok(doc.getElementById("alpha").value === "alpha", "input value set");

// Control (on a throwaway node, so the mounted tree stays intact): moving a focused
// node in jsdom blurs it — confirming preservation is real work, not a no-op.
const probe = doc.createElement("input"); probe.id = "probe"; doc.body.appendChild(probe);
probe.focus();
ok(doc.activeElement === probe, "control: probe focused");
const sink = doc.createElement("div"); doc.body.appendChild(sink); sink.appendChild(probe);
ok(doc.activeElement !== probe, "control: moving a node blurs it (jsdom is faithful)");
probe.remove(); sink.remove();

// Focus the 'alpha' input (still in its original slot), select chars 1..3, scroll.
const alpha = doc.getElementById("alpha");
alpha.focus();
alpha.setSelectionRange(1, 3);
list.scrollTop = 50;
ok(doc.activeElement === alpha, "alpha focused before reorder");

// Reorder via the flip button → [gamma, beta, alpha]; nodes move, focus would drop.
// jsdom's dispatchEvent is synchronous and does NOT await the async velve handler
// (applyFn → settle → rerender), so flush microtasks until the reorder lands.
const flip = doc.getElementById("flip");
flip.dispatchEvent(new dom.window.Event("click"));
const flush = () => new Promise(r => setImmediate(r));
for (let i = 0; i < 50 && [...list.children][0]?.id !== "gamma"; i++) await flush();

ok([...list.children].map(c => c.id).join(",") === "gamma,beta,alpha", "reordered to gamma,beta,alpha");
const alpha2 = doc.getElementById("alpha");
ok(alpha2 && alpha2.value === "alpha", "alpha input still present after reorder");
ok(doc.activeElement === alpha2, "FOCUS preserved on alpha across reorder");
ok(alpha2.selectionStart === 1 && alpha2.selectionEnd === 3, "SELECTION (1,3) preserved");
ok(doc.getElementById("list").scrollTop === 50, "SCROLL position preserved");

console.log(`browser_focus_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
