// emitjs.ts — Velve Core IR → JavaScript (D1(i)).
//
// The first of the "two representations" Decision 2 promises: this emitter maps the
// neutral IR onto JS. Numerics become JS `number` (the width tag is *dropped* — a
// native/WASM emitter would read the same IR and select a machine width instead).
// The pure compute spine has no `Perform`, so the output is plain synchronous JS.
//
// Correctness is defined DIFFERENTIALLY: the compiled program must print
// byte-identically to `eval.ts` (the never-deleted reference semantics). So the
// prelude's `$show` mirrors `value.ts`'s `display`, and the operator table mirrors
// `eval.ts`'s `evalBinOp`, exactly.

import type { IRModule, IRFn, IRExpr, IRComp, IRForClause, IRAtom, IRLit } from "./core.js";

// Operator → JS operator. Mirrors eval.ts evalBinOp: `^` is power (NOT bitwise xor),
// `++` is string concat (lists are out of core), `==`/`!=` are strict on the spine's
// primitives. Unary ops are prefixed `u` by the lowerer.
const OP: Record<string, string> = {
  "+": "+", "-": "-", "*": "*", "/": "/", "%": "%", "**": "**", "^": "**",
  "<": "<", ">": ">", "<=": "<=", ">=": ">=", "==": "===", "!=": "!==", "++": "+",
};

// `$show` mirrors value.ts `display` for the spine's value set (Num/Str/Bool/Unit);
// `$unit` is the runtime witness of `()`. Internal names are `$`-prefixed so a user
// `def` can never collide with them. Each builtin is emitted only if the module does
// not shadow its name with a `def`.
const BUILTIN_IMPL: Record<string, string> = {
  print:    "(...a) => { const s = a.map($show).join(' '); (typeof process !== 'undefined' && process.stdout) ? process.stdout.write(s) : console.log(s); return $unit; }",
  println:  "(...a) => { console.log(a.map($show).join(' ')); return $unit; }",
  toString: "(v) => $show(v)",
  abs:      "Math.abs", floor: "Math.floor", ceil: "Math.ceil",
  round:    "Math.round", sqrt: "Math.sqrt",
  // wrapped (not bare `Math.trunc`) so the const's inferred `.name` is "int", not
  // "trunc" — a first-class `int` reference must display `<fn:int>` like eval's VBuiltin.
  int:      "(x) => Math.trunc(x)",
  max:      "(a, b) => Math.max(a, b)", min: "(a, b) => Math.min(a, b)",
  // `length` mirrors eval: a list's element count, or a string's char count.
  length:   "(v) => (v && v.$t === 'L') ? v.es.length : v.length",
  isEmpty:  "(v) => v.es.length === 0",
};

function lit(l: IRLit): string {
  switch (l.t) {
    case "Num":  return String(l.v);
    case "Str":  return JSON.stringify(l.v);
    case "Bool": return l.v ? "true" : "false";
    case "Unit": return "$unit";
    // `$atom` interns by name, so two `:red`s are the SAME object and `===` is by-name.
    case "Atom": return `$atom(${JSON.stringify(l.name)})`;
  }
}

function atom(a: IRAtom): string {
  return a.k === "Var" ? a.name : lit(a.lit);
}

