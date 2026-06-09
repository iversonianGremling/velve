#include "tree_sitter/parser.h"
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

// ---------------------------------------------------------------------------
// Design notes
//
// The grammar always sequences  $._newline  BEFORE  $._indent or $._dedent.
// So when the scanner sees '\n' and the next line has a different indent:
//   1. Emit NEWLINE first  (satisfy $._newline)
//   2. Save the target column in `pending_col`
//   3. On the next call(s), emit INDENT / DEDENT(s) as zero-width tokens
//      by reading `pending_col` from state rather than re-scanning whitespace.
//
// After the NEWLINE is emitted the lexer position is already past the
// newline + leading whitespace, so subsequent calls use `pending_col`
// directly and never try to scan for '\n' again (phase 1 handles them).
// ---------------------------------------------------------------------------

#define STACK_MAX 128

enum TokenType { INDENT, DEDENT, NEWLINE, TRIPLE_QUOTE_STRING, STRING_CONTENT };

typedef struct {
  uint16_t stack[STACK_MAX];
  uint8_t  len;
  uint16_t pending_col;   // column of the next real line, saved after NEWLINE
  bool     has_pending;   // whether pending_col is valid
} Scanner;

// ── lifecycle ──────────────────────────────────────────────────────────────

void *tree_sitter_velve_external_scanner_create() {
  return calloc(1, sizeof(Scanner));
}
void tree_sitter_velve_external_scanner_destroy(void *p) { free(p); }

unsigned tree_sitter_velve_external_scanner_serialize(void *p, char *buf) {
  Scanner *s = (Scanner *)p;
  unsigned i = 0;
  buf[i++] = (char)s->len;
  for (int j = 0; j < s->len; j++) {
    buf[i++] = (char)(s->stack[j] & 0xFF);
    buf[i++] = (char)(s->stack[j] >> 8);
  }
  buf[i++] = (char)(s->pending_col & 0xFF);
  buf[i++] = (char)(s->pending_col >> 8);
  buf[i++] = s->has_pending ? 1 : 0;
  return i;
}

void tree_sitter_velve_external_scanner_deserialize(void *p, const char *buf, unsigned n) {
  if (n == 0) return;
  Scanner *s = (Scanner *)p;
  unsigned i = 0;
  s->len = (uint8_t)(unsigned char)buf[i++];
  for (int j = 0; j < s->len && i + 1 < n; j++) {
    s->stack[j] = (uint16_t)(unsigned char)buf[i] | ((uint16_t)(unsigned char)buf[i+1] << 8);
    i += 2;
  }
  if (i + 1 < n) {
    s->pending_col = (uint16_t)(unsigned char)buf[i] | ((uint16_t)(unsigned char)buf[i+1] << 8);
    i += 2;
  }
  if (i < n) s->has_pending = buf[i] != 0;
}

// ── helpers ────────────────────────────────────────────────────────────────

static inline uint16_t top(Scanner *s) {
  return s->len > 0 ? s->stack[s->len - 1] : 0;
}

// ── scan ───────────────────────────────────────────────────────────────────

