// ── UI renderer ───────────────────────────────────────────────────────────────
// Turns a rendered `VElement` tree (produced by evaluating the view DSL) into an
// HTML string. This is the BASELINE server-render: component/primitive names map
// to HTML tags, and props map to attributes + a naive inline-style subset. The
// richer "convergence" property model (parent↔child constraint resolution) is a
// separate layer that will run BEFORE this emit step, rewriting props into
// concrete values; this renderer only emits whatever props it is handed.

import type { Value } from "./value.js";
import { display } from "./value.js";

// Layout primitives → the HTML tag we emit. Anything unknown becomes a <div>
// tagged with a data-component attribute so it is still inspectable.
const TAG: Record<string, string> = {
  Stack: "div", Column: "div", Row: "div", Card: "div", Box: "div",
  Spacer: "div", Divider: "hr", Grid: "div", Scroll: "div",
  Text: "span", Heading: "h2", Label: "label",
  Button: "button", Input: "input", Slider: "input",
  Image: "img", Canvas: "canvas", Link: "a", List: "ul", Item: "li",
};

// Props that map to CSS declarations (with a unit/transform). Everything else
// becomes a plain HTML attribute. Numeric layout props get `px`.
const PX = (v: string) => (/^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v);
const CSS: Record<string, (v: string) => [string, string]> = {
  width:      v => ["width", PX(v)],
  height:     v => ["height", PX(v)],
  padding:    v => ["padding", PX(v)],
  margin:     v => ["margin", PX(v)],
  gap:        v => ["gap", PX(v)],
  radius:     v => ["border-radius", PX(v)],
  background: v => ["background", v],
  color:      v => ["color", v],
  size:       v => ["font-size", PX(v)],
  weight:     v => ["font-weight", v],
  font:       v => ["font-family", v],
  align:      v => ["align-items", v],
  justify:    v => ["justify-content", v],
  opacity:    v => ["opacity", v],
  grow:       v => ["flex-grow", v],
  shrink:     v => ["flex-shrink", v],
  basis:      v => ["flex-basis", PX(v)],
  alignSelf:  v => ["align-self", v],
};

// Flex direction implied by the primitive name.
const FLEX: Record<string, string> = {
  Row: "row", Column: "column", Stack: "column", Grid: "row",
};

// ── Shared styling helpers (reused by the live browser runtime, browser.ts) ──────
// One source of truth for prop→CSS so the live DOM matches the SSR HTML exactly.
export function propToCss(name: string, value: string): [string, string] | null {
  const f = CSS[name];
  return f ? f(value) : null;
}
export function tagFor(name: string): string { return TAG[name] ?? "div"; }
export function isKnownTag(name: string): boolean { return name in TAG; }
export function flexDir(name: string): string | undefined { return FLEX[name]; }

const ESC = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// A `Length` ADT value → its CSS form, or null if `v` is not a Length ctor.
// Px/Fr/Pct carry a Number; Fit/Fill are nullary. A bare Number prop is handled
// by PX() in the CSS map (number → `px`); this only covers the explicit ctors.
export function unitToCss(v: Value): string | null {
  if (v.tag !== "VCtor") return null;
  const n = v.payload && v.payload.tag === "VNum" ? v.payload.v : null;
  switch (v.name) {
    case "Px":   return n != null ? `${n}px` : null;
    case "Pct":  return n != null ? `${n}%`  : null;
    case "Fr":   return n != null ? `${n}fr` : null;
    case "Fit":  return "fit-content";
    case "Fill": return "100%";
    case "Clamp": {
      // Payload is a (lo, hi) tuple of Numbers (px). Fluid band: ≥lo, ≤hi,
      // `100%` between → CSS clamp(lo, 100%, hi).
      const p = v.payload;
      if (p && p.tag === "VTuple" && p.elems.length === 2) {
        const lo = p.elems[0], hi = p.elems[1];
        if (lo?.tag === "VNum" && hi?.tag === "VNum")
          return `clamp(${lo.v}px, 100%, ${hi.v}px)`;
      }
      return null;
    }
    default:     return null;
  }
}

