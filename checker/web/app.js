/* velve web runtime — bundled by esbuild (npm run bundle). The original module boundaries are kept as  comments below, in dependency order: value -> scheduler -> render -> converge -> runtime -> domhost -> eval -> browser. Run 
> velve-checker@0.1.0 bundle:min
> tsc && esbuild dist/web-entry.js --bundle --format=esm --platform=browser --external:node:fs/promises --minify --outfile=web/app.min.js for the minified production build. */

// dist/value.js
function dictKey(v) {
  switch (v.tag) {
    case "VNum":
      return "n:" + v.v;
    case "VStr":
      return "s:" + v.v;
    case "VBool":
      return "b:" + v.v;
    case "VAtom":
      return "a:" + v.name;
    case "VUnit":
      return "u:";
    case "VTuple":
      return "t:(" + v.elems.map(dictKey).join(",") + ")";
    case "VList":
      return "l:[" + v.elems.map(dictKey).join(",") + "]";
    case "VCtor":
      return "c:" + v.name + (v.payload ? "(" + dictKey(v.payload) + ")" : "");
    default:
      return "x:" + display(v);
  }
}
var VStreamQueue = class {
  buffer = [];
  waiters = [];
  push(v) {
    if (this.waiters.length)
      this.waiters.shift()(v);
    else
      this.buffer.push(v);
  }
  next() {
    if (this.buffer.length)
      return Promise.resolve(this.buffer.shift());
    return new Promise((resolve) => this.waiters.push(resolve));
  }
  // Like next(), but resolves to `undefined` if `ms` virtual time elapses before a
  // value arrives. Unlike racing next() against a timer, the waiter is removed on
  // timeout, so no pushed value is ever lost. Used by `streamDebounce`.
  nextWithin(ms, sched) {
    if (this.buffer.length)
      return Promise.resolve(this.buffer.shift());
    return new Promise((resolve) => {
      let settled = false;
      const waiter = (v) => {
        if (settled)
          return;
        settled = true;
        resolve(v);
      };
      this.waiters.push(waiter);
      sched.sleep(ms).then(() => {
        if (settled)
          return;
        settled = true;
        const i = this.waiters.indexOf(waiter);
        if (i >= 0)
          this.waiters.splice(i, 1);
        resolve(void 0);
      });
    });
  }
};
var Env = class _Env {
  parent;
  bindings = /* @__PURE__ */ new Map();
  constructor(parent = null) {
    this.parent = parent;
  }
  define(name, val) {
    this.bindings.set(name, val);
  }
  set(name, val) {
    if (this.bindings.has(name)) {
      this.bindings.set(name, val);
      return;
    }
    if (this.parent)
      this.parent.set(name, val);
  }
  lookup(name) {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }
  child() {
    return new _Env(this);
  }
  // Collect all bindings visible from this scope (child bindings shadow parent).
  allBindings() {
    const all = this.parent ? this.parent.allBindings() : /* @__PURE__ */ new Map();
    for (const [k, v] of this.bindings)
      all.set(k, v);
    return all;
  }
};
function display(v) {
  switch (v.tag) {
    case "VNum":
      return String(v.v);
    case "VStr":
      return v.v;
    case "VBool":
      return v.v ? "true" : "false";
    case "VAtom":
      return `:${v.name}`;
    case "VUnit":
      return "()";
    case "VTuple":
      return `(${v.elems.map(display).join(", ")})`;
    case "VList":
      return `[${v.elems.map(display).join(", ")}]`;
    case "VRecord": {
      const pairs = [...v.fields.entries()].map(([k, val]) => `${k}: ${display(val)}`);
      return `{ ${pairs.join(", ")} }`;
    }
    case "VCtor":
      return v.payload !== null ? `${v.name}(${display(v.payload)})` : v.name;
    case "VFn":
    case "VBuiltin":
      return `<fn:${v.name}>`;
    case "VFuture":
      return v.future.done ? `<future:done>` : `<future:pending>`;
    case "VSaga":
      return `<saga:${v.name}>`;
    case "VSagaHandle":
      return `<saga:${v.name} ${v.status.value}>`;
    case "VStream":
      return `<stream:${v.name}>`;
    case "VDict": {
      const pairs = [...v.entries.values()].map(([k, val]) => `${display(k)}: ${display(val)}`);
      return `Dict{ ${pairs.join(", ")} }`;
    }
    case "VSet":
      return `Set{ ${[...v.elems.values()].map(display).join(", ")} }`;
    case "VPtr":
      return `<ptr:${v.label}>`;
    case "VElement":
      return `<${v.name}${v.children.length ? ` \u2026${v.children.length}` : ""}>`;
    case "VDeferred":
      return `<deferred>`;
  }
}
var ReturnSignal = class {
  value;
  constructor(value) {
    this.value = value;
  }
};
var BreakSignal = class {
  value;
  constructor(value) {
    this.value = value;
  }
};
var ContinueSignal = class {
};
var RuntimeError = class extends Error {
};
var SagaCrashSignal = class {
  message;
  constructor(message) {
    this.message = message;
  }
};

// dist/scheduler.js
var Future = class {
  done = false;
  value;
  error;
  waiters = [];
  resolve(v) {
    if (this.done)
      return;
    this.done = true;
    this.value = v;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws)
      w.resolve(v);
  }
  reject(e) {
    if (this.done)
      return;
    this.done = true;
    this.error = e;
    const ws = this.waiters;
    this.waiters = [];
    for (const w of ws)
      w.reject(e);
  }
  get() {
    if (this.error !== void 0)
      throw this.error;
    return this.value ?? { tag: "VUnit" };
  }
  promise() {
    if (this.done)
      return this.error !== void 0 ? Promise.reject(this.error) : Promise.resolve(this.get());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
};
function drain() {
  return new Promise((resolve) => setImmediate(resolve));
}
var Scheduler = class {
  clock = 0;
  timers = [];
  now() {
    return this.clock;
  }
  // Spawn a detached task; returns its Future.
  spawn(run) {
    const fut = new Future();
    (async () => {
      try {
        fut.resolve(await run());
      } catch (e) {
        fut.reject(e);
      }
    })();
    return fut;
  }
  awaitFuture(fut) {
    return fut.promise();
  }
  // Block until the first of several futures resolves (used by `race`).
  awaitFirst(futs) {
    return Promise.race(futs.map((f) => f.promise()));
  }
  // Park the caller until the virtual clock has advanced by `ms`.
  sleep(ms) {
    const target = this.clock + Math.max(0, ms);
    return new Promise((resolve) => this.timers.push({ time: target, resolve }));
  }
  // A promise that never resolves — a losing race arm parks here forever.
  never() {
    return new Promise(() => {
    });
  }
  // Drive the system until the root task finishes (or everything deadlocks).
  async run(root) {
    await drain();
    while (!root.done && this.timers.length > 0) {
      this.timers.sort((a, b) => a.time - b.time);
      const t = this.timers.shift();
      this.clock = Math.max(this.clock, t.time);
      t.resolve();
      await drain();
    }
  }
};

// dist/render.js
var TAG = {
  Stack: "div",
  Column: "div",
  Row: "div",
  Card: "div",
  Box: "div",
  Spacer: "div",
  Divider: "hr",
  Grid: "div",
  Scroll: "div",
  Text: "span",
  Heading: "h2",
  Label: "label",
  Button: "button",
  Input: "input",
  Slider: "input",
  Image: "img",
  Canvas: "canvas",
  Link: "a",
  List: "ul",
  Item: "li"
};
var PX = (v) => /^-?\d+(\.\d+)?$/.test(v) ? `${v}px` : v;
var CSS = {
  width: (v) => ["width", PX(v)],
  height: (v) => ["height", PX(v)],
  padding: (v) => ["padding", PX(v)],
  margin: (v) => ["margin", PX(v)],
  gap: (v) => ["gap", PX(v)],
  radius: (v) => ["border-radius", PX(v)],
  background: (v) => ["background", v],
  color: (v) => ["color", v],
  size: (v) => ["font-size", PX(v)],
  weight: (v) => ["font-weight", v],
  font: (v) => ["font-family", v],
  align: (v) => ["align-items", v],
  justify: (v) => ["justify-content", v],
  opacity: (v) => ["opacity", v],
  grow: (v) => ["flex-grow", v],
  shrink: (v) => ["flex-shrink", v],
  basis: (v) => ["flex-basis", PX(v)],
  alignSelf: (v) => ["align-self", v]
};
var FLEX = {
  Row: "row",
  Column: "column",
  Stack: "column",
  Grid: "row"
};
function propToCss(name, value) {
  const f = CSS[name];
  return f ? f(value) : null;
}
function tagFor(name) {
  return TAG[name] ?? "div";
}
function isKnownTag(name) {
  return name in TAG;
}
function flexDir(name) {
  return FLEX[name];
}
var ESC = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
function unitToCss(v) {
  if (v.tag !== "VCtor")
    return null;
  const n = v.payload && v.payload.tag === "VNum" ? v.payload.v : null;
  switch (v.name) {
    case "Px":
      return n != null ? `${n}px` : null;
    case "Pct":
      return n != null ? `${n}%` : null;
    case "Fr":
      return n != null ? `${n}fr` : null;
    case "Fit":
      return "fit-content";
    case "Fill":
      return "100%";
    case "Clamp": {
      const p = v.payload;
      if (p && p.tag === "VTuple" && p.elems.length === 2) {
        const lo = p.elems[0], hi = p.elems[1];
        if (lo?.tag === "VNum" && hi?.tag === "VNum")
          return `clamp(${lo.v}px, 100%, ${hi.v}px)`;
      }
      return null;
    }
    default:
      return null;
  }
}
function asText(v) {
  return v.tag === "VStr" ? v.v : v.tag === "VNum" ? String(v.v) : v.tag === "VBool" ? String(v.v) : v.tag === "VAtom" ? v.name : display(v);
}
function renderNode(v, indent) {
  if (v.tag !== "VElement")
    return ESC(asText(v));
  const pad = "  ".repeat(indent);
  const tag = TAG[v.name] ?? "div";
  const styles = [];
  const attrs = [];
  if (FLEX[v.name]) {
    styles.push("display:flex", `flex-direction:${FLEX[v.name]}`);
  }
  if (!(v.name in TAG))
    attrs.push(`data-component="${ESC(v.name)}"`);
  for (const [k, val] of v.props) {
    if (k === "key")
      continue;
    const s = unitToCss(val) ?? asText(val);
    const css = CSS[k];
    if (css) {
      const [prop, out] = css(s);
      styles.push(`${prop}:${out}`);
    } else
      attrs.push(`${ESC(k)}="${ESC(s)}"`);
  }
  for (const ev of v.events.keys())
    attrs.push(`data-${ev.toLowerCase()}="true"`);
  if (styles.length)
    attrs.push(`style="${ESC(styles.join(";"))}"`);
  const open = `<${tag}${attrs.length ? " " + attrs.join(" ") : ""}>`;
  if (tag === "img" || tag === "hr" || tag === "input")
    return `${pad}${open.replace(/>$/, " />")}`;
  const kids = [];
  if (v.text)
    kids.push(v.text);
  for (const c of v.children) {
    if (c.tag === "VList")
      kids.push(...c.elems);
    else if (c.tag !== "VUnit")
      kids.push(c);
  }
  if (kids.length === 1 && kids[0].tag !== "VElement")
    return `${pad}${open}${renderNode(kids[0], 0)}</${tag}>`;
  if (kids.length === 0)
    return `${pad}${open}</${tag}>`;
  const inner = kids.map((c) => renderNode(c, indent + 1)).join("\n");
  return `${pad}${open}
${inner}
${pad}</${tag}>`;
}
function renderHtml(v) {
  return renderNode(v, 0);
}
var MODEL_MODE = {
  Row: "flex",
  Column: "flex",
  Stack: "flex",
  Grid: "flex",
  Box: "block",
  Card: "block",
  Scroll: "block",
  List: "block",
  Item: "block"
};
var INTERACTIVE = /* @__PURE__ */ new Set(["Button", "Link", "Input", "Slider"]);
var LABEL_PROPS = ["label", "ariaLabel", "title", "alt"];
function hexRgb(s) {
  const m = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(s.trim());
  if (!m)
    return null;
  let h = m[1];
  if (h.length === 3)
    h = h.split("").map((c) => c + c).join("");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}
function luminance([r, g, b]) {
  const f = (c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}
function contrast(fg, bg) {
  const a = hexRgb(fg), b = hexRgb(bg);
  if (!a || !b)
    return null;
  const l1 = luminance(a), l2 = luminance(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}
function modelNode(v, indent, bg) {
  const pad = "  ".repeat(indent);
  if (v.tag !== "VElement") {
    const t = asText(v).trim();
    return t ? `${pad}${JSON.stringify(t)}` : "";
  }
  const mode = MODEL_MODE[v.name] ?? "leaf";
  const parts = [];
  let color = null;
  let myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    parts.push(`${k}=${s}`);
    if (k === "background")
      myBg = s;
    if (k === "color")
      color = s;
  }
  const text = v.text ? asText(v.text) : "";
  const head = `${pad}${v.name}${text ? ` ${JSON.stringify(text)}` : ""}  [${mode}]` + (parts.length ? "  " + parts.join(" ") : "");
  const notes = [];
  if (color && myBg) {
    const r = contrast(color, myBg);
    if (r != null)
      notes.push(`\xB7 contrast ${r.toFixed(1)}:1 vs ${myBg}${r < 4.5 ? " \u26A0 below AA (4.5)" : " \u2713"}`);
  }
  if (INTERACTIVE.has(v.name) && !text && !LABEL_PROPS.some((p) => v.props.has(p)))
    notes.push("\u26A0 interactive element has no label/text (a11y)");
  if (mode !== "leaf" && v.children.length === 0 && !text)
    notes.push("\u26A0 empty container");
  const lines = [head, ...notes.map((n) => `${pad}  ${n}`)];
  for (const c of v.children) {
    if (c.tag === "VList") {
      for (const e of c.elems) {
        const s = modelNode(e, indent + 1, myBg);
        if (s)
          lines.push(s);
      }
    } else if (c.tag !== "VUnit") {
      const s = modelNode(c, indent + 1, myBg);
      if (s)
        lines.push(s);
    }
  }
  return lines.join("\n");
}
function renderModel(v) {
  return modelNode(v, 0, null);
}
function jsonNode(v, bg) {
  if (v.tag !== "VElement") {
    const t = asText(v).trim();
    return t ? { text: t } : null;
  }
  const node = { element: v.name, mode: MODEL_MODE[v.name] ?? "leaf" };
  const props = {};
  let color = null, myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    props[k] = s;
    if (k === "background")
      myBg = s;
    if (k === "color")
      color = s;
  }
  if (v.text)
    node.text = asText(v.text);
  if (Object.keys(props).length)
    node.props = props;
  if (color && myBg) {
    const r = contrast(color, myBg);
    if (r != null)
      node.contrast = { ratio: Number(r.toFixed(1)), against: myBg, passesAA: r >= 4.5 };
  }
  if (INTERACTIVE.has(v.name) && !node.text && !LABEL_PROPS.some((p) => v.props.has(p)))
    node.a11y = ["no-label"];
  const kids = [];
  for (const c of v.children) {
    if (c.tag === "VList") {
      for (const e of c.elems) {
        const n = jsonNode(e, myBg);
        if (n)
          kids.push(n);
      }
    } else if (c.tag !== "VUnit") {
      const n = jsonNode(c, myBg);
      if (n)
        kids.push(n);
    }
  }
  if (kids.length)
    node.children = kids;
  return node;
}
function renderJson(v) {
  return JSON.stringify(jsonNode(v, null), null, 2);
}
var SCALE_PROPS = ["padding", "margin", "gap", "radius", "size", "width", "height"];
var COLOR_PROPS = ["color", "background"];
function flattenElements(v, bg, out) {
  if (v.tag !== "VElement")
    return;
  const props = /* @__PURE__ */ new Map();
  let myBg = bg;
  for (const [k, val] of v.props) {
    const s = unitToCss(val) ?? asText(val);
    props.set(k, s);
    if (k === "background")
      myBg = s;
  }
  out.push({ name: v.name, props, text: v.text ? asText(v.text) : "", bg: myBg });
  for (const c of v.children) {
    if (c.tag === "VList")
      for (const e of c.elems)
        flattenElements(e, myBg, out);
    else if (c.tag !== "VUnit")
      flattenElements(c, myBg, out);
  }
}
function analyzeModel(v) {
  const els = [];
  flattenElements(v, null, els);
  const sections = [];
  const distinct = /* @__PURE__ */ new Map();
  for (const el of els)
    for (const p of [...SCALE_PROPS, ...COLOR_PROPS]) {
      const val = el.props.get(p);
      if (val !== void 0)
        (distinct.get(p) ?? distinct.set(p, /* @__PURE__ */ new Set()).get(p)).add(val);
    }
  const incon = [...distinct.entries()].filter(([, s]) => s.size >= 2).map(([p, s]) => `  ${p}: ${s.size} distinct [${[...s].join(", ")}]${s.size >= 4 ? "  \u26A0 consider consolidating to tokens" : ""}`);
  if (incon.length)
    sections.push("Inconsistency:\n" + incon.join("\n"));
  const bundles = /* @__PURE__ */ new Map();
  for (const el of els) {
    if (el.props.size === 0)
      continue;
    const key = el.name + "|" + [...el.props.entries()].map(([k, v2]) => `${k}=${v2}`).sort().join(" ");
    const sample = `${el.name} { ${[...el.props.entries()].map(([k, v2]) => `${k}=${v2}`).join(" ")} }`;
    const cur = bundles.get(key);
    if (cur)
      cur.count++;
    else
      bundles.set(key, { count: 1, sample });
  }
  const dups = [...bundles.values()].filter((b) => b.count >= 2).map((b) => `  \xD7${b.count} identical: ${b.sample}  \u26A0 extract a style`);
  if (dups.length)
    sections.push("Duplication:\n" + dups.join("\n"));
  const a11y = [];
  const labelless = els.filter((el) => INTERACTIVE.has(el.name) && !el.text && !LABEL_PROPS.some((p) => el.props.has(p)));
  if (labelless.length)
    a11y.push(`  \u26A0 ${labelless.length} interactive element(s) without label: ${labelless.map((e) => e.name).join(", ")}`);
  for (const el of els) {
    const color = el.props.get("color");
    if (color && el.bg) {
      const r = contrast(color, el.bg);
      if (r != null && r < 4.5)
        a11y.push(`  \u26A0 low contrast ${r.toFixed(1)}:1 \u2014 ${color} on ${el.bg} (${el.name})`);
    }
  }
  if (a11y.length)
    sections.push("A11y:\n" + a11y.join("\n"));
  const emptyNames = [];
  const checkEmpty = (n) => {
    if (n.tag !== "VElement")
      return;
    const kids = n.children.filter((c) => c.tag === "VElement" || c.tag === "VList" && c.elems.length > 0);
    if ((MODEL_MODE[n.name] ?? "leaf") !== "leaf" && kids.length === 0 && !n.text)
      emptyNames.push(n.name);
    for (const c of n.children) {
      if (c.tag === "VList")
        c.elems.forEach(checkEmpty);
      else
        checkEmpty(c);
    }
  };
  checkEmpty(v);
  if (emptyNames.length)
    sections.push(`Structure:
  \u26A0 ${emptyNames.length} empty container(s): ${emptyNames.join(", ")}`);
  const header = `Analysis (${els.length} elements):`;
  return sections.length ? `${header}
${sections.join("\n")}` : `${header}
  \u2713 no issues found`;
}