function comp(c: IRComp): string {
  switch (c.k) {
    case "Atom": return atom(c.atom);
    case "Call": return `${c.await ? "await " : ""}${c.fn}(${c.args.map(atom).join(", ")})`;
    case "PrimOp": {
      const a = c.args.map(atom);
      const j = OP[c.op];
      if (j) return `(${a[0]} ${j} ${a[1]})`;
      if (c.op === "u-") return `(-${a[0]})`;
      if (c.op === "u!" || c.op === "unot") return `(!${a[0]})`;
      throw new Error(`emitjs: unknown PrimOp '${c.op}'`);
    }
    case "Tuple": return `$tuple(${c.elems.map(atom).join(", ")})`;
    case "Proj":  return `${atom(c.tuple)}.es[${c.index}]`;
    case "Ctor":  return `$ctor(${JSON.stringify(c.name)}, ${c.payload ? atom(c.payload) : "null"})`;
    case "CtorName":    return `${atom(c.ctor)}.name`;
    case "CtorPayload": return `${atom(c.ctor)}.payload`;
    // `e is Name` (D1(xxi)) — eval's `v.tag === "VCtor" && v.name === name`. The `!= null`
    // guard (not `&&`) keeps a falsy primitive subject — `0`, `""`, `false` — returning a
    // proper `false` rather than leaking the operand, so `$show` prints "false" not "0".
    case "CtorTest":    return `(${atom(c.ctor)} != null && ${atom(c.ctor)}.$t === "C" && ${atom(c.ctor)}.name === ${JSON.stringify(c.name)})`;
    case "Record": {
      const fs = c.fields.map(f => `${JSON.stringify(f.name)}: ${atom(f.value)}`);
      const body = c.spread ? [`...${atom(c.spread)}.fs`, ...fs] : fs;
      return `$record({ ${body.join(", ")} })`;
    }
    case "Field": return `${atom(c.obj)}.fs[${JSON.stringify(c.field)}]`;
    case "List":  return `$list(${c.elems.map(atom).join(", ")})`;
    case "Index": return `${atom(c.obj)}.es[${atom(c.index)}]`;
    // A closure: a JS arrow whose body is the same statement spine a `def` emits. It
    // closes over enclosing consts lexically — eval's VFn-over-env, exactly. Wrapped in
    // `$lam` (identity) so the arrow sits in argument position and JS infers NO `.name`
    // for it — a let-bound lambda would otherwise inherit its binding's name, but eval
    // displays every lambda as `<fn:<lambda>>` regardless of binding. `$show` then reads
    // `.name`: empty ⇒ `<lambda>` (a lambda), set ⇒ the def's name (a `def` reference).
    case "Lambda": return `$lam((${c.params.join(", ")}) => {\n${body(c.body, "    ")}\n  })`;
    // A value-producing conditional (the lazy `if` short-circuit `&&`/`||` lower to). A
    // JS ternary is itself short-circuit — the untaken branch is never evaluated — so a
    // `&&`/`||`'s right operand runs only when the left lets control reach it, matching
    // eval's laziness. A trivial branch (just a `Ret`) emits as its atom; a branch with
    // its own `Let`/`If` spine wraps in an arrow-IIFE returning the value.
    case "Cond": return `(${atom(c.cond)} ? ${exprValue(c.then)} : ${exprValue(c.else_)})`;
    // Reify a value-`IRExpr` (a `match` decision-spine) as a value — `exprValue` wraps a
    // non-trivial spine in an arrow-IIFE returning the branch value, an atom if trivial.
    case "Block": return exprValue(c.body);
    // A list comprehension (D1(xvii)). An arrow-IIFE accumulates into `$acc`: each
    // generator becomes a `for…of` over its source's `.es` (the JS list backing array),
    // each filter an `if`, and the body a `$acc.push(…)` at the innermost depth — the
    // nesting IS eval's left-to-right clause recursion (a cartesian product pruned by
    // filters). The result is a fresh `$list` value.
    case "For": return `(() => {\n  const $acc = [];\n${forClauses(c.clauses, 0, c.body, "  ")}  return { $t: "L", es: $acc };\n})()`;
    // An integer range (D1(xviii)) — a `$range` fill producing the same `$list` value a
    // literal `[…]` builds (eval's VList-of-VNum). `inclusive` picks `..=` vs `..`.
    case "Range": return `$range(${atom(c.from)}, ${atom(c.to)}, ${c.inclusive})`;
    // An unbounded loop (D1(xx)) — an IIFE around a labeled `while (true)`. `break v` sets the
    // result `$r` and labeled-breaks out; bare `break` leaves `$r` at its `$unit` default;
    // `continue` re-iterates; falling off the body's end re-iterates too (the `while (true)`).
    // The IIFE scopes `$r`/`$loop` per loop, so nested loops (each its own IIFE) never collide.
    case "Loop": return `(() => {\n  let $r = $unit;\n  $loop: while (true) {\n${loopBody(c.body, "    ")}  }\n  return $r;\n})()`;
    // A `try` block (D1(xxiv)) — an IIFE yielding a Result. The body (built by `tryBlock`) is a
    // `mut last` accumulator spine: each line auto-peels (returns a failure raw, else updates
    // `last`), ending `return $tryWrap(last)`. A `?` inside emits its usual `return`, landing in
    // THIS IIFE — exactly eval's ReturnSignal catch.
    case "Try": return `(() => {\n${body(c.body, "  ")}\n})()`;
    // A unary prelude-helper call — the `try` peel primitives ($isFail / $peelVal / $tryWrap).
    case "Helper": return `${c.name}(${atom(c.arg)})`;
    // `go expr` (D2b) — spawn the deferred body on the scheduler; returns a future synchronously,
    // so `go` needs no `await` and is legal in any position. The arrow is `async` (its own fn
    // boundary), so awaits inside the spawned body are fine.
    case "Go": return `$sched.spawn(async () => {\n${body(c.body, "    ")}\n  })`;
    // `await fut` (D2b) — block on the future's value via the scheduler. Always inside an `async`
    // fn (the enclosing def uses `await` ⇒ it is colored async).
    case "AwaitFut": return `await $sched.awaitFuture(${atom(c.fut)})`;
  }
}

