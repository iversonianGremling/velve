import {
  createConnection, ProposedFeatures,
  TextDocumentSyncKind, TextDocuments,
  DiagnosticSeverity, CompletionItemKind,
  type InitializeResult,
  type Hover,
  type Location,
  type TextDocumentPositionParams,
  type CompletionItem,
  type SemanticTokens,
} from "vscode-languageserver/node.js";
import { TextDocument } from "vscode-languageserver-textdocument";
import Parser from "tree-sitter";
// @ts-ignore
import Velve from "tree-sitter-velve";
import { Lowerer } from "./lower.js";
import { resolve } from "./resolve.js";
import { infer } from "./infer.js";
import { checkExhaustiveness } from "./exhaust.js";
import { checkTotality } from "./total.js";
import { checkHandled } from "./handled.js";
import { typeToString } from "./types.js";
import { findExprAt } from "./find.js";
import type { Expr, Module } from "./ast.js";
import type { Type } from "./types.js";
import type { ResolutionMap, ScopeSnapshot, Scope, BindingKind } from "./resolve.js";

// ── Parser setup ──────────────────────────────────────────────────────────────

const parser = new Parser();
parser.setLanguage(Velve);

// ── Per-file analysis cache ───────────────────────────────────────────────────

interface Analysis {
  mod: Module;
  types: Map<Expr, Type>;
  resolutions: ResolutionMap;
  snapshots: ScopeSnapshot[];
  globals: Scope;
  nameToTypeString: Map<string, string>;
  tree: ReturnType<typeof parser.parse>;
}

const cache = new Map<string, Analysis>();

function analyze(uri: string, text: string): { analysis: Analysis; lspDiags: ReturnType<typeof toLspDiag>[] } {
  const file = uriToPath(uri);
  const tree = parser.parse(text);
  const lowerer = new Lowerer(file);
  const mod  = lowerer.lower(tree);
  const ld   = lowerer.diagnostics;
  const { resolutions, diagnostics: rd, snapshots, globals } = resolve(mod);
  const { types, diagnostics: id, nameToTypeString }         = infer(mod, resolutions);
  const ed                                                   = checkExhaustiveness(mod, types);
  const td                                                   = checkTotality(mod, resolutions);
  const hd                                                   = checkHandled(mod, types);

  const analysis: Analysis = { mod, types, resolutions, snapshots, globals, nameToTypeString, tree };
  cache.set(uri, analysis);

  return {
    analysis,
    lspDiags: [...ld, ...rd, ...id, ...ed, ...td, ...hd].map(toLspDiag),
  };
}

function toLspDiag(d: { kind: string; span: { start: { line: number; col: number }; end: { line: number; col: number } }; message: string }) {
  return {
    range: {
      start: { line: d.span.start.line, character: d.span.start.col },
      end:   { line: d.span.end.line,   character: d.span.end.col   },
    },
    severity: d.kind === "error" ? DiagnosticSeverity.Error : DiagnosticSeverity.Warning,
    message:  d.message,
    source:   "velve",
  };
}

function uriToPath(uri: string): string {
  try { return new URL(uri).pathname; } catch { return uri; }
}

// ── LSP connection ────────────────────────────────────────────────────────────

const connection = createConnection(ProposedFeatures.all);
const documents  = new TextDocuments(TextDocument);

// Semantic token legend — order must match TOKEN_TYPE_* constants below.
const SEMANTIC_TOKEN_LEGEND = {
  tokenTypes:     ["enumMember", "label"],
  tokenModifiers: [],
};
const TOKEN_ENUM_MEMBER = 0;  // value atom: :idle, :ok, :running …
const TOKEN_LABEL       = 1;  // step-label atom: :reserve, :done, :abort as transition targets

connection.onInitialize((): InitializeResult => ({
  capabilities: {
    textDocumentSync:   TextDocumentSyncKind.Full,
    hoverProvider:      true,
    definitionProvider: true,
    completionProvider: { triggerCharacters: [] },
    semanticTokensProvider: {
      legend: SEMANTIC_TOKEN_LEGEND,
      full:   true,
    },
  },
  serverInfo: { name: "velve-lsp", version: "0.1.0" },
}));

// ── Diagnostics ───────────────────────────────────────────────────────────────

function recheck(doc: TextDocument): void {
  const { lspDiags } = analyze(doc.uri, doc.getText());
  connection.sendDiagnostics({ uri: doc.uri, diagnostics: lspDiags });
}

documents.onDidOpen(e    => recheck(e.document));
documents.onDidChangeContent(e => recheck(e.document));
documents.onDidClose(e   => {
  cache.delete(e.document.uri);
  connection.sendDiagnostics({ uri: e.document.uri, diagnostics: [] });
});

// ── Hover ─────────────────────────────────────────────────────────────────────

connection.onHover(({ textDocument, position }: TextDocumentPositionParams): Hover | null => {
  const a = cache.get(textDocument.uri);
  if (!a) return null;

  const expr = findExprAt(a.mod, position.line, position.character);
  if (!expr) return null;

  // Don't surface the whole saga/machine as one giant `String` hover — that fires
  // when the cursor is on a step label (not itself an expr). Narrow exprs inside
  // step bodies are reachable via find.ts and still hover normally.
  if (expr.tag === "Machine") return null;

  const type = a.types.get(expr);
  if (!type || type.tag === "Unknown") return null;

  // For a Var, show "name : Type" — more useful than just the type.
  const label = expr.tag === "Var" ? `${expr.name} : ${typeToString(type)}` : typeToString(type);

  return {
    contents: { kind: "markdown", value: `\`\`\`velve\n${label}\n\`\`\`` },
    range: {
      start: { line: expr.span.start.line, character: expr.span.start.col },
      end:   { line: expr.span.end.line,   character: expr.span.end.col   },
    },
  };
});

