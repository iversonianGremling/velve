import type { Value } from "./value.js";

// ── Futures ─────────────────────────────────────────────────────────────────
// A Future is the handle to an in-flight computation (a spawned `go` task).
// Awaiting one parks the current process until the producer resolves it.

export class Future {
  done = false;
  private value: Value | undefined;
  private error: unknown;
  private waiters: { resolve: (v: Value) => void; reject: (e: unknown) => void }[] = [];

  resolve(v: Value): void {
    if (this.done) return;
    this.done = true; this.value = v;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w.resolve(v);
  }

  reject(e: unknown): void {
    if (this.done) return;
    this.done = true; this.error = e;
    const ws = this.waiters; this.waiters = [];
    for (const w of ws) w.reject(e);
  }

  get(): Value {
    if (this.error !== undefined) throw this.error;
    return this.value ?? { tag: "VUnit" };
  }

  promise(): Promise<Value> {
    if (this.done) return this.error !== undefined ? Promise.reject(this.error) : Promise.resolve(this.get());
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }
}

// Flush the JS microtask queue: after this resolves, every ready continuation
// has run, so any still-live task is parked on a future or a virtual timer.
function drain(): Promise<void> {
  return new Promise(resolve => setImmediate(resolve));
}

// ── Scheduler ───────────────────────────────────────────────────────────────
// Cooperative scheduler over a virtual clock. Processes run (as async functions)
// until they block; the scheduler advances logical time only when everything is
// parked, so `after`/`sleep` are deterministic rather than wall-clock.

export class Scheduler {
  private clock = 0;
  private timers: { time: number; resolve: () => void }[] = [];

  now(): number { return this.clock; }

  // Spawn a detached task; returns its Future.
  spawn(run: () => Promise<Value>): Future {
    const fut = new Future();
    (async () => {
      try { fut.resolve(await run()); }
      catch (e) { fut.reject(e); }
    })();
    return fut;
  }

  awaitFuture(fut: Future): Promise<Value> {
    return fut.promise();
  }

  // Block until the first of several futures resolves (used by `race`).
  awaitFirst(futs: Future[]): Promise<Value> {
    return Promise.race(futs.map(f => f.promise()));
  }

  // Park the caller until the virtual clock has advanced by `ms`.
  sleep(ms: number): Promise<void> {
    const target = this.clock + Math.max(0, ms);
    return new Promise<void>(resolve => this.timers.push({ time: target, resolve }));
  }

  // A promise that never resolves — a losing race arm parks here forever.
  never(): Promise<Value> {
    return new Promise<Value>(() => {});
  }

  // Drive the system until the root task finishes (or everything deadlocks).
  async run(root: Future): Promise<void> {
    await drain();
    while (!root.done && this.timers.length > 0) {
      // Everything runnable has settled; advance time to the earliest timer.
      this.timers.sort((a, b) => a.time - b.time);
      const t = this.timers.shift()!;
      this.clock = Math.max(this.clock, t.time);
      t.resolve();
      await drain();
    }
  }
}
