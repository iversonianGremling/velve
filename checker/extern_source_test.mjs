// The input unlock: host JS pushes into a velve stream from the REAL event loop
// (setImmediate, standing in for a DOM/MIDI/timer callback), and a velve consumer
// parked on `await` receives them — no virtual-clock scheduler involved.
// Run from checker/: node extern_source_test.mjs   (after tsc)
import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { Lowerer } from "./dist/lower.js";
import { Evaluator } from "./dist/eval.js";

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.log("FAIL " + m); } };

const src = `
def collect(s: Stream(Number), acc: List(Number)): List(Number)
  await s
    | Push v -> collect(s, acc ++ [v])
    | Done -> acc
`;
const p = new Parser(); p.setLanguage(Velve);
const mod = new Lowerer("t").lower(p.parse(src));
const ev = new Evaluator();
await ev.loadModule(mod);

// Host creates an injectable stream and hands it to the velve consumer.
const { stream, pushJs, done } = ev.makeStream();
const collect = ev.global("collect");
const result = ev.applyFn(collect, [stream, { tag: "VList", elems: [] }], "collect"); // parks on `await s`

// Real-world async injection, interleaved with the parked consumer.
await new Promise(r => setImmediate(r));
pushJs(10); pushJs(20);
await new Promise(r => setImmediate(r));
pushJs(30);
done();

const out = await result;
const got = (out.elems ?? []).map(e => e.v);
ok(JSON.stringify(got) === "[10,20,30]", "consumer received host-injected [10,20,30], got " + JSON.stringify(got));

console.log(`extern_source_test: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