// ── Go to definition ──────────────────────────────────────────────────────────

connection.onDefinition(({ textDocument, position }: TextDocumentPositionParams): Location | null => {
  const a = cache.get(textDocument.uri);
  if (!a) return null;

  const expr = findExprAt(a.mod, position.line, position.character);
  if (!expr || expr.tag !== "Var") return null;

  const binding = a.resolutions.get(expr as Expr & { tag: "Var" });
  if (!binding) return null;

  return {
    uri: textDocument.uri,
    range: {
      start: { line: binding.span.start.line, character: binding.span.start.col },
      end:   { line: binding.span.end.line,   character: binding.span.end.col   },
    },
  };
});

// ── Completion ────────────────────────────────────────────────────────────────

function kindToCompletionKind(kind: BindingKind): CompletionItemKind {
  switch (kind) {
    case "fn":        return CompletionItemKind.Function;
    case "type":      return CompletionItemKind.Class;
    case "ctor":      return CompletionItemKind.EnumMember;
    case "store":     return CompletionItemKind.Module;
    case "typeParam": return CompletionItemKind.TypeParameter;
    default:          return CompletionItemKind.Variable;
  }
}

connection.onCompletion(({ textDocument, position }): CompletionItem[] => {
  const a = cache.get(textDocument.uri);
  if (!a) return [];

  const { line, character } = position;

  function posInSpan(s: { start: { line: number; col: number }; end: { line: number; col: number } }): boolean {
    if (line < s.start.line || line > s.end.line) return false;
    if (line === s.start.line && character < s.start.col) return false;
    if (line === s.end.line   && character > s.end.col)   return false;
    return true;
  }

  function spanSize(s: { start: { line: number; col: number }; end: { line: number; col: number } }): number {
    return (s.end.line - s.start.line) * 100000 + s.end.col - s.start.col;
  }

  // Innermost snapshot containing the cursor.
  let bestSnap: ScopeSnapshot | null = null;
  let bestSize = Infinity;
  for (const snap of a.snapshots) {
    if (posInSpan(snap.span)) {
      const sz = spanSize(snap.span);
      if (sz < bestSize) { bestSize = sz; bestSnap = snap; }
    }
  }

  const seen = new Set<string>();
  const items: CompletionItem[] = [];

  const nts = a.nameToTypeString;

  function addScope(scope: Scope | null): void {
    while (scope) {
      for (const b of scope.own()) {
        if (seen.has(b.name)) continue;
        seen.add(b.name);
        const detail = nts.get(b.name);
        const item: CompletionItem = { label: b.name, kind: kindToCompletionKind(b.kind) };
        if (detail !== undefined) item.detail = detail;
        items.push(item);
      }
      scope = scope.parent;
    }
  }

  addScope(bestSnap ? bestSnap.scope : a.globals);

  // Also surface prelude names not already covered by scope.
  for (const [name, typeStr] of nts) {
    if (seen.has(name)) continue;
    seen.add(name);
    items.push({ label: name, kind: CompletionItemKind.Function, detail: typeStr });
  }

  return items;
});

// ── Semantic tokens ──────────────────────────────────────────────────────────

// An atom_lit is a step-label (not a value) when it's the transition target
// in step_goto/step_inline, the name in a saga_step definition, or the
// compensation target in a rollback_stmt.
function isStepLabel(node: Parser.SyntaxNode): boolean {
  const p = node.parent;
  if (!p) return false;
  if (p.type === "step_goto" || p.type === "step_inline")
    return p.namedChildren[0] === node;
  if (p.type === "saga_step")
    return p.namedChildren[0] === node;
  if (p.type === "rollback_stmt") {
    const atoms = p.namedChildren.filter(c => c.type === "atom_lit");
    return atoms[atoms.length - 1] === node;
  }
  return false;
}

function collectAtomTokens(
  node: Parser.SyntaxNode,
  tokens: { line: number; col: number; len: number; type: number }[]
): void {
  if (node.type === "atom_lit") {
    tokens.push({
      line: node.startPosition.row,
      col:  node.startPosition.column,
      len:  node.endPosition.column - node.startPosition.column,
      type: isStepLabel(node) ? TOKEN_LABEL : TOKEN_ENUM_MEMBER,
    });
  }
  for (const child of node.children) collectAtomTokens(child, tokens);
}

function encodeSemanticTokens(
  tokens: { line: number; col: number; len: number; type: number }[]
): number[] {
  tokens.sort((a, b) => a.line !== b.line ? a.line - b.line : a.col - b.col);
  const data: number[] = [];
  let prevLine = 0, prevCol = 0;
  for (const t of tokens) {
    const dLine = t.line - prevLine;
    const dCol  = dLine === 0 ? t.col - prevCol : t.col;
    data.push(dLine, dCol, t.len, t.type, 0);
    prevLine = t.line;
    prevCol  = t.col;
  }
  return data;
}

connection.onRequest("textDocument/semanticTokens/full",
  ({ textDocument }: { textDocument: { uri: string } }): SemanticTokens => {
    const a = cache.get(textDocument.uri);
    if (!a) return { data: [] };
    const tokens: { line: number; col: number; len: number; type: number }[] = [];
    collectAtomTokens(a.tree.rootNode, tokens);
    return { data: encodeSemanticTokens(tokens) };
  }
);

// ── Start ─────────────────────────────────────────────────────────────────────

documents.listen(connection);
connection.listen();
