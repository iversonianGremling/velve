// Velve standard library type registry.
// Maps module path aliases → exported name → type Scheme.
// Imported via `import String { split, join }` or `import io from "std/io"`.

import type { Type } from "./types.js";
import { freshVar } from "./types.js";

interface Scheme { forall: number[]; type: Type }

function mono(t: Type): Scheme { return { forall: [], type: t }; }
function poly(ids: number[], t: Type): Scheme { return { forall: ids, type: t }; }
function fn(params: Type[], ret: Type): Type { return { tag: "Fn", params, ret, effects: [] }; }

// ── Type aliases ──────────────────────────────────────────────────────────────

const str: Type  = { tag: "Prim", kind: "String" };
const num: Type  = { tag: "Prim", kind: "Number" };
const bool: Type = { tag: "Prim", kind: "Bool" };
const unit: Type = { tag: "Prim", kind: "Unit" };

function listOf(t: Type): Type  { return { tag: "Named", name: "List",   args: [t] }; }
function optOf(t: Type): Type   { return { tag: "Named", name: "Option", args: [t] }; }
function resOf(ok: Type, e: Type): Type { return { tag: "Named", name: "Result", args: [ok, e] }; }
// Use the canonical Async variant ({tag:"Async"}), not a Named "Async" — the
// inferrer and `await`'s unwrap match on `tag === "Async"`, so a Named form
// would never unwrap (io results would stay `Async(Result)` after `await`).
function asyncOf(t: Type): Type { return { tag: "Async", inner: t }; }
function dictOf(k: Type, v: Type): Type { return { tag: "Named", name: "Dict", args: [k, v] }; }
function setOf(t: Type): Type { return { tag: "Named", name: "Set", args: [t] }; }
function tupleOf(...ts: Type[]): Type { return { tag: "Tuple", elems: ts }; }

// A colour is an OKLCH record { l, c, h } (lightness 0–1, chroma, hue 0–360).
const colorT: Type = { tag: "Record", fields: [
  { name: "l", type: num, optional: false },
  { name: "c", type: num, optional: false },
  { name: "h", type: num, optional: false },
] };

// ── Modules ───────────────────────────────────────────────────────────────────

function makeStringModule(): Record<string, Scheme> {
  return {
    split:      mono(fn([str, str], listOf(str))),
    join:       mono(fn([listOf(str), str], str)),
    length:     mono(fn([str], num)),
    trim:       mono(fn([str], str)),
    trimStart:  mono(fn([str], str)),
    trimEnd:    mono(fn([str], str)),
    startsWith: mono(fn([str, str], bool)),
    endsWith:   mono(fn([str, str], bool)),
    includes:   mono(fn([str, str], bool)),
    indexOf:    mono(fn([str, str], num)),
    slice:      mono(fn([str, num, num], str)),
    sliceFrom:  mono(fn([str, num], str)),
    replace:    mono(fn([str, str, str], str)),
    replaceAll: mono(fn([str, str, str], str)),
    toUpper:    mono(fn([str], str)),
    toLower:    mono(fn([str], str)),
    chars:      mono(fn([str], listOf(str))),
    repeat:     mono(fn([str, num], str)),
    padStart:   mono(fn([str, num, str], str)),
    padEnd:     mono(fn([str, num, str], str)),
    fromNumber: mono(fn([num], str)),
    toNumber:   mono(fn([str], resOf(num, str))),
    isEmpty:    mono(fn([str], bool)),
    lines:      mono(fn([str], listOf(str))),
  };
}

function makeMathModule(): Record<string, Scheme> {
  return {
    floor:  mono(fn([num], num)),
    ceil:   mono(fn([num], num)),
    round:  mono(fn([num], num)),
    abs:    mono(fn([num], num)),
    sqrt:   mono(fn([num], num)),
    cbrt:   mono(fn([num], num)),
    pow:    mono(fn([num, num], num)),
    max:    mono(fn([num, num], num)),
    min:    mono(fn([num, num], num)),
    clamp:  mono(fn([num, num, num], num)),
    log:    mono(fn([num], num)),
    log2:   mono(fn([num], num)),
    log10:  mono(fn([num], num)),
    exp:    mono(fn([num], num)),
    sin:    mono(fn([num], num)),
    cos:    mono(fn([num], num)),
    tan:    mono(fn([num], num)),
    asin:   mono(fn([num], num)),
    acos:   mono(fn([num], num)),
    atan:   mono(fn([num], num)),
    atan2:  mono(fn([num, num], num)),
    sign:   mono(fn([num], num)),
    trunc:  mono(fn([num], num)),
    isNaN:  mono(fn([num], bool)),
    isFinite: mono(fn([num], bool)),
    pi:     mono(num),
    e:      mono(num),
    random: mono(fn([], num)),
  };
}