// Emit a loop BODY in statement mode. Differs from `body()` in three node kinds: a `Ret`
// (control fell off the body) emits nothing — the `while (true)` simply re-iterates and the
// trailing value is discarded, as eval discards each iteration's block value; a `Break` sets
// `$r` (when it carries a value) and labeled-breaks; a `Continue` labeled-continues. The
// structural nodes (`Let`/`Assign`/`IndexSet`/`If`/`Fail`) emit as in `body()` but recurse
// through `loopBody` so a nested `break`/`continue` stays in loop-statement mode.
function loopBody(e: IRExpr, indent: string): string {
  switch (e.k) {
    case "Ret": return "";
    case "Break": return e.value !== null ? `${indent}$r = ${atom(e.value)};\n${indent}break $loop;\n` : `${indent}break $loop;\n`;
    case "Continue": return `${indent}continue $loop;\n`;
    case "Let": return `${indent}${e.mut ? "let" : "const"} ${e.name} = ${comp(e.comp)};\n${loopBody(e.body, indent)}`;
    case "Assign": return `${indent}${e.name} = ${comp(e.comp)};\n${loopBody(e.body, indent)}`;
    case "IndexSet": return `${indent}${atom(e.obj)}.es[${atom(e.index)}] = ${atom(e.value)};\n${loopBody(e.body, indent)}`;
    case "If": return `${indent}if (${atom(e.cond)}) {\n${loopBody(e.then, indent + "  ")}${indent}} else {\n${loopBody(e.else_, indent + "  ")}${indent}}\n`;
    case "PropGuard":
      // Unreachable: the lowering refuses `?` inside a `loop` body (`noPropInValue`). Guarded
      // for exhaustiveness so a future regression surfaces loudly rather than silently.
      throw new Error("PropGuard inside a loop body");
    case "Fail": return `${indent}throw new Error(${JSON.stringify(e.msg)});\n`;
  }
}

// Fold a comprehension's clauses into nested `for…of` / `if`, bottoming out in a push of
// the body's value. Each generator iterates its source's `.es`; each filter guards the
// remaining nesting. Sources and conds are emitted via `exprValue` so a spine-bearing one
// (e.g. a generator over a `match` result) IIFE-wraps, and a later generator reading an
// earlier binding evaluates at the right depth.
function forClauses(clauses: IRForClause[], i: number, bodyE: IRExpr, indent: string): string {
  if (i === clauses.length) return `${indent}$acc.push(${exprValue(bodyE)});\n`;
  const cl = clauses[i]!;
  const inner = forClauses(clauses, i + 1, bodyE, indent + "  ");
  if (cl.k === "Filter")
    return `${indent}if (${exprValue(cl.cond)}) {\n${inner}${indent}}\n`;
  return `${indent}for (const ${cl.name} of ${exprValue(cl.iter)}.es) {\n${inner}${indent}}\n`;
}

// Emit an IRExpr as a single JS *expression* yielding its value — for a `Cond` branch.
// A bare `Ret` is just its atom; anything with a statement spine (`Let`/`If`) becomes an
// arrow-IIFE so the value is produced lazily, only when the ternary selects this branch.
function exprValue(e: IRExpr): string {
  if (e.k === "Ret") return atom(e.atom);
  return `(() => {\n${body(e, "    ")}\n  })()`;
}

