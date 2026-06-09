export interface Pos {
  line: number;   // 0-based
  col: number;    // 0-based
  offset: number; // byte offset
}

export interface Span {
  start: Pos;
  end: Pos;
  source: string; // filename or "<stdin>"
}

export function spanFrom(node: { startPosition: { row: number; column: number }; endPosition: { row: number; column: number }; startIndex: number; endIndex: number }, source: string): Span {
  return {
    start: { line: node.startPosition.row, col: node.startPosition.column, offset: node.startIndex },
    end:   { line: node.endPosition.row,   col: node.endPosition.column,   offset: node.endIndex },
    source,
  };
}

export function mergeSpan(a: Span, b: Span): Span {
  return {
    start: a.start.offset <= b.start.offset ? a.start : b.start,
    end:   a.end.offset   >= b.end.offset   ? a.end   : b.end,
    source: a.source,
  };
}
