import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { Lowerer } from "./lower.js";
import { resolve } from "./resolve.js";
import { infer } from "./infer.js";
import { checkExhaustiveness } from "./exhaust.js";
import { checkBorrows } from "./borrow.js";
import { checkTotality } from "./total.js";
import { Evaluator } from "./eval.js";
import { RuntimeError } from "./value.js";
import { analyzeTweaks } from "./tweaks.js";
import { collectParseErrors } from "./parseErrors.js";

const [cmd, file] = process.argv.slice(2);

if (!cmd || !file) {
  console.error("usage: node dist/index.js <check|run|ast|tweaks> <file.velve>");
  process.exit(1);
}

const src = readFileSync(file, "utf8");
const parser = new Parser();
parser.setLanguage(Velve);
const tree = parser.parse(src);
// A parse error makes tree-sitter drop the unparseable node during recovery, so
// every later pass would silently skip it. Surface these first.
const parseDiags = collectParseErrors(tree.rootNode as any, file);
const lowerer = new Lowerer(file);
const mod  = lowerer.lower(tree);
const lowerDiags = lowerer.diagnostics;

if (cmd === "check") {
  const { resolutions, diagnostics: resolveDiags } = resolve(mod);
  const { diagnostics: inferDiags, types } = infer(mod, resolutions);
  const exhaustDiags = checkExhaustiveness(mod, types);
  const borrowDiags = checkBorrows(mod, types);
  const totalDiags = checkTotality(mod, resolutions);

  const allDiags = [...parseDiags, ...lowerDiags, ...resolveDiags, ...inferDiags, ...exhaustDiags, ...borrowDiags, ...totalDiags];
  console.log(`${types.size} expressions typed, ${resolutions.size} names resolved`);
  if (allDiags.length === 0) {
    console.log("no errors");
  } else {
    for (const d of allDiags) {
      console.log(`  ${d.kind} [${d.span.start.line + 1}:${d.span.start.col + 1}] ${d.message}`);
    }
    // Non-zero exit so CI / tooling can trust the result, not just the printed text.
    if (allDiags.some(d => d.kind === "error")) process.exit(1);
  }
} else if (cmd === "run") {
  // Parse and lowering errors (e.g. a dropped decl, empty `{}` interpolation) make
  // the AST unsound to run — surface them and refuse, like a compiler, instead of
  // evaluating a patched tree.
  const fatal = [...parseDiags, ...lowerDiags].filter(d => d.kind === "error");
  if (fatal.length > 0) {
    for (const d of fatal) {
      console.error(`  ${d.kind} [${d.span.start.line + 1}:${d.span.start.col + 1}] ${d.message}`);
    }
    process.exit(1);
  }
  try {
    await new Evaluator().run(mod);
  } catch (e) {
    if (e instanceof RuntimeError) {
      console.error(`runtime error: ${e.message}`);
      if (process.env.VELVE_DEBUG) console.error(e.stack);
      process.exit(1);
    }
    throw e;
  }
} else if (cmd === "ast") {
  // Emit the lowered module as JSON — what the live browser runtime loads
  // (parsing is Node-native; the browser interprets a pre-parsed AST).
  console.log(JSON.stringify(mod));
} else if (cmd === "tweaks") {
  // Static intent/tweak gradient (§9.6) — per-component count of `raw()`/off-scale/
  // magic-constant props vs token-driven ones. Walks the AST, not the runtime tree.
  console.log(analyzeTweaks(mod));
} else {
  console.error(`unknown command: ${cmd}`);
  process.exit(1);
}