// Emit a function body as a block of statements terminating in a `return`.
function body(e: IRExpr, indent: string): string {
  switch (e.k) {
    case "Ret":
      return `${indent}return ${atom(e.atom)};`;
    case "Let":
      // `mut` ⇒ a reassignable `let`; otherwise `const`. Same binding either way.
      return `${indent}${e.mut ? "let" : "const"} ${e.name} = ${comp(e.comp)};\n${body(e.body, indent)}`;
    case "Assign":
      // Reassign an existing `mut` binding (eval's env.set). Yields Unit — the body that
      // follows carries the block's value (RET_UNIT when the reassignment was last).
      return `${indent}${e.name} = ${comp(e.comp)};\n${body(e.body, indent)}`;
    case "IndexSet":
      // In-place list-element write `xs[i] = v` (eval's `elems[i] = v`). The list is backed
      // by a real `.es` array, so the mutation is identical. Yields Unit via the continuation.
      return `${indent}${atom(e.obj)}.es[${atom(e.index)}] = ${atom(e.value)};\n${body(e.body, indent)}`;
    case "If":
      return `${indent}if (${atom(e.cond)}) {\n${body(e.then, indent + "  ")}\n${indent}} else {\n${body(e.else_, indent + "  ")}\n${indent}}`;
    case "Break":
    case "Continue":
      // `break`/`continue` only arise inside a loop body, which `loopBody` (not `body`) emits.
      // Reaching here means a loop node leaked into value/def-body position — a lowering bug.
      throw new Error(`${e.k} outside a loop body`);
    case "PropGuard":
      // `e?`: early-return the value when it is an `Error` ctor (eval's ReturnSignal). The
      // `return` exits the enclosing JS function — the lowering refuses `?` anywhere this
      // would sit inside a value IIFE, so reaching here always means the real function body.
      return `${indent}if (${atom(e.ctor)}.name === "Error") return ${atom(e.ctor)};\n${body(e.body, indent)}`;
    case "Fail":
      // The non-exhaustive fall-through. Unreachable on check-passing programs (the
      // `exhaust` pass guarantees coverage); emitted as a hard throw so a future
      // gap surfaces loudly rather than returning `undefined`.
      return `${indent}throw new Error(${JSON.stringify(e.msg)});`;
  }
}

function fn(f: IRFn): string {
  // An effectful def (non-empty Effect row) emits `async` (D2a); its calls to other effectful
  // defs are `await`ed. The effect system makes any awaited call sit inside an effectful (async)
  // function, so `await` is always syntactically legal.
  return `${f.async ? "async " : ""}function ${f.name}(${f.params.join(", ")}) {\n${body(f.body, "  ")}\n}`;
}

