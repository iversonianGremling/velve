; ── Keywords ──────────────────────────────────────────────────────────────────

[
  "def"
  "type"
  "store"
  "module"
  "import"
  "from"
  "pub"
] @keyword

[
  "match"
  "if"
  "else"
] @keyword.conditional

[
  "fn"
  "lazy"
] @keyword.function

[
  "mut"
  "extern"
] @keyword.modifier

[
  "send"
  "ask"
  "transaction"
  "within"
] @keyword.coroutine

(break_expr) @keyword.return

(continue_expr) @keyword.return

[
  "state"
  "messages"
  "migrate"
  "version"
  "capabilities"
  "on"
] @keyword.directive

; ── Declarations ──────────────────────────────────────────────────────────────

(function_def
  (lower_id) @function)

; Unified call: a lowercase head is a function call, an uppercase head an
; ADT/element construction. The `.` anchors the match to the callee (first child),
; so argument identifiers aren't highlighted as callees.
(call . (identifier_expr (lower_id) @function.call))

(store_def
  (upper_id) @type)

(module_def
  (lower_id) @module)

(import_stmt
  (import_name) @module)

; ── Types ─────────────────────────────────────────────────────────────────────

(type_def
  (upper_id) @type.definition)

(simple_type
  (upper_id) @type)

(parameterized_type
  (upper_id) @type)

(type_var) @type.parameter

(adt_variant
  (upper_id) @type.enum.variant)

(call . (identifier_expr (upper_id) @type.enum.variant))

; ── Patterns ──────────────────────────────────────────────────────────────────

(simple_pattern
  (upper_id) @type.enum.variant)

(qualified_pattern
  (upper_id) @type.enum.variant)

; ── Variables and identifiers ─────────────────────────────────────────────────

(identifier_expr
  (lower_id) @variable)

(binding
  (lower_id) @variable.declaration)

(destructure
  (lower_id) @variable.declaration)

(param
  (lower_id) @variable.parameter)

(record_field
  (lower_id) @variable.member)

(pub_field
  (lower_id) @variable.member)

(state_field
  (lower_id) @variable.member)

(field_access
  (lower_id) @variable.member)

; ── Messages (ADT-like constructors in stores) ────────────────────────────────

(message_def
  (upper_id) @constructor)

(send_expr
  (upper_id) @constructor)

(ask_expr
  (upper_id) @constructor)

; ── Literals ──────────────────────────────────────────────────────────────────

(literal
  (number) @number)

(literal
  (bool) @boolean)

(literal
  (unit) @constant.builtin)

(string) @string

(multiline_string) @string

(hex_color) @string.special

; ── Comments ──────────────────────────────────────────────────────────────────

(comment) @comment @spell

; ── Operators ─────────────────────────────────────────────────────────────────

[
  "+"
  "-"
  "++"
  "*"
  "/"
  "%"
  "^"
  "&"
  "=="
  "!="
  "<"
  ">"
  "<="
  ">="
  "<<"
  ">>"
  "&&"
  "||"
  "!"
  "xor"
  "not"
] @operator

[
  "|>"
  "->"
  "?"
] @operator.special

[
  "="
  ":"
] @punctuation.delimiter

[
  "("
  ")"
  "["
  "]"
  "{"
  "}"
] @punctuation.bracket

[
  ","
  "."
  "..."
] @punctuation.delimiter

; ── Escape blocks ─────────────────────────────────────────────────────────────

(js_block) @embedded

(unsafe_block) @danger

(comptime_block) @attribute

(kernel_block) @attribute

; ── Decorators ────────────────────────────────────────────────────────────────

(decorator) @attribute

; ── Effects / capabilities ────────────────────────────────────────────────────

(effect_type
  (lower_id) @keyword.coroutine)

(capabilities_decl
  (lower_id) @keyword.coroutine)

; ── Optional chain ────────────────────────────────────────────────────────────

(optional_chain) @operator.special

; ── is ───────────────────────────────────────────────────────────────────────

"is" @keyword.operator

; ── For expressions ──────────────────────────────────────────────────────────

"for" @keyword

; ── Where / constraints ──────────────────────────────────────────────────────

"where" @keyword.directive

(where_stmt
  (lower_id) @variable.parameter
  (upper_id) @type)

; ── Atom literals ────────────────────────────────────────────────────────────
; Value atoms (:idle, :ok) use the idiomatic symbol capture — themes give this a
; distinct colour (cf. Ruby symbols / Elixir atoms). Saga step *labels*
; (:done, :abort as step definitions / goto targets) override to @label below.

(atom_lit) @string.special.symbol

; ── Ranges ───────────────────────────────────────────────────────────────────

[".." "..="] @operator.special

; ── Loop ─────────────────────────────────────────────────────────────────────

["loop"] @keyword.repeat

; ── Blocks / error handling ──────────────────────────────────────────────────

["pipe" "try" "retry" "drop"] @keyword

; ── Machine / Saga ───────────────────────────────────────────────────────────

["machine" "saga" "over"] @keyword

(saga_expr
  (upper_id) @type)

; First-class saga: `saga Checkout(..) : T over Store`
(saga_def
  (upper_id) @type)

(over_clause
  (upper_id) @type)

(saga_step
  (atom_lit) @label)

(step_goto
  (atom_lit) @label)

(step_inline
  (atom_lit) @label)

(rollback_stmt
  (atom_lit) @label)

; The ?/?: rollback operators read as operators, not as the atom's leading ':'.
(rollback_stmt
  ["?" "?:"] @keyword.operator)

["go" "race" "after" "until"] @keyword.coroutine

"rollback" @keyword

(duration_lit) @number

; ── Function signature ────────────────────────────────────────────────────────

(function_sig
  (lower_id) @function)

; ── Await ─────────────────────────────────────────────────────────────────────

"await" @keyword.coroutine

; ── Tuple literals ────────────────────────────────────────────────────────────

(tuple_literal) @punctuation.bracket
