// baseline.mjs — run `check` over every .velve fixture/example and emit a
// compact, stable summary (path → error count + first error line) so a
// migration can be diffed before/after. Usage: node scripts/baseline.mjs
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIRS = [join(ROOT, "checker"), join(ROOT, "checker", "std"), join(ROOT, "examples"), ROOT];

function listVelve(dir) {
  return readdirSync(dir).filter(f => f.endsWith(".velve")).map(f => join(dir, f));
}

const files = [...new Set(DIRS.flatMap(listVelve))].sort();
const lines = [];
for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  let out = "";
  try {
    out = execFileSync("node", [join(ROOT, "checker", "dist", "index.js"), "check", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  } catch (e) {
    out = (e.stdout || "") + (e.stderr || "");
  }
  const errs = out.split("\n").filter(l => /\berror\b/.test(l) && !l.includes("DeprecationWarning"));
  const crash = /TypeError|ReferenceError|throw|at Object|at Module|\bError:/.test(out) && errs.length === 0;
  lines.push(`${rel}\t${crash ? "CRASH" : errs.length + " err"}\t${(errs[0] || "").trim().slice(0, 80)}`);
}
console.log(lines.join("\n"));
