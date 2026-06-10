// element_paren_codemod.mjs — migrate the space-form element surface to the unified
// paren/application form (call-syntax §2.1, PLAN Track A phase 2 / §5b):
//   Text "hi" size=12            ->  Text("hi", size=12)
//   Column gap=8 \n <children>   ->  Column(gap=8) \n <children>
//   Text (label) color=(c)       ->  Text(label, color=c)
//   Input value={expr}           ->  Input(value=expr)
// Content (literal / grouped) becomes the first positional; `key=value` and
// `key={expr}` props become `name=value` args; the indented children block is
// preserved verbatim (recursively migrated).
//
// SKIPPED (logged, not silently dropped): an element carrying a **spread prop**
// (`...rec`) or an **inline handler prop** (`onClick -> body`) — neither maps to a
// paren `name=value` arg without call-arg-spread / handler-arg grammar (a separate
// build). Those elements stay space-form (a 2026.1 deprecation warning) until then.
//
// SCOPE: examples/ only (the checker/ fixtures keep legacy forms as warning tests).
//
// Usage:
//   node scripts/element_paren_codemod.mjs           # dry run, summary
//   node scripts/element_paren_codemod.mjs --write    # apply

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

const counts = { migrated: 0, skipped: 0 };
const skips = [];

const tokenText = (node, t) => node.children.some(c => !c.isNamed && c.text === t);

// Is this `prop` node migratable to a `name=value` arg?  false ⇒ spread / handler.
function propMigratable(p) {
  if (tokenText(p, "...")) return false;          // spread prop `...rec`
  if (tokenText(p, "->")) return false;           // inline handler `onClick -> body`
  return true;
}

function renderContent(src, contentNode) {
  // element_content = literal | grouped. Unwrap a grouped `(expr)` to its inner
  // expression so `Text (label)` -> `Text(label)`.
  const inner = contentNode.namedChildren[0];
  if (contentNode.namedChildren.length && contentNode.children[0]?.text === "(")
    return inner ? render(src, inner) : "";
  return render(src, contentNode);
}

function renderProp(src, p) {
  const nameNode = p.namedChildren.find(c => c.type === "lower_id");
  const name = nameNode ? nameNode.text : "?";
  const valNode = p.namedChildren.find(c => c !== nameNode);
  if (!valNode) return `${name}=true`;            // bare flag
  return `${name}=${render(src, valNode)}`;        // `key=v` and `key={v}` both → `key=v`
}

function renderElement(src, node) {
  // Already paren-form (has element_args) — recurse generically, nothing to do.
  if (node.namedChildren.some(c => c.type === "element_args"))
    return renderChildren(src, node);

  const upper = node.namedChildren.find(c => c.type === "upper_id");
  const content = node.namedChildren.find(c => c.type === "element_content");
  const props = node.namedChildren.filter(c => c.type === "prop");
  const childBlock = node.namedChildren.find(c => c.type === "children_block");

  if (!props.every(propMigratable)) {
    counts.skipped++;
    skips.push(`${upper?.text ?? "?"} @ line ${node.startPosition.row + 1}`);
    return renderChildren(src, node);             // leave space-form (still warns)
  }

  const parts = [];
  if (content) parts.push(renderContent(src, content));
  for (const p of props) parts.push(renderProp(src, p));
  const head = `${upper.text}(${parts.join(", ")})`;
  counts.migrated++;

  // Preserve the gap (newline + indent) between the head and the children block,
  // and recursively migrate the block.
  const lastHead = props.length ? props[props.length - 1] : (content ?? upper);
  if (childBlock)
    return head + src.slice(lastHead.endIndex, childBlock.startIndex) + render(src, childBlock);
  return head + src.slice(lastHead.endIndex, node.endIndex);   // trailing newline
}

function render(src, node) {
  if (!node) return "";
  if (node.type === "element" || node.type === "element_leaf") return renderElement(src, node);
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
    const before = counts.migrated;
    const tree = parser.parse(src);
    const out = render(src, tree.rootNode);
    if (out !== src) {
      changedFiles++;
      if (WRITE) writeFileSync(file, out);
      console.log(`${WRITE ? "wrote" : "would change"}  ${file.slice(ROOT.length + 1)}  (${counts.migrated - before} elements)`);
    }
  }
}
console.log(`\n${changedFiles}/${totalFiles} files. ${counts.migrated} elements migrated, ${counts.skipped} skipped (spread/handler props).`);
if (skips.length) console.log("Skipped:\n  " + skips.join("\n  "));
console.log(WRITE ? "Applied." : "Dry run — re-run with --write to apply.");