// dist/converge.js
var CONV_SCOPES = /* @__PURE__ */ new Set([
  "self",
  "parent",
  "prev",
  "next",
  "children"
]);
function subExprs(e) {
  switch (e.tag) {
    case "Call":
      return [e.fn, ...e.args];
    case "BinOp":
      return [e.left, e.right];
    case "UnOp":
      return [e.expr];
    case "Field":
      return [e.obj];
    case "Index":
      return [e.obj, e.index];
    case "Lambda":
      return [e.body];
    case "Match":
      return [e.subject, ...e.branches.map((b) => b.body)];
    case "If":
      return e.else_ ? [e.cond, e.then, e.else_] : [e.cond, e.then];
    case "Range":
      return [e.from, e.to];
    case "Tuple":
      return e.elems;
    case "List":
      return e.elems;
    case "Record":
      return [...e.fields.map((f) => f.value), ...e.spread ? [e.spread] : []];
    case "Propagate":
      return [e.expr];
    case "PropWith":
      return [e.expr, e.alt];
    case "Await":
      return [e.expr, ...e.branches.map((b) => b.body)];
    case "Go":
      return [e.expr];
    case "Drop":
      return [e.expr];
    case "AddrOf":
      return [e.expr];
    case "Deref":
      return [e.expr];
    case "Send":
      return [e.msg];
    default:
      return [];
  }
}
function scanConvRefs(e) {
  const out = [];
  const visit = (x) => {
    if (x.tag === "Field" && x.obj.tag === "Var" && CONV_SCOPES.has(x.obj.name))
      out.push({ scope: x.obj.name, prop: x.field });
    for (const c of subExprs(x))
      visit(c);
  };
  visit(e);
  return out;
}
function hasConvRef(e) {
  if (e.tag === "Field" && e.obj.tag === "Var" && CONV_SCOPES.has(e.obj.name))
    return true;
  for (const c of subExprs(e))
    if (hasConvRef(c))
      return true;
  return false;
}

// dist/runtime.js
var propStr = (v) => unitToCss(v) ?? asText(v);
var textOf = (el) => el.text ? asText(el.text) : null;
var childList = (el) => {
  const out = [];
  for (const c of el.children) {
    if (c.tag === "VList")
      out.push(...c.elems);
    else if (c.tag !== "VUnit")
      out.push(c);
  }
  return out;
};
var keyOf = (v) => {
  if (v.tag !== "VElement")
    return null;
  const k = v.props.get("id") ?? v.props.get("key");
  return k && k.tag === "VStr" ? k.v : null;
};
var childPath = (path, i) => path === "" ? String(i) : `${path}/${i}`;
var summary = (v) => {
  const s = renderHtml(v).replace(/\s+/g, " ").trim();
  return s.length > 80 ? s.slice(0, 77) + "\u2026" : s;
};
function diff(oldV, newV, path = "") {
  if (oldV.tag !== "VElement" || newV.tag !== "VElement") {
    if (oldV.tag === "VElement" || newV.tag === "VElement" || asText(oldV) !== asText(newV))
      return [{ op: "replace", path, html: summary(newV) }];
    return [];
  }
  if (oldV.name !== newV.name)
    return [{ op: "replace", path, html: summary(newV) }];
  const patches = [];
  for (const [k, v] of newV.props) {
    const o = oldV.props.get(k);
    const nv = propStr(v);
    if (o === void 0 || propStr(o) !== nv)
      patches.push({ op: "setProp", path, name: k, value: nv });
  }
  for (const k of oldV.props.keys())
    if (!newV.props.has(k))
      patches.push({ op: "removeProp", path, name: k });
  const ot = textOf(oldV), nt = textOf(newV);
  if (ot !== nt && nt !== null)
    patches.push({ op: "setText", path, text: nt });
  else if (ot !== nt && nt === null)
    patches.push({ op: "setText", path, text: "" });
  const oldKids = childList(oldV), newKids = childList(newV);
  const allKeyed = (xs) => xs.length > 0 && xs.every((x) => keyOf(x) !== null);
  if (allKeyed(oldKids) && allKeyed(newKids)) {
    const oldByKey = new Map(oldKids.map((c, i) => [keyOf(c), { c, i }]));
    const newByKey = new Map(newKids.map((c, i) => [keyOf(c), { c, i }]));
    for (const [key, { i }] of oldByKey)
      if (!newByKey.has(key))
        patches.push({ op: "removeChild", path, index: i });
    newKids.forEach((c, i) => {
      const key = keyOf(c);
      const prev = oldByKey.get(key);
      if (!prev) {
        patches.push({ op: "insertChild", path, index: i, html: summary(c) });
        return;
      }
      if (prev.i !== i)
        patches.push({ op: "moveChild", path, key, from: prev.i, to: i });
      patches.push(...diff(prev.c, c, childPath(path, i)));
    });
  } else {
    const n = Math.min(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++)
      patches.push(...diff(oldKids[i], newKids[i], childPath(path, i)));
    for (let i = n; i < newKids.length; i++)
      patches.push({ op: "insertChild", path, index: i, html: summary(newKids[i]) });
    for (let i = n; i < oldKids.length; i++)
      patches.push({ op: "removeChild", path, index: i });
  }
  return patches;
}
function keylessListWarnings(root) {
  const warns = [];
  const walk = (v) => {
    if (v.tag !== "VElement")
      return;
    for (const c of v.children)
      if (c.tag === "VList" && c.elems.some((e) => e.tag === "VElement" && keyOf(e) === null))
        warns.push(`\u26A0 dynamic list under ${v.name} has no key \u2014 reconciliation falls back to position`);
    for (const c of childList(v))
      walk(c);
  };
  walk(root);
  return warns;
}
function patchLabel(p) {
  const at = (path) => path === "" ? "(root)" : path;
  switch (p.op) {
    case "setProp":
      return `setProp     ${at(p.path)} ${p.name}=${p.value}`;
    case "removeProp":
      return `removeProp  ${at(p.path)} ${p.name}`;
    case "setText":
      return `setText     ${at(p.path)} ${JSON.stringify(p.text)}`;
    case "replace":
      return `replace     ${at(p.path)} ${p.html}`;
    case "insertChild":
      return `insertChild ${at(p.path)}[${p.index}] ${p.html}`;
    case "removeChild":
      return `removeChild ${at(p.path)}[${p.index}]`;
    case "moveChild":
      return `moveChild   ${at(p.path)} key=${p.key} ${p.from}->${p.to}`;
  }
}

