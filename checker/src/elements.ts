// ── Built-in view-DSL primitives ─────────────────────────────────────────────────
// The closed set of primitive element names (Row/Column/Text/Button/…). This is the
// SINGLE SOURCE OF TRUTH for "is this Uppercase head an element?", shared by:
//   • the lowerer — a paren-form call `Text("hi")` whose head is a primitive lowers
//     to an `Element` node, not a `Call` (call-syntax §2.1; ADT constructors like
//     `Ok(x)` stay calls). Capitalization is the cue; this set splits element heads
//     from data-constructor heads, since both are Uppercase and grammatically
//     identical in paren-form.
//   • the checker — prop schemas, layout-context validity, and required-prop checks
//     key off `PRIMITIVE_MODE`.
//
// These names are RESERVED: a user ADT constructor may not shadow a primitive
// (e.g. `type T = Text | …` then `Text(x)` would be ambiguous). No corpus does this.

// Layout mode drives context-dependent prop validity (§9.5): CONTAINER props
// (gap/align/justify) need a flex/grid element; FLEX-ITEM props need a flex parent.
export type LayoutMode = "flex" | "block" | "leaf";

export const PRIMITIVE_MODE: Record<string, LayoutMode> = {
  Row: "flex", Column: "flex", Stack: "flex", Grid: "flex",
  Box: "block", Card: "block", Scroll: "block", List: "block", Item: "block",
  Text: "leaf", Heading: "leaf", Label: "leaf", Button: "leaf", Link: "leaf",
  Image: "leaf", Canvas: "leaf", Input: "leaf", Slider: "leaf",
  Spacer: "leaf", Divider: "leaf",
};

// The element-name set, derived from PRIMITIVE_MODE so the two never drift.
export const PRIMITIVE_ELEMENTS: ReadonlySet<string> = new Set(Object.keys(PRIMITIVE_MODE));
