import Parser from "tree-sitter";
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
const p=new Parser(); p.setLanguage(Velve);
const file=process.argv[2];
const t=p.parse(readFileSync(file,"utf8"));
let n=0;
(function walk(node){
  if(node.type==="ERROR"||node.isMissing){ n++; if(n<=8) console.log(`${node.isMissing?"MISSING":"ERROR"} [${node.startPosition.row+1}:${node.startPosition.column}] "${node.text.slice(0,50).replace(/\n/g,"\\n")}"`); }
  for(const c of node.children) walk(c);
})(t.rootNode);
console.log("total error/missing nodes:", n);