// A prop/text value → its flat string form (strings unquoted, others displayed).
export function asText(v: Value): string {
  return v.tag === "VStr" ? v.v
    : v.tag === "VNum" ? String(v.v)
    : v.tag === "VBool" ? String(v.v)
    : v.tag === "VAtom" ? v.name
    : display(v);
}

function renderNode(v: Value, indent: number): string {
  // Non-element children (text from `{expr}`, numbers, etc.) render as text.
  if (v.tag !== "VElement") return ESC(asText(v));

  const pad = "  ".repeat(indent);
  const tag = TAG[v.name] ?? "div";

  const styles: string[] = [];
  const attrs: string[] = [];
  if (FLEX[v.name]) { styles.push("display:flex", `flex-direction:${FLEX[v.name]}`); }
  if (!(v.name in TAG)) attrs.push(`data-component="${ESC(v.name)}"`);

  for (const [k, val] of v.props) {
    // `key` is the reconciliation identity (read by keyOf in runtime.ts), not a DOM
    // attribute — stripped from the rendered markup, as in React.
    if (k === "key") continue;
    const s = unitToCss(val) ?? asText(val);
    const css = CSS[k];
    if (css) { const [prop, out] = css(s); styles.push(`${prop}:${out}`); }
    else attrs.push(`${ESC(k)}="${ESC(s)}"`);
  }
  // Captured handlers are surfaced as data-on-* markers; a live runtime wires the
  // actual closures (this static emit can't run them).
  for (const ev of v.events.keys()) attrs.push(`data-${ev.toLowerCase()}="true"`);
  if (styles.length) attrs.push(`style="${ESC(styles.join(";"))}"`);

  const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;

  // Void elements (img/hr/input) self-close.
  if (tag === "img" || tag === "hr" || tag === "input")
    return `${pad}${open.replace(/>$/, " />")}`;

  // Flatten list-valued children (e.g. `{xs |> map …}`).
  const kids: Value[] = [];
  if (v.text) kids.push(v.text);
  for (const c of v.children) {
    if (c.tag === "VList") kids.push(...c.elems);
    else if (c.tag !== "VUnit") kids.push(c);
  }

  // Leaf with a single text child → keep on one line.
  if (kids.length === 1 && kids[0]!.tag !== "VElement")
    return `${pad}${open}${renderNode(kids[0]!, 0)}</${tag}>`;
  if (kids.length === 0) return `${pad}${open}</${tag}>`;

  const inner = kids.map(c => renderNode(c, indent + 1)).join("\n");
  return `${pad}${open}\n${inner}\n${pad}</${tag}>`;
}

export function renderHtml(v: Value): string {
  return renderNode(v, 0);
}

// ── UI model (analyzable IR) ────────────────────────────────────────────────────
// Serializes a VElement tree to a readable, annotated outline — for static analysis
// (a11y / contrast / structure inspection) and for an LLM to reason over. Built from
// the concrete tree, so it shows resolved values; it gets richer once a convergence
// pass resolves cross-references.

const MODEL_MODE: Record<string, string> = {
  Row: "flex", Column: "flex", Stack: "flex", Grid: "flex",
  Box: "block", Card: "block", Scroll: "block", List: "block", Item: "block",
};
const INTERACTIVE = new Set(["Button", "Link", "Input", "Slider"]);
const LABEL_PROPS = ["label", "ariaLabel", "title", "alt"];

