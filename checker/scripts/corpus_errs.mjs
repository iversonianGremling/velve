import Parser from "tree-sitter";
import Velve from "tree-sitter-velve";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const HERE = dirname(fileURLToPath(import.meta.url));
const CORPUS = join(HERE, "..", "..", "test", "corpus");
const p = new Parser(); p.setLanguage(Velve);
for (const f of readdirSync(CORPUS).filter(x => x.endsWith(".txt"))) {
  const text = readFileSync(join(CORPUS, f), "utf8");
  const blocks = text.split(/^={3,}\s*$/m);
  for (let i = 2; i < blocks.length; i += 2) {
    const name = (blocks[i - 1] || "").trim();
    const body = blocks[i] || "";
    const src = body.split(/^-{3,}\s*$/m)[0];
    if (!src || !src.trim()) continue;
    const t = p.parse(src);
    const sexp = t.rootNode.toString();
    if (sexp.includes("ERROR") || sexp.includes("MISSING"))
      console.log(f + " :: " + name);
  }
}
