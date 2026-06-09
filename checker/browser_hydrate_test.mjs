// SSR hydration, verified on a real headless DOM (jsdom): server-render the view to
// HTML (render.ts), inject it into the page, then hydrate with a FRESH "client"
// evaluator. Hydration must REUSE the existing server nodes (no rebuild/flash) and
// wire the handlers onto them, so a click drives a reconcile in place.
// Run from checker/: node browser_hydrate_test.mjs   (after tsc)
import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { Lowerer } from "./dist/lower.js";
import { Evaluator } from "./dist/eval.js";
import { renderHtml } from "./dist/render.js";
import { hydrate } from "./dist/browser.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL " + m); } };
const parse = src => { const p = new Parser(); p.setLanguage(Velve); return new Lowerer("t").lower(p.parse(src)); };

const mod = parse(readFileSync("runtime_counter_test.velve", "utf8"));
const dom = new JSDOM("<!DOCTYPE html><body><div id='app'></div></body>");
const doc = dom.window.document;
const app = doc.getElementById("app");

// ── "Server": render view() to HTML and put it in the page (no JS yet) ───────────
const serverEv = new Evaluator();
await serverEv.loadModule(mod);
const serverTree = await serverEv.converge(await serverEv.applyFn(serverEv.global("view"), [], "view"));
app.innerHTML = renderHtml(serverTree);

const serverRoot = app.firstElementChild;
const serverBtn = doc.getElementById("inc");
const serverSpan = serverRoot.children[0];
ok(!!serverBtn, "server HTML mounted a button");
ok(serverSpan.textContent === "count 0", "server HTML shows count 0");
ok(serverBtn.style.background === "#4FC1FF" || serverBtn.getAttribute("style")?.includes("#4FC1FF"), "server HTML carries styles");

// ── "Client": hydrate with a FRESH evaluator (separate store state, same initial) ─
const clientEv = new Evaluator();
await clientEv.loadModule(mod);
const { root } = await hydrate(app, clientEv, "view", doc);

// Hydration REUSED the server nodes (identity preserved — not rebuilt).
ok(root === serverRoot, "hydrate reused the server root node (no rebuild)");
ok(doc.getElementById("inc") === serverBtn, "hydrate reused the same button node");
ok(root.children[0] === serverSpan, "hydrate reused the same count span");

// Handlers were wired onto the existing nodes → a click reconciles in place.
serverBtn.dispatchEvent(new dom.window.Event("click"));
const flush = () => new Promise(r => setImmediate(r));
for (let i = 0; i < 50 && serverSpan.textContent !== "count 1"; i++) await flush();
ok(serverSpan.textContent === "count 1", "click after hydrate updates count → 1");
ok(root.children[0] === serverSpan, "count span is the SAME node after reconcile (patched, not replaced)");
ok(doc.getElementById("inc") === serverBtn, "button is the SAME node after reconcile");

console.log(`browser_hydrate_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
