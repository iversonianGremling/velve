import type { Diagnostic } from "./resolve.js";
import { spanFrom } from "./span.js";

// Minimal structural shape of a tree-sitter node — we only touch what we need so
// this stays decoupled from the binding's type defs (which differ web vs node).
interface TSNode {
  type: string;
  isMissing: boolean;
  hasError: boolean;
  startPosition: { row: number; column: number };
  endPosition: { row: number; column: number };
  startIndex: number;
  endIndex: number;
  children: TSNode[];
}

// Walk the parse tree and turn tree-sitter's error recovery into real diagnostics.
// Without this, an unparseable body/decl is silently dropped (the recovered tree
// just omits the node) and `check` reports "no errors" on code that never parsed.
// We only descend where `hasError` is set, so clean trees cost one boolean check.
export function collectParseErrors(root: TSNode, source: string): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const visit = (n: TSNode) => {
    if (!n.hasError && !n.isMissing) return;
    if (n.isMissing) {
      diags.push({
        kind: "error",
        span: spanFrom(n, source),
        message: `syntax error: missing ${n.type || "token"}`,
      });
    } else if (n.type === "ERROR") {
      const snippet = n.children.map(c => c.type).filter(Boolean).join(" ");
      diags.push({
        kind: "error",
        span: spanFrom(n, source),
        message: snippet ? `syntax error: unexpected ${snippet}` : "syntax error",
      });
    }
    for (const c of n.children) visit(c);
  };
  visit(root);
  return diags;
}