function hexRgb(s: string): [number, number, number] | null {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m) return null;
  let h = m[1]!;
  if (h.length === 3) h = h.split("").map(c => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
// WCAG relative luminance + contrast ratio.
function luminance([r, g, b]: [number, number, number]): number {
  const f = (c: number) => { const x = c / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg: string, bg: string): number | null {
  const a = hexRgb(fg), b = hexRgb(bg);
  if (!a || !b) return null;
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

function modelNode(v: Value, indent: number, bg: string | null): string {
  const pad = "  ".repeat(indent);
  if (v.tag !== "VElement") {
    const t = asText(v).trim();
    return t ? `${pad}${JSON.stringify(t)}` : "";
  }
  const mode = MODEL_MODE[v.name] ?? "leaf";
  const parts: string[] = [];
  let color: string | null = null;
  let myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    parts.push(`${k}=${s}`);
    if (k === "background") myBg = s;
    if (k === "color") color = s;
  }
  const text = v.text ? asText(v.text) : "";
  const head = `${pad}${v.name}${text ? ` ${JSON.stringify(text)}` : ""}  [${mode}]` +
    (parts.length ? "  " + parts.join(" ") : "");

  const notes: string[] = [];
  if (color && myBg) {
    const r = contrast(color, myBg);
    if (r != null) notes.push(`· contrast ${r.toFixed(1)}:1 vs ${myBg}${r < 4.5 ? " ⚠ below AA (4.5)" : " ✓"}`);
  }
  if (INTERACTIVE.has(v.name) && !text && !LABEL_PROPS.some(p => v.props.has(p)))
    notes.push("⚠ interactive element has no label/text (a11y)");
  if (mode !== "leaf" && v.children.length === 0 && !text)
    notes.push("⚠ empty container");

  const lines = [head, ...notes.map(n => `${pad}  ${n}`)];
  for (const c of v.children) {
    if (c.tag === "VList") { for (const e of c.elems) { const s = modelNode(e, indent + 1, myBg); if (s) lines.push(s); } }
    else if (c.tag !== "VUnit") { const s = modelNode(c, indent + 1, myBg); if (s) lines.push(s); }
  }
  return lines.join("\n");
}

export function renderModel(v: Value): string {
  return modelNode(v, 0, null);
}

// ── UI model, JSON form (§13.1 deferred half) ───────────────────────────────────
// The same annotated model as `renderModel`, serialized for tools/LLMs that want
// structure rather than an outline. Shares the contrast + prop-resolution helpers.
interface JsonNode {
  element?: string; mode?: string; text?: string; props?: Record<string, string>;
  contrast?: { ratio: number; against: string; passesAA: boolean };
  a11y?: string[]; children?: JsonNode[];
}
function jsonNode(v: Value, bg: string | null): JsonNode | null {
  if (v.tag !== "VElement") { const t = asText(v).trim(); return t ? { text: t } : null; }
  const node: JsonNode = { element: v.name, mode: MODEL_MODE[v.name] ?? "leaf" };
  const props: Record<string, string> = {};
  let color: string | null = null, myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    props[k] = s;
    if (k === "background") myBg = s;
    if (k === "color") color = s;
  }
  if (v.text) node.text = asText(v.text);
  if (Object.keys(props).length) node.props = props;
  if (color && myBg) {
    const r = contrast(color, myBg);
    if (r != null) node.contrast = { ratio: Number(r.toFixed(1)), against: myBg, passesAA: r >= 4.5 };
  }
  if (INTERACTIVE.has(v.name) && !node.text && !LABEL_PROPS.some(p => v.props.has(p))) node.a11y = ["no-label"];
  const kids: JsonNode[] = [];
  for (const c of v.children) {
    if (c.tag === "VList") { for (const e of c.elems) { const n = jsonNode(e, myBg); if (n) kids.push(n); } }
    else if (c.tag !== "VUnit") { const n = jsonNode(c, myBg); if (n) kids.push(n); }
  }
  if (kids.length) node.children = kids;
  return node;
}
export function renderJson(v: Value): string {
  return JSON.stringify(jsonNode(v, null), null, 2);
}

// ── Analyzers (§13.2) ───────────────────────────────────────────────────────────
// Pure passes over the concrete tree that lint for the failure modes a model makes
// visible: value inconsistency (too many distinct paddings/colours → consolidate),
// duplication (identical prop bundles → extract a style), a11y (labelless
// interactive elements, contrast < AA), and structure (empty containers). Reuses
// the same prop-resolution + contrast helpers as the model. Tweak-density and
// token-set membership need source/static info (the runtime tree has collapsed
// `raw(13)`→`13`), so they stay with the deferred half of §13.1.

const SCALE_PROPS = ["padding", "margin", "gap", "radius", "size", "width", "height"];
const COLOR_PROPS = ["color", "background"];

interface ElemView { name: string; props: Map<string, string>; text: string; bg: string | null; }

// Flatten the tree to a list of elements, each with resolved string props and the
// background it inherits (own `background` overrides for itself + descendants).
function flattenElements(v: Value, bg: string | null, out: ElemView[]): void {
  if (v.tag !== "VElement") return;
  const props = new Map<string, string>();
  let myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    props.set(k, s);
    if (k === "background") myBg = s;
  }
  out.push({ name: v.name, props, text: v.text ? asText(v.text) : "", bg: myBg });
  for (const c of v.children) {
    if (c.tag === "VList") for (const e of c.elems) flattenElements(e, myBg, out);
    else if (c.tag !== "VUnit") flattenElements(c, myBg, out);
  }
}

