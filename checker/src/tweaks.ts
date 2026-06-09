// ── Tweak-density analyzer (§9.6 — the intent/tweak gradient) ────────────────────
// The tier model is EMERGENT, not declared: a prop value is either *intent*
// (token-driven — on a defined scale, or a semantic unit like Fill/Fit) or a *tweak*
// (a `raw()` escape, an explicit pixel/colour magic constant, or an off-scale
// number). The more tweaks a component carries, the more it has decayed into the
// "all-tweak layer" (the reason a utility-class soup stops scaling). This pass
// measures that ratio per component.
//
// Why this is STATIC (not a runtime analyzer like `analyze()`): the runtime VElement
// tree has already collapsed `raw(13)` → `13` and `Px 13` → a resolved value, erasing
// exactly the intent/tweak distinction. So this walks the lowered AST, where the
// source shape survives. Exposed as the `velve tweaks <file>` CLI subcommand.

import type { Module, Decl, Expr } from "./ast.js";
import { visitExpr } from "./find.js";
import { constEval, EMPTY_ENV, PROP_SCALE, type ConstVal } from "./infer.js";

// Props that carry design-system weight — the surface where the gradient matters.
// (weight/opacity/grow/shrink/align/justify are layout mechanics, not tokens → skip.)
const TRACKED_PROPS = new Set([
  "width", "height", "padding", "margin", "gap", "radius", "basis", // box-model lengths
  "size",                                                           // typography scale
  "color", "background",                                            // colour
]);
const COLOR_PROPS = new Set(["color", "background"]);

// Length constructors that express layout intent (relative/fluid), not a magic pixel.
const SEMANTIC_CTORS = new Set(["Fill", "Fit", "Fr", "Clamp"]);
// Length constructors that wrap a raw dimension → an explicit one-off tweak.
const RAW_CTORS = new Set(["Px", "Pct"]);

type Class = "token" | "semantic" | "tweak" | "dynamic";

interface PropTweak { name: string; reason: string; }
interface CompReport {
  name: string;
  tweaks: PropTweak[];
  tracked: number;   // intent + tweak (hardcoded values; dynamic refs excluded)
}

// Collect `type Name = Base where <pred>` refinements (the defined token scales) by
// name → predicate. A literal "on scale" iff folding the predicate with value bound
// yields true.
function collectScales(decls: Decl[], out: Map<string, Expr>): void {
  for (const d of decls) {
    if (d.tag === "DModule") collectScales(d.decls, out);
    else if (d.tag === "DType" && d.body.tag === "TBAlias" && d.body.pred)
      out.set(d.name, d.body.pred);
  }
}

function callee(e: Expr): string | null {
  if (e.tag === "Call") return e.fn.tag === "Var" ? e.fn.name : null;
  if (e.tag === "Var") return e.name;
  return null;
}

// Classify one prop value against the project's defined scales.
function classify(name: string, value: Expr, scales: Map<string, Expr>): { cls: Class; reason: string } {
  const head = callee(value);

  // `raw(n)` — the explicit escape hatch. Always a tweak, by definition.
  if (value.tag === "Call" && head === "raw")
    return { cls: "tweak", reason: "raw() escape" };

  // Length constructors.
  if (head && SEMANTIC_CTORS.has(head)) return { cls: "semantic", reason: head };
  if (head && RAW_CTORS.has(head))
    return { cls: "tweak", reason: `explicit ${head.toLowerCase()}` };

  // Colour literals — a hardcoded hex/keyword is a magic colour (no colour scale
  // exists to make it intent).
  if (COLOR_PROPS.has(name) && value.tag === "Lit" && value.lit.tag === "Str")
    return { cls: "tweak", reason: "magic colour" };

  // Numeric literals (possibly via `Px n`/folded arithmetic) on a length/size prop.
  const cv = constEval(value, EMPTY_ENV);
  if (typeof cv === "number") {
    const scaleName = PROP_SCALE[name];
    const pred = scaleName ? scales.get(scaleName) : undefined;
    if (pred) {
      const onScale = constEval(pred, new Map<string, ConstVal>([["value", cv]])) === true;
      return onScale
        ? { cls: "token", reason: `${scaleName} token` }
        : { cls: "tweak", reason: `off the '${scaleName}' scale` };
    }
    return { cls: "tweak", reason: "magic number (no scale defined)" };
  }

  // A variable / param / field / interpolation — parameterized, not a hardcoded
  // value. Neutral: the caller decides, so it neither helps nor hurts the ratio.
  return { cls: "dynamic", reason: "" };
}

function reportComponent(name: string, body: Expr, scales: Map<string, Expr>): CompReport | null {
  const tweaks: PropTweak[] = [];
  let tracked = 0;
  let sawElement = false;
  visitExpr(body, e => {
    if (e.tag !== "Element") return;
    sawElement = true;
    for (const p of e.props) {
      if (!TRACKED_PROPS.has(p.name)) continue;
      const { cls, reason } = classify(p.name, p.value, scales);
      if (cls === "dynamic") continue;
      tracked++;
      if (cls === "tweak") tweaks.push({ name: p.name, reason });
    }
  });
  return sawElement ? { name, tweaks, tracked } : null;
}

export function analyzeTweaks(mod: Module): string {
  const scales = new Map<string, Expr>();
  collectScales(mod.decls, scales);

  const reports: CompReport[] = [];
  const walk = (decls: Decl[]) => {
    for (const d of decls) {
      if (d.tag === "DModule") walk(d.decls);
      else if (d.tag === "DFn")
        for (const clause of d.clauses) {
          const r = reportComponent(d.name, clause.body, scales);
          if (r) reports.push(r);
        }
    }
  };
  walk(mod.decls);

  const header = scales.size
    ? `tweak density (scales: ${[...scales.keys()].join(", ")})`
    : "tweak density (no token scales defined — every hardcoded value reads as a tweak)";

  if (reports.length === 0) return `${header}\n  (no components found)`;

  const lines: string[] = [header];
  let totalTweaks = 0;
  for (const r of reports) {
    const pct = r.tracked ? Math.round((r.tweaks.length / r.tracked) * 100) : 0;
    const flag = r.tracked > 0 && r.tweaks.length / r.tracked > 0.5 ? " ⚠" : "";
    lines.push(`  ${r.name}: ${r.tweaks.length} tweaks / ${r.tracked} tracked (${pct}%)${flag}`);
    for (const t of r.tweaks) lines.push(`      ${t.name}  (${t.reason})`);
    totalTweaks += r.tweaks.length;
  }
  lines.push(`summary: ${totalTweaks} tweak${totalTweaks === 1 ? "" : "s"} across ${reports.length} component${reports.length === 1 ? "" : "s"}`);
  return lines.join("\n");
}
