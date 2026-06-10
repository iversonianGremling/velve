import type { FnClause, MachineStep, Param, Expr } from "./ast.js";
import type { Future } from "./scheduler.js";

// A live saga instance's durable log, shared between the running task and the
// handle returned by `go Checkout(..)`. Records both step transitions and the
// compensations registered along the way, so a crashed instance can be replayed
// with `resume` (rebuilding the compensation stack from the log).
export type SagaJournalEntry =
  | { kind: "step"; step: string; args: Value[] }    // entered a state
  | { kind: "comp"; target: string; args: Value[] }  // registered a `? rollback :step`
export interface SagaStatus { value: string }   // "running" | "done" | "aborted" | "crashed"

// ── Runtime values ────────────────────────────────────────────────────────────

export type Value =
  | { tag: "VNum";     v: number }
  | { tag: "VStr";     v: string }
  | { tag: "VBool";    v: boolean }
  | { tag: "VAtom";    name: string }
  | { tag: "VUnit" }
  | { tag: "VTuple";   elems: Value[] }
  | { tag: "VList";    elems: Value[] }
  | { tag: "VRecord";  fields: Map<string, Value> }
  | { tag: "VCtor";    name: string; payload: Value | null }
  | { tag: "VFn";      name: string; clauses: FnClause[]; env: Env }
  | { tag: "VBuiltin"; name: string; fn: (args: Value[]) => Value | Promise<Value> }
  | { tag: "VFuture";  future: Future }   // an in-flight `go` task
  // A first-class saga, callable to run to completion (`Checkout(args)`).
  | { tag: "VSaga";    name: string; params: Param[]; steps: MachineStep[]; store: string | null; env: Env }
  // A live saga instance from `go Checkout(args)` — its own journal & status.
  | { tag: "VSagaHandle"; name: string; future: Future; journal: SagaJournalEntry[]; status: SagaStatus }
  // A push-based async stream/channel declared with `stream Name : T`.
  | { tag: "VStream"; name: string; q: VStreamQueue }
  // An immutable Dict (std `Dict` module). Keyed by a canonical encoding of the
  // key value (`dictKey`); each slot stores the original key alongside the value
  // so `keys`/`entries` can recover it. All ops copy the map (persistent).
  | { tag: "VDict"; entries: Map<string, [Value, Value]> }
  // An immutable Set (std `Set` module). Same canonical-key scheme; each slot
  // stores the original element so `toList` can recover it.
  | { tag: "VSet"; elems: Map<string, Value> }
  // A pointer (§2.11), produced by `x.&`. `read`/`write` close over the
  // borrowed storage (an env binding for an lvalue, or a private cell for an
  // rvalue snapshot) so `p.*` observes the current value and writes alias back.
  | { tag: "VPtr"; read: () => Value; write: (v: Value) => void; label: string }
  // A rendered UI node (§ view DSL). `name` is the component/primitive name
  // (Row, Text, Button…), `text` the inline content (`Text "hi"`), `props` the
  // attribute/style map, `children` the nested nodes, `events` the captured
  // handlers (event-name → zero-arg closure) for a future interactive runtime.
  | { tag: "VElement"; name: string; text: Value | null; props: Map<string, Value>; children: Value[]; events: Map<string, Value> }
  // A deferred prop value (convergence §6): its expression references another
  // element's prop (self/parent/prev/next/children), so it is held unevaluated at
  // eval time and resolved in topological order by `Evaluator.converge`.
  | { tag: "VDeferred"; expr: Expr; env: Env };

// Canonical string encoding of a Dict key, so structurally-equal keys collide.
export function dictKey(v: Value): string {
  switch (v.tag) {
    case "VNum":  return "n:" + v.v;
    case "VStr":  return "s:" + v.v;
    case "VBool": return "b:" + v.v;
    case "VAtom": return "a:" + v.name;
    case "VUnit": return "u:";
    case "VTuple": return "t:(" + v.elems.map(dictKey).join(",") + ")";
    case "VList":  return "l:[" + v.elems.map(dictKey).join(",") + "]";
    case "VCtor":  return "c:" + v.name + (v.payload ? "(" + dictKey(v.payload) + ")" : "");
    default:       return "x:" + display(v);
  }
}

// ── Stream queue ─────────────────────────────────────────────────────────────

// The declaration-site backpressure policy (SPEC §10.1). Policies govern `Push`
// values only — `Done` is the termination signal and always lands (a policy
// that lost `Done` would leave consumers parked forever). Absent (null) =
// unbounded buffer, the default.
export type StreamQueuePolicy =
  | { kind: "drop" }                // lossy: deliver to a waiting consumer, else discard
  | { kind: "buffer"; n: number }   // bounded: keep the newest n, evict oldest on overflow
  | { kind: "block" }               // lossless: `send` suspends until a consumer takes it

const isDoneSignal = (v: Value): boolean => v.tag === "VCtor" && v.name === "Done";

export class VStreamQueue {
  private buffer: Value[] = [];
  private waiters: Array<(v: Value) => void> = [];
  // `block`-policy producers parked mid-`send`, each holding its undelivered value.
  private senders: Array<{ v: Value; release: () => void }> = [];