// dist/domhost.js
var APPLIER_JS = String.raw`
// prop -> [cssProperty, isPx] — mirrors render.ts CSS map so styles match the SSR.
const VELVE_CSS = {
  width:["width",1], height:["height",1], padding:["padding",1], margin:["margin",1],
  gap:["gap",1], radius:["border-radius",1], background:["background",0], color:["color",0],
  size:["font-size",1], weight:["font-weight",0], font:["font-family",0],
  align:["align-items",0], justify:["justify-content",0], opacity:["opacity",0],
  grow:["flex-grow",0], shrink:["flex-shrink",0], basis:["flex-basis",1], alignSelf:["align-self",0],
};
function velvePx(v){ return /^-?\d+(\.\d+)?$/.test(v) ? v + "px" : v; }
// Navigate a patch path ("0/1") over ELEMENT children (matches diff's childList for
// element-only trees — the keyless caveat applies to mixed text/element children).
function velveNodeAt(root, path){
  if(path === "") return root;
  let n = root;
  for(const seg of path.split("/")){ if(!n) return null; n = n.children[+seg]; }
  return n;
}
function velveApply(root, p){
  const n = velveNodeAt(root, p.path);
  if(!n) return;
  switch(p.op){
    case "setProp": {
      const m = VELVE_CSS[p.name];
      if(m) n.style.setProperty(m[0], m[1] ? velvePx(p.value) : p.value);
      else n.setAttribute(p.name, p.value);
      break;
    }
    case "removeProp": {
      const m = VELVE_CSS[p.name];
      if(m) n.style.removeProperty(m[0]); else n.removeAttribute(p.name);
      break;
    }
    case "setText": n.textContent = p.text; break;
    case "replace": n.outerHTML = p.html; break;
    case "insertChild": {
      const tmp = document.createElement("template");
      tmp.innerHTML = p.html.trim();
      const ref = n.children[p.index] || null;
      n.insertBefore(tmp.content.firstChild, ref);
      break;
    }
    case "removeChild": { const c = n.children[p.index]; if(c) c.remove(); break; }
    case "moveChild": {
      const cur = [...n.children].find(c => c.id === p.key);
      if(cur) n.insertBefore(cur, n.children[p.to] || null);
      break;
    }
  }
}
`;
function domHostPage(initialHtml, session, title) {
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${title}</title>
<style>body{font:14px system-ui;margin:24px}#velve-log{color:#666;white-space:pre-wrap}</style>
</head><body>
<h3>${title} \u2014 retained-runtime replay (${session.length} step${session.length === 1 ? "" : "s"})</h3>
<div id="velve-root">${initialHtml}</div>
<p><button id="velve-step">\u25B6 next step</button> <button id="velve-all">\u25B6\u25B6 all</button></p>
<pre id="velve-log"></pre>
<script>
${APPLIER_JS}
const SESSION = ${JSON.stringify(session)};
let i = 0;
const root = document.getElementById("velve-root").firstElementChild;
const log = document.getElementById("velve-log");
function step(){
  if(i >= SESSION.length){ log.textContent += "\\n(done)"; return false; }
  const s = SESSION[i++];
  for(const p of s.patches) velveApply(root, p);
  log.textContent += "\\n" + s.label + " \u2014 " + s.patches.length + " patch(es)";
  return true;
}
document.getElementById("velve-step").onclick = step;
document.getElementById("velve-all").onclick = () => { while(step()){} };
<\/script>
</body></html>`;
}

// dist/eval.js
var _fs = null;
var loadFs = async () => _fs ??= await import("node:fs/promises");
function emptyEvent() {
  return { tag: "VRecord", fields: /* @__PURE__ */ new Map([
    ["value", { tag: "VStr", v: "" }],
    ["key", { tag: "VStr", v: "" }],
    ["checked", { tag: "VBool", v: false }]
  ]) };
}
var Evaluator = class {
  env;
  stores = /* @__PURE__ */ new Map();
  sched = new Scheduler();
  constructor() {
    this.env = buildPrelude();
    patchHOF(this.env, this);
  }
  async run(mod) {
    await this.evalDecls(mod.decls, this.env);
    const main = this.env.lookup("main");
    if (main) {
      const fut = this.sched.spawn(() => this.applyFn(main, [], "(main)"));
      await this.sched.run(fut);
      fut.get();
    }
  }
  sleep(ms) {
    return this.sched.sleep(ms);
  }
  // Evaluate a module's declarations (functions/stores/sagas) into the global env,
  // WITHOUT running `main` — used by the live browser runtime, which then drives
  // `view()` and its handlers itself. (`run()` is the CLI's main-calling entry.)
  async loadModule(mod) {
    await this.evalDecls(mod.decls, this.env);
  }
  // Look up a top-level binding (e.g. the `view` function) after loadModule.
  global(name) {
    return this.env.lookup(name);
  }
  // The journaled step names for a saga's backing store (durable history).
  journalOf(store) {
    return (this.sagaJournals.get(store) ?? []).flatMap((e) => e.kind === "step" ? [e.step] : []);
  }
  // Drain pending store message handlers (each `send` chains the store's `tail`
  // promise) so the retained runtime re-renders against settled state. A few
  // passes cover handlers that cascade into further sends.
  async settle() {
    for (let i = 0; i < 8; i++) {
      await Promise.all([...this.stores.values()].map((s) => s.tail));
      await Promise.resolve();
    }
  }
  // ── Convergence pass (styles-design §6) ──────────────────────────────────────
  // Resolve deferred props (those referencing self/parent/prev/next/children) in
  // topological order over the (element instance, prop) graph. A cycle — including
  // a "diagonal" one across different prop names — is a RuntimeError pointing at
  // the offending props. Runs on the concrete tree, just before render/model emit.
  async converge(root) {
    const elemChildVals = (el) => {
      const out = [];
      for (const c of el.children) {
        if (c.tag === "VList")
          out.push(...c.elems);
        else
          out.push(c);
      }
      return out;
    };
    const all = [];
    const walk = (v, parent) => {
      if (v.tag !== "VElement")
        return null;
      const ctx = { el: v, parent, siblings: [], index: 0, kids: [] };
      all.push(ctx);
      const kids = elemChildVals(v).map((cv) => walk(cv, ctx)).filter((k) => k !== null);
      ctx.kids = kids;
      kids.forEach((k, i) => {
        k.siblings = kids;
        k.index = i;
      });
      return ctx;
    };
    const rootCtx = walk(root, null);
    if (!rootCtx)
      return root;
    rootCtx.siblings = [rootCtx];
    const idxOf = /* @__PURE__ */ new Map();
    all.forEach((c, i) => idxOf.set(c, i));
    const key = (c, prop) => `${idxOf.get(c)}\0${prop}`;
    const nodes = /* @__PURE__ */ new Map();
    for (const ctx of all)
      for (const [prop, val] of ctx.el.props)
        if (val.tag === "VDeferred")
          nodes.set(key(ctx, prop), { ctx, prop, expr: val.expr, env: val.env, refs: scanConvRefs(val.expr), deps: /* @__PURE__ */ new Set() });
    if (nodes.size === 0)
      return root;
    const targets = (ctx, scope) => {
      switch (scope) {
        case "self":
          return [ctx];
        case "parent":
          return ctx.parent ? [ctx.parent] : [];
        case "prev":
          return ctx.index > 0 ? [ctx.siblings[ctx.index - 1]] : [];
        case "next":
          return ctx.index < ctx.siblings.length - 1 ? [ctx.siblings[ctx.index + 1]] : [];
        case "children":
          return ctx.kids;
      }
    };
    for (const node of nodes.values())
      for (const ref of node.refs)
        for (const t of targets(node.ctx, ref.scope)) {
          const k = key(t, ref.prop);
          if (nodes.has(k))
            node.deps.add(k);
        }
    const indeg = /* @__PURE__ */ new Map();
    const dependents = /* @__PURE__ */ new Map();
    for (const [k, node] of nodes) {
      indeg.set(k, node.deps.size);
      for (const d of node.deps)
        (dependents.get(d) ?? dependents.set(d, []).get(d)).push(k);
    }
    const ready = [...nodes.keys()].filter((k) => indeg.get(k) === 0);
    const order = [];
    while (ready.length) {
      const k = ready.shift();
      order.push(nodes.get(k));
      for (const dep of dependents.get(k) ?? []) {
        indeg.set(dep, indeg.get(dep) - 1);
        if (indeg.get(dep) === 0)
          ready.push(dep);
      }
    }
    if (order.length !== nodes.size) {
      const stuck = [...nodes.values()].find((n) => (indeg.get(key(n.ctx, n.prop)) ?? 0) > 0);
      const onProp = [...stuck.deps].map((d) => nodes.get(d)).filter((d) => d.prop === stuck.prop);
      const detail = onProp.length ? ` \u2014 '${stuck.prop}' on ${stuck.ctx.el.name} and ${onProp[0].ctx.el.name} reference each other` : ` \u2014 involving '${stuck.prop}' on ${stuck.ctx.el.name}`;
      throw new RuntimeError(`convergence cycle: props form a dependency cycle${detail}. The (element, prop) graph must be acyclic (styles-design \xA76).`);
    }
    const recordOf = (ctx) => {
      const fields = /* @__PURE__ */ new Map();
      for (const [p, v] of ctx.el.props)
        if (v.tag !== "VDeferred")
          fields.set(p, v);
      return { tag: "VRecord", fields };
    };
    const childrenRecord = (kids) => {
      const names = /* @__PURE__ */ new Set();
      for (const k of kids)
        for (const [p, v] of k.el.props)
          if (v.tag !== "VDeferred")
            names.add(p);
      const fields = /* @__PURE__ */ new Map();
      for (const name of names) {
        const elems = [];
        for (const k of kids) {
          const v = k.el.props.get(name);
          if (v && v.tag !== "VDeferred")
            elems.push(v);
        }
        fields.set(name, { tag: "VList", elems });
      }
      return { tag: "VRecord", fields };
    };
    const emptyRec = { tag: "VRecord", fields: /* @__PURE__ */ new Map() };
    for (const node of order) {
      const cenv = node.env.child();
      const used = new Set(node.refs.map((r) => r.scope));
      if (used.has("self"))
        cenv.define("self", recordOf(node.ctx));
      if (used.has("parent"))
        cenv.define("parent", node.ctx.parent ? recordOf(node.ctx.parent) : emptyRec);
      if (used.has("prev"))
        cenv.define("prev", node.ctx.index > 0 ? recordOf(node.ctx.siblings[node.ctx.index - 1]) : emptyRec);
      if (used.has("next"))
        cenv.define("next", node.ctx.index < node.ctx.siblings.length - 1 ? recordOf(node.ctx.siblings[node.ctx.index + 1]) : emptyRec);
      if (used.has("children"))
        cenv.define("children", childrenRecord(node.ctx.kids));
      node.ctx.el.props.set(node.prop, await this.evalExpr(node.expr, cenv));
    }
    return root;
  }
  // ── Declarations ────────────────────────────────────────────────────────────
  async evalDecls(decls, env) {
    for (const decl of decls) {
      if (decl.tag === "DFn" || decl.tag === "DSaga")
        env.define(decl.name, { tag: "VUnit" });
    }
    for (const decl of decls)
      await this.evalDecl(decl, env);
  }
  async evalDecl(decl, env) {
    switch (decl.tag) {
      case "DFn": {
        env.define(decl.name, { tag: "VFn", name: decl.name, clauses: decl.clauses, env });
        break;
      }
      case "DType": {
        if (decl.body.tag === "TBAdt") {
          for (const v of decl.body.variants) {
            if (v.payload) {
              const name = v.name;
              env.define(name, builtin(name, (args) => ({ tag: "VCtor", name, payload: args[0] ?? { tag: "VUnit" } })));
            } else {
              env.define(v.name, { tag: "VCtor", name: v.name, payload: null });
            }
          }
          break;
        }
        if (decl.body.tag === "TBAlias" && decl.body.pred) {
          const pred = decl.body.pred;
          const typeName = decl.name;
          const defEnv = env;
          const parse = builtin(`${typeName}.parse`, async (args) => {
            const value = args[0] ?? { tag: "VUnit" };
            const child = defEnv.child();
            child.define("value", value);
            const ok = await this.evalExpr(pred, child);
            if (ok.tag === "VBool" && ok.v)
              return { tag: "VCtor", name: "Ok", payload: value };
            return { tag: "VCtor", name: "Error", payload: { tag: "VStr", v: `${typeName}: ${display(value)} failed refinement` } };
          });
          env.define(typeName, { tag: "VRecord", fields: /* @__PURE__ */ new Map([["parse", parse]]) });
        }
        break;
      }
      case "DModule":
        await this.evalDecls(decl.decls, env);
        break;
      case "DStore":
        await this.evalStore(decl, env);
        break;
      case "DSaga":
        env.define(decl.name, {
          tag: "VSaga",
          name: decl.name,
          params: decl.params,
          steps: decl.steps,
          store: decl.store,
          env
        });
        break;
      case "DStream": {
        const q = new VStreamQueue();
        env.define(decl.name, { tag: "VStream", name: decl.name, q });
        env.define("Push", builtin("Push", (args) => ({ tag: "VCtor", name: "Push", payload: args[0] ?? { tag: "VUnit" } })));
        env.define("Done", { tag: "VCtor", name: "Done", payload: null });
        break;
      }
      case "DImport": {
        const mod = STDLIB_RUNTIME[decl.path];
        if (!mod)
          break;
        const isNamespace = decl.names.length === 1 && !(decl.names[0].name in mod);
        if (isNamespace) {
          const n = decl.names[0];
          env.define(n.alias ?? n.name, { tag: "VRecord", fields: new Map(Object.entries(mod)) });
        } else {
          for (const { name, alias } of decl.names) {
            const member = mod[name];
            if (member)
              env.define(alias ?? name, member);
          }
        }
        break;
      }
    }
  }
  // ── Machines & sagas (state machines) ───────────────────────────────────────
  //
  // A `machine` is a pure jump-table FSM. A `saga StoreName` is the same FSM with
  // two extra capabilities, carried in a SagaCtx:
  //   • a JOURNAL — every transition is recorded to `sagaJournals[store]`, so the
  //     run's progress is durable and inspectable (`journalOf "Store"`).
  //   • COMPENSATIONS — `expr ? rollback :step` defers an undo action; if the saga
  //     later transitions into `:abort`, the deferred steps run in reverse order.
  //   • `expr ?: rollback :step` recovers immediately when `expr` is a failure.
  sagaJournals = /* @__PURE__ */ new Map();
  async evalMachine(expr, env) {
    const steps = new Map(expr.steps.map((s) => [s.name, s]));
    const journal = expr.store ? [] : null;
    const ctx = expr.store ? { store: expr.store, comps: [], steps, journal } : void 0;
    if (ctx)
      this.sagaJournals.set(ctx.store, journal);
    return this.runMachine(expr.steps[0]?.name, [], steps, env, ctx, journal);
  }
  // Bind a saga's constructor inputs into a fresh child of its closure env.
  sagaEnv(saga, args) {
    const env = saga.env.child();
    saga.params.forEach((p, idx) => {
      const b = matchPat(p.pat, args[idx] ?? { tag: "VUnit" });
      if (b)
        for (const [k, v] of b)
          env.define(k, v);
    });
    return env;
  }
  // Run a live first-class saga instance: bind its constructor inputs, journal
  // every transition into the per-INSTANCE `journal` (so concurrent instances
  // don't collide), and record final status. The same journal is also exposed
  // under the store name for `journalOf`. A `crash` mid-flight leaves the journal
  // intact (status `crashed`) so the instance can be `resume`d.
  async runSagaInstance(saga, args, journal, status) {
    const steps = new Map(saga.steps.map((s) => [s.name, s]));
    const storeName = saga.store ?? saga.name;
    const ctx = { store: storeName, comps: [], steps, journal };
    this.sagaJournals.set(storeName, journal);
    return this.settleSaga(this.runMachine(saga.steps[0]?.name, [], steps, this.sagaEnv(saga, args), ctx, journal), journal, status);
  }
  // Re-hydrate a crashed saga from its durable journal and continue it. The
  // already-recorded steps are NOT re-executed; instead the compensation stack is
  // rebuilt from the journal's `comp` entries, and execution resumes at the last
  // recorded step (re-running just that one — at-least-once for the crash point).
  async resumeSagaInstance(saga, args, status) {
    const steps = new Map(saga.steps.map((s) => [s.name, s]));
    const storeName = saga.store ?? saga.name;
    const journal = this.sagaJournals.get(storeName) ?? [];
    const comps = journal.flatMap((e) => e.kind === "comp" ? [{ target: e.target, args: e.args }] : []);
    const ctx = { store: storeName, comps, steps, journal };
    const lastStep = [...journal].reverse().find((e) => e.kind === "step");
    const start = lastStep?.step ?? saga.steps[0]?.name;
    const startArgs = lastStep?.args ?? [];
    return this.settleSaga(this.runMachine(
      start,
      startArgs,
      steps,
      this.sagaEnv(saga, args),
      ctx,
      journal,
      /*skipFirstJournal*/
      true
    ), journal, status);
  }
  // Await a saga's result, mapping the outcome to a status. A `SagaCrashSignal`
  // is swallowed (the journal survives for `resume`); other errors propagate.
  async settleSaga(run, journal, status) {
    try {
      const result = await run;
      status.value = journal.some((e) => e.kind === "step" && e.step === "abort") ? "aborted" : "done";
      return result;
    } catch (e) {
      if (e instanceof SagaCrashSignal) {
        status.value = "crashed";
        return { tag: "VCtor", name: "Crashed", payload: { tag: "VStr", v: e.message } };
      }
      status.value = "aborted";
      throw e;
    }
  }
  // The shared transition loop for machines and sagas.
  async runMachine(start, startArgs, steps, env, ctx, journal, skipFirstJournal = false) {
    let current = start;
    let args = startArgs;
    const MAX_TRANSITIONS = 1e5;
    for (let i = 0; i < MAX_TRANSITIONS; i++) {
      if (current === void 0)
        return { tag: "VUnit" };
      const step = steps.get(current);
      if (!step)
        throw new RuntimeError(`${ctx ? "saga" : "machine"}: no such state ':${current}'`);
      if (journal && !(skipFirstJournal && i === 0))
        journal.push({ kind: "step", step: current, args });
      const stepEnv = env.child();
      step.params.forEach((p, idx) => stepEnv.define(p, args[idx] ?? { tag: "VUnit" }));
      const outcome = await this.runSagaBody(step.body, stepEnv, ctx);
      if (outcome.kind === "goto") {
        if (ctx && outcome.target === "abort")
          await this.runCompensations(ctx, env);
        current = outcome.target;
        args = outcome.args;
        continue;
      }
      return outcome.value;
    }
    throw new RuntimeError(`machine exceeded ${MAX_TRANSITIONS} transitions (infinite loop?)`);
  }
  // Run each registered compensation step, most-recent first. Compensations are
  // side-effecting cleanup (release stock, refund, ...) — any transition they
  // attempt is ignored; they run to settle the saga's external effects.
  // Slice-extraction (§2.11): a sub-region of a container. List/String slices are
  // value copies; a pointer slice is an aliasing VIEW — read/write splice through the
  // parent buffer in place, so the slice genuinely carries the parent's storage (the
  // borrow checker ties its lifetime to the parent's).
  slice(obj, lo, hi) {
    if (obj.tag === "VList")
      return { tag: "VList", elems: obj.elems.slice(lo, hi) };
    if (obj.tag === "VStr")
      return { tag: "VStr", v: obj.v.slice(lo, hi) };
    if (obj.tag === "VPtr") {
      return {
        tag: "VPtr",
        label: `${obj.label}[${lo}..${hi}]`,
        read: () => this.slice(obj.read(), lo, hi),
        write: (v) => {
          const base = obj.read();
          if (base.tag === "VList" && v.tag === "VList") {
            base.elems.splice(lo, hi - lo, ...v.elems);
            obj.write(base);
          } else if (base.tag === "VStr" && v.tag === "VStr") {
            obj.write({ tag: "VStr", v: base.v.slice(0, lo) + v.v + base.v.slice(hi) });
          } else {
            throw new RuntimeError("cannot write through this slice");
          }
        }
      };
    }
    throw new RuntimeError(`cannot slice ${obj.tag}`);
  }
  async runCompensations(ctx, env) {
    while (ctx.comps.length > 0) {
      const c = ctx.comps.pop();
      const step = ctx.steps.get(c.target);
      if (!step)
        continue;
      const cenv = env.child();
      step.params.forEach((p, idx) => cenv.define(p, c.args[idx] ?? { tag: "VUnit" }));
      await this.runSagaBody(step.body, cenv, void 0);
    }
  }
  // Run a step/branch body. Either it transitions (goto) or yields a value.
  async runSagaBody(body, env, ctx) {
    let last = { tag: "VUnit" };
    for (const stmt of body) {
      switch (stmt.tag) {
        case "SBindS":
          env.define(stmt.name, await this.evalExpr(stmt.value, env));
          break;
        case "Goto":
          return { kind: "goto", target: stmt.target, args: await this.evalAll(stmt.args, env) };
        case "Yield":
          last = await this.evalExpr(stmt.expr, env);
          break;
        case "Rollback": {
          const v = await this.evalExpr(stmt.expr, env);
          if (stmt.mode === "defer") {
            if (ctx) {
              ctx.comps.push({ target: stmt.target, args: [v] });
              ctx.journal?.push({ kind: "comp", target: stmt.target, args: [v] });
            }
          } else {
            if (isFailure(v))
              return { kind: "goto", target: stmt.target, args: [failurePayload(v)] };
          }
          break;
        }
        case "SagaMatch": {
          const subj = await this.evalExpr(stmt.subject, env);
          return await this.matchSagaBranches(subj, stmt.branches, env, "match", ctx);
        }
        case "SagaIf": {
          const cond = await this.evalExpr(stmt.cond, env);
          if (cond.tag !== "VBool")
            throw new RuntimeError(`machine: if condition must be Bool, got ${display(cond)}`);
          return await this.runSagaBody(cond.v ? stmt.then : stmt.else_, env.child(), ctx);
        }
        case "SagaGo":
          this.sched.spawn(() => this.evalExpr(stmt.expr, env));
          break;
        case "SagaJoin": {
          const futs = stmt.tasks.map((t) => this.sched.spawn(() => this.evalExpr(t, env)));
          const results = [];
          for (const f of futs)
            results.push(await this.sched.awaitFuture(f));
          const subject = results.length === 1 ? results[0] : { tag: "VTuple", elems: results };
          return await this.matchSagaBranches(subject, stmt.branches, env, "join", ctx);
        }
        case "SagaRace": {
          const futs = stmt.arms.map((arm) => {
            if (arm.kind === "after")
              return this.sched.spawn(async () => {
                await this.sched.sleep(arm.expr ? num(await this.evalExpr(arm.expr, env)) : 0);
                return { tag: "VCtor", name: "Timeout", payload: null };
              });
            if (arm.kind === "until")
              return this.sched.spawn(async () => {
                const c = arm.expr ? await this.evalExpr(arm.expr, env) : { tag: "VBool", v: false };
                if (c.tag === "VBool" && c.v)
                  return { tag: "VCtor", name: "Cancelled", payload: null };
                return this.sched.never();
              });
            return this.sched.spawn(() => this.evalExpr(arm.expr, env));
          });
          const subject = await this.sched.awaitFirst(futs);
          return await this.matchSagaBranches(subject, stmt.branches, env, "race", ctx);
        }
      }
    }
    return { kind: "value", value: last };
  }
  async matchSagaBranches(subject, branches, env, what, ctx) {
    for (const br of branches) {
      const b = matchPat(br.pat, subject);
      if (b) {
        const bs = env.child();
        for (const [k, v] of b)
          bs.define(k, v);
        return await this.runSagaBody(br.body, bs, ctx);
      }
    }
    throw new RuntimeError(`machine: no ${what} branch matched ${display(subject)}`);
  }
  // ── Stores ────────────────────────────────────────────────────────────────────
  async evalStore(decl, env) {
    const fields = /* @__PURE__ */ new Map();
    for (const f of decl.fields) {
      fields.set(f.name, f.default_ ? await this.evalExpr(f.default_, env) : { tag: "VUnit" });
    }
    const state = { tag: "VRecord", fields };
    const rt = { state, fieldNames: decl.fields.map((f) => f.name), pubs: decl.pubs, env, tail: Promise.resolve(), handlers: /* @__PURE__ */ new Map() };
    this.stores.set(decl.name, rt);
    env.define(decl.name, state);
    await this.recomputePubs(rt);
    const handlers = new Map(decl.messages.map((m) => [m.name, m]));
    rt.handlers = handlers;
    for (const msg of decl.messages) {
      env.define(msg.name, builtin(msg.name, async (args) => {
        await this.deliver(rt, msg.name, args);
        return { tag: "VUnit" };
      }));
    }
  }
  // Run a store message handler under the store's exclusive lock, mutating its
  // state and recomputing pubs. Returns the store's state record (the reply).
  deliver(rt, name, args) {
    const run = rt.tail.then(async () => {
      const msg = rt.handlers.get(name);
      if (!msg)
        throw new RuntimeError(`store has no message '${name}'`);
      const henv = this.storeScope(rt);
      msg.params.forEach((p, i) => {
        const b = matchPat(p.pat, args[i] ?? { tag: "VUnit" });
        if (b)
          for (const [k, v] of b)
            henv.define(k, v);
      });
      const result = await this.evalExpr(msg.body, henv);
      if (result.tag === "VRecord") {
        for (const [k, v] of result.fields)
          if (rt.fieldNames.includes(k))
            rt.state.fields.set(k, v);
      }
      await this.recomputePubs(rt);
      return rt.state;
    });
    rt.tail = run.then(() => {
    }, () => {
    });
    return run;
  }
  storeScope(rt) {
    const scope = rt.env.child();
    for (const name of rt.fieldNames)
      scope.define(name, rt.state.fields.get(name) ?? { tag: "VUnit" });
    return scope;
  }
  async recomputePubs(rt) {
    const scope = this.storeScope(rt);
    for (const pub of rt.pubs) {
      const val = pub.body ? await this.evalExpr(pub.body, scope) : rt.state.fields.get(pub.name) ?? { tag: "VUnit" };
      rt.state.fields.set(pub.name, val);
    }
  }
  // ── Expressions ─────────────────────────────────────────────────────────────
  async evalAll(exprs, env) {
    const out = [];
    for (const e of exprs)
      out.push(await this.evalExpr(e, env));
    return out;
  }
  async evalExpr(expr, env) {
    switch (expr.tag) {
      case "Lit":
        return litToValue(expr.lit);
      case "Var":
        return this.lookupVar(expr.name, env);
      case "Tuple":
        return { tag: "VTuple", elems: await this.evalAll(expr.elems, env) };
      case "List":
        return { tag: "VList", elems: await this.evalAll(expr.elems, env) };
      case "Record": {
        const fields = /* @__PURE__ */ new Map();
        if (expr.spread) {
          const base = await this.evalExpr(expr.spread, env);
          if (base.tag === "VRecord")
            for (const [k, v] of base.fields)
              fields.set(k, v);
        }
        for (const f of expr.fields)
          fields.set(f.name, await this.evalExpr(f.value, env));
        return { tag: "VRecord", fields };
      }
      case "Call": {
        const fn = await this.evalExpr(expr.fn, env);
        const args = await this.evalAll(expr.args, env);
        return await this.applyFn(fn, args, expr.fn.tag === "Var" ? expr.fn.name : "?");
      }
      case "Lambda": {
        const clause = { params: expr.params, body: expr.body, ret: null, effects: [], where_: [], lifetimeConstraints: [], span: expr.span };
        return { tag: "VFn", name: "<lambda>", clauses: [clause], env };
      }
      case "BinOp":
        return await this.evalBinOp(expr.op, expr.left, expr.right, env);
      case "UnOp":
        return await this.evalUnOp(expr.op, expr.expr, env);
      case "Field": {
        const obj = await this.evalExpr(expr.obj, env);
        if (obj.tag === "VRecord") {
          const v = obj.fields.get(expr.field);
          if (v !== void 0)
            return v;
        }
        if (obj.tag === "VSagaHandle") {
          const stepNames = obj.journal.flatMap((e) => e.kind === "step" ? [e.step] : []);
          switch (expr.field) {
            case "journal":
              return { tag: "VList", elems: stepNames.map((s) => ({ tag: "VAtom", name: s })) };
            case "status":
              return { tag: "VAtom", name: obj.status.value };
            case "step":
              return { tag: "VAtom", name: stepNames.at(-1) ?? "idle" };
            case "result":
              return await this.sched.awaitFuture(obj.future);
          }
        }
        throw new RuntimeError(`no field '${expr.field}' on ${display(obj)}`);
      }
      case "Index": {
        if (expr.index.tag === "Range") {
          const target = await this.evalExpr(expr.obj, env);
          const from = await this.evalExpr(expr.index.from, env);
          const to = await this.evalExpr(expr.index.to, env);
          if (from.tag !== "VNum" || to.tag !== "VNum")
            throw new RuntimeError("slice bounds must be numbers");
          const lo = Math.floor(from.v);
          const hi = expr.index.inclusive ? Math.floor(to.v) + 1 : Math.floor(to.v);
          return this.slice(target, lo, hi);
        }
        const obj = await this.evalExpr(expr.obj, env);
        const idx = await this.evalExpr(expr.index, env);
        if (obj.tag === "VList" && idx.tag === "VNum") {
          const i = Math.floor(idx.v);
          if (i < 0 || i >= obj.elems.length)
            throw new RuntimeError(`index ${i} out of bounds`);
          return obj.elems[i];
        }
        if (obj.tag === "VStr" && idx.tag === "VNum")
          return { tag: "VStr", v: obj.v[Math.floor(idx.v)] ?? "" };
        if (obj.tag === "VDict") {
          const slot = obj.entries.get(dictKey(idx));
          if (!slot)
            throw new RuntimeError(`key not found: ${display(idx)}`);
          return slot[1];
        }
        throw new RuntimeError(`cannot index ${obj.tag} with ${display(idx)}`);
      }
      case "AddrOf": {
        if (expr.expr.tag === "Var") {
          const name = expr.expr.name;
          return {
            tag: "VPtr",
            label: name,
            read: () => this.lookupVar(name, env),
            write: (v) => env.set(name, v)
          };
        }
        if (expr.expr.tag === "Index") {
          const obj = await this.evalExpr(expr.expr.obj, env);
          const idx = await this.evalExpr(expr.expr.index, env);
          const lbl = exprLabel(expr.expr.obj);
          if (obj.tag === "VList" && idx.tag === "VNum") {
            const i = Math.floor(idx.v);
            const inBounds = () => {
              if (i < 0 || i >= obj.elems.length)
                throw new RuntimeError(`pointer index ${i} out of bounds`);
            };
            inBounds();
            return {
              tag: "VPtr",
              label: `${lbl}[${i}]`,
              read: () => {
                inBounds();
                return obj.elems[i];
              },
              write: (v) => {
                inBounds();
                obj.elems[i] = v;
              }
            };
          }
          if (obj.tag === "VDict") {
            const k = dictKey(idx);
            return {
              tag: "VPtr",
              label: `${lbl}[${display(idx)}]`,
              read: () => {
                const s = obj.entries.get(k);
                if (!s)
                  throw new RuntimeError(`key not found: ${display(idx)}`);
                return s[1];
              },
              write: (v) => {
                obj.entries.set(k, [idx, v]);
              }
            };
          }
          if (obj.tag === "VStr" && idx.tag === "VNum") {
            const i = Math.floor(idx.v);
            const inBounds = () => {
              if (i < 0 || i >= obj.v.length)
                throw new RuntimeError(`pointer index ${i} out of bounds`);
            };
            inBounds();
            return {
              tag: "VPtr",
              label: `${lbl}[${i}]`,
              read: () => {
                inBounds();
                return { tag: "VStr", v: obj.v[i] };
              },
              write: (v) => {
                inBounds();
                if (v.tag !== "VStr")
                  throw new RuntimeError(`cannot assign ${v.tag} to a string index`);
                obj.v = obj.v.slice(0, i) + v.v + obj.v.slice(i + 1);
              }
            };
          }
        }
        if (expr.expr.tag === "Field") {
          const obj = await this.evalExpr(expr.expr.obj, env);
          if (obj.tag === "VRecord") {
            const f = expr.expr.field;
            if (!obj.fields.has(f))
              throw new RuntimeError(`cannot borrow unknown field '${f}'`);
            return {
              tag: "VPtr",
              label: `${exprLabel(expr.expr.obj)}.${f}`,
              read: () => obj.fields.get(f),
              write: (v) => {
                obj.fields.set(f, v);
              }
            };
          }
        }
        let cell = await this.evalExpr(expr.expr, env);
        return { tag: "VPtr", label: "_", read: () => cell, write: (v) => {
          cell = v;
        } };
      }
      case "Deref": {
        const p = await this.evalExpr(expr.expr, env);
        if (p.tag !== "VPtr")
          throw new RuntimeError(`cannot dereference non-pointer ${display(p)}`);
        return p.read();
      }
      case "Match":
        return await this.evalMatch(expr.subject, expr.branches, env);
      case "If": {
        const cond = await this.evalExpr(expr.cond, env);
        if (cond.tag !== "VBool")
          throw new RuntimeError(`if condition must be Bool, got ${display(cond)}`);
        if (cond.v)
          return await this.evalExpr(expr.then, env);
        if (expr.else_)
          return await this.evalExpr(expr.else_, env);
        return { tag: "VUnit" };
      }
      case "Do":
        return await this.evalBlock(expr.stmts, env);
      case "Loop":
        return await this.evalLoop(expr.stmts, env);
      case "Break":
        throw new BreakSignal(expr.value ? await this.evalExpr(expr.value, env) : null);
      case "Continue":
        throw new ContinueSignal();
      case "Machine":
        return await this.evalMachine(expr, env);
      case "Go": {
        if (expr.expr.tag === "Call" && expr.expr.fn.tag === "Var") {
          const saga = env.lookup(expr.expr.fn.name);
          if (saga?.tag === "VSaga") {
            let args = await this.evalAll(expr.expr.args, env);
            if (args.length === 1 && args[0].tag === "VUnit")
              args = [];
            const journal = [];
            const status = { value: "running" };
            const future = this.sched.spawn(() => this.runSagaInstance(saga, args, journal, status));
            return { tag: "VSagaHandle", name: saga.name, future, journal, status };
          }
        }
        return { tag: "VFuture", future: this.sched.spawn(() => this.evalExpr(expr.expr, env)) };
      }
      case "Resume": {
        if (expr.expr.tag === "Call" && expr.expr.fn.tag === "Var") {
          const saga = env.lookup(expr.expr.fn.name);
          if (saga?.tag === "VSaga") {
            let args = await this.evalAll(expr.expr.args, env);
            if (args.length === 1 && args[0].tag === "VUnit")
              args = [];
            return await this.resumeSagaInstance(saga, args, { value: "running" });
          }
        }
        return await this.evalExpr(expr.expr, env);
      }
      case "Drop": {
        await this.evalExpr(expr.expr, env);
        return { tag: "VUnit" };
      }
      case "Try":
        return await this.evalTryBody(expr.stmts, env);
      case "Retry": {
        let max = Infinity;
        let schedule = null;
        if (expr.count) {
          const cv = await this.evalExpr(expr.count, env);
          if (cv.tag === "VNum") {
            max = cv.v;
          } else if (cv.tag === "VList") {
            schedule = cv.elems.map((e) => e.tag === "VNum" ? e.v : 0);
            max = schedule.length + 1;
          } else {
            throw new RuntimeError(`retry count must be a Number or a list of delays, got ${display(cv)}`);
          }
        }
        let fixedDelay = 0;
        if (expr.delay) {
          const dv = await this.evalExpr(expr.delay, env);
          if (dv.tag !== "VNum")
            throw new RuntimeError(`retry delay must be a Number/Duration, got ${display(dv)}`);
          fixedDelay = dv.v;
        }
        let last = { tag: "VCtor", name: "Error", payload: { tag: "VUnit" } };
        for (let attempt = 0; attempt < max; attempt++) {
          if (attempt > 0) {
            const d = schedule ? schedule[attempt - 1] ?? 0 : fixedDelay;
            if (d > 0)
              await this.sched.sleep(d);
          }
          const result = await this.evalTryBody(expr.stmts, env);
          if (!isFailure(result))
            return result;
          last = result;
        }
        return last;
      }
      case "Await": {
        const v = await this.evalExpr(expr.expr, env);
        let resolved;
        if (v.tag === "VStream") {
          resolved = await v.q.next();
        } else {
          resolved = v.tag === "VFuture" || v.tag === "VSagaHandle" ? await this.sched.awaitFuture(v.future) : v;
        }
        if (expr.branches.length === 0)
          return resolved;
        return await this.matchBranches(resolved, expr.branches, env);
      }
      case "For": {
        const results = [];
        const step = async (i, scope) => {
          if (i === expr.clauses.length) {
            try {
              results.push(await this.evalExpr(expr.body, scope));
            } catch (e) {
              if (e instanceof BreakSignal)
                return false;
              if (e instanceof ContinueSignal)
                return true;
              throw e;
            }
            return true;
          }
          const clause = expr.clauses[i];
          if (clause.tag === "Filter") {
            const c = await this.evalExpr(clause.cond, scope);
            if (c.tag === "VBool" && !c.v)
              return true;
            if (c.tag !== "VBool")
              throw new RuntimeError(`for filter must be Bool, got ${display(c)}`);
            return await step(i + 1, scope);
          }
          for (const elem of toList(await this.evalExpr(clause.iter, scope))) {
            const inner = scope.child();
            const bindings = matchPat(clause.binding, elem);
            if (!bindings)
              throw new RuntimeError(`for binding failed on ${display(elem)}`);
            for (const [k, v] of bindings)
              inner.define(k, v);
            if (!await step(i + 1, inner))
              return false;
          }
          return true;
        };
        await step(0, env);
        return { tag: "VList", elems: results };
      }
      case "Range": {
        const from = await this.evalExpr(expr.from, env);
        const to = await this.evalExpr(expr.to, env);
        if (from.tag !== "VNum" || to.tag !== "VNum")
          throw new RuntimeError("range requires numbers");
        const elems = [];
        const end = expr.inclusive ? to.v : to.v - 1;
        for (let i = from.v; i <= end; i++)
          elems.push({ tag: "VNum", v: i });
        return { tag: "VList", elems };
      }
      case "Propagate": {
        const v = await this.evalExpr(expr.expr, env);
        if (v.tag === "VCtor" && v.name === "Ok")
          return v.payload ?? { tag: "VUnit" };
        if (v.tag === "VCtor" && v.name === "Error")
          throw new ReturnSignal(v);
        return v;
      }
      case "PropWith": {
        const v = await this.evalExpr(expr.expr, env);
        if (v.tag === "VCtor" && v.name === "Ok")
          return v.payload ?? { tag: "VUnit" };
        return await this.evalExpr(expr.alt, env);
      }
      case "TypeTest": {
        const v = await this.evalExpr(expr.expr, env);
        const name = expr.against.tag === "TRNamed" ? expr.against.name : null;
        if (!name)
          return { tag: "VBool", v: true };
        return { tag: "VBool", v: v.tag === "VCtor" && v.name === name };
      }
      case "Send": {
        const msg = await this.evalExpr(expr.msg, env);
        const target = env.lookup(expr.store);
        if (target?.tag === "VStream") {
          target.q.push(msg);
          return { tag: "VUnit" };
        }
        return { tag: "VUnit" };
      }
      case "Transaction": {
        let maxRetry = 0;
        let deadline = null;
        if (expr.config) {
          const cfg = await this.evalExpr(expr.config, env);
          if (cfg.tag === "VRecord") {
            const mr = cfg.fields.get("maxRetry");
            if (mr?.tag === "VNum")
              maxRetry = mr.v;
            const to = cfg.fields.get("to");
            if (to?.tag === "VNum")
              deadline = to.v;
          }
        }
        let retries = 0;
        for (; ; ) {
          if (deadline !== null && this.sched.now() > deadline) {
            return {
              tag: "VCtor",
              name: "Timeout",
              payload: { tag: "VRecord", fields: /* @__PURE__ */ new Map([["after", { tag: "VNum", v: this.sched.now() }]]) }
            };
          }
          const snapshot = this.snapshotStores();
          let failure = null;
          try {
            const result = await this.evalBlock(expr.body, env);
            if (!isFailure(result))
              return { tag: "VCtor", name: "Ok", payload: result };
            failure = result;
          } catch (e) {
            if (e instanceof SagaCrashSignal) {
              this.restoreStores(snapshot);
              return { tag: "VCtor", name: "Cancelled", payload: null };
            }
            if (e instanceof ReturnSignal && isFailure(e.value)) {
              failure = e.value;
            } else {
              this.restoreStores(snapshot);
              throw e;
            }
          }
          this.restoreStores(snapshot);
          if (retries < maxRetry) {
            retries++;
            continue;
          }
          if (expr.config) {
            return {
              tag: "VCtor",
              name: "Conflict",
              payload: { tag: "VRecord", fields: /* @__PURE__ */ new Map([["retries", { tag: "VNum", v: retries }]]) }
            };
          }
          return failure;
        }
      }
      case "Element": {
        const text = expr.content ? await this.evalExpr(expr.content, env) : null;
        const props = /* @__PURE__ */ new Map();
        for (const p of expr.props) {
          if (hasConvRef(p.value))
            props.set(p.name, { tag: "VDeferred", expr: p.value, env });
          else
            props.set(p.name, await this.evalExpr(p.value, env));
        }
        const events = /* @__PURE__ */ new Map();
        const children = [];
        for (const c of expr.children) {
          if (c.tag === "Handler") {
            const body = c.body, param = c.param, capturedEnv = env;
            events.set(c.event, { tag: "VBuiltin", name: `on:${c.event}`, fn: (args) => {
              if (!param)
                return this.evalExpr(body, capturedEnv);
              const e2 = capturedEnv.child();
              e2.define(param, args[0] ?? emptyEvent());
              return this.evalExpr(body, e2);
            } });
          } else {
            children.push(await this.evalExpr(c, env));
          }
        }
        return { tag: "VElement", name: expr.name, text, props, children, events };
      }
      case "Handler": {
        const body = expr.body, param = expr.param, capturedEnv = env;
        return { tag: "VBuiltin", name: `on:${expr.event}`, fn: (args) => {
          if (!param)
            return this.evalExpr(body, capturedEnv);
          const e2 = capturedEnv.child();
          e2.define(param, args[0] ?? emptyEvent());
          return this.evalExpr(body, e2);
        } };
      }
      case "JSExpr": {
        const jsEnv = {};
        for (const [k, v] of env.allBindings())
          jsEnv[k] = velveToJs(v);
        let result;
        try {
          result = new Function("$velve", `"use strict"; return (${expr.code})`)({ env: jsEnv });
        } catch (e) {
          throw new RuntimeError(`@js error: ${e instanceof Error ? e.message : String(e)}`);
        }
        return jsToVelve(result);
      }
    }
  }
  // ── Block / loop ─────────────────────────────────────────────────────────────
  // Implicit `try` body: each line auto-unwraps its Result — `Ok v` binds/yields
  // `v`, `Error`/`None` collapses the whole block to that failure, a non-Result
  // passes through unchanged. The block's value is `Ok(last)` (or the last value
  // if it is already a Result). An explicit `?` inside still works (its
  // ReturnSignal is caught at the boundary).
  async evalTryBody(stmts, parentEnv) {
    let env = parentEnv.child();
    let last = { tag: "VUnit" };
    const peel = (v) => {
      if (v.tag === "VCtor" && v.name === "Ok")
        return { fail: null, val: v.payload ?? { tag: "VUnit" } };
      if (v.tag === "VCtor" && (v.name === "Error" || v.name === "None"))
        return { fail: v, val: v };
      return { fail: null, val: v };
    };
    try {
      for (const stmt of stmts) {
        switch (stmt.tag) {
          case "SBind": {
            const u = peel(await this.evalExpr(stmt.value, env));
            if (u.fail)
              return u.fail;
            if (!stmt.declares && stmt.pat.tag === "PVar" && env.lookup(stmt.pat.name) !== void 0) {
              env.set(stmt.pat.name, u.val);
              last = { tag: "VUnit" };
              break;
            }
            const next = env.child();
            const bindings = matchPat(stmt.pat, u.val);
            if (!bindings)
              throw new RuntimeError(`pattern match failed in try bind: ${display(u.val)}`);
            for (const [k, v] of bindings)
              next.define(k, v);
            env = next;
            last = { tag: "VUnit" };
            break;
          }
          case "SExpr": {
            const u = peel(await this.evalExpr(stmt.expr, env));
            if (u.fail)
              return u.fail;
            last = u.val;
            break;
          }
          case "SAssign":
            await this.evalAssign(stmt.target, stmt.value, env);
            last = { tag: "VUnit" };
            break;
          case "SReturn":
            throw new ReturnSignal(stmt.value ? await this.evalExpr(stmt.value, env) : { tag: "VUnit" });
          case "SBreak":
            throw new BreakSignal(stmt.value ? await this.evalExpr(stmt.value, env) : null);
        }
      }
    } catch (e) {
      if (e instanceof ReturnSignal && isFailure(e.value))
        return e.value;
      throw e;
    }
    if (last.tag === "VCtor" && (last.name === "Ok" || last.name === "Error"))
      return last;
    return { tag: "VCtor", name: "Ok", payload: last };
  }
  async evalBlock(stmts, parentEnv) {
    let env = parentEnv.child();
    let last = { tag: "VUnit" };
    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          const val = await this.evalExpr(stmt.value, env);
          if (!stmt.declares && stmt.pat.tag === "PVar" && env.lookup(stmt.pat.name) !== void 0) {
            env.set(stmt.pat.name, val);
            last = { tag: "VUnit" };
            break;
          }
          const next = env.child();
          const bindings = matchPat(stmt.pat, val);
          if (!bindings)
            throw new RuntimeError(`pattern match failed in bind: ${display(val)}`);
          for (const [k, v] of bindings)
            next.define(k, v);
          env = next;
          last = { tag: "VUnit" };
          break;
        }
        case "SExpr":
          last = await this.evalExpr(stmt.expr, env);
          break;
        case "SAssign":
          await this.evalAssign(stmt.target, stmt.value, env);
          last = { tag: "VUnit" };
          break;
        case "SReturn":
          throw new ReturnSignal(stmt.value ? await this.evalExpr(stmt.value, env) : { tag: "VUnit" });
        case "SBreak":
          throw new BreakSignal(stmt.value ? await this.evalExpr(stmt.value, env) : null);
      }
    }
    return last;
  }
  // Write through an lvalue: `p.* = v` (pointer), `xs[i] = v` (list element), or
  // `rec.f = v` (record field). All mutate a by-reference container in place, so
  // the write is observable wherever the container is bound or aliased.
  async evalAssign(target, value, env) {
    const v = await this.evalExpr(value, env);
    if (target.tag === "Deref") {
      const p = await this.evalExpr(target.expr, env);
      if (p.tag !== "VPtr")
        throw new RuntimeError(`cannot assign through non-pointer ${display(p)}`);
      p.write(v);
      return;
    }
    if (target.tag === "Index") {
      const obj = await this.evalExpr(target.obj, env);
      const idx = await this.evalExpr(target.index, env);
      if (obj.tag === "VList" && idx.tag === "VNum") {
        const i = Math.floor(idx.v);
        if (i < 0 || i >= obj.elems.length)
          throw new RuntimeError(`index ${i} out of bounds`);
        obj.elems[i] = v;
        return;
      }
      if (obj.tag === "VDict") {
        obj.entries.set(dictKey(idx), [idx, v]);
        return;
      }
      if (obj.tag === "VStr" && idx.tag === "VNum") {
        const i = Math.floor(idx.v);
        if (i < 0 || i >= obj.v.length)
          throw new RuntimeError(`index ${i} out of bounds`);
        if (v.tag !== "VStr")
          throw new RuntimeError(`cannot assign ${v.tag} to a string index`);
        obj.v = obj.v.slice(0, i) + v.v + obj.v.slice(i + 1);
        return;
      }
      throw new RuntimeError(`cannot index-assign ${obj.tag}`);
    }
    if (target.tag === "Field") {
      const obj = await this.evalExpr(target.obj, env);
      if (obj.tag === "VRecord") {
        obj.fields.set(target.field, v);
        return;
      }
      throw new RuntimeError(`cannot field-assign ${obj.tag}`);
    }
    throw new RuntimeError(`invalid assignment target`);
  }
  // ── Transactions ─────────────────────────────────────────────────────────────
  // Shallow-copy every store's field map so a failed `transaction` can restore
  // the exact pre-transaction state. Store mutation is by value-replacement
  // (handlers merge a partial record), so a shallow copy of the field map is a
  // complete snapshot; nested values are never mutated in place.
  snapshotStores() {
    const snap = /* @__PURE__ */ new Map();
    for (const [name, rt] of this.stores)
      snap.set(name, new Map(rt.state.fields));
    return snap;
  }
  restoreStores(snap) {
    for (const [name, fields] of snap) {
      const rt = this.stores.get(name);
      if (!rt)
        continue;
      rt.state.fields.clear();
      for (const [k, v] of fields)
        rt.state.fields.set(k, v);
    }
  }
  async evalLoop(stmts, env) {
    for (; ; ) {
      try {
        await this.evalBlock(stmts, env);
      } catch (e) {
        if (e instanceof BreakSignal)
          return e.value ?? { tag: "VUnit" };
        if (e instanceof ContinueSignal)
          continue;
        throw e;
      }
    }
  }
  // ── Match ────────────────────────────────────────────────────────────────────
  async evalMatch(subjectExpr, branches, env) {
    return await this.matchBranches(await this.evalExpr(subjectExpr, env), branches, env);
  }
  async matchBranches(subject, branches, env) {
    for (const branch of branches) {
      const bindings = matchPat(branch.pat, subject);
      if (!bindings)
        continue;
      const inner = env.child();
      for (const [k, v] of bindings)
        inner.define(k, v);
      if (branch.guard) {
        const g = await this.evalExpr(branch.guard, inner);
        if (g.tag !== "VBool" || !g.v)
          continue;
      }
      return await this.evalExpr(branch.body, inner);
    }
    throw new RuntimeError(`non-exhaustive match on ${display(subject)}`);
  }
  // ── Function application ─────────────────────────────────────────────────────
  async applyFn(fn, args, callSite) {
    if (args.length === 1 && args[0].tag === "VUnit")
      args = [];
    if (fn.tag === "VBuiltin")
      return await fn.fn(args);
    if (fn.tag === "VSaga") {
      return await this.runSagaInstance(fn, args, [], { value: "running" });
    }
    if (fn.tag !== "VFn")
      throw new RuntimeError(`cannot call ${display(fn)}`);
    for (const clause of fn.clauses) {
      if (clause.params.length !== args.length)
        continue;
      const r = await this.runClause(fn, clause, args.slice(0, clause.params.length));
      if (r.ok)
        return r.value;
    }
    for (const clause of fn.clauses) {
      const n = clause.params.length;
      if (n === 0 || n >= args.length)
        continue;
      const r = await this.runClause(fn, clause, args.slice(0, n));
      if (r.ok)
        return await this.applyFn(r.value, args.slice(n), callSite);
    }
    const fnVal = fn;
    const minArity = Math.min(...fn.clauses.map((c) => c.params.length));
    if (args.length > 0 && args.length < minArity) {
      const bound = args;
      return {
        tag: "VBuiltin",
        name: `${callSite}(partial)`,
        fn: (more) => this.applyFn(fnVal, [...bound, ...more], callSite)
      };
    }
    throw new RuntimeError(`non-exhaustive patterns in '${callSite}' for args: ${args.map(display).join(", ")}`);
  }
  // Bind one clause against exactly `args` (length must equal clause arity).
  // Returns {ok:false} if a parameter pattern fails so the caller can try the
  // next clause; throws for genuine runtime errors inside the body.
  async runClause(fn, clause, args) {
    const inner = fn.env.child();
    for (let i = 0; i < clause.params.length; i++) {
      const b = matchPat(clause.params[i].pat, args[i]);
      if (!b)
        return { ok: false };
      for (const [k, v] of b)
        inner.define(k, v);
    }
    for (const { pat, value } of clause.where_) {
      const wv = await this.evalExpr(value, inner);
      const wb = matchPat(pat, wv);
      if (!wb)
        throw new RuntimeError(`where binding failed`);
      for (const [k, v] of wb)
        inner.define(k, v);
    }
    try {
      return { ok: true, value: await this.evalExpr(clause.body, inner) };
    } catch (e) {
      if (e instanceof ReturnSignal)
        return { ok: true, value: e.value };
      throw e;
    }
  }
  // ── Operators ────────────────────────────────────────────────────────────────
  async evalBinOp(op, leftExpr, rightExpr, env) {
    if (op === "&&") {
      const l2 = await this.evalExpr(leftExpr, env);
      if (l2.tag !== "VBool")
        throw new RuntimeError(`&& requires Bool`);
      if (!l2.v)
        return { tag: "VBool", v: false };
      return await this.evalExpr(rightExpr, env);
    }
    if (op === "||") {
      const l2 = await this.evalExpr(leftExpr, env);
      if (l2.tag !== "VBool")
        throw new RuntimeError(`|| requires Bool`);
      if (l2.v)
        return { tag: "VBool", v: true };
      return await this.evalExpr(rightExpr, env);
    }
    if (op === "|>") {
      const l2 = await this.evalExpr(leftExpr, env);
      const f = await this.evalExpr(rightExpr, env);
      return await this.applyFn(f, [l2], "|>");
    }
    const l = await this.evalExpr(leftExpr, env);
    const r = await this.evalExpr(rightExpr, env);
    switch (op) {
      case "+":
        return numOp(l, r, (a, b) => a + b);
      case "-":
        return numOp(l, r, (a, b) => a - b);
      case "*":
        return numOp(l, r, (a, b) => a * b);
      case "/":
        return numOp(l, r, (a, b) => a / b);
      case "%":
        return numOp(l, r, (a, b) => a % b);
      case "**":
        return numOp(l, r, (a, b) => a ** b);
      case "^":
        return numOp(l, r, (a, b) => a ** b);
      case "<":
        return cmpOp(l, r, (a, b) => a < b);
      case ">":
        return cmpOp(l, r, (a, b) => a > b);
      case "<=":
        return cmpOp(l, r, (a, b) => a <= b);
      case ">=":
        return cmpOp(l, r, (a, b) => a >= b);
      case "==":
        return { tag: "VBool", v: equal(l, r) };
      case "!=":
        return { tag: "VBool", v: !equal(l, r) };
      case "++": {
        if (l.tag === "VStr" && r.tag === "VStr")
          return { tag: "VStr", v: l.v + r.v };
        if (l.tag === "VList" && r.tag === "VList")
          return { tag: "VList", elems: [...l.elems, ...r.elems] };
        throw new RuntimeError(`++ requires two Strings or two Lists, got ${display(l)} and ${display(r)}`);
      }
    }
    throw new RuntimeError(`unknown operator: ${op}`);
  }
  async evalUnOp(op, exprNode, env) {
    const v = await this.evalExpr(exprNode, env);
    switch (op) {
      case "-":
        if (v.tag === "VNum")
          return { tag: "VNum", v: -v.v };
        break;
      case "!":
        if (v.tag === "VBool")
          return { tag: "VBool", v: !v.v };
        break;
      case "not":
        if (v.tag === "VBool")
          return { tag: "VBool", v: !v.v };
        break;
    }
    throw new RuntimeError(`cannot apply ${op} to ${display(v)}`);
  }
  lookupVar(name, env) {
    const v = env.lookup(name);
    if (v !== void 0)
      return v;
    throw new RuntimeError(`undefined variable: ${name}`);
  }
};
function matchPat(pat, val) {
  const b = /* @__PURE__ */ new Map();
  return matchInto(pat, val, b) ? b : null;
}
function exprLabel(e) {
  switch (e.tag) {
    case "Var":
      return e.name;
    case "Field":
      return `${exprLabel(e.obj)}.${e.field}`;
    case "Index":
      return `${exprLabel(e.obj)}[\u2026]`;
    default:
      return "_";
  }
}
function matchInto(pat, val, b) {
  switch (pat.tag) {
    case "PWild":
      return true;
    case "PVar":
      b.set(pat.name, val);
      return true;
    case "PTyped":
      b.set(pat.name, val);
      return true;
    case "PAtom":
      return val.tag === "VAtom" && val.name === pat.name;
    case "PLit":
      return litMatch(pat.lit, val);
    case "PCtor":
      if (val.tag !== "VCtor" || val.name !== pat.name)
        return false;
      if (!pat.inner)
        return val.payload === null;
      if (val.payload === null)
        return false;
      return matchInto(pat.inner, val.payload, b);
    case "PTuple":
      if (val.tag !== "VTuple" || val.elems.length !== pat.elems.length)
        return false;
      return pat.elems.every((p, i) => matchInto(p, val.elems[i], b));
    case "PRecord":
      if (val.tag !== "VRecord")
        return false;
      for (const f of pat.fields) {
        const fval = val.fields.get(f.name);
        if (fval === void 0)
          return false;
        if (!matchInto(f.pat, fval, b))
          return false;
      }
      return true;
    default:
      return false;
  }
}
function litMatch(lit, val) {
  switch (lit.tag) {
    case "Num":
      return val.tag === "VNum" && val.v === lit.value;
    case "Str":
      return val.tag === "VStr" && val.v === lit.value;
    case "Bool":
      return val.tag === "VBool" && val.v === lit.value;
    case "Unit":
      return val.tag === "VUnit";
    case "Atom":
      return val.tag === "VAtom" && val.name === lit.name;
    default:
      return false;
  }
}
function litToValue(lit) {
  switch (lit.tag) {
    case "Num":
      return { tag: "VNum", v: lit.value };
    case "Str":
      return { tag: "VStr", v: lit.value };
    case "Bool":
      return { tag: "VBool", v: lit.value };
    case "Unit":
      return { tag: "VUnit" };
    case "Atom":
      return { tag: "VAtom", name: lit.name };
    case "Duration":
      return { tag: "VNum", v: lit.ms };
  }
}
function toList(v) {
  if (v.tag === "VList")
    return v.elems;
  throw new RuntimeError(`expected List, got ${display(v)}`);
}
function numOp(l, r, f) {
  if (l.tag !== "VNum" || r.tag !== "VNum")
    throw new RuntimeError(`arithmetic requires numbers, got ${display(l)} and ${display(r)}`);
  return { tag: "VNum", v: f(l.v, r.v) };
}
function cmpOp(l, r, f) {
  if (l.tag === "VNum" && r.tag === "VNum")
    return { tag: "VBool", v: f(l.v, r.v) };
  if (l.tag === "VStr" && r.tag === "VStr")
    return { tag: "VBool", v: f(l.v < r.v ? -1 : l.v > r.v ? 1 : 0, 0) };
  throw new RuntimeError(`comparison requires two numbers or two strings`);
}
function equal(a, b) {
  if (a.tag !== b.tag)
    return false;
  switch (a.tag) {
    case "VNum":
      return a.v === b.v;
    case "VStr":
      return a.v === b.v;
    case "VBool":
      return a.v === b.v;
    case "VAtom":
      return a.name === b.name;
    case "VUnit":
      return true;
    case "VTuple":
      return a.elems.every((e, i) => equal(e, b.elems[i]));
    case "VList":
      return a.elems.length === b.elems.length && a.elems.every((e, i) => equal(e, b.elems[i]));
    case "VCtor":
      return a.name === b.name && (a.payload === null ? b.payload === null : b.payload !== null && equal(a.payload, b.payload));
    default:
      return false;
  }
}
function builtin(name, fn) {
  return { tag: "VBuiltin", name, fn };
}
function findById(v, id) {
  if (v.tag !== "VElement")
    return null;
  const k = v.props.get("id");
  if (k && k.tag === "VStr" && k.v === id)
    return v;
  for (const c of v.children) {
    if (c.tag === "VList") {
      for (const e of c.elems) {
        const r = findById(e, id);
        if (r)
          return r;
      }
    } else {
      const r = findById(c, id);
      if (r)
        return r;
    }
  }
  return null;
}
function buildPrelude() {
  const env = new Env();
  const def = (name, fn) => env.define(name, builtin(name, fn));
  env.define("Ok", builtin("Ok", (args) => ({ tag: "VCtor", name: "Ok", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Error", builtin("Error", (args) => ({ tag: "VCtor", name: "Error", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Some", builtin("Some", (args) => ({ tag: "VCtor", name: "Some", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("None", { tag: "VCtor", name: "None", payload: null });
  env.define("Px", builtin("Px", (args) => ({ tag: "VCtor", name: "Px", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Fr", builtin("Fr", (args) => ({ tag: "VCtor", name: "Fr", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Pct", builtin("Pct", (args) => ({ tag: "VCtor", name: "Pct", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Fit", { tag: "VCtor", name: "Fit", payload: null });
  env.define("Fill", { tag: "VCtor", name: "Fill", payload: null });
  env.define("Clamp", builtin("Clamp", (args) => ({
    tag: "VCtor",
    name: "Clamp",
    payload: { tag: "VTuple", elems: [args[0] ?? { tag: "VUnit" }, args[1] ?? { tag: "VUnit" }] }
  })));
  env.define("Mobile", { tag: "VCtor", name: "Mobile", payload: null });
  env.define("Tablet", { tag: "VCtor", name: "Tablet", payload: null });
  env.define("Desktop", { tag: "VCtor", name: "Desktop", payload: null });
  env.define("Wide", { tag: "VCtor", name: "Wide", payload: null });
  env.define("viewport", { tag: "VRecord", fields: /* @__PURE__ */ new Map([
    ["width", { tag: "VNum", v: 1280 }],
    ["height", { tag: "VNum", v: 800 }],
    ["breakpoint", { tag: "VCtor", name: "Desktop", payload: null }]
  ]) });
  const atom = (n) => ({ tag: "VCtor", name: n, payload: null });
  for (const n of [
    "Idle",
    "Hovered",
    "Focused",
    "Pressed",
    "Dragged",
    "Disabled",
    "Empty",
    "Loading",
    "Partial",
    "Failed",
    "Ideal"
  ])
    env.define(n, atom(n));
  env.define("interactionOf", builtin("interactionOf", (args) => {
    const r = args[0];
    const on = (k) => {
      const v = r && r.tag === "VRecord" ? r.fields.get(k) : void 0;
      return v?.tag === "VBool" ? v.v : false;
    };
    return atom(on("disabled") ? "Disabled" : on("pressed") ? "Pressed" : on("dragged") ? "Dragged" : on("focused") ? "Focused" : on("hovered") ? "Hovered" : "Idle");
  }));
  for (const n of ["Off", "On", "Mixed", "Valid", "Invalid", "Pending"])
    env.define(n, atom(n));
  const allOf = (ns) => ({ tag: "VRecord", fields: /* @__PURE__ */ new Map([["all", { tag: "VList", elems: ns.map(atom) }]]) });
  env.define("Interaction", allOf(["Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled"]));
  env.define("UIState", allOf(["Empty", "Loading", "Partial", "Failed", "Ideal"]));
  env.define("Toggle", allOf(["Off", "On", "Mixed"]));
  env.define("Validity", allOf(["Valid", "Invalid", "Pending"]));
  env.define("raw", builtin("raw", (args) => args[0] ?? { tag: "VUnit" }));
  def("print", (args) => {
    console.log(args.map(display).join(" "));
    return { tag: "VUnit" };
  });
  def("println", (args) => {
    console.log(args.map(display).join(" "));
    return { tag: "VUnit" };
  });
  def("toString", (args) => ({ tag: "VStr", v: display(args[0] ?? { tag: "VUnit" }) }));
  const nums = (v) => (v.tag === "VList" ? v.elems : []).flatMap((e) => e.tag === "VNum" ? [e.v] : []);
  def("sum", (args) => ({ tag: "VNum", v: nums(args[0]).reduce((a, b) => a + b, 0) }));
  def("avg", (args) => {
    const ns = nums(args[0]);
    return { tag: "VNum", v: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0 };
  });
  def("abs", (args) => ({ tag: "VNum", v: Math.abs(num(args[0])) }));
  def("floor", (args) => ({ tag: "VNum", v: Math.floor(num(args[0])) }));
  def("ceil", (args) => ({ tag: "VNum", v: Math.ceil(num(args[0])) }));
  def("round", (args) => ({ tag: "VNum", v: Math.round(num(args[0])) }));
  def("sqrt", (args) => ({ tag: "VNum", v: Math.sqrt(num(args[0])) }));
  def("max", (args) => ({ tag: "VNum", v: Math.max(num(args[0]), num(args[1])) }));
  def("min", (args) => ({ tag: "VNum", v: Math.min(num(args[0]), num(args[1])) }));
  def("int", (args) => ({ tag: "VNum", v: Math.trunc(num(args[0])) }));
  def("not", (args) => ({ tag: "VBool", v: !bool(args[0]) }));
  def("length", (args) => {
    const v = args[0];
    if (v.tag === "VList")
      return { tag: "VNum", v: v.elems.length };
    if (v.tag === "VStr")
      return { tag: "VNum", v: v.v.length };
    throw new RuntimeError(`length: expected List or String`);
  });
  def("isEmpty", (args) => ({ tag: "VBool", v: toList(args[0]).length === 0 }));
  def("head", (args) => {
    const elems = toList(args[0]);
    if (!elems.length)
      throw new RuntimeError("head: empty list");
    return elems[0];
  });
  def("tail", (args) => {
    const elems = toList(args[0]);
    if (!elems.length)
      throw new RuntimeError("tail: empty list");
    return { tag: "VList", elems: elems.slice(1) };
  });
  def("append", (args) => ({ tag: "VList", elems: [...toList(args[0]), args[1]] }));
  def("prepend", (args) => ({ tag: "VList", elems: [args[0], ...toList(args[1])] }));
  def("concat", (args) => ({ tag: "VList", elems: toList(args[0]).flatMap((v) => toList(v)) }));
  def("reverse", (args) => ({ tag: "VList", elems: [...toList(args[0])].reverse() }));
  def("slice", (args) => ({ tag: "VList", elems: toList(args[0]).slice(num(args[1]), num(args[2])) }));
  def("zip", (args) => {
    const a = toList(args[0]), b = toList(args[1]);
    const len = Math.min(a.length, b.length);
    return { tag: "VList", elems: Array.from({ length: len }, (_, i) => ({ tag: "VTuple", elems: [a[i], b[i]] })) };
  });
  def("range", (args) => {
    const from = num(args[0]), to = num(args[1]);
    const elems = [];
    for (let i = from; i < to; i++)
      elems.push({ tag: "VNum", v: i });
    return { tag: "VList", elems };
  });
  def("trim", (args) => ({ tag: "VStr", v: str(args[0]).trim() }));
  def("split", (args) => ({ tag: "VList", elems: str(args[0]).split(str(args[1])).map((s) => ({ tag: "VStr", v: s })) }));
  def("join", (args) => ({ tag: "VStr", v: toList(args[0]).map((v) => display(v)).join(str(args[1])) }));
  def("contains", (args) => ({ tag: "VBool", v: str(args[0]).includes(str(args[1])) }));
  def("matches", (args) => ({ tag: "VBool", v: new RegExp(str(args[1])).test(str(args[0])) }));
  def("startsWith", (args) => ({ tag: "VBool", v: str(args[0]).startsWith(str(args[1])) }));
  def("endsWith", (args) => ({ tag: "VBool", v: str(args[0]).endsWith(str(args[1])) }));
  def("toUpperCase", (args) => ({ tag: "VStr", v: str(args[0]).toUpperCase() }));
  def("toLowerCase", (args) => ({ tag: "VStr", v: str(args[0]).toLowerCase() }));
  def("parseInt", (args) => {
    const n = parseInt(str(args[0]), 10);
    return isNaN(n) ? { tag: "VCtor", name: "Error", payload: { tag: "VStr", v: "not a number" } } : { tag: "VCtor", name: "Ok", payload: { tag: "VNum", v: n } };
  });
  def("parseFloat", (args) => {
    const n = parseFloat(str(args[0]));
    return isNaN(n) ? { tag: "VCtor", name: "Error", payload: { tag: "VStr", v: "not a number" } } : { tag: "VCtor", name: "Ok", payload: { tag: "VNum", v: n } };
  });
  return env;
}
function patchHOF(env, ev) {
  const def = (name, fn) => env.define(name, { tag: "VBuiltin", name, fn });
  def("map", async (args) => {
    const f = args[0], list = toList(args[1]);
    const out = [];
    for (const v of list)
      out.push(await ev.applyFn(f, [v], "map"));
    return { tag: "VList", elems: out };
  });
  def("html", async (args) => ({ tag: "VStr", v: renderHtml(await ev.converge(args[0])) }));
  def("uiModel", async (args) => ({ tag: "VStr", v: renderModel(await ev.converge(args[0])) }));
  def("analyze", async (args) => ({ tag: "VStr", v: analyzeModel(await ev.converge(args[0])) }));
  def("uiJson", async (args) => ({ tag: "VStr", v: renderJson(await ev.converge(args[0])) }));
  def("sandbox", async (args) => {
    const name = args[0]?.tag === "VStr" ? args[0].v : "component";
    const variants = toList(args[1]);
    const render = args[2];
    const blocks = [];
    for (const variant of variants) {
      const tree = await ev.converge(await ev.applyFn(render, [variant], "sandbox"));
      blocks.push(`=== ${name} / ${display(variant)} ===
${renderModel(tree)}
--- html ---
${renderHtml(tree)}`);
    }
    return { tag: "VStr", v: blocks.join("\n\n") };
  });
  def("interactive", async (args) => {
    const view = args[0];
    const steps = args[1] && args[1].tag === "VList" ? args[1].elems : [];
    const lines = [];
    let tree = await ev.converge(await ev.applyFn(view, [], "view"));
    lines.push("=== initial ===", renderHtml(tree));
    for (const w of keylessListWarnings(tree))
      lines.push(w);
    let n = 0;
    for (const step of steps) {
      n++;
      const rec = step.tag === "VRecord" ? step.fields : /* @__PURE__ */ new Map();
      const tgt = rec.get("target"), evt = rec.get("event");
      const targetId = tgt?.tag === "VStr" ? tgt.v : "";
      const eventName = evt?.tag === "VStr" ? evt.v : "";
      const header = `=== step ${n}: ${eventName} on #${targetId} ===`;
      const node = findById(tree, targetId);
      const handler = node?.events.get(eventName);
      if (!handler) {
        lines.push(header, node ? `  (no ${eventName} handler on #${targetId})` : `  (no element with id "${targetId}")`);
        continue;
      }
      await ev.applyFn(handler, [], `event:${eventName}`);
      await ev.settle();
      const next = await ev.converge(await ev.applyFn(view, [], "view"));
      const patches = diff(tree, next);
      lines.push(header, ...patches.length ? patches.map((p) => "  " + patchLabel(p)) : ["  (no change)"]);
      tree = next;
    }
    return { tag: "VStr", v: lines.join("\n") };
  });
  def("domHost", async (args) => {
    const view = args[0];
    const steps = args[1] && args[1].tag === "VList" ? args[1].elems : [];
    let tree = await ev.converge(await ev.applyFn(view, [], "view"));
    const initialHtml = renderHtml(tree);
    const session = [];
    for (const step of steps) {
      const rec = step.tag === "VRecord" ? step.fields : /* @__PURE__ */ new Map();
      const tgt = rec.get("target"), evt = rec.get("event");
      const targetId = tgt?.tag === "VStr" ? tgt.v : "";
      const eventName = evt?.tag === "VStr" ? evt.v : "";
      const node = findById(tree, targetId);
      const handler = node?.events.get(eventName);
      if (!handler) {
        session.push({ label: `${eventName} on #${targetId} (no handler)`, patches: [] });
        continue;
      }
      await ev.applyFn(handler, [], `event:${eventName}`);
      await ev.settle();
      const next = await ev.converge(await ev.applyFn(view, [], "view"));
      session.push({ label: `${eventName} on #${targetId}`, patches: diff(tree, next) });
      tree = next;
    }
    return { tag: "VStr", v: domHostPage(initialHtml, session, "velve") };
  });
  const settle = async (v) => v.tag === "VFuture" || v.tag === "VSagaHandle" ? await ev.sched.awaitFuture(v.future) : v;
  def("pmap", async (args) => {
    const list = toList(args[0]), f = args[1];
    const futs = list.map((v) => ev.sched.spawn(() => ev.applyFn(f, [v], "pmap")));
    const out = [];
    for (const fut of futs)
      out.push(await settle(await ev.sched.awaitFuture(fut)));
    return { tag: "VList", elems: out };
  });
  def("pfilter", async (args) => {
    const list = toList(args[0]), f = args[1];
    const futs = list.map((v) => ev.sched.spawn(() => ev.applyFn(f, [v], "pfilter")));
    const out = [];
    for (let i = 0; i < list.length; i++) {
      if (bool(await settle(await ev.sched.awaitFuture(futs[i]))))
        out.push(list[i]);
    }
    return { tag: "VList", elems: out };
  });
  def("parallel", async (args) => {
    const list = toList(args[0]);
    const out = [];
    for (const v of list)
      out.push(await settle(v));
    return { tag: "VList", elems: out };
  });
  const asStream = (v, who) => {
    if (v?.tag === "VStream")
      return v;
    throw new RuntimeError(`${who} expects a Stream, got ${v ? display(v) : "nothing"}`);
  };
  const isPush = (v) => v.tag === "VCtor" && v.name === "Push";
  const DONE = { tag: "VCtor", name: "Done", payload: { tag: "VUnit" } };
  const push = (v) => ({ tag: "VCtor", name: "Push", payload: v });
  def("streamMap", async (args) => {
    const src = asStream(args[0], "streamMap"), f = args[1];
    const out = { tag: "VStream", name: `${src.name}.map`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      for (; ; ) {
        const v = await src.q.next();
        if (isPush(v))
          out.q.push(push(await ev.applyFn(f, [v.payload], "streamMap")));
        else {
          out.q.push(DONE);
          return { tag: "VUnit" };
        }
      }
    });
    return out;
  });
  def("streamFilter", async (args) => {
    const src = asStream(args[0], "streamFilter"), pred = args[1];
    const out = { tag: "VStream", name: `${src.name}.filter`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      for (; ; ) {
        const v = await src.q.next();
        if (isPush(v)) {
          if (bool(await ev.applyFn(pred, [v.payload], "streamFilter")))
            out.q.push(v);
        } else {
          out.q.push(DONE);
          return { tag: "VUnit" };
        }
      }
    });
    return out;
  });
  def("streamTake", async (args) => {
    const src = asStream(args[0], "streamTake"), n = num(args[1]);
    const out = { tag: "VStream", name: `${src.name}.take`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let taken = 0;
      while (taken < n) {
        const v = await src.q.next();
        if (isPush(v)) {
          out.q.push(v);
          taken++;
        } else {
          out.q.push(DONE);
          return { tag: "VUnit" };
        }
      }
      out.q.push(DONE);
      return { tag: "VUnit" };
    });
    return out;
  });
  def("streamFold", async (args) => {
    const src = asStream(args[0], "streamFold"), f = args[2];
    let acc = args[1];
    for (; ; ) {
      const v = await src.q.next();
      if (isPush(v))
        acc = await ev.applyFn(f, [acc, v.payload], "streamFold");
      else
        return acc;
    }
  });
  def("streamMerge", async (args) => {
    const a = asStream(args[0], "streamMerge"), b = asStream(args[1], "streamMerge");
    const out = { tag: "VStream", name: `${a.name}+${b.name}`, q: new VStreamQueue() };
    let live = 2;
    const drainInto = (src) => ev.sched.spawn(async () => {
      for (; ; ) {
        const v = await src.q.next();
        if (isPush(v))
          out.q.push(v);
        else {
          if (--live === 0)
            out.q.push(DONE);
          return { tag: "VUnit" };
        }
      }
    });
    drainInto(a);
    drainInto(b);
    return out;
  });
  def("streamDebounce", async (args) => {
    const src = asStream(args[0], "streamDebounce"), ms = num(args[1]);
    const out = { tag: "VStream", name: `${src.name}.debounce`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let pending = void 0;
      for (; ; ) {
        if (pending === void 0) {
          const v = await src.q.next();
          if (isPush(v))
            pending = v;
          else {
            out.q.push(DONE);
            return { tag: "VUnit" };
          }
        } else {
          const v = await src.q.nextWithin(ms, ev.sched);
          if (v === void 0) {
            out.q.push(pending);
            pending = void 0;
          } else if (isPush(v))
            pending = v;
          else {
            out.q.push(pending);
            out.q.push(DONE);
            return { tag: "VUnit" };
          }
        }
      }
    });
    return out;
  });
  def("streamThrottle", async (args) => {
    const src = asStream(args[0], "streamThrottle"), ms = num(args[1]);
    const out = { tag: "VStream", name: `${src.name}.throttle`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let lastEmit = -Infinity;
      for (; ; ) {
        const v = await src.q.next();
        if (isPush(v)) {
          const now = ev.sched.now();
          if (now - lastEmit >= ms) {
            out.q.push(v);
            lastEmit = now;
          }
        } else {
          out.q.push(DONE);
          return { tag: "VUnit" };
        }
      }
    });
    return out;
  });
  def("filter", async (args) => {
    const f = args[0], list = toList(args[1]);
    const out = [];
    for (const v of list)
      if (bool(await ev.applyFn(f, [v], "filter")))
        out.push(v);
    return { tag: "VList", elems: out };
  });
  def("foldl", async (args) => {
    const f = args[0];
    let acc = args[1];
    for (const v of toList(args[2]))
      acc = await ev.applyFn(f, [acc, v], "foldl");
    return acc;
  });
  def("foldr", async (args) => {
    const f = args[0];
    let acc = args[1];
    for (const v of [...toList(args[2])].reverse())
      acc = await ev.applyFn(f, [v, acc], "foldr");
    return acc;
  });
  def("forEach", async (args) => {
    const f = args[0], list = toList(args[1]);
    for (const v of list)
      await ev.applyFn(f, [v], "forEach");
    return { tag: "VUnit" };
  });
  def("flatMap", async (args) => {
    const f = args[0], list = toList(args[1]);
    const out = [];
    for (const v of list)
      out.push(...toList(await ev.applyFn(f, [v], "flatMap")));
    return { tag: "VList", elems: out };
  });
  def("any", async (args) => {
    const f = args[0], list = toList(args[1]);
    for (const v of list)
      if (bool(await ev.applyFn(f, [v], "any")))
        return { tag: "VBool", v: true };
    return { tag: "VBool", v: false };
  });
  def("all", async (args) => {
    const f = args[0], list = toList(args[1]);
    for (const v of list)
      if (!bool(await ev.applyFn(f, [v], "all")))
        return { tag: "VBool", v: false };
    return { tag: "VBool", v: true };
  });
  def("sortBy", async (args) => {
    const f = args[0], list = [...toList(args[1])];
    for (let i = 1; i < list.length; i++) {
      const x = list[i];
      let j = i - 1;
      while (j >= 0 && num(await ev.applyFn(f, [list[j], x], "sortBy")) > 0) {
        list[j + 1] = list[j];
        j--;
      }
      list[j + 1] = x;
    }
    return { tag: "VList", elems: list };
  });
  def("sleep", async (args) => {
    await ev.sleep(num(args[0]));
    return { tag: "VUnit" };
  });
  def("journalOf", (args) => ({ tag: "VList", elems: ev.journalOf(str(args[0])).map((s) => ({ tag: "VStr", v: s })) }));
  def("crash", (args) => {
    throw new SagaCrashSignal(args[0] ? str(args[0]) : "crashed");
  });
  DICT_RT.map = { tag: "VBuiltin", name: "Dict.map", fn: async (args) => {
    const f = args[1], next = /* @__PURE__ */ new Map();
    for (const [ck, [k, v]] of dictEntries(args[0]))
      next.set(ck, [k, await ev.applyFn(f, [v], "Dict.map")]);
    return { tag: "VDict", entries: next };
  } };
  DICT_RT.filter = { tag: "VBuiltin", name: "Dict.filter", fn: async (args) => {
    const f = args[1], next = /* @__PURE__ */ new Map();
    for (const [ck, [k, v]] of dictEntries(args[0]))
      if (bool(await ev.applyFn(f, [v], "Dict.filter")))
        next.set(ck, [k, v]);
    return { tag: "VDict", entries: next };
  } };
  SET_RT.map = { tag: "VBuiltin", name: "Set.map", fn: async (args) => {
    const f = args[1], next = /* @__PURE__ */ new Map();
    for (const x of setElems(args[0]).values()) {
      const y = await ev.applyFn(f, [x], "Set.map");
      next.set(dictKey(y), y);
    }
    return { tag: "VSet", elems: next };
  } };
  SET_RT.filter = { tag: "VBuiltin", name: "Set.filter", fn: async (args) => {
    const f = args[1], next = /* @__PURE__ */ new Map();
    for (const [k, x] of setElems(args[0]))
      if (bool(await ev.applyFn(f, [x], "Set.filter")))
        next.set(k, x);
    return { tag: "VSet", elems: next };
  } };
}
function velveToJs(v) {
  switch (v.tag) {
    case "VNum":
      return v.v;
    case "VStr":
      return v.v;
    case "VBool":
      return v.v;
    case "VUnit":
      return null;
    case "VList":
      return v.elems.map(velveToJs);
    case "VTuple":
      return v.elems.map(velveToJs);
    case "VRecord":
      return Object.fromEntries([...v.fields.entries()].map(([k, val]) => [k, velveToJs(val)]));
    case "VCtor":
      return v.payload ? { _tag: v.name, value: velveToJs(v.payload) } : { _tag: v.name };
    default:
      return void 0;
  }
}
function jsToVelve(v) {
  if (v === null || v === void 0)
    return { tag: "VUnit" };
  if (typeof v === "number")
    return { tag: "VNum", v };
  if (typeof v === "string")
    return { tag: "VStr", v };
  if (typeof v === "boolean")
    return { tag: "VBool", v };
  if (Array.isArray(v))
    return { tag: "VList", elems: v.map(jsToVelve) };
  if (typeof v === "object") {
    const fields = /* @__PURE__ */ new Map();
    for (const [k, val] of Object.entries(v))
      fields.set(k, jsToVelve(val));
    return { tag: "VRecord", fields };
  }
  return { tag: "VStr", v: String(v) };
}
var STRING_RT = {
  split: builtin("split", (args) => ({ tag: "VList", elems: str(args[0]).split(str(args[1])).map((s) => ({ tag: "VStr", v: s })) })),
  join: builtin("join", (args) => {
    const elems = args[0]?.tag === "VList" ? args[0].elems : [];
    return { tag: "VStr", v: elems.map((v) => v.tag === "VStr" ? v.v : display(v)).join(str(args[1])) };
  }),
  length: builtin("length", (args) => ({ tag: "VNum", v: str(args[0]).length })),
  trim: builtin("trim", (args) => ({ tag: "VStr", v: str(args[0]).trim() })),
  trimStart: builtin("trimStart", (args) => ({ tag: "VStr", v: str(args[0]).trimStart() })),
  trimEnd: builtin("trimEnd", (args) => ({ tag: "VStr", v: str(args[0]).trimEnd() })),
  startsWith: builtin("startsWith", (args) => ({ tag: "VBool", v: str(args[0]).startsWith(str(args[1])) })),
  endsWith: builtin("endsWith", (args) => ({ tag: "VBool", v: str(args[0]).endsWith(str(args[1])) })),
  includes: builtin("includes", (args) => ({ tag: "VBool", v: str(args[0]).includes(str(args[1])) })),
  indexOf: builtin("indexOf", (args) => ({ tag: "VNum", v: str(args[0]).indexOf(str(args[1])) })),
  slice: builtin("slice", (args) => ({ tag: "VStr", v: str(args[0]).slice(num(args[1]), num(args[2])) })),
  sliceFrom: builtin("sliceFrom", (args) => ({ tag: "VStr", v: str(args[0]).slice(num(args[1])) })),
  replace: builtin("replace", (args) => ({ tag: "VStr", v: str(args[0]).replace(str(args[1]), str(args[2])) })),
  replaceAll: builtin("replaceAll", (args) => ({ tag: "VStr", v: str(args[0]).replaceAll(str(args[1]), str(args[2])) })),
  toUpper: builtin("toUpper", (args) => ({ tag: "VStr", v: str(args[0]).toUpperCase() })),
  toLower: builtin("toLower", (args) => ({ tag: "VStr", v: str(args[0]).toLowerCase() })),
  chars: builtin("chars", (args) => ({ tag: "VList", elems: [...str(args[0])].map((c) => ({ tag: "VStr", v: c })) })),
  repeat: builtin("repeat", (args) => ({ tag: "VStr", v: str(args[0]).repeat(num(args[1])) })),
  padStart: builtin("padStart", (args) => ({ tag: "VStr", v: str(args[0]).padStart(num(args[1]), str(args[2])) })),
  padEnd: builtin("padEnd", (args) => ({ tag: "VStr", v: str(args[0]).padEnd(num(args[1]), str(args[2])) })),
  fromNumber: builtin("fromNumber", (args) => ({ tag: "VStr", v: String(num(args[0])) })),
  toNumber: builtin("toNumber", (args) => {
    const n = parseFloat(str(args[0]));
    return isNaN(n) ? { tag: "VCtor", name: "Error", payload: { tag: "VStr", v: "not a number" } } : { tag: "VCtor", name: "Ok", payload: { tag: "VNum", v: n } };
  }),
  isEmpty: builtin("isEmpty", (args) => ({ tag: "VBool", v: str(args[0]).length === 0 })),
  lines: builtin("lines", (args) => ({ tag: "VList", elems: str(args[0]).split("\n").map((s) => ({ tag: "VStr", v: s })) }))
};
var MATH_RT = {
  floor: builtin("floor", (args) => ({ tag: "VNum", v: Math.floor(num(args[0])) })),
  ceil: builtin("ceil", (args) => ({ tag: "VNum", v: Math.ceil(num(args[0])) })),
  round: builtin("round", (args) => ({ tag: "VNum", v: Math.round(num(args[0])) })),
  abs: builtin("abs", (args) => ({ tag: "VNum", v: Math.abs(num(args[0])) })),
  sqrt: builtin("sqrt", (args) => ({ tag: "VNum", v: Math.sqrt(num(args[0])) })),
  cbrt: builtin("cbrt", (args) => ({ tag: "VNum", v: Math.cbrt(num(args[0])) })),
  pow: builtin("pow", (args) => ({ tag: "VNum", v: Math.pow(num(args[0]), num(args[1])) })),
  max: builtin("max", (args) => ({ tag: "VNum", v: Math.max(num(args[0]), num(args[1])) })),
  min: builtin("min", (args) => ({ tag: "VNum", v: Math.min(num(args[0]), num(args[1])) })),
  clamp: builtin("clamp", (args) => ({ tag: "VNum", v: Math.min(Math.max(num(args[0]), num(args[1])), num(args[2])) })),
  log: builtin("log", (args) => ({ tag: "VNum", v: Math.log(num(args[0])) })),
  log2: builtin("log2", (args) => ({ tag: "VNum", v: Math.log2(num(args[0])) })),
  log10: builtin("log10", (args) => ({ tag: "VNum", v: Math.log10(num(args[0])) })),
  exp: builtin("exp", (args) => ({ tag: "VNum", v: Math.exp(num(args[0])) })),
  sin: builtin("sin", (args) => ({ tag: "VNum", v: Math.sin(num(args[0])) })),
  cos: builtin("cos", (args) => ({ tag: "VNum", v: Math.cos(num(args[0])) })),
  tan: builtin("tan", (args) => ({ tag: "VNum", v: Math.tan(num(args[0])) })),
  asin: builtin("asin", (args) => ({ tag: "VNum", v: Math.asin(num(args[0])) })),
  acos: builtin("acos", (args) => ({ tag: "VNum", v: Math.acos(num(args[0])) })),
  atan: builtin("atan", (args) => ({ tag: "VNum", v: Math.atan(num(args[0])) })),
  atan2: builtin("atan2", (args) => ({ tag: "VNum", v: Math.atan2(num(args[0]), num(args[1])) })),
  sign: builtin("sign", (args) => ({ tag: "VNum", v: Math.sign(num(args[0])) })),
  trunc: builtin("trunc", (args) => ({ tag: "VNum", v: Math.trunc(num(args[0])) })),
  isNaN: builtin("isNaN", (args) => ({ tag: "VBool", v: isNaN(num(args[0])) })),
  isFinite: builtin("isFinite", (args) => ({ tag: "VBool", v: isFinite(num(args[0])) })),
  pi: { tag: "VNum", v: Math.PI },
  e: { tag: "VNum", v: Math.E },
  random: builtin("random", (_args) => ({ tag: "VNum", v: Math.random() }))
};
function dictEntries(v) {
  if (v?.tag === "VDict")
    return v.entries;
  throw new RuntimeError(`expected Dict, got ${v ? display(v) : "nothing"}`);
}
function mkDict(entries) {
  return { tag: "VDict", entries };
}
var SOME = (v) => ({ tag: "VCtor", name: "Some", payload: v });
var NONE = { tag: "VCtor", name: "None", payload: null };
var DICT_RT = {
  empty: builtin("empty", (_args) => mkDict(/* @__PURE__ */ new Map())),
  get: builtin("get", (args) => {
    const e = dictEntries(args[0]).get(dictKey(args[1]));
    return e ? SOME(e[1]) : NONE;
  }),
  getOr: builtin("getOr", (args) => {
    const e = dictEntries(args[0]).get(dictKey(args[1]));
    return e ? e[1] : args[2];
  }),
  set: builtin("set", (args) => {
    const next = new Map(dictEntries(args[0]));
    next.set(dictKey(args[1]), [args[1], args[2]]);
    return mkDict(next);
  }),
  delete: builtin("delete", (args) => {
    const next = new Map(dictEntries(args[0]));
    next.delete(dictKey(args[1]));
    return mkDict(next);
  }),
  has: builtin("has", (args) => ({ tag: "VBool", v: dictEntries(args[0]).has(dictKey(args[1])) })),
  keys: builtin("keys", (args) => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k]) => k) })),
  values: builtin("values", (args) => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([, v]) => v) })),
  entries: builtin("entries", (args) => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k, v]) => ({ tag: "VTuple", elems: [k, v] })) })),
  size: builtin("size", (args) => ({ tag: "VNum", v: dictEntries(args[0]).size })),
  isEmpty: builtin("isEmpty", (args) => ({ tag: "VBool", v: dictEntries(args[0]).size === 0 })),
  toList: builtin("toList", (args) => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k, v]) => ({ tag: "VTuple", elems: [k, v] })) })),
  fromList: builtin("fromList", (args) => {
    const next = /* @__PURE__ */ new Map();
    const list = args[0]?.tag === "VList" ? args[0].elems : [];
    for (const pair of list) {
      if (pair.tag === "VTuple" && pair.elems.length >= 2)
        next.set(dictKey(pair.elems[0]), [pair.elems[0], pair.elems[1]]);
    }
    return mkDict(next);
  }),
  merge: builtin("merge", (args) => {
    const next = new Map(dictEntries(args[0]));
    for (const [k, kv] of dictEntries(args[1]))
      next.set(k, kv);
    return mkDict(next);
  })
};
function setElems(v) {
  if (v?.tag === "VSet")
    return v.elems;
  throw new RuntimeError(`expected Set, got ${v ? display(v) : "nothing"}`);
}
function mkSet(elems) {
  return { tag: "VSet", elems };
}
var SET_RT = {
  empty: builtin("empty", (_args) => mkSet(/* @__PURE__ */ new Map())),
  add: builtin("add", (args) => {
    const next = new Map(setElems(args[0]));
    next.set(dictKey(args[1]), args[1]);
    return mkSet(next);
  }),
  remove: builtin("remove", (args) => {
    const next = new Map(setElems(args[0]));
    next.delete(dictKey(args[1]));
    return mkSet(next);
  }),
  has: builtin("has", (args) => ({ tag: "VBool", v: setElems(args[0]).has(dictKey(args[1])) })),
  size: builtin("size", (args) => ({ tag: "VNum", v: setElems(args[0]).size })),
  isEmpty: builtin("isEmpty", (args) => ({ tag: "VBool", v: setElems(args[0]).size === 0 })),
  toList: builtin("toList", (args) => ({ tag: "VList", elems: [...setElems(args[0]).values()] })),
  fromList: builtin("fromList", (args) => {
    const next = /* @__PURE__ */ new Map();
    const list = args[0]?.tag === "VList" ? args[0].elems : [];
    for (const x of list)
      next.set(dictKey(x), x);
    return mkSet(next);
  }),
  union: builtin("union", (args) => {
    const next = new Map(setElems(args[0]));
    for (const [k, x] of setElems(args[1]))
      next.set(k, x);
    return mkSet(next);
  }),
  intersect: builtin("intersect", (args) => {
    const b = setElems(args[1]), next = /* @__PURE__ */ new Map();
    for (const [k, x] of setElems(args[0]))
      if (b.has(k))
        next.set(k, x);
    return mkSet(next);
  }),
  difference: builtin("difference", (args) => {
    const b = setElems(args[1]), next = /* @__PURE__ */ new Map();
    for (const [k, x] of setElems(args[0]))
      if (!b.has(k))
        next.set(k, x);
    return mkSet(next);
  })
};
var OK = (v) => ({ tag: "VCtor", name: "Ok", payload: v });
var ERR = (m) => ({ tag: "VCtor", name: "Error", payload: { tag: "VStr", v: m } });
var JSON_RT = {
  parse: builtin("parse", (args) => {
    try {
      return OK(jsToVelve(JSON.parse(str(args[0]))));
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "invalid JSON");
    }
  }),
  stringify: builtin("stringify", (args) => ({ tag: "VStr", v: JSON.stringify(velveToJs(args[0])) ?? "null" })),
  prettyPrint: builtin("prettyPrint", (args) => ({ tag: "VStr", v: JSON.stringify(velveToJs(args[0]), null, num(args[1])) ?? "null" }))
};
var IO_RT = {
  readFile: builtin("readFile", async (args) => {
    try {
      return OK({ tag: "VStr", v: await (await loadFs()).readFile(str(args[0]), "utf8") });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "read failed");
    }
  }),
  writeFile: builtin("writeFile", async (args) => {
    try {
      await (await loadFs()).writeFile(str(args[0]), str(args[1]));
      return OK({ tag: "VUnit" });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "write failed");
    }
  }),
  appendFile: builtin("appendFile", async (args) => {
    try {
      await (await loadFs()).appendFile(str(args[0]), str(args[1]));
      return OK({ tag: "VUnit" });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "append failed");
    }
  }),
  deleteFile: builtin("deleteFile", async (args) => {
    try {
      await (await loadFs()).unlink(str(args[0]));
      return OK({ tag: "VUnit" });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "delete failed");
    }
  }),
  exists: builtin("exists", async (args) => {
    try {
      await (await loadFs()).access(str(args[0]));
      return { tag: "VBool", v: true };
    } catch {
      return { tag: "VBool", v: false };
    }
  }),
  readDir: builtin("readDir", async (args) => {
    try {
      return OK({ tag: "VList", elems: (await (await loadFs()).readdir(str(args[0]))).map((n) => ({ tag: "VStr", v: n })) });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "readDir failed");
    }
  }),
  mkdir: builtin("mkdir", async (args) => {
    try {
      await (await loadFs()).mkdir(str(args[0]), { recursive: true });
      return OK({ tag: "VUnit" });
    } catch (e) {
      return ERR(e instanceof Error ? e.message : "mkdir failed");
    }
  }),
  cwd: builtin("cwd", (_args) => ({ tag: "VStr", v: typeof process !== "undefined" ? process.cwd() : "/" })),
  env: builtin("env", (args) => {
    const val = typeof process !== "undefined" ? process.env[str(args[0])] : void 0;
    return val === void 0 ? { tag: "VCtor", name: "None", payload: null } : SOME({ tag: "VStr", v: val });
  })
};
var DURATION_RT = {
  // Durations are ms numbers at runtime, so the conversions are identities
  // (fromSeconds scales to ms). The type checker enforces the Number/Duration line.
  fromMs: builtin("fromMs", (args) => ({ tag: "VNum", v: num(args[0]) })),
  fromSeconds: builtin("fromSeconds", (args) => ({ tag: "VNum", v: num(args[0]) * 1e3 })),
  toMs: builtin("toMs", (args) => ({ tag: "VNum", v: num(args[0]) }))
};
var STDLIB_RUNTIME = {
  "Duration": DURATION_RT,
  "duration": DURATION_RT,
  "std/Duration": DURATION_RT,
  "std/duration": DURATION_RT,
  "String": STRING_RT,
  "string": STRING_RT,
  "std/String": STRING_RT,
  "std/string": STRING_RT,
  "Math": MATH_RT,
  "math": MATH_RT,
  "std/Math": MATH_RT,
  "std/math": MATH_RT,
  "Dict": DICT_RT,
  "dict": DICT_RT,
  "std/Dict": DICT_RT,
  "std/dict": DICT_RT,
  "Set": SET_RT,
  "set": SET_RT,
  "std/Set": SET_RT,
  "std/set": SET_RT,
  "Json": JSON_RT,
  "json": JSON_RT,
  "std/Json": JSON_RT,
  "std/json": JSON_RT,
  "io": IO_RT,
  "std/io": IO_RT
};
function num(v) {
  if (v?.tag === "VNum")
    return v.v;
  throw new RuntimeError(`expected Number, got ${v ? display(v) : "nothing"}`);
}
function str(v) {
  if (v?.tag === "VStr")
    return v.v;
  throw new RuntimeError(`expected String, got ${v ? display(v) : "nothing"}`);
}
function bool(v) {
  if (v?.tag === "VBool")
    return v.v;
  throw new RuntimeError(`expected Bool, got ${v ? display(v) : "nothing"}`);
}
function isFailure(v) {
  return v.tag === "VCtor" && (v.name === "Error" || v.name === "None");
}
function failurePayload(v) {
  return v.tag === "VCtor" && v.payload !== null ? v.payload : v;
}