function makeDictModule(): Record<string, Scheme> {
  const k = freshVar("k"), v = freshVar("v"), v2 = freshVar("v2");
  return {
    empty:    poly([k.id, v.id], fn([], dictOf(k, v))),
    get:      poly([k.id, v.id], fn([dictOf(k, v), k], optOf(v))),
    getOr:    poly([k.id, v.id], fn([dictOf(k, v), k, v], v)),
    set:      poly([k.id, v.id], fn([dictOf(k, v), k, v], dictOf(k, v))),
    delete:   poly([k.id, v.id], fn([dictOf(k, v), k], dictOf(k, v))),
    has:      poly([k.id, v.id], fn([dictOf(k, v), k], bool)),
    keys:     poly([k.id, v.id], fn([dictOf(k, v)], listOf(k))),
    values:   poly([k.id, v.id], fn([dictOf(k, v)], listOf(v))),
    entries:  poly([k.id, v.id], fn([dictOf(k, v)], listOf(tupleOf(k, v)))),
    size:     poly([k.id, v.id], fn([dictOf(k, v)], num)),
    isEmpty:  poly([k.id, v.id], fn([dictOf(k, v)], bool)),
    fromList: poly([k.id, v.id], fn([listOf(tupleOf(k, v))], dictOf(k, v))),
    toList:   poly([k.id, v.id], fn([dictOf(k, v)], listOf(tupleOf(k, v)))),
    map:      poly([k.id, v.id, v2.id], fn([dictOf(k, v), fn([v], v2)], dictOf(k, v2))),
    filter:   poly([k.id, v.id], fn([dictOf(k, v), fn([v], bool)], dictOf(k, v))),
    merge:    poly([k.id, v.id], fn([dictOf(k, v), dictOf(k, v)], dictOf(k, v))),
  };
}

function makeSetModule(): Record<string, Scheme> {
  const a = freshVar("a"), b = freshVar("b");
  return {
    empty:      poly([a.id], fn([], setOf(a))),
    add:        poly([a.id], fn([setOf(a), a], setOf(a))),
    remove:     poly([a.id], fn([setOf(a), a], setOf(a))),
    has:        poly([a.id], fn([setOf(a), a], bool)),
    size:       poly([a.id], fn([setOf(a)], num)),
    isEmpty:    poly([a.id], fn([setOf(a)], bool)),
    toList:     poly([a.id], fn([setOf(a)], listOf(a))),
    fromList:   poly([a.id], fn([listOf(a)], setOf(a))),
    union:      poly([a.id], fn([setOf(a), setOf(a)], setOf(a))),
    intersect:  poly([a.id], fn([setOf(a), setOf(a)], setOf(a))),
    difference: poly([a.id], fn([setOf(a), setOf(a)], setOf(a))),
    map:        poly([a.id, b.id], fn([setOf(a), fn([a], b)], setOf(b))),
    filter:     poly([a.id], fn([setOf(a), fn([a], bool)], setOf(a))),
  };
}

function makeJsonModule(): Record<string, Scheme> {
  const any: Type = { tag: "Unknown" };
  return {
    parse:     mono(fn([str], resOf(any, str))),
    stringify: mono(fn([any], str)),
    prettyPrint: mono(fn([any, num], str)),
  };
}

function makeIoModule(): Record<string, Scheme> {
  return {
    readFile:  mono(fn([str], asyncOf(resOf(str, str)))),
    writeFile: mono(fn([str, str], asyncOf(resOf(unit, str)))),
    appendFile: mono(fn([str, str], asyncOf(resOf(unit, str)))),
    deleteFile: mono(fn([str], asyncOf(resOf(unit, str)))),
    exists:    mono(fn([str], asyncOf(bool))),
    readDir:   mono(fn([str], asyncOf(resOf(listOf(str), str)))),
    mkdir:     mono(fn([str], asyncOf(resOf(unit, str)))),
    cwd:       mono(fn([], str)),
    env:       mono(fn([str], optOf(str))),
  };
}

const dur: Type = { tag: "Named", name: "Duration", args: [] };

function makeDurationModule(): Record<string, Scheme> {
  // Convert between raw Numbers (ms) and the dimensional `Duration` type. Runtime
  // is identity (durations are ms numbers); these just cross the type boundary.
  return {
    fromMs:      mono(fn([num], dur)),   // 250 → 250ms
    fromSeconds: mono(fn([num], dur)),   // 3   → 3s
    toMs:        mono(fn([dur], num)),   // 250ms → 250
  };
}

// ── Registry ──────────────────────────────────────────────────────────────────

