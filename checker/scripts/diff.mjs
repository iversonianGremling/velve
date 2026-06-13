// diff.mjs — the three-column differential harness (D1). For every .velve fixture/
// example it runs CHECK, RUN (eval — the reference semantics), and RUNC (the Velve-
// Core→JS compiled path), then asserts the compiled stdout is byte-identical to
// eval's wherever the program compiles. `eval.ts` is never deleted; it is the oracle.
//
// Verdicts per file:
//   match        — checks clean, both paths ran, stdout identical          (✓)
//   mismatch     — both ran but stdout differs                              (✗ gate)
//   js-crash     — compiled path threw a JS error (a frontier leak)        (✗ gate)
//   unsupported  — compiler refused at the frontier (exit 2) — expected    (·)
//   check-fail   — does not type-check; compiled path not meaningful       (·)
//   eval-error   — eval raised a runtime error; nothing to compare against (·)
//
// Exit nonzero if any `mismatch` or `js-crash` appears — those are regressions /
// miscompiles. `unsupported` is the honest, growing frontier and never fails the gate.
// Usage: node scripts/diff.mjs [--all]   (default lists only non-trivial verdicts)

import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const IDX = join(ROOT, "checker", "dist", "index.js");
const DIRS = [join(ROOT, "checker"), join(ROOT, "checker", "std"), join(ROOT, "examples"), ROOT];
const SHOW_ALL = process.argv.includes("--all");

const listVelve = d => { try { return readdirSync(d).filter(f => f.endsWith(".velve")).map(f => join(d, f)); } catch { return []; } };
const files = [...new Set(DIRS.flatMap(listVelve))].sort();

function runCmd(cmd, file) {
  try {
    const out = execFileSync("node", [IDX, cmd, file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
    return { out, err: "", code: 0 };
  } catch (e) {
    return { out: e.stdout || "", err: e.stderr || "", code: e.status ?? 1 };
  }
}

const counts = { match: 0, mismatch: 0, "js-crash": 0, unsupported: 0, "check-fail": 0, "eval-error": 0 };
const notable = [];

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);

  const chk = runCmd("check", file);
  const checkClean = !/\berror\b/.test(chk.out) && chk.code === 0;
  if (!checkClean) { counts["check-fail"]++; continue; }

  const ev = runCmd("run", file);
  if (/runtime error:/.test(ev.err) || /runtime error:/.test(ev.out)) { counts["eval-error"]++; continue; }

  const rc = runCmd("runc", file);
  if (rc.code === 2 || /^unsupported:/m.test(rc.err)) { counts.unsupported++; continue; }
  if (/TypeError|ReferenceError|SyntaxError|is not a function|at Object|at Module/.test(rc.err)) {
    counts["js-crash"]++; notable.push(`✗ js-crash    ${rel}\t${(rc.err.split("\n").find(Boolean) || "").slice(0, 80)}`); continue;
  }

  if (ev.out === rc.out) { counts.match++; if (SHOW_ALL) notable.push(`✓ match       ${rel}`); }
  else { counts.mismatch++; notable.push(`✗ MISMATCH    ${rel}\n    eval: ${JSON.stringify(ev.out.slice(0, 60))}\n    runc: ${JSON.stringify(rc.out.slice(0, 60))}`); }
}

if (notable.length) console.log(notable.join("\n"));
console.log("\n— differential summary —");
for (const [k, v] of Object.entries(counts)) console.log(`  ${k.padEnd(12)} ${v}`);
const regressions = counts.mismatch + counts["js-crash"];
console.log(regressions === 0
  ? `\n✓ no mismatches, no js-crashes across ${files.length} files (eval ≡ compiled on every compiled program)`
  : `\n✗ ${regressions} regression(s) — compiled output diverged from eval`);
process.exit(regressions === 0 ? 0 : 1);