// Emit a complete, self-contained JS module. When `callMain` and the module has a
// `main`, append the entry call so the text runs standalone under node.
export function emitModule(mod: IRModule, callMain = true): string {
  const userNames = new Set(mod.fns.map(f => f.name));
  const prelude = [
    '"use strict";',
    '// velve-core → js (D1) — values are JS primitives; the width tag is dropped here.',
    'const $unit = Symbol("unit");',
    '// Heap values carry a `$t` tag so $show dispatches to value.ts `display` exactly.',
    'const $tuple = (...es) => ({ $t: "T", es });',
    '// A tagged variant: nullary ⇒ payload null (displays as the bare name).',
    'const $ctor = (name, payload) => ({ $t: "C", name, payload });',
    '// A record: fields in a plain object, whose key-insertion order is the display order.',
    'const $record = (fs) => ({ $t: "R", fs });',
    '// A list: elements in a JS array tagged for $show — displays `[a, b, …]`.',
    'const $list = (...es) => ({ $t: "L", es });',
    '// An integer range fill `from..to` — `inc` ⇒ inclusive upper bound (`..=`), else',
    '// exclusive; steps +1 from `from`, empty when descending. Same `$list` value a',
    '// literal `[…]` builds, matching eval\'s VList-of-VNum.',
    'const $range = (from, to, inc) => { const es = []; const end = inc ? to : to - 1; for (let i = from; i <= end; i++) es.push(i); return { $t: "L", es }; };',
    '// `try` peel primitives (D1(xxiv)). $isFail: an `Error`/`None` ctor (collapses the block);',
    '// $peelVal: an `Ok`\'s payload, else the value as-is; $tryWrap: wrap a final value `Ok(...)`',
    '// unless it is already a Result.',
    'const $isFail = (v) => v != null && v.$t === "C" && (v.name === "Error" || v.name === "None");',
    'const $peelVal = (v) => (v != null && v.$t === "C" && v.name === "Ok") ? v.payload : v;',
    'const $tryWrap = (v) => (v != null && v.$t === "C" && (v.name === "Ok" || v.name === "Error")) ? v : $ctor("Ok", v);',
    '// Identity wrapper: keeps a lambda anonymous (arg-position ⇒ no inferred `.name`),',
    '// so $show shows `<fn:<lambda>>` while a `def` reference keeps its real name.',
    'const $lam = (f) => f;',
    '// An atom `:name`, INTERNED so two `:red`s are the same object ⇒ `===` is by-name,',
    '// matching eval\'s VAtom equality; displays `:name`.',
    'const $atomTable = new Map();',
    'const $atom = (n) => { let a = $atomTable.get(n); if (a === undefined) { a = { $t: "A", name: n }; $atomTable.set(n, a); } return a; };',
    'const $show = (v) => v === $unit ? "()" : (v && v.$t === "T") ? "(" + v.es.map($show).join(", ") + ")" : (v && v.$t === "C") ? (v.payload !== null ? v.name + "(" + $show(v.payload) + ")" : v.name) : (v && v.$t === "R") ? "{ " + Object.entries(v.fs).map(([k, val]) => k + ": " + $show(val)).join(", ") + " }" : (v && v.$t === "L") ? "[" + v.es.map($show).join(", ") + "]" : (v && v.$t === "A") ? ":" + v.name : typeof v === "function" ? "<fn:" + (v.name || "<lambda>") + ">" : typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "string" ? v : String(v);',
    ...Object.entries(BUILTIN_IMPL)
      .filter(([name]) => !userNames.has(name))
      .map(([name, impl]) => `const ${name} = ${impl};`),
  ];
  // The async scheduler (D2b) — a verbatim port of checker/src/scheduler.ts (Future + Scheduler),
  // emitted ONLY when the module uses `go`/`await` (keeps every non-concurrent program byte-identical).
  // It is pure virtual time (no setTimeout/Date.now): determinism is JS microtask FIFO + a stable sort
  // of the virtual-timer array, identical to eval's own scheduler — so ordering/timing match by construction.
  if (mod.usesScheduler) prelude.push(SCHEDULER_PRELUDE);
  const out = [prelude.join("\n"), ...mod.fns.map(fn)];
  // The entry call. A concurrent module drives `main` under the scheduler (so the virtual clock can
  // advance) exactly as eval's `run()` does; a plain module keeps the synchronous fire-and-forget call.
  if (callMain && mod.hasMain) out.push(mod.usesScheduler ? "$sched.run($sched.spawn(async () => await main()));" : "main();");
  return out.join("\n\n") + "\n";
}

// Verbatim port of checker/src/scheduler.ts (Future + Scheduler), with `Value` → JS values and
// `{tag:"VUnit"}` → `$unit`. See that file for the design notes; the logic here is 1:1.
const SCHEDULER_PRELUDE = [
  '// The async scheduler (D2b) — a verbatim port of src/scheduler.ts; pure virtual time.',
  'class $Future {',
  '  constructor() { this.done = false; this.value = undefined; this.error = undefined; this.waiters = []; }',
  '  resolve(v) { if (this.done) return; this.done = true; this.value = v; const ws = this.waiters; this.waiters = []; for (const w of ws) w.resolve(v); }',
  '  reject(e) { if (this.done) return; this.done = true; this.error = e; const ws = this.waiters; this.waiters = []; for (const w of ws) w.reject(e); }',
  '  get() { if (this.error !== undefined) throw this.error; return this.value === undefined ? $unit : this.value; }',
  '  promise() { if (this.done) return this.error !== undefined ? Promise.reject(this.error) : Promise.resolve(this.get()); return new Promise((resolve, reject) => this.waiters.push({ resolve, reject })); }',
  '}',
  'const $drain = () => new Promise(r => setImmediate(r));',
  'const $sched = {',
  '  clock: 0,',
  '  timers: [],',
  '  now() { return this.clock; },',
  '  spawn(run) { const fut = new $Future(); (async () => { try { fut.resolve(await run()); } catch (e) { fut.reject(e); } })(); return fut; },',
  '  awaitFuture(fut) { return fut.promise(); },',
  '  awaitFirst(futs) { return Promise.race(futs.map(f => f.promise())); },',
  '  sleep(ms) { const target = this.clock + Math.max(0, ms); return new Promise(resolve => this.timers.push({ time: target, resolve })); },',
  '  never() { return new Promise(() => {}); },',
  '  async run(root) { await $drain(); while (!root.done && this.timers.length > 0) { this.timers.sort((a, b) => a.time - b.time); const t = this.timers.shift(); this.clock = Math.max(this.clock, t.time); t.resolve(); await $drain(); } },',
  '};',
].join("\n");
