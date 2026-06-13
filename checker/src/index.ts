import { loadProgram } from "./loader.js";
import { resolve } from "./resolve.js";
import { infer } from "./infer.js";
import { checkExhaustiveness } from "./exhaust.js";
import { checkBorrows } from "./borrow.js";
import { checkTotality } from "./total.js";
import { checkHandled } from "./handled.js";
import { checkNonZero, checkBounds, checkArith, checkOverflow } from "./facts.js";
import { buildMeasureJobs } from "./terminates.js";
import { discharge } from "./smt.js";
import { Evaluator } from "./eval.js";
import { RuntimeError } from "./value.js";
import { analyzeTweaks } from "./tweaks.js";

const [cmd, file] = process.argv.slice(2);

if (!cmd || !file) {
  console.error("usage: node dist/index.js <check|run|ast|tweaks> <file.velve>");
  process.exit(1);
}

// Load the entry file and every file-relative module it imports, transitively,
// into one merged program (loader.ts). Parse errors (tree-sitter drops the
// unparseable node during recovery, so every later pass would silently skip it)
// and lowering errors from ALL files are surfaced here, before the later passes.
const { mod, diagnostics: loadDiags } = loadProgram(file);

if (cmd === "check") {
  const { resolutions, diagnostics: resolveDiags } = resolve(mod);
  const { diagnostics: inferDiags, types } = infer(mod, resolutions);
  const exhaustDiags = checkExhaustiveness(mod, types);
  const borrowDiags = checkBorrows(mod, types);
  const { diagnostics: totalDiags, candidates } = checkTotality(mod, resolutions);
  const handledDiags = checkHandled(mod, types);
  // The sync floors hand their residue to Z3 (smt.ts): unproved-but-
  // translatable divisors and index reads, and @total fns whose only failure
  // was the structural decrease (the Tier-2 measure check).
  const { diagnostics: nonZeroDiags, residue } = checkNonZero(mod, resolutions);
  const { diagnostics: boundsDiags, residue: boundsResidue } = checkBounds(mod, types, resolutions);
  const { diagnostics: arithDiags, residue: arithResidue } = checkArith(mod, resolutions);
  const { diagnostics: overflowDiags, residue: overflowResidue } = checkOverflow(mod, types, resolutions);
  const { diagnostics: measureDiags, jobs } = buildMeasureJobs(candidates, resolutions);
  const smtDiags = await discharge(residue, jobs, boundsResidue, arithResidue, overflowResidue);

  const allDiags = [...loadDiags, ...resolveDiags, ...inferDiags, ...exhaustDiags, ...borrowDiags, ...totalDiags, ...handledDiags, ...nonZeroDiags, ...boundsDiags, ...arithDiags, ...overflowDiags, ...measureDiags, ...smtDiags];
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
  const fatal = loadDiags.filter(d => d.kind === "error");
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
