// ctor_pattern_codemod.mjs — migrate bare constructor *patterns* to the unified
// construction form: `Ok v` -> `Ok(v)` (call-syntax §2.1, PLAN Track A phase 2).
// Construction already uses parens (`Ok(v)`); destructuring was the last space-form
// holdout. Paren-form patterns already parse to the identical PCtor AST, so the
// rewrite is purely surface — the warning (2026.1) / error (2026.6) disappears with
// no type-checker change.
//
// Transform: a `simple_pattern` that is `Upper <payload>` with a SINGLE, undelimited
// payload becomes `Upper(<payload>)`. Delimited payloads (`Ok(v)`, `Ok (Chunk c)`,
// `Ok {body}`) and the binding+record form (`Ok r {body}`) are left untouched —
// matching the lower-time gate in lower.ts (`checkCtorPatternForm`). Nested bare
// ctors (`Ok (Chunk c)` -> `Ok (Chunk(c))`) are wrapped by recursion.
//
// SCOPE: examples/ only. The checker/ fixtures intentionally keep legacy forms as
// the deprecation-warning tests, so they are left untouched (except the 2026.6
// fixtures, which are migrated by hand since they would otherwise error).
//
// Usage:
//   node scripts/ctor_pattern_codemod.mjs           # dry run, summary
//   node scripts/ctor_pattern_codemod.mjs --write    # apply

import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE = process.argv.includes("--write");
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIRS = [join(ROOT, "examples")];

const counts = { ctor: 0 };

function render(src, node) {
  if (!node) return "";

  // A constructor pattern with a single, undelimited payload: `Upper payload`.
  if (node.type === "simple_pattern") {
    const named = node.namedChildren;
    const upper = named.find(c => c.type === "upper_id");
    if (upper && named.length === 2) {
      const inner = named.find(c => c !== upper);
      if (inner && !inner.text.startsWith("(") && !inner.text.startsWith("{")) {
        counts.ctor++;
        return `${upper.text}(${render(src, inner)})`;
      }
    }
  }

  if (node.childCount === 0) return node.text;
  return renderChildren(src, node);
}

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

const listVelve = dir => readdirSync(dir).filter(f => f.endsWith(".velve")).map(f => join(dir, f));

const parser = new Parser();
parser.setLanguage(Velve);

let totalFiles = 0, changedFiles = 0;
for (const dir of DIRS) {
  for (const file of listVelve(dir)) {
    totalFiles++;
    const src = readFileSync(file, "utf8");
    const before = counts.ctor;
    const tree = parser.parse(src);
    const out = render(src, tree.rootNode);
    if (out !== src) {
      changedFiles++;
      if (WRITE) writeFileSync(file, out);
      const rel = file.slice(ROOT.length + 1);
      console.log(`${WRITE ? "wrote" : "would change"}  ${rel}  (${counts.ctor - before} ctor pattern${counts.ctor - before === 1 ? "" : "s"})`);
    }
  }
}
console.log(`\n${changedFiles}/${totalFiles} files. Total: ${counts.ctor} ctor patterns wrapped.`);
console.log(WRITE ? "Applied." : "Dry run — re-run with --write to apply.");