  constructor(private readonly policy: StreamQueuePolicy | null = null) {}

  push(v: Value): void {
    if (this.waiters.length) { this.waiters.shift()!(v); return; }
    if (!isDoneSignal(v)) {
      if (this.policy?.kind === "drop") return;
      if (this.policy?.kind === "buffer" && this.buffer.length >= this.policy.n) this.buffer.shift();
    }
    this.buffer.push(v);
  }

  // Policy-aware producer side. Identical to push() except under `block`, where
  // the returned promise parks the producer until a consumer takes the value —
  // the cooperative scheduler only advances the clock once every task is parked,
  // so a blocked `send` is deterministic, not a busy-wait.
  send(v: Value): Promise<void> {
    if (this.policy?.kind === "block" && !this.waiters.length && !isDoneSignal(v)) {
      return new Promise(release => this.senders.push({ v, release }));
    }
    this.push(v);
    return Promise.resolve();
  }

  // Take the next ready value: buffered first, then a parked sender's (releasing it).
  private takeReady(): Value | undefined {
    if (this.buffer.length) return this.buffer.shift()!;
    if (this.senders.length) {
      const s = this.senders.shift()!;
      s.release();
      return s.v;
    }
    return undefined;
  }

  next(): Promise<Value> {
    const ready = this.takeReady();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise(resolve => this.waiters.push(resolve));
  }

  // Like next(), but resolves to `undefined` if `ms` virtual time elapses before a
  // value arrives. Unlike racing next() against a timer, the waiter is removed on
  // timeout, so no pushed value is ever lost. Used by `streamDebounce`.
  nextWithin(ms: number, sched: { sleep(ms: number): Promise<void> }): Promise<Value | undefined> {
    const ready = this.takeReady();
    if (ready !== undefined) return Promise.resolve(ready);
    return new Promise(resolve => {
      let settled = false;
      const waiter = (v: Value) => { if (settled) return; settled = true; resolve(v); };
      this.waiters.push(waiter);
      sched.sleep(ms).then(() => {
        if (settled) return;
        settled = true;
        const i = this.waiters.indexOf(waiter);
        if (i >= 0) this.waiters.splice(i, 1);
        resolve(undefined);
      });
    });
  }
}

// ── Environment ───────────────────────────────────────────────────────────────

export class Env {
  private bindings = new Map<string, Value>();
  constructor(public readonly parent: Env | null = null) {}

  define(name: string, val: Value): void {
    this.bindings.set(name, val);
  }

  set(name: string, val: Value): void {
    if (this.bindings.has(name)) { this.bindings.set(name, val); return; }
    if (this.parent) this.parent.set(name, val);
  }

  lookup(name: string): Value | undefined {
    return this.bindings.get(name) ?? this.parent?.lookup(name);
  }

  child(): Env { return new Env(this); }

  // Collect all bindings visible from this scope (child bindings shadow parent).
  allBindings(): Map<string, Value> {
    const all = this.parent ? this.parent.allBindings() : new Map<string, Value>();
    for (const [k, v] of this.bindings) all.set(k, v);
    return all;
  }
}

// ── Display ───────────────────────────────────────────────────────────────────

export function display(v: Value): string {
  switch (v.tag) {
    case "VNum":    return String(v.v);
    case "VStr":    return v.v;
    case "VBool":   return v.v ? "true" : "false";
    case "VAtom":   return `:${v.name}`;
    case "VUnit":   return "()";
    case "VTuple":  return `(${v.elems.map(display).join(", ")})`;
    case "VList":   return `[${v.elems.map(display).join(", ")}]`;
    case "VRecord": {
      const pairs = [...v.fields.entries()].map(([k, val]) => `${k}: ${display(val)}`);
      return `{ ${pairs.join(", ")} }`;
    }
    case "VCtor":   return v.payload !== null ? `${v.name}(${display(v.payload)})` : v.name;
    case "VFn":
    case "VBuiltin":  return `<fn:${v.name}>`;
    case "VFuture":   return v.future.done ? `<future:done>` : `<future:pending>`;
    case "VSaga":     return `<saga:${v.name}>`;
    case "VSagaHandle": return `<saga:${v.name} ${v.status.value}>`;
    case "VStream":   return `<stream:${v.name}>`;
    case "VDict": {
      const pairs = [...v.entries.values()].map(([k, val]) => `${display(k)}: ${display(val)}`);
      return `Dict{ ${pairs.join(", ")} }`;
    }
    case "VSet":
      return `Set{ ${[...v.elems.values()].map(display).join(", ")} }`;
    case "VPtr":      return `<ptr:${v.label}>`;
    case "VElement":  return `<${v.name}${v.children.length ? ` …${v.children.length}` : ""}>`;
    case "VDeferred": return `<deferred>`;
  }
}

// ── Signals (used for control flow) ──────────────────────────────────────────

export class ReturnSignal   { constructor(public value: Value) {} }
export class BreakSignal    { constructor(public value: Value | null) {} }
export class ContinueSignal {}
export class RuntimeError extends Error {}
// Thrown by the `crash` builtin to abort a saga instance mid-flight. The
// instance's journal survives, so `resume` can re-hydrate and continue it.
export class SagaCrashSignal { constructor(public message: string) {} }
