// loader.ts — multi-file module loading (Phase C1, SPEC §7.3).
//
// A Velve program is one entry file plus the file-relative modules it `import`s,
// transitively. Rather than thread a cross-file symbol table through every pass,
// the loader produces a SINGLE merged `Module`: the imported files' decls are
// spliced in ahead of the entry's, in dependency order. Everything downstream
// (resolve / infer / exhaust / eval) then runs unchanged, because a module
// nested in the decl list is exactly what a single-file `module Foo { … }` already
// produces — the registries (REFINEMENTS, FN_PARAMS, ADT_CTORS) become
// per-program for free, and `@private` ctors stay sealed to their module via the
// existing `privateTo` / moduleStack machinery.
//
// Only `./`- and `../`-relative paths resolve to disk here; bare names
// (`"String"`, `"std/json"`) stay stdlib/ambient imports, handled per-module as
// before. `std/` on disk is C1(iii).
import Parser from "tree-sitter";
// @ts-ignore — no types for the native grammar
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { Lowerer } from "./lower.js";
import { collectParseErrors } from "./parseErrors.js";
import type { Module, Decl } from "./ast.js";
import type { Diagnostic } from "./resolve.js";

export interface LoadResult {
  mod: Module;
  diagnostics: Diagnostic[];
}

// A path is file-local (resolved from disk) iff it is written relative to the
// importing file. Everything else is a stdlib/ambient module name.
function isLocalPath(path: string): boolean {
  return path.startsWith("./") || path.startsWith("../");
}

function resolveLocal(importerFile: string, path: string): string {
  const withExt = path.endsWith(".velve") ? path : path + ".velve";
  return resolvePath(dirname(importerFile), withExt);
}

export function loadProgram(entryFile: string): LoadResult {
  const parser = new Parser();
  parser.setLanguage(Velve);

  const diagnostics: Diagnostic[] = [];
  // Files whose decls are already merged in (dedup diamond imports by abspath).
  const loaded = new Set<string>();
  // The DFS stack of in-progress files — re-entering one is a cyclic import.
  const onStack = new Set<string>();
  // Imported-first accumulation; the entry file's own decls are appended last.
  const merged: Decl[] = [];

  // Parse + lower one file, recurse into its local imports (post-order so a
  // dependency's decls land before the file that needs them), and return the
  // file's own decls. Returns the lowered Module so the entry keeps its edition.
  function load(file: string): Module {
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // Reported against the importer via the DImport span (see caller).
      return { source: file, decls: [], edition: "2026.1" } as Module;
    }
    const tree = parser.parse(src);
    diagnostics.push(...collectParseErrors(tree.rootNode as any, file));
    const lowerer = new Lowerer(file);
    const mod = lowerer.lower(tree);
    diagnostics.push(...lowerer.diagnostics);

    for (const decl of mod.decls) {
      if (decl.tag !== "DImport" || !isLocalPath(decl.path)) continue;
      const dep = resolveLocal(file, decl.path);
      // This import is satisfied by merged decls, not its own binding path.
      decl.local = true;
      if (loaded.has(dep)) continue;
      if (onStack.has(dep)) {
        diagnostics.push({ kind: "error", span: decl.span,
          message: `cyclic import of '${decl.path}' — the module import graph must be acyclic (recursion within a module is fine; a cycle between files is not)` });
        continue;
      }
      let exists = true;
      try { readFileSync(dep, "utf8"); } catch { exists = false; }
      if (!exists) {
        diagnostics.push({ kind: "error", span: decl.span,
          message: `cannot resolve import '${decl.path}' — no file at ${dep}` });
        continue;
      }
      onStack.add(dep);
      const depMod = load(dep);
      onStack.delete(dep);
      loaded.add(dep);
      merged.push(...depMod.decls);
    }
    return mod;
  }

  const entry = load(entryFile);
  // Entry decls come last: a top-level expression in the entry may reference
  // anything an imported module exported.
  merged.push(...entry.decls);
  return { mod: { source: entryFile, decls: merged, edition: entry.edition }, diagnostics };
}
