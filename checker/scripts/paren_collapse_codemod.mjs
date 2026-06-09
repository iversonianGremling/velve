// paren_collapse_codemod.mjs — cosmetic cleanup (PLAN 2e): collapse redundant
// double-parens left by the earlier juxtaposition→parens migration.
//
//   print((x))      -> print(x)
//   transfer((30))  -> transfer(30)
//   f((a + b), y)   -> f(a + b, y)
//
// SAFE by construction: a direct call argument that is a `grouped` node `(E)` is
// redundant — the call already delimits arguments with its own parens, and a
// `grouped` holds exactly one expression (commas separate args, so unwrapping can
// never merge or split an argument). It also lowers identically (`grouped` → inner),
// so the rewrite is a provable no-op for the type checker. A single-tuple argument
// `f((a, b))` is a `tuple_literal`, NOT a `grouped`, so it is left untouched.
//
// Dry-run by default; pass --write to apply in place. Verify afterwards that the
// corpus baseline is byte-identical (the rewrite must not change any diagnostics).
//
// Usage:
//   node scripts/paren_collapse_codemod.mjs           # dry run, summary
//   node scripts/paren_collapse_codemod.mjs --write   # apply

import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE = process.argv.includes("--write");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");           // repo root
const DIRS = [join(ROOT, "checker"), join(ROOT, "examples"), ROOT];

let collapsed = 0;

// Is `node` a `call` argument list slot holding a redundant `grouped`? We detect
// the call's argument region and unwrap any direct-child `grouped`. The render is
// generic (stitch original text between children with rendered children), so nested
// calls and grouped args at any depth are handled in one pass.
function render(src, node) {
  if (node.type === "grouped" && isDirectCallArg(node)) {
    // Unwrap `(E)` → `E` (recursively render the inner expression).
    collapsed++;
    return render(src, node.namedChildren[0]);
  }
  if (node.childCount === 0) return node.text;
  let out = "";
  let cursor = node.startIndex;
  for (const child of node.children) {
    out += src.slice(cursor, child.startIndex);
    out += render(src, child);
    cursor = child.endIndex;
  }
  out += src.slice(cursor, node.endIndex);
  return out;
}

// True when this `grouped` sits directly in a call's argument list — i.e. its
// parent is a `call` (the unified application node) and it is not the callee (the
// callee is the first child / the part before the immediate `(`). We approximate
// the argument region as: a `grouped` whose previous sibling token is `(` or `,`.
function isDirectCallArg(node) {
  const parent = node.parent;
  if (!parent || parent.type !== "call") return false;
  // The callee is the first child; arguments follow the immediate `(`.
  const prev = node.previousSibling;
  return !!prev && (prev.type === "(" || prev.type === ",");
}

function listVelve(dir) {
  return readdirSync(dir).filter(f => f.endsWith(".velve")).map(f => join(dir, f));
}

const parser = new Parser();
parser.setLanguage(Velve);

let totalFiles = 0, changedFiles = 0;
for (const dir of DIRS) {
  for (const file of listVelve(dir)) {
    totalFiles++;
    const src = readFileSync(file, "utf8");
    const before = collapsed;
    const tree = parser.parse(src);
    const out = render(src, tree.rootNode);
    if (out !== src) {
      changedFiles++;
      if (WRITE) writeFileSync(file, out);
      const rel = file.slice(ROOT.length + 1);
      console.log(`${WRITE ? "wrote" : "would change"}  ${rel}  (${collapsed - before} parens)`);
    }
  }
}
console.log(`\n${changedFiles}/${totalFiles} files, ${collapsed} redundant parens ${WRITE ? "collapsed" : "to collapse"}.`);
console.log(WRITE ? "Applied." : "Dry run — re-run with --write to apply.");