export function analyzeModel(v: Value): string {
  const els: ElemView[] = [];
  flattenElements(v, null, els);
  const sections: string[] = [];

  // Inconsistency — distinct values per tracked prop across the whole tree.
  const distinct = new Map<string, Set<string>>();
  for (const el of els)
    for (const p of [...SCALE_PROPS, ...COLOR_PROPS]) {
      const val = el.props.get(p);
      if (val !== undefined) (distinct.get(p) ?? distinct.set(p, new Set()).get(p)!).add(val);
    }
  const incon = [...distinct.entries()].filter(([, s]) => s.size >= 2)
    .map(([p, s]) => `  ${p}: ${s.size} distinct [${[...s].join(", ")}]${s.size >= 4 ? "  ⚠ consider consolidating to tokens" : ""}`);
  if (incon.length) sections.push("Inconsistency:\n" + incon.join("\n"));

  // Duplication — identical full prop bundles on same-named elements (≥2×).
  const bundles = new Map<string, { count: number; sample: string }>();
  for (const el of els) {
    if (el.props.size === 0) continue;
    const key = el.name + "|" + [...el.props.entries()].map(([k, v2]) => `${k}=${v2}`).sort().join(" ");
    const sample = `${el.name} { ${[...el.props.entries()].map(([k, v2]) => `${k}=${v2}`).join(" ")} }`;
    const cur = bundles.get(key);
    if (cur) cur.count++; else bundles.set(key, { count: 1, sample });
  }
  const dups = [...bundles.values()].filter(b => b.count >= 2)
    .map(b => `  ×${b.count} identical: ${b.sample}  ⚠ extract a style`);
  if (dups.length) sections.push("Duplication:\n" + dups.join("\n"));

  // A11y — labelless interactive elements + contrast below AA.
  const a11y: string[] = [];
  const labelless = els.filter(el => INTERACTIVE.has(el.name) && !el.text && !LABEL_PROPS.some(p => el.props.has(p)));
  if (labelless.length)
    a11y.push(`  ⚠ ${labelless.length} interactive element(s) without label: ${labelless.map(e => e.name).join(", ")}`);
  for (const el of els) {
    const color = el.props.get("color");
    if (color && el.bg) {
      const r = contrast(color, el.bg);
      if (r != null && r < 4.5) a11y.push(`  ⚠ low contrast ${r.toFixed(1)}:1 — ${color} on ${el.bg} (${el.name})`);
    }
  }
  if (a11y.length) sections.push("A11y:\n" + a11y.join("\n"));

  // Structure — flex/block containers with no children and no text. Walked on the
  // live tree (the flattened view has lost child links).
  const emptyNames: string[] = [];
  const checkEmpty = (n: Value): void => {
    if (n.tag !== "VElement") return;
    const kids = n.children.filter(c => c.tag === "VElement" || (c.tag === "VList" && c.elems.length > 0));
    if ((MODEL_MODE[n.name] ?? "leaf") !== "leaf" && kids.length === 0 && !n.text) emptyNames.push(n.name);
    for (const c of n.children) { if (c.tag === "VList") c.elems.forEach(checkEmpty); else checkEmpty(c); }
  };
  checkEmpty(v);
  if (emptyNames.length) sections.push(`Structure:\n  ⚠ ${emptyNames.length} empty container(s): ${emptyNames.join(", ")}`);

  const header = `Analysis (${els.length} elements):`;
  return sections.length ? `${header}\n${sections.join("\n")}` : `${header}\n  ✓ no issues found`;
}
