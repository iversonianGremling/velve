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
// `./`- and `../`-relative paths resolve to a sibling file. A `std/…` path
// resolves to a Velve source file shipped WITH the compiler (`checker/std/`) —
// but only if such a file exists: the ambient stdlib modules (`std/json`,
// `std/set`, the capitalized namespaces) have no `.velve` source and stay for
// infer.ts to resolve (§5.5). Everything else (bare `"String"`, foreign
// `import js`) is left untouched here.
import Parser from "tree-sitter";
// @ts-ignore — no types for the native grammar
import Velve from "tree-sitter-velve";
import { readFileSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { Lowerer } from "./lower.js";
import { collectParseErrors } from "./parseErrors.js";
import type { Module, Decl } from "./ast.js";
import type { Diagnostic } from "./resolve.js";

// The stdlib source tree ships next to the compiler. From `dist/loader.js` this
// is `dist/../std` = `checker/std`; from `src/loader.ts` it is `src/../std` =
// `checker/std` — both land on the same directory, so the resolution is stable
// whether we run the built or the source tree.
const STD_ROOT = resolvePath(dirname(fileURLToPath(import.meta.url)), "..", "std");

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

// A `std/…` path names a compiler-shipped module. It resolves to disk only if
// the source file exists; otherwise the path is an ambient stdlib name.
function isStdPath(path: string): boolean {
  return path.startsWith("std/");
}

function resolveStd(path: string): string {
  const rest = path.slice("std/".length);
  const withExt = rest.endsWith(".velve") ? rest : rest + ".velve";
  return resolvePath(STD_ROOT, withExt);
}

function fileExists(file: string): boolean {
  try { readFileSync(file, "utf8"); return true; } catch { return false; }
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
    // The current file joins the DFS stack for the duration of its own load, so
    // a dependency that imports back into it (directly or transitively) is caught
    // as a cycle BEFORE we recurse — including a cycle through the entry file.
    onStack.add(file);
    let src: string;
    try {
      src = readFileSync(file, "utf8");
    } catch {
      // Reported against the importer via the DImport span (see caller).
      onStack.delete(file);
      return { source: file, decls: [], edition: "2026.1" } as Module;
    }
    const tree = parser.parse(src);
    diagnostics.push(...collectParseErrors(tree.rootNode as any, file));
    const lowerer = new Lowerer(file);
    const mod = lowerer.lower(tree);
    diagnostics.push(...lowerer.diagnostics);

    for (const decl of mod.decls) {
      if (decl.tag !== "DImport") continue;
      // Where does this import resolve on disk? A `./`/`../` path is always a
      // file (a missing one is an error). A `std/…` path is a file only if the
      // compiler ships its source — otherwise it is an ambient stdlib module,
      // which we leave for infer.ts (do NOT mark `local`, do NOT error).
      let dep: string;
      if (isLocalPath(decl.path)) {
        dep = resolveLocal(file, decl.path);
        if (!fileExists(dep)) {
          diagnostics.push({ kind: "error", span: decl.span,
            message: `cannot resolve import '${decl.path}' — no file at ${dep}` });
          continue;
        }
      } else if (isStdPath(decl.path)) {
        const cand = resolveStd(decl.path);
        if (!fileExists(cand)) continue;   // ambient stdlib module, not on disk
        dep = cand;
      } else {
        continue;
      }
      // This import is satisfied by merged decls, not its own binding path.
      decl.local = true;
      if (loaded.has(dep)) continue;     // diamond: already merged once
      if (onStack.has(dep)) {            // back-edge: a cycle in the import graph
        diagnostics.push({ kind: "error", span: decl.span,
          message: `cyclic import of '${decl.path}' — the module import graph must be acyclic (recursion within a module is fine; a cycle between files is not)` });
        continue;
      }
      const depMod = load(dep);
      loaded.add(dep);
      merged.push(...depMod.decls);
    }
    onStack.delete(file);
    return mod;
  }

  // Normalize the entry to an absolute path so its `onStack`/`loaded` key matches
  // the absolute paths `resolveLocal` produces — otherwise a cycle back through
  // the entry (a → b → a) wouldn't be recognized as the same file, and the entry
  // would load (and merge) twice.
  const entry = load(resolvePath(entryFile));
  // Entry decls come last: a top-level expression in the entry may reference
  // anything an imported module exported.
  merged.push(...entry.decls);
  return { mod: { source: entryFile, decls: merged, edition: entry.edition }, diagnostics };
}
