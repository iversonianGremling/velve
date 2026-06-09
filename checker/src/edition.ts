// Editions (SPEC §17) — dated language epochs that let the surface syntax change
// without a flag day. A module opts in with an `@edition "YYYY.M"` pragma on its
// first line; lower/infer/eval branch behavior on the resolved edition. The core
// AST is edition-agnostic — editions differ only in the frontend (surface syntax
// + lowering), so modules on different editions still interoperate.
//
// Naming is date-based (year.month), Rust-style ordered epochs:
//   2026.1 — BASELINE: the language as it stands pre-refactor (the implicit default
//            for any file without a pragma, so existing code keeps compiling).
//   2026.6 — the surface-consistency refactor (Outcome rename, for…in, no ternary,
//            glued ?/?:, #{} records, …). Opt in with `@edition "2026.6"`.

export type Edition = "2026.1" | "2026.6";

// Ordered oldest→newest. Index in this list is the comparison key.
export const EDITIONS: Edition[] = ["2026.1", "2026.6"];

export const BASELINE: Edition = "2026.1";
export const LATEST: Edition = "2026.6";

// A file with no `@edition` pragma resolves to this. Pinned to BASELINE during the
// migration so the existing corpus keeps compiling untouched; flip to LATEST once
// everything is migrated.
export const DEFAULT_EDITION: Edition = BASELINE;

export function isEdition(s: string): s is Edition {
  return (EDITIONS as string[]).includes(s);
}

// Resolve a raw pragma string (already stripped of quotes) to an Edition, or null
// if unrecognized (caller emits a diagnostic and falls back to DEFAULT_EDITION).
export function parseEdition(raw: string): Edition | null {
  return isEdition(raw) ? raw : null;
}

// `a` is at least as new as `b` (edition-gating predicate: `atLeast(ed, "2026.6")`).
export function atLeast(a: Edition, b: Edition): boolean {
  return EDITIONS.indexOf(a) >= EDITIONS.indexOf(b);
}
