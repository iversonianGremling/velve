/**
 * @file Velve grammar for tree-sitter
 * @author Vela
 * @license MIT
 */

/// <reference types="tree-sitter-cli/dsl" />
// @ts-check

// Reserved keywords (single source of truth). Used both to seed the global
// reserved set AND to re-admit those words as member names after `.`/`?.` —
// otherwise a field whose name collides with a keyword (`x.after`, `x.state`,
// `x.type`) is unreachable, since the lexer would tokenize it as the keyword.
const RESERVED_WORDS = [
  'def', 'type', 'store', 'module', 'match', 'responsive', 'if', 'then', 'else',
  'send', 'ask', 'transaction', 'within', 'import',
  'from', 'as', 'pub', 'mut', 'state', 'messages', 'where',
  'is', 'true', 'false', 'not', 'xor', 'lazy',
  'capabilities', 'migrate', 'version', 'extern',
  'break', 'continue', 'fn', 'on',
  'let', 'const', 'loop', 'for',
  'machine', 'saga', 'go', 'race', 'rollback', 'after', 'until',
  'await', 'over', 'resume', 'drop', 'pipe', 'try', 'retry',
  'persisted',
];

export default grammar({
  name: 'velve',

  extras: $ => [
    /[ \t\r\n]/,
    $.comment,
  ],

  externals: $ => [
    $._indent,
    $._dedent,
    $._newline,
    $.triple_quote_string,
    $._string_content,
  ],

  word: $ => $.lower_id,

  reserved: {
    global: $ => RESERVED_WORDS,
  },

  // tree-sitter reads each inner array HIGHEST → LOWEST (first = binds tightest).
  precedences: $ => [
    [
      'postfix',
      'unary',
      'power',
      'multiplicative',
      'additive',
      'bitwise_shift',
      'bitwise',
      'comparative',
      'logical',
      'range',
      'pipe',
      'ternary',
      'lambda',
    ],
  ],

  conflicts: $ => [
    [$.identifier_expr, $.call],
    [$.simple_type, $.identifier_expr],
    [$.type_var, $.identifier_expr],
    [$.type_or_expr, $.grouped],
    [$.destructure, $.identifier_expr],
    [$.simple_pattern, $.simple_pattern],
    [$.binding_pattern, $.atom],
    [$._statement, $._expr],
    [$.block_binding, $.binding],
    [$.block_binding, $.lambda],
    [$.block_binding, $._expr],
    [$.pipe_match_stmt, $.pipe_expr],
    [$.pipe_lambda_stmt, $.pipe_expr],
    // element conflicts: an UpperId at statement/branch/child start could begin an
    // identifier expression / call or an element.
    [$.identifier_expr, $.element],
    [$.call, $.element],
    [$.identifier_expr, $.element_leaf],
    [$.call, $.element_leaf],
    [$.element, $.element_leaf],
    [$.atom, $.prop],
    // block `if` (newline body) vs inline `if c then a else b` — shared `if <expr>`
    // prefix, disambiguated by the token after the condition (newline vs `then`).
    [$.if_expr, $.if_then_expr],
    // lambda_simple conflicts
    [$.lambda_simple, $.binary_expr],
    [$.lambda_simple, $.pipe_expr],
    [$.lambda_simple, $.ternary_expr],
    [$.lambda_simple, $.field_access],
    [$.lambda_simple, $.optional_chain],
    [$.lambda_simple, $.array_index],
    [$.lambda_simple, $.type_test],
    [$.lambda_simple, $.call],
    [$.lambda_simple, $.propagate_expr],
    [$.lambda_simple, $.deref_expr],
    [$.lambda_simple, $.addr_of_expr],
    // propagate_expr ? vs ternary_expr ?
    [$.propagate_expr, $.ternary_expr],
    [$.unary_expr, $.ternary_expr, $.propagate_expr],
    [$.lazy_expr, $.ternary_expr, $.propagate_expr],
    [$.go_expr, $.ternary_expr, $.propagate_expr],
    [$.resume_expr, $.ternary_expr, $.propagate_expr],
    [$.drop_expr, $.ternary_expr, $.propagate_expr],
    [$.lambda_simple, $.ternary_expr, $.propagate_expr],
    [$.for_expr, $.ternary_expr],
    [$.retry_block, $.literal],
    [$.pipe_expr, $.ternary_expr, $.propagate_expr],
    [$.field_access, $.ternary_expr, $.propagate_expr],
    [$.optional_chain, $.ternary_expr, $.propagate_expr],
    [$.array_index, $.ternary_expr, $.propagate_expr],
    [$.call, $.ternary_expr, $.propagate_expr],
    [$.call, $.field_access],
    [$.identifier_expr, $.ternary_expr, $.propagate_expr],
    [$.type_test, $.ternary_expr, $.propagate_expr],
    [$.send_expr, $.ternary_expr, $.propagate_expr],
    [$.ask_expr, $.ternary_expr, $.propagate_expr],
    [$.deref_expr, $.ternary_expr, $.propagate_expr],
    // lifetime_of_type
    [$.lifetime_of_type, $.type_var],
    [$.lifetime_of_type, $.simple_type],
    // if_pattern_expr vs if_expr
    [$.if_pattern_expr, $.if_expr],
    // for_clause
    [$.for_clause, $.for_generator],
    [$.binary_expr, $.for_expr],
    [$.for_expr, $.ternary_expr, $.propagate_expr],
    [$.for_expr, $.propagate_expr],
    [$.for_expr, $.lambda_simple],
    [$.for_expr, $.pipe_expr],
    [$.for_expr, $.array_index],
    [$.for_expr, $.field_access],
    [$.for_expr, $.optional_chain],
    [$.for_expr, $.deref_expr],
    [$.for_expr, $.addr_of_expr],
    [$.for_expr, $.type_test],
    [$.for_expr, $.range_expr],
    // function_def single-line vs block
    [$.function_def],
    // function_sig vs function_def (both start with 'def lower_id (')
    [$.function_sig, $.function_def],
    [$.function_sig, $.param_list],
    [$.identifier_expr, $.pipe_expr],
    [$.identifier_expr, $.pipe_expr, $.pipe_lambda_call],
    [$._expr, $.pipe_expr],
    // where_stmt vs binding
    [$.where_stmt, $.binding],
    // match_branch | () vs unit literal
    [$.match_branch, $.unit],
    // guard_pattern
    [$.binary_expr, $.guard_pattern],
    // range_expr
    [$.range_expr, $.binary_expr],
    [$.range_expr, $.lambda_simple],
    [$.ternary_expr, $.range_expr, $.propagate_expr],
    // rollback_stmt vs propagate_expr (both start with _expr ?)
    [$.rollback_stmt, $.propagate_expr],
    [$.rollback_stmt, $.ternary_expr],
    [$.rollback_stmt, $.ternary_expr, $.propagate_expr],
    [$.rollback_stmt, $.binary_expr],
    // implicit_match vs expression statement (both start with _expr _newline)
    [$.implicit_match, $._expr],
    [$.implicit_match, $.binding],
    [$.implicit_match, $.match_expr],
    // step_goto vs expression statement (both can start with atom_lit)
    [$.step_goto, $._expr],
    [$.step_goto, $._statement],
    // saga_step vs _statement (step starts with atom_lit)
    [$.saga_step, $._statement],
    [$.saga_step, $._expr],
    // param pattern additions vs type/expr
    [$.param, $.simple_type],
    [$.param, $.identifier_expr],
    // until_stmt vs expression statement
    [$.until_stmt, $._expr],
    // function_sig type_var vs param lower_id
    [$.type_var, $.param],
    [$.step_goto, $.literal],
    [$.step_inline, $.literal],
    [$.step_inline, $._expr],
    // saga_branch | as statement vs binary | operator
    [$.saga_branch, $._expr],
    // await_stmt (with branches) vs await_expr (inline)
    [$.await_stmt, $.await_expr],
    // await_expr vs ternary/propagate (await expr ?)
    [$.ternary_expr, $.propagate_expr, $.await_expr],
    // tuple_literal (a, b) vs grouped (a)
    [$.tuple_literal, $.grouped],
    // element_content (Text "x" props) vs an Upper-headed call/identifier atom
    [$.atom, $.element_content],
  ],

  rules: {

    // ----------
    // Top level
    // ----------

    program: $ => seq(
      optional($.edition_pragma),
      repeat($.import_stmt),
      repeat($._declaration),
    ),

    // Edition pragma — opts a module into a dated language edition (Rust-style
    // editions, SPEC §17). Must be the first line of the file. Names are dates,
    // e.g. `@edition "2026.6"`. Read by the checker (lower/infer/eval), which gate
    // edition-specific semantics; absent → the project's pinned default edition.
    edition_pragma: $ => seq(
      token('@edition'),
      field('name', $.string),
      $._newline,
    ),

    comment: $ => token(seq('--', /.*/)),

    // ----------
    // Imports
    // ----------

    import_stmt: $ => choice(
      seq('import', $.lower_id, 'from', $.string, $._newline),
      seq('import', $.upper_id, 'from', $.string, $._newline),   // import String from "std/string"
      seq('import', '{', commaSep($.import_name), '}', 'from', $.string, $._newline),
      seq('import', 'js', $.string, 'as', $.lower_id, $._newline),
    ),

    import_name: $ => choice(
      $.lower_id,
      seq($.lower_id, 'as', $.lower_id),
      seq($.upper_id, 'as', $.upper_id),
    ),

    // ----------
    // Declarations
    // ----------

    _declaration: $ => choice(
      $.type_def,
      $.store_def,
      $.machine_def,
      $.saga_def,
      $.stream_def,
      $.inputmap_def,
      $.keymap_def,
      $.module_def,
      $.function_def,
      $.function_sig,
      $.binding,
      $.decorator_def,
      $.kernel_block,
    ),

    // First-class saga: a top-level persistent FSM with compensation.
    //   saga Checkout(cart: Cart): Result Receipt Error
    //     over CheckoutState        -- optional explicit backing store
    //     :reserve
    //       ...
    // Called like a function `Checkout(cart)` to run to completion, or spawned
    // as a live instance with `go Checkout(cart)` (yields a saga handle).
    saga_def: $ => seq(
      'saga',
      $.upper_id,
      optional(seq('(', commaSep($.param), ')')),
      ':',
      $._type,
      $._newline,
      $._indent,
      optional($.over_clause),
      repeat1($.saga_step),
      $._dedent,
    ),

    // Canonical first-class durable/compensating machine (was: saga).
    //   machine Checkout(stockOk: Bool, payOk: Bool): String persisted over CheckoutState
    // The `persisted` modifier unlocks the saga capabilities: durable journal,
    // `? rollback :step` compensation, crash/resume. `over Store` is the optional
    // explicit backing-store hatch; omit it and the machine auto-backs itself.
    machine_def: $ => seq(
      'machine',
      $.upper_id,
      optional(seq('(', commaSep($.param), ')')),
      ':',
      $._type,
      'persisted',
      optional(seq('over', $.upper_id)),
      $._newline,
      $._indent,
      repeat1($.saga_step),
      $._dedent,
    ),

    over_clause: $ => seq('over', $.upper_id, $._newline),

    // stream Name : T [policy] — declares a push-based async channel of type T.
    // The optional policy is the declaration-site backpressure rule (SPEC §10.1):
    // `drop` (lossy, deliver-or-discard), `buffer N` (bounded, evict oldest),
    // `block` (lossless, `send` suspends). Absent → unbounded buffer.
    stream_def: $ => seq(
      'stream',
      $.upper_id,
      ':',
      $._type,
      optional($.stream_policy),
      $._newline,
    ),

    // `drop` is already a reserved keyword; `buffer`/`block` stay CONTEXTUAL —
    // they lex as a plain lower_id here and the lowerer validates the word, so
    // neither is stolen from users as an identifier (a keyword would reserve it
    // globally — tree-sitter keyword extraction has no per-state fallback).
    stream_policy: $ => choice(
      'drop',
      seq($.lower_id, optional($.number)),
    ),

    // inputmap Name over Stream — a typed pattern-match over an input-event
    // stream, written as a table (multitarget-design §4.0). Each row maps a
    // pattern over the stream's event type to an action expression, with an
    // optional inline help label (the substrate for the auto-generated help
    // overlay). Semantics: the stream drain loop —
    //   await Stream | <pat> -> <action> | _ -> ()   (Done terminates the loop)
    // `inputmap` is a reserved keyword (like `machine`/`stream`); `over` was
    // already one (over_clause).
    inputmap_def: $ => seq(
      'inputmap',
      $.upper_id,
      'over',
      $.upper_id,
      $._newline,
      $._indent,
      repeat1($.inputmap_row),
      $._dedent,
    ),

    inputmap_row: $ => seq(
      $.pattern,
      '->',
      $._expr,
      optional(field('label', $.string)),
      $._newline,
    ),

    // keymap Name — sugar for `inputmap Name over Key` (multitarget §4.0:
    // "a keymap = inputmap over the keyboard"). The `Key` stream must be in
    // scope (declared, or from a Key device library once one ships).
    keymap_def: $ => seq(
      'keymap',
      $.upper_id,
      $._newline,
      $._indent,
      repeat1($.inputmap_row),
      $._dedent,
    ),

    // ----------
    // Types
    // ----------

    // Units of measure (B2): `Number unit m/s^2` — a dimension expression as a
    // flat sequence of signed factors. The first factor is positive; each later
    // factor's sign is the `*`/`/` that precedes it. `^<int>` is the exponent.
    // Lowered to a normalized atom→exponent vector; the solver never sees it.
    unit_clause:  $ => seq('unit', $.unit_factor, repeat(seq(choice('*', '/'), $.unit_factor))),
    unit_factor:  $ => seq($.lower_id, optional(seq('^', $.number))),

    type_def: $ => seq(
      'type',
      $.upper_id,
      repeat($.lower_id),
      choice(
        seq('=', 'extern', $.record_type, $._newline),
        seq('=', $._type, optional($.unit_clause), optional(seq('where', $._expr)), $._newline),
        seq(
          optional(seq('version', ':', $.number, $._newline)),
          $._newline,
          $._indent,
          repeat1($.adt_variant),
          $._dedent,
        ),
      ),
    ),

    adt_variant: $ => seq(
      choice('=', '|'),
      $.upper_id,
      optional($._type),
      $._newline,
    ),

    _type: $ => choice(
      $.simple_type,
      $.type_var,
      $.lifetime_var,
      $.lifetime_of_type,
      $.unit_type,
      $.parameterized_type,
      $.record_type,
      $.tuple_type,
      $.function_type,
      $.tainted_type,
      $.effect_type,
      $.async_type,
      $.array_type,
      $.result_type,
      $.pointer_type,
      $.atomic_type,
    ),

    simple_type: $ => $.upper_id,

    type_var: $ => $.lower_id,

    unit_type: $ => prec(1, '()'),

    parameterized_type: $ => prec(1, seq(
      $.upper_id,
      '(',
      commaSep1($.type_or_expr),
      ')',
    )),

    type_or_expr: $ => choice(
      $._type,
      $._expr,
    ),

    record_type: $ => seq(
      '{',
      commaSep1($.type_field),
      '}',
    ),

    type_field: $ => seq(
      $.lower_id,
      ':',
      $._type,
      optional(seq('align=', $.number)),
    ),

    tuple_type: $ => seq(
      '(',
      commaSep1($._type),
      ')',
    ),

    // Function-type ascription (row-variables-design S4a): `(A -> B)`,
    // n-ary `(A, B -> C)`, thunk `(() -> T)`. Parens are MANDATORY — a bare
    // `->` after a def's return type starts the single-line body
    // (`def idy(x: a): a -> x`), so an unparenthesized arrow type in that
    // slot would be ambiguous with the body arrow. Shares its `( type...`
    // prefix with tuple_type; they diverge at `->` vs `)`.
    function_type: $ => seq(
      '(',
      commaSep1($._type),
      '->',
      $._type,
      ')',
    ),

    tainted_type: $ => seq(
      'Tainted',
      choice(
        // `Tainted(T)` paren form — `token.immediate('(')` (no space) distinguishes
        // it from juxtaposition `Tainted T`, matching the unified `Name(args)` call
        // syntax. With a space, `Tainted (T)` still reads (T) as the juxtaposed type.
        seq(token.immediate('('), $._type, ')'),
        $._type,
      ),
    ),

    effect_type: $ => seq(
      'Effect',
      '[',
      commaSep1(choice($.lower_id, $.effect_tail)),
      ']',
      $._type,
    ),

    // `..e` — a user-spelled effect TAIL (row-variables E2): "plus whatever the
    // fn parameter(s) marked ..e charge at each call site". Spelled identically
    // in a def's own Effect clause and in an fn-type ascription's return slot
    // (`f: (String -> Effect [..e] String)`) — the shared name ties them.
    effect_tail: $ => seq('..', $.lower_id),

    async_type: $ => seq(
      'Async',
      choice(
        // `Async(T)` paren form (see tainted_type for the token.immediate rationale).
        seq(token.immediate('('), $._type, ')'),
        $._type,
      ),
    ),

    array_type: $ => seq(
      'Array',
      '(',
      $.type_or_expr,
      ',',
      $._type,
      ')',
    ),

    result_type: $ => seq(
      'Result',
      choice(
        // `Result(ok, err)` paren form — `token.immediate('(')` (no space) keeps it
        // distinct from juxtaposition `Result ok err`. Without this, `Result(A, B)`
        // parsed as `Result` applied to the tuple `(A, B)` and then hungrily ate the
        // following expression as the error type (turning a def into a signature).
        // The error slot (and ONLY that slot) admits `_` — the inferred error
        // row marker (error-rows-design S1): `Result Number _`.
        seq(token.immediate('('), $._type, ',', choice($._type, $.wildcard), ')'),
        seq($._type, choice($._type, $.wildcard)),
      ),
    ),

    pointer_type: $ => prec(2, seq(
      'Ptr',
      optional($.lifetime_var),
      $._type,
    )),

    lifetime_var: $ => /~[a-z][a-zA-Z0-9_]*/,

    lifetime_of_type: $ => prec(1, seq(
      choice($.lower_id, $.upper_id),
      '.~',
    )),

    lifetime_where: $ => seq(
      'where',
      repeat1(seq('(', $.lifetime_constraint, ')')),
    ),

    lifetime_constraint: $ => seq(
      $.lifetime_ref,
      choice('=', '>='),
      $.lifetime_ref,
    ),

    lifetime_ref: $ => choice(
      $.lifetime_var,
      $.lifetime_of_type,
    ),

    atomic_type: $ => seq(
      'Atomic',
      '(',
      $._type,
      ')',
    ),

    // ----------
    // Store definitions
    // ----------

    store_def: $ => seq(
      'store',
      $.upper_id,
      $._newline,
      $._indent,
      optional($.version_decl),
      optional($.migrate_block),
      $.state_block,
      $.messages_block,
      $.pub_block,
      $._dedent,
    ),

    version_decl: $ => seq(
      'version',
      ':',
      $.number,
      $._newline,
    ),

    migrate_block: $ => seq(
      'migrate',
      $._newline,
      $._indent,
      repeat1($.migrate_branch),
      $._dedent,
    ),

    migrate_branch: $ => seq(
      '|',
      $.lower_id,
      $.record_pattern,
      '->',
      $._expr,
      $._newline,
    ),

    state_block: $ => seq(
      'state',
      $._newline,
      $._indent,
      repeat1($.state_field),
      $._dedent,
    ),

    state_field: $ => seq(
      $.lower_id,
      ':',
      $._type,
      '=',
      $._expr,
      $._newline,
    ),

    messages_block: $ => seq(
      'messages',
      $._newline,
      $._indent,
      repeat1($.message_def),
      $._dedent,
    ),

    message_def: $ => seq(
      $.upper_id,
      optional(seq('(', commaSep1($.param), ')')),
      '->',
      choice(
        seq($._expr, $._newline),
        seq($._newline, $._indent, repeat1($._statement), $._dedent),
      ),
    ),

    pub_block: $ => seq(
      'pub',
      $._newline,
      $._indent,
      repeat1($.pub_field),
      $._dedent,
    ),

    pub_field: $ => seq(
      $.lower_id,
      optional(seq('=', $._expr)),
      $._newline,
    ),

    // ----------
    // Module definitions
    // ----------

    module_def: $ => seq(
      'module',
      $.lower_id,
      $._newline,
      $._indent,
      optional($.capabilities_decl),
      optional($.proofs_decl),
      repeat($._declaration),
      $._dedent,
    ),

    capabilities_decl: $ => seq(
      'capabilities',
      ':',
      '[',
      commaSep1($.lower_id),
      ']',
      $._newline,
    ),

    // The proof gradient's module scope (SPEC §12.7): obligations the module
    // promises, checked top-down — the dual of capabilities (effects flow up,
    // proofs flow down into every def the module contains).
    proofs_decl: $ => seq(
      'proofs',
      ':',
      '[',
      commaSep1($.lower_id),
      ']',
      $._newline,
    ),

    // A function-scope effect clause (SPEC §12.4): `effects: [payment, io]` at
    // the head of a body is sugar for the inline `Effect [payment, io] T`
    // return wrapper — the readable spelling for the concrete-row common case.
    // Same shape as `proofs_decl`; the inline form stays for HOF effect-tail
    // polymorphism (`Effect [..e]`), which a fixed list can't express.
    effects_decl: $ => seq(
      'effects',
      ':',
      '[',
      commaSep1($.lower_id),
      ']',
      $._newline,
    ),

    // ----------
    // Function definitions
    // ----------

    decorator_def: $ => seq(
      $.decorator,
      choice($.function_def, $.type_def),
    ),

    decorator: $ => seq(
      '@',
      $.lower_id,
      optional(seq(
        commaSep1($.decorator_arg),
      )),
      $._newline,
    ),

    decorator_arg: $ => seq(
      $.lower_id,
      '=',
      $._expr,
    ),

    // Type-only signature: def describe(Atom, Number): String
    function_sig: $ => seq(
      'def',
      $.lower_id,
      '(',
      commaSep($._type),
      ')',
      ':',
      $._type,
      $._newline,
    ),

    function_def: $ => choice(
      // block form
      seq(
        'def',
        $.lower_id,
        optional($.param_list),
        ':',
        $._type,
        optional($.using_clause),
        $._newline,
        $._indent,
        // Function-scope clause head, mirroring the module body head: the
        // up-flowing `effects: [...]` (like `capabilities:`) then the
        // down-flowing `proofs: [...]` (SPEC §12.4 / §12.7 A4). Both reuse the
        // module-scope productions verbatim.
        optional($.effects_decl),
        optional($.proofs_decl),
        repeat1($._statement),
        $._dedent,
      ),
      // single-line form: def foo(x: Number): Number -> x + 1
      seq(
        'def',
        $.lower_id,
        optional($.param_list),
        ':',
        $._type,
        optional($.using_clause),
        '->',
        $._expr,
        $._newline,
      ),
    ),

    // Explicit ambient-surface application on an element-returning function
    // (theme-design §2b). `using panel` applies a named Surface role; the inline
    // `using surface = <expr>` form declares-and-applies in one breath.
    using_clause: $ => seq(
      'using',
      $.lower_id,
      optional(seq('=', $._expr)),
    ),

    // where clause as first line(s) of body
    where_stmt: $ => seq(
      'where',
      commaSep1(choice(
        seq($.lower_id, ':', $.upper_id),
        seq('(', $.lifetime_constraint, ')'),
      )),
      $._newline,
    ),

    // params: typed, untyped, pattern (:atom), type-pattern (Rect), wildcard (_),
    // literal (0, true) for clause-head dispatch on a constant value
    param: $ => choice(
      seq($.lower_id, ':', $._type, '=', $._expr),   // n: Number = 0
      seq($.lower_id, '=', $._expr),                 // n = 0  (type inferred)
      seq($.lower_id, ':', $._type),
      $.lower_id,
      $.atom_lit,
      $.upper_id,
      $.wildcard,
      $.number,
      $.bool,
    ),

    // Function-signature parameter list. A bare `*` separator marks every
    // parameter after it keyword-only: def render(node, *, theme=Dark).
    param_list: $ => seq(
      '(',
      commaSep(choice($.param, $.kw_separator)),
      ')',
    ),

    kw_separator: $ => '*',

    // ----------
    // Statements
    // ----------

    _statement: $ => choice(
      $.binding,
      $.block_binding,
      $.index_assign,
      $.deref_assign,
      $.destructure,
      $.on_handler,
      $.pipe_block,
      $.try_block,
      $.retry_block,
      $.loop_expr,
      $.await_stmt,
      $.machine_expr,
      $.saga_expr,
      $.where_stmt,
      seq($._expr, $._newline),
      // Block expressions end with _dedent (no trailing _newline):
      $.if_expr,
      $.if_pattern_expr,
      $.match_expr,
      $.responsive_expr,
      $.transaction_expr,
      $.comptime_block,
      $.unsafe_block,
      $.pipe_match_stmt,
      $.pipe_lambda_stmt,
      $.element,
      $._newline,
    ),

    // Saga-specific statement set — superset of _statement.
    // Saga-only rules are ONLY valid here, keeping _indent from being
    // valid after expressions in regular function bodies.
    // saga_branch (| pattern -> ...) is valid directly here — go_stmt+
    // followed by saga_branch+ at the same level forms a parallel join.
    _saga_stmt: $ => choice(
      $.implicit_match,
      $.saga_branch,
      $.step_goto,
      $.rollback_stmt,
      $.after_stmt,
      $.until_stmt,
      $.race_block,
      $._statement,  // includes go_stmt
    ),

    binding: $ => seq(
      optional(choice('const', 'let', seq('let', 'mut'), 'mut')),
      $.lower_id,
      optional(seq(':', $._type)),
      '=',
      $._expr,
      $._newline,
    ),

    index_assign: $ => seq(
      $.array_index,
      '=',
      $._expr,
      $._newline,
    ),

    // write through a pointer: `p.* = v`
    deref_assign: $ => seq(
      $.deref_expr,
      '=',
      $._expr,
      $._newline,
    ),

    block_binding: $ => seq(
      optional(choice('const', 'let', seq('let', 'mut'), 'mut')),
      $.lower_id,
      optional(seq(':', $._type)),
      '=',
      choice(
        $.lambda_block,
        $.if_expr,
        $.match_expr,
        $.responsive_expr,
        $.transaction_expr,
        $.comptime_block,
        $.unsafe_block,
        $.pipe_block,
        $.try_block,
        $.retry_block,
        $.await_stmt,
        $.machine_expr,
        $.saga_expr,
      ),
    ),

    pipe_match_stmt: $ => prec.left('pipe', seq($._expr, '|>', $.pipe_match)),

    pipe_lambda_stmt: $ => prec.left('pipe', seq($._expr, '|>', $.pipe_lambda_call)),

    destructure: $ => seq(
      choice(
        seq('{', commaSep1($.lower_id), '}'),
        seq('(', commaSep1($.lower_id), ')'),
      ),
      '=',
      $._expr,
      $._newline,
    ),

    // ----------
    // Machine / Saga
    // ----------

    // Pure state machine — no store, no rollback
    machine_expr: $ => seq(
      'machine',
      $._newline,
      $._indent,
      repeat1($.saga_step),
      $._dedent,
    ),

    // State machine + store backing + rollback
    saga_expr: $ => seq(
      'saga',
      $.upper_id,
      $._newline,
      $._indent,
      repeat1($.saga_step),
      $._dedent,
    ),

    // :stepname args\n  body  OR  :stepname args -> expr
    saga_step: $ => choice(
      seq(
        $.atom_lit,
        repeat($.lower_id),
        $._newline,
        $._indent,
        repeat1($._saga_stmt),
        $._dedent,
      ),
      seq(
        $.atom_lit,
        repeat($.lower_id),
        '->',
        $._expr,
        $._newline,
      ),
    ),

    // after 30s — time signal (Timeout); standalone = sleep
    after_stmt: $ => seq(
      'after',
      $.duration_lit,
      $._newline,
    ),

    // until expr — condition signal (Cancelled); standalone = block until true
    until_stmt: $ => seq(
      'until',
      $._expr,
      $._newline,
    ),

    // race block — first go/after/until wins, single result
    race_block: $ => seq(
      'race',
      $._newline,
      $._indent,
      repeat1($.race_arm),
      $._dedent,
    ),

    race_arm: $ => choice(
      seq($.go_expr, $._newline),
      $.after_stmt,
      $.until_stmt,
    ),

    // Implicit match: expr\n  | branches (no 'match' keyword, for saga steps)
    implicit_match: $ => seq(
      $._expr,
      $._newline,
      $._indent,
      repeat1($.saga_branch),
      $._dedent,
    ),

    saga_branch: $ => choice(
      seq('|', $.pattern, '->', $._saga_branch_body),
      seq('|', '->', $._saga_branch_body),
    ),

    // Inline step transition (named so it can appear in conflicts): :reserve clean
    step_inline: $ => seq($.atom_lit, repeat($.atom)),

    // Branch body: inline step transition, expression, or block of saga statements
    _saga_branch_body: $ => choice(
      seq($.step_inline, $._newline),
      seq($._expr, $._newline),
      seq($._newline, $._indent, repeat1($._saga_stmt), $._dedent),
    ),

    // Step transition as statement: :reserve clean\n
    step_goto: $ => seq(
      $.atom_lit,
      repeat($.atom),
      $._newline,
    ),

    // Compensation: expr ? rollback :step  OR  expr ?: rollback :step
    rollback_stmt: $ => seq(
      $._expr,
      choice('?', '?:'),
      'rollback',
      $.atom_lit,
      $._newline,
    ),

    // Duration literal: 30s, 100ms, 5m, 1h
    duration_lit: $ => token(seq(/[0-9]+/, choice('ms', 's', 'm', 'h'))),

    // ----------
    // Expressions
    // ----------

    _expr: $ => choice(
      $.literal,
      $.identifier_expr,
      $.unary_expr,
      $.binary_expr,
      $.pipe_expr,
      $.ternary_expr,
      $.if_then_expr,
      $.field_access,
      $.optional_chain,
      $.array_index,
      $.deref_expr,
      $.addr_of_expr,
      $.propagate_expr,
      $.range_expr,
      $.if_pattern_expr,
      $.type_test,
      $.record_literal,
      $.record_spread,
      $.brace_block,
      $.list_literal,
      $.for_expr,
      $.match_expr,
      $.responsive_expr,
      $.if_expr,
      $.call,
      $.lambda,
      $.send_expr,
      $.ask_expr,
      $.transaction_expr,
      $.js_block,
      $.unsafe_block,
      $.comptime_block,
      $.lazy_expr,
      $.go_expr,
      $.resume_expr,
      $.drop_expr,
      $.break_expr,
      $.continue_expr,
      $.grouped,
      $.tuple_literal,
      $.await_expr,
    ),

    identifier_expr: $ => choice(
      $.lower_id,
      $.upper_id,
    ),

    unary_expr: $ => prec('unary', seq(
      choice('-', '!', 'not'),
      $._expr,
    )),

    binary_expr: $ => choice(
      prec.left('power',
        seq($._expr, '^', $._expr)),
      prec.left('multiplicative',
        seq($._expr, choice('*', '/', '%'), $._expr)),
      prec.left('additive',
        seq($._expr, choice('+', '-', '++'), $._expr)),
      prec.left('bitwise_shift',
        seq($._expr, choice('<<', '>>'), $._expr)),
      prec.left('bitwise',
        seq($._expr, choice('&', '|', 'xor'), $._expr)),
      prec.left('comparative',
        seq($._expr, choice('==', '!=', '<', '>', '<=', '>='), $._expr)),
      prec.left('logical',
        seq($._expr, choice('&&', '||'), $._expr)),
    ),

    pipe_expr: $ => prec.left('pipe', seq(
      $._expr,
      '|>',
      choice(
        $.pipe_lambda_call,
        $.call,
        $.lower_id,
        $.pipe_match,
        $.upper_id,
        $.send_expr,
        $.ask_expr,
        $.transaction_expr,
      ),
    )),

    pipe_lambda_call: $ => seq(
      $.lower_id,
      repeat($.atom),
      $.pipe_lambda_param,
      '->',
      $._branch_body,
    ),

    pipe_lambda_param: $ => choice(
      $.wildcard,
      $.binding_pattern,
      $.record_pattern,
    ),

    pipe_match: $ => seq(
      'match',
      $._newline,
      $._indent,
      repeat1($.match_branch),
      $._dedent,
    ),

    // Conditional operator: spaced `?` (`cond ? a : b`). Propagate uses a GLUED
    // `?` (`value?`, token.immediate below), so the two never collide: a space
    // before `?` ⇒ ternary, no space ⇒ propagate. Precedence then resolves
    // `a > b ? c : d` as `(a > b) ? c : d`.
    // DEPRECATED in edition 2026.6 → use `if c then a else b` (if_then_expr). The
    // rule stays in the superset grammar so 2026.1 keeps parsing; the lowerer warns
    // (2026.1) / errors (2026.6). This removes the last whitespace-keyed `?` meaning.
    ternary_expr: $ => prec.right('ternary', choice(
      seq($._expr, '?', $._expr, ':', $._expr),
      seq($._expr, '?', $._expr),
    )),

    // Inline conditional expression `if c then a else b` — the 2026.6 replacement
    // for the ternary. Distinct from the indented-block `if_expr` (which takes a
    // newline after the condition); here `then` follows the condition on one line.
    if_then_expr: $ => prec.right('ternary', seq(
      'if', $._expr, 'then', $._expr, 'else', $._expr,
    )),

    range_expr: $ => prec.left('range', seq(
      $._expr,
      choice('..', '..='),
      $.atom,
    )),

    // for (x = 1..10, y = %items, x > y) -> (x * y)
    for_expr: $ => prec.right('lambda', seq(
      'for',
      '(',
      $.for_generator,
      repeat(seq(',', $.for_clause)),
      ')',
      '->',
      $._expr,
    )),

    // A comprehension generator. The 2026.6 form is `x in iter` (matching the UI
    // keyed-list `for r in rows`). The legacy `x = source` form — with its optional,
    // semantically-inert `%` sigil — stays in the superset grammar but is deprecated
    // (lowerer warns in 2026.1, errors in 2026.6).
    for_generator: $ => choice(
      seq($.lower_id, 'in', $._expr),
      seq($.lower_id, '=', $.for_source),
    ),

    // Legacy generator source. The `%` "iterate" sigil was always a no-op (the
    // lowerer drops it); removed in 2026.6 along with the `=` form.
    for_source: $ => choice(
      seq('%', $._expr),
      $._expr,
    ),

    for_clause: $ => choice(
      $.for_generator,
      $._expr,
    ),

    // if fetchUser = Ok x — pattern match in condition
    // `prec.right` resolves the same dangling-else as `if_expr` (else binds inner).
    if_pattern_expr: $ => prec.right(seq(
      'if',
      $._expr,
      '=',
      $.simple_pattern,
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
      optional(seq(
        'else',
        $._newline,
        $._indent,
        repeat1($._statement),
        $._dedent,
      )),
    )),

    field_access: $ => prec.left('postfix', seq(
      $._expr,
      '.',
      $.member_name,
    )),

    optional_chain: $ => prec.left('postfix', seq(
      $._expr,
      '?.',
      $.member_name,
    )),

    // A member name after `.`/`?.`. Accepts ordinary identifiers AND reserved
    // words: in member position a keyword can only mean a field name, so
    // `x.after` / `x.state` / `x.type` are unambiguous. Kept as a named node so
    // the lowerer reads `.text` uniformly whether the field is a keyword or not.
    member_name: $ => choice($.lower_id, ...RESERVED_WORDS),

    deref_expr: $ => prec.left('postfix', seq(
      $._expr,
      '.*',
    )),

    addr_of_expr: $ => prec.left('postfix', seq(
      $._expr,
      '.&',
    )),

    // ? propagates error; ?: provides fallback expression (Error "msg", custom type, etc.)
    // Propagate `value?` — the `?` is GLUED (no preceding space) so it can't be
    // confused with the ternary `cond ? a : b` (spaced). `?:` stays a distinct
    // two-char token (propagate-with-default).
    propagate_expr: $ => prec.left('postfix', choice(
      seq($._expr, token.immediate('?')),
      seq($._expr, '?:', $._expr),
    )),

    array_index: $ => prec.left('postfix', seq(
      $._expr,
      '[',
      $._expr,
      ']',
    )),

    type_test: $ => prec.left('comparative', seq(
      $._expr,
      'is',
      $.upper_id,
    )),

    // Record literal. The 2026.6 canonical opener is `#{` — it makes records
    // unambiguous from `{ … }` blocks (dissolving the comma-`:` vs semicolon-`=`
    // disambiguation) and visually distinct from named-arg calls (`Row(size=12)` with
    // `=` vs `#{ size: 12 }` with `:`). The bare `{ … }` form stays in the superset
    // grammar but is deprecated (lowerer warns 2026.1 / errors 2026.6).
    record_literal: $ => choice(
      seq('#{', commaSep1($.record_field), '}'),
      seq('{',  commaSep1($.record_field), '}'),
    ),

    record_field: $ => seq(
      $.lower_id,
      ':',
      $._expr,
    ),

    record_spread: $ => choice(
      seq('#{', '...', $._expr, optional(seq(',', commaSep1($.record_field))), '}'),
      seq('{',  '...', $._expr, optional(seq(',', commaSep1($.record_field))), '}'),
    ),

    list_literal: $ => seq(
      '[',
      commaSep($._expr),
      ']',
    ),

    grouped: $ => seq(
      '(',
      $._expr,
      ')',
    ),

    // Tuple literal: (a, b) or (a, b, c) — at least two elements
    // prec(1) over grouped so GLR prefers tuple when comma follows
    tuple_literal: $ => prec(1, seq(
      '(',
      $._expr,
      ',',
      commaSep1($._expr),
      optional(','),
      ')',
    )),

    lazy_expr: $ => prec('unary', seq('lazy', $._expr)),

    go_expr: $ => prec('unary', seq('go', $._expr)),

    // resume a crashed saga from its durable journal: `resume Checkout(args)`
    resume_expr: $ => prec('unary', seq('resume', $._expr)),

    // deterministic early release of a Drop value: `drop guard`. Yields Unit.
    drop_expr: $ => prec('unary', seq('drop', $._expr)),

    break_expr: $ => 'break',

    continue_expr: $ => 'continue',

    // ----------
    // Lambdas
    // ----------

    lambda_simple: $ => prec.right('lambda', seq(
      'fn',
      optional(choice(
        $.simple_pattern,                                // fn x -> …  /  fn (a, b) -> … (tuple)
        seq('(', $.lower_id, repeat1($.lower_id), ')'),  // fn (a b c) -> … (multi-arg; space-separated, not a tuple)
      )),
      '->',
      $._expr,
    )),

    lambda_block: $ => seq(
      'fn',
      $._newline,
      $._indent,
      repeat1($.match_branch),
      $._dedent,
    ),

    lambda: $ => choice(
      $.lambda_simple,
      $.lambda_block,
    ),

    // ----------
    // Match expressions
    // ----------

    match_expr: $ => seq(
      'match',
      $._expr,
      $._newline,
      $._indent,
      repeat1($.match_branch),
      $._dedent,
    ),

    // `responsive | Mobile -> … | Desktop -> …` — sugar for a match on the implicit
    // `viewport.breakpoint` subject. Same exhaustive Breakpoint coverage as the
    // explicit form; the only difference is the subject is supplied by lowering.
    responsive_expr: $ => seq(
      'responsive',
      $._newline,
      $._indent,
      repeat1($.match_branch),
      $._dedent,
    ),

    match_branch: $ => choice(
      seq('|', $.pattern, repeat(seq('|', $.pattern)), '->', $._branch_body),
      seq('|', '->', $._branch_body),
      seq('|', '()'),
    ),

    _branch_body: $ => choice(
      seq($._expr, $._newline),
      $.step_goto,                         // | Ok r -> :done r  (saga step transition)
      $.element,                           // | Before -> Text "x" color=red
      seq($._newline, $._indent, repeat1($._saga_stmt), $._dedent),
    ),

    pattern: $ => choice(
      $.simple_pattern,
      $.guard_pattern,
    ),

    simple_pattern: $ => choice(
      $.literal,
      $.wildcard,
      seq('[', ']'),
      $.upper_id,
      seq($.upper_id, $.lower_id, $.record_pattern),  // Ok response { body, status }
      seq($.upper_id, $.simple_pattern),
      seq($.upper_id, $.record_pattern),
      $.record_pattern,
      $.qualified_pattern,
      $.binding_pattern,
      seq('(', $.pattern, ')'),  // parenthesized: Ok (Chunk c)
      $.tuple_pattern,           // (a, b), (Ok x, Error e)
    ),

    // Tuple destructuring pattern: two or more comma-separated sub-patterns.
    tuple_pattern: $ => seq('(', $.pattern, ',', commaSep1($.pattern), ')'),

    wildcard: $ => '_',

    binding_pattern: $ => $.lower_id,

    record_pattern: $ => seq(
      '{',
      commaSep1($.lower_id),
      '}',
    ),

    qualified_pattern: $ => seq(
      $.lower_id,
      repeat(seq('.', $.lower_id)),
      '.',
      $.upper_id,
      optional($.lower_id),
    ),

    guard_pattern: $ => seq(
      $.simple_pattern,
      'if',
      $._expr,
    ),

    // ----------
    // If expressions
    // ----------

    // `prec.right` resolves the dangling-else: when a block `if` is the `then`
    // branch of an inline `if c then … else …`, the `else` binds to the nearest
    // (inner block) `if`, the conventional reading.
    if_expr: $ => prec.right(seq(
      'if',
      $._expr,
      $._newline,
      $._indent,
      repeat1($._saga_stmt),
      $._dedent,
      optional(seq(
        'else',
        $._newline,
        $._indent,
        repeat1($._saga_stmt),
        $._dedent,
      )),
    )),

    // ----------
    // Function calls
    // ----------

    // Unified application: any expression callee followed by an IMMEDIATE `(`
    // opens an argument list. `token.immediate('(')` (no space) is what keeps
    //   f(a, b)    — a call
    // distinct from a bare tuple `(a, b)` in expression position. This single
    // rule subsumes the old function_call (`f x`), qualified_call (`Mod.f x`),
    // paren_call (`(fn..) x`) and adt_call (`Ok x`). Whether the callee names a
    // function or a constructor is decided downstream by its capitalization.
    call: $ => prec.left('postfix', seq(
      $._expr,
      choice(
        seq(token.immediate('('), optional($._arg_list), ')'),
        // Zero-arg call `f()`: the `()` lexes as a single token (it would
        // otherwise be the `unit` literal), so match it immediately here.
        // `token.immediate` outranks the plain `unit` token, so an Upper-headed
        // `Inc()` resolves to a call rather than an incomplete element.
        token.immediate('()'),
      ),
    )),

    _arg_list: $ => seq(
      commaSep1(choice($.named_arg, $._expr)),
      optional(','),
    ),

    // `name=value` keyword argument. The `=` glyph binds a value to a parameter
    // by name (record fields keep `:`). All positional args must precede named.
    named_arg: $ => seq(
      $.lower_id,
      '=',
      $._expr,
    ),

    atom: $ => choice(
      $.literal,
      $.lower_id,
      $.upper_id,
      $.grouped,
      $.tuple_literal,
      $.record_literal,
      $.record_spread,
      $.list_literal,
    ),

    // ----------
    // Effects
    // ----------

    send_expr: $ => seq(
      'send',
      $.upper_id,
      $.atom,
    ),

    ask_expr: $ => seq(
      'ask',
      $.upper_id,
      $.atom,
      optional(seq('timeout=', $.number)),
    ),

    transaction_expr: $ => seq(
      'transaction',
      optional(seq('within', $.record_literal)),
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // ----------
    // Event handlers
    // ----------

    on_handler: $ => seq(
      'on',
      $.lower_id,                 // event name (onClick, onInput, …)
      optional($.lower_id),       // optional event param: `on onInput e -> …(e.value)`
      choice(
        seq('->', $._expr, $._newline),
        seq('->', $._newline, $._indent, repeat1($._statement), $._dedent),
      ),
    ),

    // ----------
    // Escape blocks
    // ----------

    kernel_block: $ => seq(
      '@kernel{',
      $._newline,
      $._indent,
      repeat1($.function_def),
      $._dedent,
      '}',
    ),

    js_block: $ => seq(
      '@js{',
      token.immediate(/[^}]*/),
      '}',
    ),

    unsafe_block: $ => seq(
      '@unsafe{',
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    comptime_block: $ => seq(
      '@comptime{',
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // Optional explicit `{ ... }` block — items separated by `;`. Works single-
    // or multi-line (`;` at line ends). Disambiguated from record_literal by the
    // separator AND content: `,` + `name:` ⇒ record; `;` / `name =` / `<stmt>` /
    // `{}` ⇒ block. `;`-required (not bare newline) keeps it unambiguous from a
    // multi-line record, which makes NEWLINE invalid inside `{}` (the scanner
    // only emits NEWLINE when the grammar marks it valid). No inline `: type` on
    // brace-bindings keeps the `=` vs `:` record fork one token wide.
    brace_block: $ => seq(
      '{',
      optional(seq(
        $._brace_item,
        repeat(seq(';', $._brace_item)),
        optional(';'),
      )),
      '}',
    ),

    _brace_item: $ => choice(
      $.brace_binding,
      $._expr,
    ),

    brace_binding: $ => seq(
      optional(choice('const', 'let', seq('let', 'mut'), 'mut')),
      $.lower_id,
      '=',
      $._expr,
    ),

    // `pipe` block: each line threads its result into `ret` for the next line.
    // Desugars to a sequence of `ret = <line>` bindings; value = last line.
    pipe_block: $ => seq(
      'pipe',
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // `try` block: implicit `?` after each line; first Error collapses the whole
    // block to that Error. Value is `Result T E` (Design A — caught by `match`).
    try_block: $ => seq(
      'try',
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // `retry [N] [D]` block: run the body like a `try`; on Error, re-run.
    //   retry 3            — up to 3 attempts, no delay
    //   retry 3 200ms      — 3 attempts, sleep 200ms between each
    //   retry [100ms, 1s]  — backoff schedule: len+1 attempts, those delays
    //   retry              — until it succeeds (unbounded)
    // The delay is a bare duration literal (juxtaposed after the count). Value is
    // `Result T E` (the Ok on success, or the last Error once attempts run out).
    retry_block: $ => seq(
      'retry',
      optional($._expr),
      optional($.duration_lit),
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // await expr — wait for next value from a stream/channel
    await_expr: $ => prec('unary', seq('await', $._expr)),

    // await expr\n  | branches — wait and match on result
    await_stmt: $ => seq(
      'await',
      $._expr,
      $._newline,
      $._indent,
      repeat1($.match_branch),
      $._dedent,
    ),

    loop_expr: $ => seq(
      'loop',
      $._newline,
      $._indent,
      repeat1($._statement),
      $._dedent,
    ),

    // ----------
    // Elements
    // ----------

    // A single self-terminating element rule (no inline/block split). The element
    // consumes its own trailing _newline, then OPTIONALLY an indented children
    // block — exactly the `if_expr` shape, which parses correctly at double-dedent
    // boundaries. The previous element_inline/element_block split made `inline` a
    // prefix of `block`, an ambiguity the GLR+indent-scanner resolved wrongly when
    // an element-bodied function was followed by another top-level def (children
    // mis-nested / collapsed to siblings). Elements are only ever statements,
    // match-branch bodies, or children — never inline sub-expressions — so eating
    // the newline here is safe. Content: `Text "hi" size=12`, `Image url radius=8`.
    // Strict element (statement / branch position): must carry ≥1 prop OR a
    // children block, so a bare `Ok (x)` / `Spacer` stays an adt_call constructor
    // application and only genuine elements (`Text "x" size=1`, `Column\n …`) are
    // elements. Self-terminating: eats its own newline, then optional children.
    // (Content-only leaf elements like `Text "hello"` are allowed via element_leaf
    // inside a children_block, where no adt_call competes.)
    element: $ => seq(
      $.upper_id,
      choice(
        // Legacy space-form (deprecated → error in edition 2026.6): `Text "hi" size=12`,
        // `Column gap=8` + children. Props are space-separated `key=value`.
        seq(
          optional($.element_content),
          choice(
            seq(repeat1($.prop), $._newline, optional($.children_block)),
            seq($._newline, $.children_block),
          ),
        ),
        // Paren-form with a children block: `Column(gap=8)` + indented children.
        // Content is the first positional, props are `name=value`. Childless paren
        // elements (`Text("hi")`) parse as `call` and lower to an Element by
        // primitive-name — only the children-bearing form needs the block attached
        // here. `call` cannot consume the indented block, but the GLR still had a
        // rival parse — call STATEMENT + deeper-indented siblings (the indent
        // scanner is demand-driven, so the statement path simply never asks for
        // the indent) — and it won by default, silently flattening every
        // paren-form element's children into siblings (the 2026.6 form rendered
        // childless trees). The dynamic precedence makes the children-bearing
        // element win whenever both parses survive.
        prec.dynamic(2, seq($.element_args, $._newline, $.children_block)),
      ),
    ),

    // The glued paren argument list of a paren-form element, reusing the call
    // `_arg_list` (positional content + `name=value` props). `token.immediate`
    // mirrors the call rule so `Column(gap=8)` (not `Column (gap=8)`) opens it.
    element_args: $ => seq(
      token.immediate('('),
      optional($._arg_list),
      ')',
    ),

    // A content-only / bare element, valid only as a child (no adt_call ambiguity
    // there): `Text "hello"`, `Spacer`.
    element_leaf: $ => seq(
      $.upper_id,
      choice(
        optional($.element_content),   // space-form leaf: `Text "hi"`, `Spacer`
        $.element_args,                // paren-form leaf: `Text("hi", size=12)`
      ),
      $._newline,
    ),

    // positional content: literal or parenthesized expression (not a bare ident — that's a prop)
    element_content: $ => choice(
      $.literal,
      $.grouped,
    ),

    prop: $ => choice(
      seq($.lower_id, '=', $.atom),
      seq($.lower_id, '={', $._expr, '}'),
      seq($.lower_id, '->', $._expr),
      seq(
        $.lower_id,
        '->',
        $._newline,
        $._indent,
        repeat1($._statement),
        $._dedent,
      ),
      $.lower_id,
      seq('...', $._expr),
    ),

    // The leading _newline is consumed by `element` before this block, so it only
    // holds the indent / children / dedent.
    children_block: $ => seq(
      $._indent,
      repeat1($.child),
      $._dedent,
    ),

    // Every child is self-terminating (element eats its own newline; on_handler
    // ends in a newline or dedent; `{expr}` takes a trailing newline) so siblings
    // at the same indent stay siblings instead of mis-nesting.
    child: $ => choice(
      $.element,
      $.element_leaf,
      $.call_child,
      $.for_child,
      $.on_handler,
      seq('{', $._expr, '}', $._newline),
    ),

    // A bare component call as a child: `card()`, `header(title="x")`. Lowercase-
    // headed only, so it never competes with element_leaf's Upper-headed paren
    // form (`Text("hi")`) — capitalization splits the space exactly as it does
    // for call-vs-constructor. Before this rule, `card()` lines under an element
    // weren't a child form at all, so the GLR quietly parsed them as SIBLING
    // statements of the element (the same demand-driven-indent flattening the
    // prec.dynamic on `element` fixes) and composed views rendered only their
    // last leaf. Self-terminating like every other child. The previous escape
    // hatch `{card()}` still parses (the brace child above).
    call_child: $ => seq(
      $.lower_id,
      choice(
        seq(token.immediate('('), optional($._arg_list), ')'),
        token.immediate('()'),
      ),
      $._newline,
    ),

    // Keyed list rendering: `for r in rows` over an indented per-item element.
    // Distinct from the `for ( … ) ->` comprehension (which requires parens). Each
    // produced child is auto-keyed on `r.id` (the implicit, SQL-primary-key default)
    // unless the element sets its own `id`/`key`. Lowering supplies the key.
    for_child: $ => seq(
      'for',
      $.lower_id,
      'in',
      $._expr,
      $._newline,
      $._indent,
      choice($.element, $.element_leaf),
      $._dedent,
    ),

    // ----------
    // Literals
    // ----------

    literal: $ => choice(
      $.number,
      $.bool,
      $.triple_quote_string,
      $.multiline_string,
      $.string,
      $.hex_color,
      $.unit,
      $.atom_lit,
      $.duration_lit,
      $.sigil_string,
      $.regex_sigil,
    ),

    // Atom: colon glued directly to a lowercase identifier (`:done`). Single
    // token so `:name` never collides with a record/ascription `:` (which is
    // always followed by space or an uppercase type). This is what makes the
    // `{ name: … }` = record vs `{ … }` = block content-disambiguation sound.
    atom_lit: $ => token(seq(':', /[a-z][a-zA-Z0-9_]*/)),

    number: $ => token(choice(
      /0b[01][01_]*/,
      /0x[0-9a-fA-F][0-9a-fA-F_]*/,
      /[0-9][0-9_]*\.[0-9][0-9_]*/,
      /[0-9][0-9_]*/,
    )),

    sigil_string: $ => token(seq('r"', /[^"]*/, '"')),

    regex_sigil: $ => token(seq('rx/', /[^/]*/, '/')),

    bool: $ => choice('true', 'false'),

    string: $ => seq(
      '"',
      repeat(choice(
        // `_string_content` is an EXTERNAL token (scanner.c): it greedily
        // consumes raw text up to `"`, `{`, `\` or newline. tree-sitter tries
        // external tokens before `extras`, so a `--` inside a string is NOT
        // eaten as a comment (the internal lexer's longest-match would let
        // `--.*` swallow the closing quote — see the `_string_content` case).
        $._string_content,
        seq(token.immediate('{'), $._expr, '}'),
        seq(token.immediate('\\'), token.immediate(/./)),
      )),
      '"',
    ),

    multiline_string: $ => choice(
      seq('`', token.immediate(/[^`]*/), '`'),
      token(prec(1, seq('"""', /([^"]|"[^"]|""[^"])*/, '"""'))),
    ),

    hex_color: $ => token(/#[0-9a-fA-F]{3,8}/),

    unit: $ => '()',

    // ----------
    // Identifiers
    // ----------

    lower_id: $ => /[a-z][a-zA-Z0-9_]*/,
    upper_id: $ => /[A-Z][a-zA-Z0-9_]*/,

  }
})

function commaSep(rule) {
  return optional(commaSep1(rule))
}

function commaSep1(rule) {
  return seq(rule, repeat(seq(',', rule)))
}
