// ── Shared colour science (OKLCH / APCA) ──────────────────────────────────────
// Single source of truth for the `std/color` maths, used by BOTH the runtime
// (eval.ts `COLOR_RT`) and the compile-time fold (infer.ts `constEval`, theme
// design-note Slice 3). Keeping one implementation is load-bearing: the §4.3
// accessibility-as-proof guarantee is only honest if a *derived* role
// (`toHex(legibleOn(accent))`) folds at check time to the exact hex the runtime
// would compute — a divergence would make the compiler prove a contrast the
// program doesn't actually render. Hence: no duplicated maths.
//
// A colour is an `LCH` triple `[L, C, H]` (OKLCH: lightness 0–1, chroma ≥0,
// hue 0–360). `lch()` is the canonical constructor — it clamps chroma to ≥0 and
// wraps hue into [0,360), exactly as the runtime `mkColor` does, so triples
// compare identically on both sides.

export type LCH = [number, number, number];

export function lch(l: number, c: number, h: number): LCH {
  return [l, Math.max(0, c), ((h % 360) + 360) % 360];
}

// OKLCH → linear sRGB (the Björn Ottosson matrices).
export function oklchRaw3(L: number, C: number, H: number): LCH {
  const h = H * Math.PI / 180, a = C * Math.cos(h), b = C * Math.sin(h);
  const l = (L + 0.3963377774*a + 0.2158037573*b)**3, m = (L - 0.1055613458*a - 0.0638541728*b)**3, s = (L - 0.0894841775*a - 1.2914855480*b)**3;
  return [4.0767416621*l - 3.3077115913*m + 0.2309699292*s, -1.2684380046*l + 2.6097574011*m - 0.3413193965*s, -0.0041960863*l - 0.7034186147*m + 1.7076147010*s];
}
const inGamut = (L: number, C: number, H: number) => { const [r,g,b] = oklchRaw3(L,C,H), e = 1e-4; return r>=-e&&r<=1+e&&g>=-e&&g<=1+e&&b>=-e&&b<=1+e; };
export const maxChroma = (L: number, H: number) => { let lo=0,hi=0.4; for (let i=0;i<20;i++){const m=(lo+hi)/2; inGamut(L,m,H)?lo=m:hi=m;} return lo; };
export function cusp(H: number): [number, number] { let best: [number, number] = [0.5,0]; for (let L=0.04;L<=0.99;L+=0.005){const C=maxChroma(L,H); if(C>best[1])best=[L,C];} return best; }
export const lin2srgbC = (c: number) => { c = Math.min(1, Math.max(0, c)); return c<=0.0031308? 12.92*c : 1.055*c**(1/2.4)-0.055; };
export const srgb2linC = (c: number) => c<=0.04045? c/12.92 : ((c+0.055)/1.055)**2.4;

export function oklchToHex(L: number, C: number, H: number): string {
  const hx = (x: number) => Math.round(Math.min(1, Math.max(0, x))*255).toString(16).padStart(2, "0");
  const lin = oklchRaw3(L,C,H);
  return "#" + hx(lin2srgbC(lin[0])) + hx(lin2srgbC(lin[1])) + hx(lin2srgbC(lin[2]));
}
export function hexToOklch3(hex: string): LCH {
  const mm = hex.replace("#","").match(/.{2}/g); if (!mm || mm.length < 3) return [0,0,0];
  const r = srgb2linC(parseInt(mm[0]!,16)/255), g = srgb2linC(parseInt(mm[1]!,16)/255), b = srgb2linC(parseInt(mm[2]!,16)/255);
  return linToOklch3(r, g, b);
}
// Inverse of oklchRaw3: LINEAR sRGB → OKLCH (cube-root LMS, then the OKLab matrix).
export function linToOklch3(r: number, g: number, b: number): LCH {
  const l = Math.cbrt(0.4122214708*r+0.5363325363*g+0.0514459929*b), n = Math.cbrt(0.2119034982*r+0.6806995451*g+0.1073969566*b), s = Math.cbrt(0.0883024619*r+0.2817188376*g+0.6299787005*b);
  const L = 0.2104542553*l+0.7936177850*n-0.0040720468*s, A = 1.9779984951*l-2.4285922050*n+0.4505937099*s, B = 0.0259040371*l+0.7827717662*n-0.8086757660*s;
  let H = Math.atan2(B,A)*180/Math.PI; if (H < 0) H += 360; return [L, Math.hypot(A,B), H];
}
// Perceptual distance: OKLab Euclidean (ΔEOK). lch args are [L,C,H].
export function deltaEOK(p: LCH, q: LCH): number {
  const lab = (x: LCH): LCH => [x[0], x[1]*Math.cos(x[2]*Math.PI/180), x[1]*Math.sin(x[2]*Math.PI/180)];
  const a = lab(p), b = lab(q);
  return Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);
}
// APCA Lc magnitude over OKLCH triples (text on background), via linear light.
export function apcaTriple(txt: LCH, bg: LCH): number {
  const Y = (l: LCH) => { const g = oklchRaw3(l[0],l[1],l[2]); return 0.2126*lin2srgbC(g[0])**2.4 + 0.7152*lin2srgbC(g[1])**2.4 + 0.0722*lin2srgbC(g[2])**2.4; };
  let Yt = Y(txt), Yb = Y(bg); const cl = (y: number) => y < 0.022 ? y + (0.022 - y)**1.414 : y; Yt = cl(Yt); Yb = cl(Yb);
  let Lc; if (Yb > Yt) { const S = (Yb**0.56 - Yt**0.57)*1.14; Lc = S < 0.1 ? 0 : (S - 0.027)*100; }
          else        { const S = (Yb**0.65 - Yt**0.62)*1.14; Lc = S > -0.1 ? 0 : (S + 0.027)*100; }
  return Math.abs(Lc);
}