// dist/browser.js
var domEvent = (e) => e.replace(/^on/, "").toLowerCase();
var childVals = (v) => {
  const out = [];
  for (const c of v.children) {
    if (c.tag === "VList")
      out.push(...c.elems);
    else if (c.tag !== "VUnit")
      out.push(c);
  }
  return out;
};
var elemChildren = (v) => childVals(v).filter((c) => c.tag === "VElement");
var combinedText = (v) => (v.text ? asText(v.text) : "") + childVals(v).filter((c) => c.tag !== "VElement").map(asText).join("");
var keyOf2 = (v) => {
  if (v.tag !== "VElement")
    return null;
  const k = v.props.get("id") ?? v.props.get("key");
  return k && k.tag === "VStr" ? k.v : null;
};
function eventRecord(domEv, el) {
  const t = domEv?.target ?? el;
  return { tag: "VRecord", fields: /* @__PURE__ */ new Map([
    ["value", { tag: "VStr", v: String(t?.value ?? "") }],
    ["key", { tag: "VStr", v: String(domEv?.key ?? "") }],
    ["checked", { tag: "VBool", v: !!t?.checked }]
  ]) };
}
function buildDom(v, doc, ev, onEvent) {
  if (v.tag !== "VElement")
    return doc.createTextNode(asText(v));
  const el = doc.createElement(tagFor(v.name));
  if (!isKnownTag(v.name))
    el.setAttribute("data-component", v.name);
  const fd = flexDir(v.name);
  if (fd) {
    el.style.setProperty("display", "flex");
    el.style.setProperty("flex-direction", fd);
  }
  for (const [k, val] of v.props) {
    if (k === "key")
      continue;
    const s = unitToCss(val) ?? asText(val);
    const css = propToCss(k, s);
    if (css)
      el.style.setProperty(css[0], css[1]);
    else
      el.setAttribute(k, s);
  }
  for (const [event, thunk] of v.events) {
    el.addEventListener(domEvent(event), async (domEv) => {
      await ev.applyFn(thunk, [eventRecord(domEv, el)], "event");
      await ev.settle();
      await onEvent();
    });
  }
  const kids = childVals(v);
  if (kids.some((c) => c.tag === "VElement")) {
    if (v.text)
      el.appendChild(doc.createTextNode(asText(v.text)));
    for (const c of kids)
      el.appendChild(buildDom(c, doc, ev, onEvent));
  } else {
    const t = combinedText(v);
    if (t)
      el.textContent = t;
  }
  return el;
}
function patchDom(dom, oldV, newV, doc, ev, onEvent) {
  if (oldV.tag !== "VElement" || newV.tag !== "VElement") {
    if (oldV.tag !== "VElement" && newV.tag !== "VElement") {
      if (asText(oldV) !== asText(newV))
        dom.textContent = asText(newV);
      return dom;
    }
    const nd = buildDom(newV, doc, ev, onEvent);
    dom.replaceWith(nd);
    return nd;
  }
  if (oldV.name !== newV.name) {
    const nd = buildDom(newV, doc, ev, onEvent);
    dom.replaceWith(nd);
    return nd;
  }
  const sv = (val) => unitToCss(val) ?? asText(val);
  for (const [k, val] of newV.props) {
    if (k === "key")
      continue;
    const o = oldV.props.get(k);
    const s = sv(val);
    if (o === void 0 || sv(o) !== s) {
      const css = propToCss(k, s);
      if (css)
        dom.style.setProperty(css[0], css[1]);
      else
        dom.setAttribute(k, s);
    }
  }
  for (const k of oldV.props.keys())
    if (k !== "key" && !newV.props.has(k)) {
      const css = propToCss(k, "");
      if (css)
        dom.style.removeProperty(css[0]);
      else
        dom.removeAttribute(k);
    }
  const oldKids = elemChildren(oldV), newKids = elemChildren(newV);
  if (newKids.length === 0) {
    const t = combinedText(newV);
    if (dom.textContent !== t)
      dom.textContent = t;
    return dom;
  }
  const allKeyed = (xs) => xs.length > 0 && xs.every((x) => keyOf2(x) !== null);
  if (allKeyed(oldKids) && allKeyed(newKids)) {
    const domByKey = /* @__PURE__ */ new Map();
    oldKids.forEach((c, i) => domByKey.set(keyOf2(c), dom.children[i]));
    const oldByKey = new Map(oldKids.map((c) => [keyOf2(c), c]));
    for (const [key, dnode] of domByKey)
      if (!newKids.some((c) => keyOf2(c) === key))
        dnode.remove();
    newKids.forEach((c, i) => {
      const key = keyOf2(c);
      const prevV = oldByKey.get(key);
      const ref = dom.children[i] || null;
      if (!prevV) {
        dom.insertBefore(buildDom(c, doc, ev, onEvent), ref);
        return;
      }
      const node = patchDom(domByKey.get(key), prevV, c, doc, ev, onEvent);
      if (dom.children[i] !== node)
        dom.insertBefore(node, dom.children[i] || null);
    });
  } else {
    const n = Math.min(oldKids.length, newKids.length);
    for (let i = 0; i < n; i++)
      patchDom(dom.children[i], oldKids[i], newKids[i], doc, ev, onEvent);
    for (let i = n; i < newKids.length; i++)
      dom.appendChild(buildDom(newKids[i], doc, ev, onEvent));
    while (dom.children.length > newKids.length)
      dom.children[dom.children.length - 1].remove();
  }
  return dom;
}
function captureFocus(doc) {
  const a = doc.activeElement;
  if (!a || a === doc.body || !a.id)
    return null;
  return { id: a.id, start: a.selectionStart ?? null, end: a.selectionEnd ?? null };
}
function restoreFocus(doc, snap) {
  if (!snap)
    return;
  const next = doc.getElementById(snap.id);
  if (!next || doc.activeElement === next)
    return;
  next.focus?.();
  if (snap.start != null && next.setSelectionRange) {
    try {
      next.setSelectionRange(snap.start, snap.end ?? snap.start);
    } catch {
    }
  }
}
function captureScroll(doc) {
  const m = /* @__PURE__ */ new Map();
  for (const el of doc.querySelectorAll?.("[id]") ?? [])
    if (el.scrollTop || el.scrollLeft)
      m.set(el.id, [el.scrollTop, el.scrollLeft]);
  return m;
}
function restoreScroll(doc, m) {
  for (const [id, [t, l]] of m) {
    const el = doc.getElementById(id);
    if (el) {
      el.scrollTop = t;
      el.scrollLeft = l;
    }
  }
}
async function mountLive(rootEl, ev, viewName, doc) {
  const view = ev.global(viewName);
  if (!view)
    throw new Error(`mountLive: no '${viewName}' binding in module`);
  let tree = await ev.converge(await ev.applyFn(view, [], viewName));
  let dom;
  const rerender = async () => {
    const focus = captureFocus(doc);
    const scroll = captureScroll(doc);
    const next = await ev.converge(await ev.applyFn(view, [], viewName));
    dom = patchDom(dom, tree, next, doc, ev, rerender);
    tree = next;
    restoreScroll(doc, scroll);
    restoreFocus(doc, focus);
  };
  dom = buildDom(tree, doc, ev, rerender);
  rootEl.appendChild(dom);
  return { root: dom, rerender };
}
function hydrateDom(dom, vel, ev, onEvent) {
  if (vel.tag !== "VElement")
    return;
  for (const [event, thunk] of vel.events)
    dom.addEventListener(domEvent(event), async (domEv) => {
      await ev.applyFn(thunk, [eventRecord(domEv, dom)], "event");
      await ev.settle();
      await onEvent();
    });
  const velKids = elemChildren(vel);
  const domKids = dom.children;
  const n = Math.min(velKids.length, domKids.length);
  for (let i = 0; i < n; i++)
    hydrateDom(domKids[i], velKids[i], ev, onEvent);
}
async function hydrate(rootEl, ev, viewName, doc) {
  const view = ev.global(viewName);
  if (!view)
    throw new Error(`hydrate: no '${viewName}' binding in module`);
  let tree = await ev.converge(await ev.applyFn(view, [], viewName));
  let dom = rootEl.firstElementChild ?? rootEl.children?.[0];
  if (!dom)
    return mountLive(rootEl, ev, viewName, doc);
  const rerender = async () => {
    const focus = captureFocus(doc);
    const scroll = captureScroll(doc);
    const next = await ev.converge(await ev.applyFn(view, [], viewName));
    dom = patchDom(dom, tree, next, doc, ev, rerender);
    tree = next;
    restoreScroll(doc, scroll);
    restoreFocus(doc, focus);
  };
  hydrateDom(dom, tree, ev, rerender);
  return { root: dom, rerender };
}
export {
  Evaluator,
  hydrate,
  mountLive
};
