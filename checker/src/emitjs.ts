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

import type { IRModule, IRFn, IRExpr, IRComp, IRAtom, IRLit } from "./core.js";

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
  }
}

function atom(a: IRAtom): string {
  return a.k === "Var" ? a.name : lit(a.lit);
}

function comp(c: IRComp): string {
  switch (c.k) {
    case "Atom": return atom(c.atom);
    case "Call": return `${c.fn}(${c.args.map(atom).join(", ")})`;
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
  }
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
      return `${indent}const ${e.name} = ${comp(e.comp)};\n${body(e.body, indent)}`;
    case "If":
      return `${indent}if (${atom(e.cond)}) {\n${body(e.then, indent + "  ")}\n${indent}} else {\n${body(e.else_, indent + "  ")}\n${indent}}`;
    case "Fail":
      // The non-exhaustive fall-through. Unreachable on check-passing programs (the
      // `exhaust` pass guarantees coverage); emitted as a hard throw so a future
      // gap surfaces loudly rather than returning `undefined`.
      return `${indent}throw new Error(${JSON.stringify(e.msg)});`;
  }
}

function fn(f: IRFn): string {
  return `function ${f.name}(${f.params.join(", ")}) {\n${body(f.body, "  ")}\n}`;
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
    '// Identity wrapper: keeps a lambda anonymous (arg-position ⇒ no inferred `.name`),',
    '// so $show shows `<fn:<lambda>>` while a `def` reference keeps its real name.',
    'const $lam = (f) => f;',
    'const $show = (v) => v === $unit ? "()" : (v && v.$t === "T") ? "(" + v.es.map($show).join(", ") + ")" : (v && v.$t === "C") ? (v.payload !== null ? v.name + "(" + $show(v.payload) + ")" : v.name) : (v && v.$t === "R") ? "{ " + Object.entries(v.fs).map(([k, val]) => k + ": " + $show(val)).join(", ") + " }" : (v && v.$t === "L") ? "[" + v.es.map($show).join(", ") + "]" : typeof v === "function" ? "<fn:" + (v.name || "<lambda>") + ">" : typeof v === "boolean" ? (v ? "true" : "false") : typeof v === "string" ? v : String(v);',
    ...Object.entries(BUILTIN_IMPL)
      .filter(([name]) => !userNames.has(name))
      .map(([name, impl]) => `const ${name} = ${impl};`),
  ];
  const out = [prelude.join("\n"), ...mod.fns.map(fn)];
  if (callMain && mod.hasMain) out.push("main();");
  return out.join("\n\n") + "\n";
}