// ── Derived roles (pure LCH → LCH) — the theme-construction primitives ─────────
export const cGray    = (l: number): LCH => lch(l, 0, 0);
export const cLighten = (c: LCH, n: number): LCH => lch(c[0]+n, c[1], c[2]);
export const cDarken  = (c: LCH, n: number): LCH => lch(c[0]-n, c[1], c[2]);
export const cSaturate   = (c: LCH, n: number): LCH => lch(c[0], c[1]+n, c[2]);
export const cDesaturate = (c: LCH, n: number): LCH => lch(c[0], c[1]-n, c[2]);
export const cRotate     = (c: LCH, n: number): LCH => lch(c[0], c[1], c[2]+n);
export const cComplement = (c: LCH): LCH => lch(c[0], c[1], c[2]+180);
export const cCusp = (c: LCH): LCH => { const [cl, cc] = cusp(c[2]); return lch(cl, cc, c[2]); };
export function cMix(a: LCH, b: LCH, t: number): LCH {
  const lab = (L: number, C: number, H: number): LCH => [L, C*Math.cos(H*Math.PI/180), C*Math.sin(H*Math.PI/180)];
  const [La,Aa,Ba] = lab(a[0],a[1],a[2]), [Lb,Ab,Bb] = lab(b[0],b[1],b[2]);
  const L = La+(Lb-La)*t, A = Aa+(Ab-Aa)*t, B = Ba+(Bb-Ba)*t;
  let H = Math.atan2(B,A)*180/Math.PI; if (H < 0) H += 360; return lch(L, Math.hypot(A,B), H);
}
// The readable foreground for a background: black or white (at the bg's hue),
// whichever wins on APCA. This is what makes a theme correct-by-construction.
export function cLegibleOn(bg: LCH): LCH {
  const black: LCH = [0.15, 0, bg[2]], white: LCH = [0.98, 0, bg[2]];
  const pick = apcaTriple(black, bg) >= apcaTriple(white, bg) ? black : white;
  return lch(pick[0], pick[1], pick[2]);
}
// n steps toward a target lightness, hue kept, chroma gamut-clamped.
function towards(c: LCH, target: number, n: number): LCH[] {
  const steps = Math.max(1, Math.round(n)); const out: LCH[] = [];
  for (let i = 1; i <= steps; i++) { const L = c[0] + (target - c[0]) * (i / steps); out.push(lch(L, Math.min(c[1], maxChroma(L, c[2])), c[2])); }
  return out;
}
export const cShades = (c: LCH, n: number): LCH[] => towards(c, 0.1, n);
export const cTints  = (c: LCH, n: number): LCH[] => towards(c, 0.98, n);
export function cRamp(c: LCH, n: number): LCH[] {
  const steps = Math.max(1, Math.round(n)); const out: LCH[] = [];
  for (let i = 0; i < steps; i++) { const L = steps === 1 ? 0.55 : 0.15 + (0.95 - 0.15) * (i / (steps - 1)); out.push(lch(L, Math.min(c[1], maxChroma(L, c[2])), c[2])); }
  return out;
}

// ── The built-in read-only theme root (theme-design Slice 4) ─────────────────
// `theme` is a read-only reactive root (styles-design §9.1) — like `viewport`,
// anything may depend on `theme.*`, nothing writes back. Its default roles are
// DERIVED from two base surfaces via the same pure ops the runtime and the
// compile-time fold use, so `theme.text` folds at check time to the exact hex
// the runtime renders (the Slice 3 fold==runtime invariant, now for the root).
// `text`/`onAccent` are `legibleOn` the surfaces they sit on → the active theme
// is correct-by-construction on the §4.3 axis, proven against `theme.panel`.
const hexOf = (c: LCH): string => oklchToHex(c[0], c[1], c[2]);
const _panel: LCH  = lch(0.21, 0.02, 264);   // near-black panel surface
const _accent: LCH = lch(0.62, 0.17, 262);   // brand blue accent surface
export const DEFAULT_THEME: { readonly [role: string]: string } = {
  panel:    hexOf(_panel),
  text:     hexOf(cLegibleOn(_panel)),        // readable fg for the panel
  accent:   hexOf(_accent),
  onAccent: hexOf(cLegibleOn(_accent)),       // readable fg for the accent
};