bool tree_sitter_velve_external_scanner_scan(
  void *p, TSLexer *lexer, const bool *valid
) {
  Scanner *s = (Scanner *)p;

  // ── string content: raw text inside "..." up to a boundary ─────────────
  // An external token so tree-sitter matches it BEFORE `extras` — without this
  // a `-- ...` inside a string is lexed as a comment (its `--.*` longest-match
  // swallows the closing quote). Stops at the interpolation `{`, escape `\`,
  // closing `"`, a stray `}`, or newline; those are matched by the grammar.
  if (valid[STRING_CONTENT]) {
    bool any = false;
    while (!lexer->eof(lexer)) {
      int32_t c = lexer->lookahead;
      if (c == '"' || c == '{' || c == '}' || c == '\\' || c == '\n') break;
      lexer->advance(lexer, false);
      any = true;
    }
    if (any) {
      lexer->mark_end(lexer);
      lexer->result_symbol = STRING_CONTENT;
      return true;
    }
    return false; // at a boundary char — let the grammar consume it
  }

  // ── triple-quoted string: """...""" ────────────────────────────────────
  if (valid[TRIPLE_QUOTE_STRING] && lexer->lookahead == '"') {
    lexer->advance(lexer, false);
    if (lexer->lookahead != '"') return false;
    lexer->advance(lexer, false);
    if (lexer->lookahead != '"') return false;
    lexer->advance(lexer, false);
    // consume until closing """
    int q = 0;
    while (!lexer->eof(lexer)) {
      int32_t c = lexer->lookahead;
      lexer->advance(lexer, false);
      if (c == '"') { q++; if (q == 3) break; }
      else q = 0;
    }
    lexer->result_symbol = TRIPLE_QUOTE_STRING;
    return true;
  }

  // ── phase 1: drain pending indent/dedent from a previously-seen newline ─
  //
  // After we emitted NEWLINE in phase 2, pending_col holds the column of
  // the next real line. Emit INDENT or DEDENT(s) as zero-width tokens.
  if (s->has_pending) {
    uint16_t col = s->pending_col;
    uint16_t cur = top(s);

    if (col > cur && valid[INDENT]) {
      if (s->len < STACK_MAX) s->stack[s->len++] = col;
      s->has_pending = false;
      lexer->mark_end(lexer);
      lexer->result_symbol = INDENT;
      return true;
    }
    if (col < cur && valid[DEDENT]) {
      s->len--;
      if (col >= top(s)) s->has_pending = false; // no more dedents needed
      lexer->mark_end(lexer);
      lexer->result_symbol = DEDENT;
      return true;
    }
    // col == cur, or the needed token isn't valid yet: clear and fall through
    if (col == cur) s->has_pending = false;
  }

  // ── phase 2: scan a physical newline ──────────────────────────────────
  if (!valid[INDENT] && !valid[DEDENT] && !valid[NEWLINE]) return false;

  // Skip trailing horizontal whitespace, then an inline `-- comment`, so a
  // comment at the end of a line doesn't suppress the NEWLINE token. (NEWLINE is
  // never valid at a `->`, so a leading '-' here can only begin a comment.)
  while (lexer->lookahead == ' ' || lexer->lookahead == '\t' || lexer->lookahead == '\r')
    lexer->advance(lexer, true);
  if (lexer->lookahead == '-') {
    lexer->advance(lexer, true);
    if (lexer->lookahead != '-') return false;       // not a comment
    while (lexer->lookahead != '\n' && lexer->lookahead != 0) lexer->advance(lexer, true);
  }

  if (lexer->lookahead != '\n') return false;

  lexer->advance(lexer, false); // consume '\n'

  // Skip blank lines; count indentation of next real line.
  uint16_t col = 0;
  for (;;) {
    col = 0;
    while (lexer->lookahead == ' ')  { col++;     lexer->advance(lexer, true); }
    while (lexer->lookahead == '\t') { col += 4;  lexer->advance(lexer, true); }

    if (lexer->lookahead == '\r') { lexer->advance(lexer, true); continue; }
    if (lexer->lookahead == '\n') { lexer->advance(lexer, false); continue; }

    break; // real content (or EOF)
  }

  // ── EOF after the newline ──────────────────────────────────────────────
  if (lexer->lookahead == 0) {
    // Close any open blocks
    if (valid[DEDENT] && s->len > 0) {
      s->len--;
      if (s->len > 0) { s->pending_col = 0; s->has_pending = true; }
      lexer->result_symbol = DEDENT;
      return true;
    }
    if (valid[NEWLINE]) {
      // If there are still open blocks, flag them so the next call(s) emit DEDENTs.
      if (s->len > 0) {
        s->pending_col = 0;
        s->has_pending = true;
      }
      lexer->result_symbol = NEWLINE;
      return true;
    }
    return false;
  }

  // ── real line at column `col` ──────────────────────────────────────────
  //
  // Implicit line continuation: if the next line is MORE indented than the
  // current block AND starts with a binary-only operator (one that cannot
  // begin a new statement), suppress NEWLINE and let the parser treat the
  // newline as whitespace. This enables:
  //   result = items
  //     |> filter valid    -- leading |> continuation
  //     |> map transform
  if (valid[NEWLINE] && col > top(s)) {
    char c = (char)lexer->lookahead;
    if (c == '+' || c == '*' || c == '/' ||
        c == '%' || c == '^' || c == '&' || c == '?') {
      return false; // treat newline+indent as whitespace, continue expression
    }
    // `|>` (pipe) continues the previous line; a bare `|` (match branch) starts a
    // new statement. They differ only in the 2nd char, so peek it: tree-sitter
    // resets the lexer to the scan start when scan returns false, so consuming the
    // `|` here is speculative. For the non-pipe case, mark_end keeps the `|` for
    // the parser before we fall through to emit NEWLINE.
    if (c == '|') {
      lexer->mark_end(lexer);
      lexer->advance(lexer, true);
      if ((char)lexer->lookahead == '>') {
        return false; // `|>` — continue the expression
      }
      // bare `|` — match branch; fall through to emit NEWLINE (ends before `|`).
    }
  }

  // NEWLINE always wins when valid — the grammar always sequences
  // $._newline before $._indent / $._dedent, so we emit NEWLINE first
  // and save any indent change as pending.
  if (valid[NEWLINE]) {
    if (col != top(s)) {
      s->pending_col = col;
      s->has_pending = true;
    }
    lexer->result_symbol = NEWLINE;
    return true;
  }

  // NEWLINE not valid — we must be directly expecting INDENT or DEDENT.
  // (Shouldn't normally occur given the grammar structure, but handled
  //  for robustness.)
  uint16_t cur = top(s);
  if (col > cur && valid[INDENT]) {
    if (s->len < STACK_MAX) s->stack[s->len++] = col;
    lexer->result_symbol = INDENT;
    return true;
  }
  if (col < cur && valid[DEDENT]) {
    s->len--;
    if (col < top(s)) { s->pending_col = col; s->has_pending = true; }
    lexer->result_symbol = DEDENT;
    return true;
  }

  return false;
}
