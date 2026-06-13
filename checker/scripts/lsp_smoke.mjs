// lsp_smoke.mjs — the C1(vi) proof. Drives the LSP's pure analysis/query
// functions (exported from dist/lsp.js) over IN-MEMORY buffers, the way the
// editor does. It proves the editor path is loader-aware: an open buffer that
// `import`s from a std library type-checks clean, hover/definition/completion
// answer correctly, go-to-definition crosses INTO the imported file, and type
// errors (incl. unresolved imports) surface on the open file.
//
// Usage: node scripts/lsp_smoke.mjs   (after `npm run build`)
import assert from "node:assert/strict";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE       = dirname(fileURLToPath(import.meta.url));
const CHECKER    = resolvePath(HERE, "..");
const { analyzeText, hoverAt, definitionAt, completionsAt, semanticTokensFor } =
  await import(pathToFileURL(resolvePath(CHECKER, "dist", "lsp.js")).href);

// A virtual entry file inside checker/ (need not exist on disk — the open buffer
// overrides disk). `std/units` resolves via the compiler's std root regardless.
const greenUri = pathToFileURL(resolvePath(CHECKER, "__lsp_smoke_green.velve")).href;

// Position of the first character of `needle` in `text`, as {line, character}.
function loc(text, needle) {
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`needle not found: ${JSON.stringify(needle)}`);
  const before = text.slice(0, i);
  const line = before.split("\n").length - 1;
  const character = i - (before.lastIndexOf("\n") + 1);
  return { line, character };
}

let passed = 0;
const ok = (label) => { console.log(`  ok  ${label}`); passed++; };

// ── GREEN: an open buffer that imports from std/units, fully resolved ──────────
{
  const text = [
    '@edition "2026.6"',
    'import { meters, inMeters } from "std/units"',
    '',
    'def demo(): Number',
    '  let d: Meters = meters(42)',
    '  inMeters(d)',
    '',
  ].join("\n");

  const { analysis, lspDiags } = analyzeText(greenUri, text);

  // (1) Loader-aware: imported `meters`/`inMeters` + the un-imported type name
  // `Meters` all resolve, so the buffer type-checks with ZERO errors. Pre-loader
  // this would die "undefined variable: meters".
  const errs = lspDiags.filter(d => d.severity === 1 /* Error */);
  assert.equal(errs.length, 0, `expected 0 errors, got: ${JSON.stringify(errs)}`);
  ok("green buffer: imports resolve, 0 errors");

  // (2) Hover on the `d` in `inMeters(d)` reports its unit type.
  const dUse = loc(text, "(d)");
  const hov = hoverAt(analysis, dUse.line, dUse.character + 1); // +1 → onto the `d`
  assert.ok(hov, "hover returned null on `d`");
  assert.match(hov.contents.value, /d : Meters/, `hover was: ${hov.contents.value}`);
  ok("hover on `d` → `d : Meters`");

  // (3) Same-file go-to-definition: `d` use → its `let d` binding, this file.
  const defD = definitionAt(analysis, dUse.line, dUse.character + 1);
  assert.ok(defD, "definition of `d` returned null");
  assert.equal(defD.uri, greenUri, "definition of `d` should stay in the open file");
  const letD = loc(text, "let d");
  assert.equal(defD.range.start.line, letD.line, "definition of `d` points at the wrong line");
  ok("go-to-definition `d` → its `let` binding (same file)");

  // (4) CROSS-FILE go-to-definition: the `meters` call → std/units.velve.
  const callM = loc(text, "meters(42)");
  const defM = definitionAt(analysis, callM.line, callM.character + 1);
  assert.ok(defM, "definition of `meters` returned null");
  assert.notEqual(defM.uri, greenUri, "definition of `meters` should cross files");
  assert.match(defM.uri, /std[/\\]units\.velve$/, `definition uri was: ${defM.uri}`);
  ok("go-to-definition `meters` → std/units.velve (cross-file)");

  // (5) Completion inside the body surfaces the IMPORTED names — proof the
  // loader's merged surface reaches the editor (the imported type names too).
  const comps = completionsAt(analysis, dUse.line, dUse.character + 1).map(c => c.label);
  for (const name of ["meters", "inMeters", "Meters"])
    assert.ok(comps.includes(name), `completion missing ${name}; got ${comps.slice(0, 20)}`);
  ok("completion offers the imported names (meters, inMeters, Meters)");
}

// ── SEMANTIC TOKENS: an atom literal is tokenized ──────────────────────────────
{
  const text = [
    '@edition "2026.6"',
    'def pick(): Atom',
    '  :idle',
    '',
  ].join("\n");
  const { analysis } = analyzeText(
    pathToFileURL(resolvePath(CHECKER, "__lsp_smoke_atom.velve")).href, text);
  const { data } = semanticTokensFor(analysis);
  assert.ok(data.length >= 5, `expected >=1 semantic token (5 ints), got ${data.length}`);
  ok("semantic tokens: `:idle` atom is emitted");
}

// ── BAD #1: a plain type error surfaces on the open file ───────────────────────
{
  const text = [
    '@edition "2026.6"',
    'def bad(): Number',
    '  let x: Number = "hello"',
    '  x',
    '',
  ].join("\n");
  const { lspDiags } = analyzeText(
    pathToFileURL(resolvePath(CHECKER, "__lsp_smoke_bad1.velve")).href, text);
  const errs = lspDiags.filter(d => d.severity === 1);
  assert.ok(errs.length >= 1, "expected a type error, got none");
  const letX = loc(text, 'let x');
  assert.ok(errs.some(d => d.range.start.line === letX.line),
    `error not on the offending line; got ${JSON.stringify(errs.map(e => e.range.start))}`);
  ok("bad #1: `let x: Number = \"hello\"` reports an error on its line");
}

// ── BAD #2: a loader import-resolution error surfaces on the import line ───────
{
  const text = [
    '@edition "2026.6"',
    'import { thing } from "./does_not_exist"',
    '',
    'def f(): Number',
    '  1',
    '',
  ].join("\n");
  const { lspDiags } = analyzeText(
    pathToFileURL(resolvePath(CHECKER, "__lsp_smoke_bad2.velve")).href, text);
  const errs = lspDiags.filter(d => d.severity === 1);
  assert.ok(errs.some(d => /cannot resolve import/.test(d.message)),
    `expected a 'cannot resolve import' error, got: ${JSON.stringify(errs.map(e => e.message))}`);
  const importLine = loc(text, "import").line;
  assert.ok(errs.every(d => d.range.start.line === importLine),
    "the import error should land on the import line");
  ok("bad #2: unresolvable `import … from \"./does_not_exist\"` surfaces on the import line");
}

console.log(`\nLSP smoke: ${passed}/${passed} checks passed.`);
