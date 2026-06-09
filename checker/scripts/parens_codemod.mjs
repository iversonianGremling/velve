// parens_codemod.mjs — one-time migration: juxtaposition application → uniform parens.
//
// Rewrites the four juxtaposition call forms to `head(arg, arg, ...)`:
//   function_call    listGet parts 0          -> listGet(parts, 0)
//   adt_call         Ok res                   -> Ok(res)
//   qualified_call   Http.get url             -> Http.get(url)
//   paren_call       (fn x -> x*2) 3          -> (fn x -> x*2)(3)
//
// Rules (see the locked design decisions):
//   * a single GROUPED atom  `f (x)`     unwraps  -> f(x)
//   * a single TUPLE atom    `f (a, b)`  stays one arg -> f((a, b))
//   * multiple atoms         `f a b`     -> f(a, b)
//   * nested calls in args are converted too (generic recursive render).
//
// MUST be run against the CURRENT (pre-change) grammar so the juxtaposition
// nodes still exist. Dry-run by default; pass --write to apply in place.
//
// Usage:
//   node scripts/parens_codemod.mjs            # dry run, summary only
//   node scripts/parens_codemod.mjs --write    # apply to all .velve fixtures + examples

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

const CALL_TYPES = new Set(["function_call", "adt_call", "qualified_call", "paren_call"]);

const parser = new Parser();
parser.setLanguage(Velve);

// Generic recursive renderer: returns transformed source text for `node`.
// Non-call nodes are reconstructed verbatim by stitching original inter-child
// text with recursively-rendered children, so nested calls inside any context
// (args, record fields, list elements, …) are converted too.
function render(src, node) {
  if (CALL_TYPES.has(node.type)) return renderCall(src, node);
  if (node.childCount === 0) return node.text;
  let out = "";
  let cursor = node.startIndex;
  for (const child of node.children) {
    out += src.slice(cursor, child.startIndex);   // punctuation / whitespace between children
    out += render(src, child);
    cursor = child.endIndex;
  }
  out += src.slice(cursor, node.endIndex);
  return out;
}

function calleeText(src, node) {
  if (node.type === "qualified_call") {
    // upper_id '.' lower_id  atom+
    const mod = node.namedChildren[0];
    const fn = node.namedChildren[1];
    return `${render(src, mod)}.${render(src, fn)}`;
  }
  // function_call / adt_call / paren_call: first named child is the callee
  return render(src, node.namedChildren[0]);
}

function argNodes(node) {
  // atoms are the named children after the callee (2 leading children for qualified_call)
  const lead = node.type === "qualified_call" ? 2 : 1;
  return node.namedChildren.slice(lead);
}

function renderArg(src, atom) {
  // `f (x)` — a single grouped atom unwraps to its inner expression.
  if (atom.type === "grouped") return render(src, atom.namedChildren[0]);
  // tuple_literal / record_literal / list_literal / literal / ids — rendered as-is.
  return render(src, atom);
}

// Descend an `atom` wrapper and one layer of grouping to the real node.
function unwrapAtom(a) {
  if (a.type === "atom" && a.namedChildren[0]) a = a.namedChildren[0];
  if (a.type === "grouped" && a.namedChildren[0]) a = a.namedChildren[0];
  return a;
}

function renderCall(src, node) {
  const callee = calleeText(src, node);
  const atoms = argNodes(node);
  // Match the OLD lowerCallArgs semantics exactly: with a SINGLE argument that
  // is a tuple, the tuple is FLATTENED into the positional arg list — i.e. the
  // juxtaposition `f (a, b)` always meant `f(a, b)`, never `f((a, b))`. A single
  // `()` unit means zero args. (The old grammar offered no way to pass a literal
  // tuple as one arg, so flattening is loss-free for the corpus.)
  if (atoms.length === 1) {
    const inner = unwrapAtom(atoms[0]);
    if (inner.type === "unit" ||
        (inner.type === "literal" && inner.namedChildren[0]?.type === "unit"))
      return `${callee}()`;
    if (inner.type === "tuple_literal") {
      const parts = inner.namedChildren.map(c => render(src, c));
      return `${callee}(${parts.join(", ")})`;
    }
  }
  const parts = atoms.map(a => renderArg(src, a));
  return `${callee}(${parts.join(", ")})`;
}

function listVelve(dir) {
  return readdirSync(dir).filter(f => f.endsWith(".velve")).map(f => join(dir, f));
}

let totalFiles = 0, changedFiles = 0, totalCalls = 0;
for (const dir of DIRS) {
  for (const file of listVelve(dir)) {
    totalFiles++;
    const src = readFileSync(file, "utf8");
    const tree = parser.parse(src);
    // Count juxtaposition call nodes (for reporting) before transforming.
    let n = 0;
    (function count(node) {
      if (CALL_TYPES.has(node.type)) n++;
      for (const c of node.children) count(c);
    })(tree.rootNode);
    if (n === 0) continue;

    const out = render(src, tree.rootNode);
    totalCalls += n;
    if (out !== src) {
      changedFiles++;
      if (WRITE) writeFileSync(file, out);
      const rel = file.slice(ROOT.length + 1);
      console.log(`${WRITE ? "wrote" : "would change"}  ${rel}  (${n} call nodes)`);
    }
  }
}
console.log(`\n${changedFiles}/${totalFiles} files, ${totalCalls} juxtaposition calls ${WRITE ? "rewritten" : "to rewrite"}.`);
console.log(WRITE ? "Applied." : "Dry run — re-run with --write to apply.");