// All aliases that resolve to each module.
// Colour: OKLCH construction, perceptual adjustment, harmony, gamut cusp, APCA.
// Data-first so it pipes: `oklch(0.55,0.17,262) |> complement |> toHex`.
function makeColorModule(): Record<string, Scheme> {
  return {
    // construct
    oklch: mono(fn([num, num, num], colorT)),   // lightness, chroma, hue
    hex:   mono(fn([str], colorT)),             // "#5b6ef0" → Color
    gray:  mono(fn([num], colorT)),             // a neutral at lightness l
    // adjust (perceptual: in OKLCH, so steps look even)
    lighten:    mono(fn([colorT, num], colorT)),
    darken:     mono(fn([colorT, num], colorT)),
    saturate:   mono(fn([colorT, num], colorT)),
    desaturate: mono(fn([colorT, num], colorT)),
    rotate:     mono(fn([colorT, num], colorT)), // shift hue by degrees
    // harmony (wheel relationships)
    complement:      mono(fn([colorT], colorT)),
    analogous:       mono(fn([colorT], listOf(colorT))),
    triad:           mono(fn([colorT], listOf(colorT))),
    tetrad:          mono(fn([colorT], listOf(colorT))),
    splitComplement: mono(fn([colorT], listOf(colorT))),
    // mix + perception
    mix:       mono(fn([colorT, colorT, num], colorT)), // perceptual blend (OKLab)
    cusp:      mono(fn([colorT], colorT)),              // most-saturated form of the hue
    contrast:  mono(fn([colorT, colorT], num)),         // APCA Lc (text, bg)
    legibleOn: mono(fn([colorT], colorT)),              // the readable fg for a bg
    // output — per target. Color is canonical/perceptual (OKLCH); these encode it.
    toHex:    mono(fn([colorT], str)),                       // web: "#rrggbb"
    css:      mono(fn([colorT], str)),                       // web: "oklch(L C H)"
    toLinear: mono(fn([colorT], tupleOf(num, num, num))),    // GPU: linear-RGB floats 0–1
    // distance + scales + accessibility + terminal
    deltaE:      mono(fn([colorT, colorT], num)),            // perceptual distance (ΔEOK, OKLab)
    ramp:        mono(fn([colorT, num], listOf(colorT))),    // n tones dark→light, gamut-clamped
    shades:      mono(fn([colorT, num], listOf(colorT))),    // n steps darker (toward L=0.1)
    tints:       mono(fn([colorT, num], listOf(colorT))),    // n steps lighter (toward L=0.98)
    simulate:    mono(fn([colorT, str], colorT)),            // CVD simulation (proto/deuter/trit/achroma)
    nearestAnsi: mono(fn([colorT], num)),                    // index 0–15 of nearest ANSI colour
    // named hue constructors (values, seated at the hue's gamut cusp)
    rose:     mono(colorT),
    amber:    mono(colorT),
    lime:     mono(colorT),
    emerald:  mono(colorT),
    teal:     mono(colorT),
    cyan:     mono(colorT),
    azure:    mono(colorT),
    indigo:   mono(colorT),
    violet:   mono(colorT),
    plum:     mono(colorT),
  };
}

const MODULE_ALIASES: Record<string, () => Record<string, Scheme>> = {
  // Color
  "Color":     makeColorModule,
  "color":     makeColorModule,
  "std/Color": makeColorModule,
  "std/color": makeColorModule,
  // String
  "String": makeStringModule,
  "string": makeStringModule,
  "std/String": makeStringModule,
  "std/string": makeStringModule,
  // Math
  "Math": makeMathModule,
  "math": makeMathModule,
  "std/Math": makeMathModule,
  "std/math": makeMathModule,
  // Dict
  "Dict": makeDictModule,
  "dict": makeDictModule,
  "std/Dict": makeDictModule,
  "std/dict": makeDictModule,
  // Set
  "Set": makeSetModule,
  "set": makeSetModule,
  "std/Set": makeSetModule,
  "std/set": makeSetModule,
  // Json
  "Json":     makeJsonModule,
  "json":     makeJsonModule,
  "JSON":     makeJsonModule,
  "std/json": makeJsonModule,
  "std/Json": makeJsonModule,
  // IO
  "io":     makeIoModule,
  "IO":     makeIoModule,
  "std/io": makeIoModule,
  "std/IO": makeIoModule,
  // Duration
  "Duration":     makeDurationModule,
  "duration":     makeDurationModule,
  "std/Duration": makeDurationModule,
  "std/duration": makeDurationModule,
};

// Look up the type scheme for a specific export from a module path.
// Returns null if the module or name is unknown (caller should fall back to Unknown).
export function stdlibLookup(modulePath: string, exportName: string): Scheme | null {
  const factory = MODULE_ALIASES[modulePath];
  if (!factory) return null;
  return factory()[exportName] ?? null;
}

// Returns all exports for a module, or null if the module is unknown.
export function stdlibModule(modulePath: string): Record<string, Scheme> | null {
  return MODULE_ALIASES[modulePath]?.() ?? null;
}

// AMBIENT module names: `Math.sqrt(x)` resolves with no import (SPEC §5.5) —
// the stdlib docs are written in qualified style. Only the capitalized,
// slash-free aliases are ambient; lowercase (`math`) and path forms
// (`std/math`) stay import-only so the no-import surface is exactly the
// documented spelling. User bindings shadow these: every consumer falls back
// to this set only after a normal lookup fails.
export const STDLIB_MODULE_NAMES: ReadonlySet<string> = new Set(
  Object.keys(MODULE_ALIASES).filter(k => !k.includes("/") && /^[A-Z]/.test(k)));
