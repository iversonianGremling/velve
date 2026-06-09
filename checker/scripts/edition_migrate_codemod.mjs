// edition_migrate_codemod.mjs — migrate the aspirational `examples/` off the
// edition-2026.6-deprecated surface forms (PLAN Phase 4c). Three transforms, each
// using a form that is valid in BOTH editions (only the OLD form is gated), so the
// files keep working on the default 2026.1 edition — the warnings simply disappear:
//
//   1. record literal/spread opener   { … }  ->  #{ … }   (§3.9)
//   2. ternary                       c ? a : b  ->  if c then a else b   (§3.11)
//   3. comprehension generator       x = src / x = %src  ->  x in src    (§3.8)
//
// SCOPE: examples/ only. The checker/ fixtures intentionally keep legacy forms as
// the deprecation-warning tests, so they are left untouched.
//
// The render is the generic stitch (original inter-child text + rendered children),
// so transforms compose and nest in one pass. Record *types* (`record_type`) and
// `{ … }` blocks (`brace_block`) are DIFFERENT node types and are never matched, so
// only true record literals/spreads get the `#`.
//
// Dry-run by default; pass --write to apply. Verify afterwards that `check` on each
// example shows the deprecation warnings gone and NO new errors.
//
// Usage:
//   node scripts/edition_migrate_codemod.mjs           # dry run, summary
//   node scripts/edition_migrate_codemod.mjs --write   # apply

import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE = process.argv.includes("--write");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");           // repo root
const DIRS = [join(ROOT, "examples")];         // examples only — see header

const counts = { record: 0, ternary: 0, forgen: 0 };

function render(src, node) {
  if (!node) return "";

  // 1. record literal / spread: prepend `#` to the leading `{` opener.
  if ((node.type === "record_literal" || node.type === "record_spread")
      && node.children[0]?.type === "{") {
    counts.record++;
    return "#" + renderChildren(src, node);
  }

  // 2. ternary `cond ? a : b` -> `if cond then a else b`. Named children are
  //    [cond, then, else]; transform only when all three are present (a partial
  //    parse falls through to a verbatim render).
  if (node.type === "ternary_expr" && node.namedChildren.length >= 3) {
    const [cond, then_, else_] = node.namedChildren;
    counts.ternary++;
    return `if ${render(src, cond)} then ${render(src, then_)} else ${render(src, else_)}`;
  }

  // 3. legacy comprehension generator `x = src` / `x = %src` -> `x in src`.
  //    Detect the legacy form by the presence of a bare `=` token. The iterable
  //    is the `for_source` child; render its inner expr, dropping the `%` sigil.
  if (node.type === "for_generator" && node.children.some(c => !c.isNamed && c.text === "=")) {
    const name = node.namedChildren.find(c => c.type === "lower_id");
    const srcNode = node.namedChildren.find(c => c.type === "for_source");
    if (name && srcNode) {
      counts.forgen++;
      // for_source is either `%expr` or `expr`; render only its named children.
      const iter = srcNode.namedChildren.map(c => render(src, c)).join("");
      return `${render(src, name)} in ${iter}`;
    }
  }

  if (node.childCount === 0) return node.text;
  return renderChildren(src, node);
}

// Generic stitch: original source between children, with children rendered.
function renderChildren(src, node) {
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
    const before = { ...counts };
    const tree = parser.parse(src);
    const out = render(src, tree.rootNode);
    if (out !== src) {
      changedFiles++;
      if (WRITE) writeFileSync(file, out);
      const rel = file.slice(ROOT.length + 1);
      const d = `${counts.record - before.record} rec, ${counts.ternary - before.ternary} ternary, ${counts.forgen - before.forgen} for`;
      console.log(`${WRITE ? "wrote" : "would change"}  ${rel}  (${d})`);
    }
  }
}
console.log(`\n${changedFiles}/${totalFiles} files. Totals: ${counts.record} record, ${counts.ternary} ternary, ${counts.forgen} for-gen.`);
console.log(WRITE ? "Applied." : "Dry run — re-run with --write to apply.");
