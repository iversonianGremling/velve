// runbaseline.mjs — `run` every .velve fixture/example, record a compact result
// (path → ok / runtime-error / crash) to diff a migration's runtime behavior.
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const DIRS = [join(ROOT, "checker"), join(ROOT, "examples"), ROOT];
const listVelve = d => readdirSync(d).filter(f => f.endsWith(".velve")).map(f => join(d, f));
const files = [...new Set(DIRS.flatMap(listVelve))].sort();

for (const file of files) {
  const rel = file.slice(ROOT.length + 1);
  let out = "", code = 0;
  try {
    out = execFileSync("node", [join(ROOT, "checker", "dist", "index.js"), "run", file],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 20000, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
  } catch (e) { out = (e.stdout || "") + (e.stderr || ""); code = e.status ?? 1; }
  const rt = (out.match(/runtime error:[^\n]*/) || [])[0];
  const js = /TypeError|ReferenceError|at Object\.|at Module|Cannot read prop/.test(out);
  const tag = js ? "JS-CRASH" : rt ? "rt-error" : code === 0 ? "ok" : "check-fail";
  console.log(`${rel}\t${tag}\t${(rt || "").slice(0, 70)}`);
}
