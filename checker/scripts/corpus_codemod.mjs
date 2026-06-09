// corpus_codemod.mjs — migrate juxtaposition application → parens inside the
// SOURCE sections of tree-sitter corpus .txt files. Same render logic as
// parens_codemod.mjs. MUST run against the OLD grammar (juxtaposition nodes
// still exist). The expected-sexp sections are left alone; regenerate them
// afterward with `tree-sitter test --update`. Dry-run by default; --write applies.
import Parser from "tree-sitter";
import Velve from "tree-sitter-velve";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const WRITE = process.argv.includes("--write");
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "..", "test", "corpus");
const CALL_TYPES = new Set(["function_call", "adt_call", "qualified_call", "paren_call"]);

const parser = new Parser();
parser.setLanguage(Velve);

function render(src, node) {
  if (CALL_TYPES.has(node.type)) return renderCall(src, node);
  if (node.childCount === 0) return node.text;
  let out = "", cursor = node.startIndex;
  for (const child of node.children) {
    out += src.slice(cursor, child.startIndex);
    out += render(src, child);
    cursor = child.endIndex;
  }
  out += src.slice(cursor, node.endIndex);
  return out;
}
function calleeText(src, node) {
  if (node.type === "qualified_call")
    return `${render(src, node.namedChildren[0])}.${render(src, node.namedChildren[1])}`;
  return render(src, node.namedChildren[0]);
}
function argNodes(node) {
  return node.namedChildren.slice(node.type === "qualified_call" ? 2 : 1);
}
function unwrapAtom(a) {
  if (a.type === "atom" && a.namedChildren[0]) a = a.namedChildren[0];
  if (a.type === "grouped" && a.namedChildren[0]) a = a.namedChildren[0];
  return a;
}
function renderArg(src, atom) {
  if (atom.type === "grouped") return render(src, atom.namedChildren[0]);
  return render(src, atom);
}
function renderCall(src, node) {
  const callee = calleeText(src, node);
  const atoms = argNodes(node);
  if (atoms.length === 1) {
    const inner = unwrapAtom(atoms[0]);
    if (inner.type === "unit" || (inner.type === "literal" && inner.namedChildren[0]?.type === "unit"))
      return `${callee}()`;
    if (inner.type === "tuple_literal")
      return `${callee}(${inner.namedChildren.map(c => render(src, c)).join(", ")})`;
  }
  return `${callee}(${atoms.map(a => renderArg(src, a)).join(", ")})`;
}

function hasCall(node) {
  if (CALL_TYPES.has(node.type)) return true;
  for (const c of node.children) if (hasCall(c)) return true;
  return false;
}

let files = 0, changed = 0, blocks = 0;
for (const f of readdirSync(CORPUS).filter(x => x.endsWith(".txt"))) {
  files++;
  const path = join(CORPUS, f);
  const text = readFileSync(path, "utf8");
  // A corpus file is: ===\nname\n===\n\nSOURCE\n---\nSEXP  (repeated). We migrate
  // only the SOURCE between the `===` header and the `---` separator.
  const parts = text.split(/^(={3,}\s*\n.*\n={3,}\s*\n)/m);  // keep headers as delimiters
  // parts: [pre, header1, body1, header2, body2, ...]
  let out = parts[0] ?? "";
  let fileChanged = false;
  for (let i = 1; i < parts.length; i += 2) {
    const header = parts[i];
    const body = parts[i + 1] ?? "";
    const m = body.split(/^(-{3,}\s*)$/m);   // [source, dashesLine, ...rest]
    const source = m[0];
    const rest = body.slice(source.length);
    let migrated = source;
    if (source.trim()) {
      const tree = parser.parse(source);
      if (hasCall(tree.rootNode)) { migrated = render(source, tree.rootNode); blocks++; if (migrated !== source) fileChanged = true; }
    }
    out += header + migrated + rest;
  }
  if (fileChanged) {
    changed++;
    if (WRITE) writeFileSync(path, out);
    console.log(`${WRITE ? "wrote" : "would change"}  ${f}`);
  }
}
console.log(`\n${changed}/${files} corpus files (${blocks} source blocks with calls) ${WRITE ? "rewritten" : "to rewrite"}.`);
console.log(WRITE ? "Applied." : "Dry run — re-run with --write.");
