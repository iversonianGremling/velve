// Event payloads, verified on jsdom: typing into an Input fires `on onInput e -> …`
// with the DOM event marshaled to a velve Event record, so `e.value` flows through
// the store and the greeting updates live.
// Run from checker/: node browser_event_test.mjs   (after tsc)
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
await ev.loadModule(parse(readFileSync("event_payload_test.velve", "utf8")));
await mountLive(doc.body, ev, "view", doc);

const field = doc.getElementById("field");
const greet = doc.getElementById("greet");
ok(!!field && !!greet, "input + greeting mounted");
ok(greet.textContent === "hello ", "initial greeting empty");

// Type "Ada": set the input value and fire an input event (as a browser would).
field.value = "Ada";
field.dispatchEvent(new dom.window.Event("input"));
const flush = () => new Promise(r => setImmediate(r));
for (let i = 0; i < 50 && greet.textContent !== "hello Ada"; i++) await flush();
ok(greet.textContent === "hello Ada", "e.value flowed through store → greeting 'hello Ada'");

// Type more — the handler keeps receiving the live value.
field.value = "Ada L";
field.dispatchEvent(new dom.window.Event("input"));
for (let i = 0; i < 50 && greet.textContent !== "hello Ada L"; i++) await flush();
ok(greet.textContent === "hello Ada L", "subsequent input updates greeting 'hello Ada L'");

console.log(`browser_event_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
