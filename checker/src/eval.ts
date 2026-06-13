import type { Module, Decl, Expr, Stmt, Pat, FnClause, Lit, Branch, Param } from "./ast.js";
import { patToSource, patKey } from "./ast.js";
import type { InputmapRow } from "./ast.js";
import { needsResolution, type ParamSlot } from "./callresolve.js";
import { Env, VStreamQueue, display, dictKey, ReturnSignal, BreakSignal, ContinueSignal, RuntimeError, SagaCrashSignal } from "./value.js";
import type { Value, SagaJournalEntry, SagaStatus } from "./value.js";
import { Scheduler } from "./scheduler.js";
import { renderHtml, renderModel, analyzeModel, renderJson } from "./render.js";
import { hasConvRef, scanConvRefs } from "./converge.js";
import type { ConvRef } from "./converge.js";
import { diff, keylessListWarnings, patchLabel } from "./runtime.js";
import { domHostPage } from "./domhost.js";
import type { HostStep } from "./domhost.js";
import {
  type LCH, oklchRaw3, oklchToHex, hexToOklch3, linToOklch3, deltaEOK, apcaTriple, cusp, DEFAULT_THEME,
  cGray, cLighten, cDarken, cSaturate, cDesaturate, cRotate, cComplement, cCusp, cMix, cLegibleOn, cShades, cTints, cRamp,
} from "./color.js";
// node:fs is loaded lazily so this module (the interpreter) can be bundled for the
// browser — the file-io builtins only pull it in when actually called.
type NodeFs = typeof import("node:fs/promises");
let _fs: NodeFs | null = null;
const loadFs = async (): Promise<NodeFs> => (_fs ??= await import("node:fs/promises"));

// The default value bound to an `on … e ->` handler's event param when fired without
// real event data (e.g. the headless `interactive`/saga drivers). The live browser
// host (browser.ts) overrides each field from the actual DOM event. Shape matches the
// `Event` record typed in infer.ts.
function emptyEvent(): Value {
  return { tag: "VRecord", fields: new Map<string, Value>([
    ["value",   { tag: "VStr",  v: "" }],
    ["key",     { tag: "VStr",  v: "" }],
    ["checked", { tag: "VBool", v: false }],
  ]) };
}

// ── Evaluator ─────────────────────────────────────────────────────────────────
//
// The interpreter is fully asynchronous: every eval method returns a Promise so
// that a process can suspend (at an `await`, a `go` join, or a `sleep`) and be
// resumed by the cooperative Scheduler. Ordinary synchronous code still runs to
// completion in a single microtask burst — the async plumbing only matters when
// concurrency primitives are involved.

interface StoreRuntime {
  state: Extract<Value, { tag: "VRecord" }>;       // live record, mutated in place
  fieldNames: string[];
  pubs: { name: string; body: Expr | null }[];
  env: Env;
  tail: Promise<unknown>;                          // mailbox tail: serializes message handling
  handlers: Map<string, Extract<Decl, { tag: "DStore" }>["messages"][number]>;
}

// Per-run state for a `saga StoreName`: its backing store name, the deferred
// compensation stack (LIFO, run in reverse on `:abort`), and a step lookup so
// compensations can re-enter named steps. `undefined` ctx = a pure `machine`.
interface SagaCtx {
  store: string;
  comps: { target: string; args: Value[] }[];
  steps: Map<string, import("./ast.js").MachineStep>;
  journal: SagaJournalEntry[] | null;   // durable log to append comp registrations to
}

export class Evaluator {
  private env: Env;
  private stores = new Map<string, StoreRuntime>();
  // inputmap registry (SPEC �10.5), keyed by the map's runtime value so
  // `help(m)` and `++` layering work through aliases. Each row carries the
  // env it was declared in, so layered maps run their actions in the right
  // scope. Built once per map (declaration eval or `++` merge).
  readonly inputmapInfo = new WeakMap<object, {
    name: string; stream: string;
    rows: { row: InputmapRow; env: Env }[];
    help: Value;
  }>();
  readonly sched = new Scheduler();

  constructor() {
    this.env = buildPrelude();
    patchHOF(this.env, this);
  }

  async run(mod: Module): Promise<void> {
    await this.evalDecls(mod.decls, this.env);
    const main = this.env.lookup("main");
    if (main) {
      const fut = this.sched.spawn(() => this.applyFn(main, [], "(main)"));
      await this.sched.run(fut);
      fut.get(); // surface a RuntimeError / completion to the caller
    }
  }

  sleep(ms: number): Promise<void> { return this.sched.sleep(ms); }

  // Evaluate a module's declarations (functions/stores/sagas) into the global env,
  // WITHOUT running `main` — used by the live browser runtime, which then drives
  // `view()` and its handlers itself. (`run()` is the CLI's main-calling entry.)
  async loadModule(mod: Module): Promise<void> { await this.evalDecls(mod.decls, this.env); }
  // Look up a top-level binding (e.g. the `view` function) after loadModule.
  global(name: string): Value | undefined { return this.env.lookup(name); }

  // Bind a top-level value into the global scope (e.g. inject a host-provided input
  // stream so velve code can `await` it by name). Mirrors how `viewport`/`theme`
  // would be host-provided roots.
  defineGlobal(name: string, value: Value): void { this.env.define(name, value); }

  // Create an INJECTABLE input stream — the host-side boundary every input device is
  // built on. Host code (a device driver, a DOM/MIDI/gamepad callback, a timer)
  // pushes values in from the REAL event loop via `push`/`pushJs`; a velve consumer
  // parked on `await` resumes (driven by the host event loop, not the virtual clock,
  // so it works for open-world/interactive programs). `std/midi` etc. call this.
  makeStream(name = "extern"): { stream: Value; push: (v: Value) => void; pushJs: (v: unknown) => void; done: () => void } {
    const q = new VStreamQueue();
    const stream: Value = { tag: "VStream", name, q };
    const PUSH = (v: Value): void => q.push({ tag: "VCtor", name: "Push", payload: v });
    return { stream, push: PUSH, pushJs: v => PUSH(jsToVelve(v)), done: () => q.push({ tag: "VCtor", name: "Done", payload: null }) };
  }

  // The journaled step names for a saga's backing store (durable history).
  journalOf(store: string): string[] {
    return (this.sagaJournals.get(store) ?? []).flatMap(e => e.kind === "step" ? [e.step] : []);
  }

  // Drain pending store message handlers (each `send` chains the store's `tail`
  // promise) so the retained runtime re-renders against settled state. A few
  // passes cover handlers that cascade into further sends.
  async settle(): Promise<void> {
    for (let i = 0; i < 8; i++) {
      await Promise.all([...this.stores.values()].map(s => s.tail));
      await Promise.resolve();
    }
  }

  // ── Convergence pass (styles-design §6) ──────────────────────────────────────
  // Resolve deferred props (those referencing self/parent/prev/next/children) in
  // topological order over the (element instance, prop) graph. A cycle — including
  // a "diagonal" one across different prop names — is a RuntimeError pointing at
  // the offending props. Runs on the concrete tree, just before render/model emit.
  async converge(root: Value): Promise<Value> {
    type EVal = Extract<Value, { tag: "VElement" }>;
    interface ElemCtx { el: EVal; parent: ElemCtx | null; siblings: ElemCtx[]; index: number; kids: ElemCtx[]; }

    // Element children, flattening one level of VList (dynamic `{xs |> map …}`).
    const elemChildVals = (el: EVal): Value[] => {
      const out: Value[] = [];
      for (const c of el.children) { if (c.tag === "VList") out.push(...c.elems); else out.push(c); }
      return out;
    };

    const all: ElemCtx[] = [];
    const walk = (v: Value, parent: ElemCtx | null): ElemCtx | null => {
      if (v.tag !== "VElement") return null;
      const ctx: ElemCtx = { el: v, parent, siblings: [], index: 0, kids: [] };
      all.push(ctx);
      const kids = elemChildVals(v).map(cv => walk(cv, ctx)).filter((k): k is ElemCtx => k !== null);
      ctx.kids = kids;
      kids.forEach((k, i) => { k.siblings = kids; k.index = i; });
      return ctx;
    };
    const rootCtx = walk(root, null);
    if (!rootCtx) return root;
    rootCtx.siblings = [rootCtx];

    // One node per deferred prop, keyed by element-index + prop name.
    const idxOf = new Map<ElemCtx, number>();
    all.forEach((c, i) => idxOf.set(c, i));
    const key = (c: ElemCtx, prop: string) => `${idxOf.get(c)} ${prop}`;
    interface DNode { ctx: ElemCtx; prop: string; expr: Expr; env: Env; refs: ConvRef[]; deps: Set<string>; }
    const nodes = new Map<string, DNode>();
    for (const ctx of all)
      for (const [prop, val] of ctx.el.props)
        if (val.tag === "VDeferred")
          nodes.set(key(ctx, prop), { ctx, prop, expr: val.expr, env: val.env, refs: scanConvRefs(val.expr), deps: new Set() });
    if (nodes.size === 0) return root;

    const targets = (ctx: ElemCtx, scope: ConvRef["scope"]): ElemCtx[] => {
      switch (scope) {
        case "self":     return [ctx];
        case "parent":   return ctx.parent ? [ctx.parent] : [];
        case "prev":     return ctx.index > 0 ? [ctx.siblings[ctx.index - 1]!] : [];
        case "next":     return ctx.index < ctx.siblings.length - 1 ? [ctx.siblings[ctx.index + 1]!] : [];
        case "children": return ctx.kids;
      }
    };
    // Edges: a node depends on every referenced prop that is itself deferred.
    for (const node of nodes.values())
      for (const ref of node.refs)
        for (const t of targets(node.ctx, ref.scope)) {
          const k = key(t, ref.prop);
          if (nodes.has(k)) node.deps.add(k);
        }

    // Kahn topological sort over the deferred nodes.
    const indeg = new Map<string, number>();
    const dependents = new Map<string, string[]>();
    for (const [k, node] of nodes) {
      indeg.set(k, node.deps.size);
      for (const d of node.deps) (dependents.get(d) ?? dependents.set(d, []).get(d)!).push(k);
    }
    const ready = [...nodes.keys()].filter(k => indeg.get(k) === 0);
    const order: DNode[] = [];
    while (ready.length) {
      const k = ready.shift()!;
      order.push(nodes.get(k)!);
      for (const dep of dependents.get(k) ?? []) {
        indeg.set(dep, indeg.get(dep)! - 1);
        if (indeg.get(dep) === 0) ready.push(dep);
      }
    }
    if (order.length !== nodes.size) {
      const stuck = [...nodes.values()].find(n => (indeg.get(key(n.ctx, n.prop)) ?? 0) > 0)!;
      const onProp = [...stuck.deps].map(d => nodes.get(d)!).filter(d => d.prop === stuck.prop);
      const detail = onProp.length
        ? ` — '${stuck.prop}' on ${stuck.ctx.el.name} and ${onProp[0]!.ctx.el.name} reference each other`
        : ` — involving '${stuck.prop}' on ${stuck.ctx.el.name}`;
      throw new RuntimeError(`convergence cycle: props form a dependency cycle${detail}. The (element, prop) graph must be acyclic (styles-design §6).`);
    }

    // Resolve each deferred prop with its references bound to resolved values.
    const recordOf = (ctx: ElemCtx): Value => {
      const fields = new Map<string, Value>();
      for (const [p, v] of ctx.el.props) if (v.tag !== "VDeferred") fields.set(p, v);
      return { tag: "VRecord", fields };
    };
    const childrenRecord = (kids: ElemCtx[]): Value => {
      const names = new Set<string>();
      for (const k of kids) for (const [p, v] of k.el.props) if (v.tag !== "VDeferred") names.add(p);
      const fields = new Map<string, Value>();
      for (const name of names) {
        const elems: Value[] = [];
        for (const k of kids) { const v = k.el.props.get(name); if (v && v.tag !== "VDeferred") elems.push(v); }
        fields.set(name, { tag: "VList", elems });
      }
      return { tag: "VRecord", fields };
    };
    const emptyRec: Value = { tag: "VRecord", fields: new Map() };
    for (const node of order) {
      const cenv = node.env.child();
      const used = new Set(node.refs.map(r => r.scope));
      if (used.has("self"))     cenv.define("self",   recordOf(node.ctx));
      if (used.has("parent"))   cenv.define("parent", node.ctx.parent ? recordOf(node.ctx.parent) : emptyRec);
      if (used.has("prev"))     cenv.define("prev",   node.ctx.index > 0 ? recordOf(node.ctx.siblings[node.ctx.index - 1]!) : emptyRec);
      if (used.has("next"))     cenv.define("next",   node.ctx.index < node.ctx.siblings.length - 1 ? recordOf(node.ctx.siblings[node.ctx.index + 1]!) : emptyRec);
      if (used.has("children")) cenv.define("children", childrenRecord(node.ctx.kids));
      node.ctx.el.props.set(node.prop, await this.evalExpr(node.expr, cenv));
    }
    return root;
  }

  // ── Declarations ────────────────────────────────────────────────────────────

  // Build an inputmap runtime value (SPEC �10.5): a nullary runner over the
  // stream's drain loop  await an event, run the FIRST matching row's action
  // with the pattern's bindings in scope, fall through when no row matches,
  // stop on Done (after a bound Done row runs, so the termination signal is
  // observable but never leaves the loop spinning). Also derives the help
  // table (labelled rows only  a label is the row's opt-in to user-facing
  // help; guarded rows marked "if ...") and registers both for `help`/`++`.
  private makeInputmap(name: string, stream: string, rows: { row: InputmapRow; env: Env }[]): Value {
    const helpRows: Value[] = rows
      .filter(e => e.row.label !== null)
      .map(e => ({ tag: "VRecord", fields: new Map([
        ["pattern", { tag: "VStr", v: patToSource(e.row.pat) + (e.row.guard ? " if ..." : "") } as Value],
        ["label",   { tag: "VStr", v: e.row.label! } as Value],
      ]) } as Value));
    const runner = builtin(name, async () => {
      const sv = rows[0]?.env.lookup(stream) ?? this.env.lookup(stream);
      if (!sv || sv.tag !== "VStream") throw new RuntimeError(`inputmap '${name}': '${stream}' is not a stream`);
      while (true) {
        const v = await sv.q.next();
        for (const e of rows) {
          const bindings = matchPat(e.row.pat, v);
          if (!bindings) continue;
          const child = e.env.child();
          for (const [k, bv] of bindings) child.define(k, bv);
          if (e.row.guard) {
            const g = await this.evalExpr(e.row.guard, child);
            if (!(g.tag === "VBool" && g.v)) continue;
          }
          await this.evalExpr(e.row.action, child);
          break;
        }
        if (v.tag === "VCtor" && v.name === "Done") return { tag: "VUnit" };
      }
    });
    this.inputmapInfo.set(runner, { name, stream, rows, help: { tag: "VList", elems: helpRows } });
    return runner;
  }

  private async evalDecls(decls: Decl[], env: Env): Promise<void> {
    // First pass: register all fn/saga/let names so mutual recursion works (and a
    // module constant referenced before its line still resolves to a placeholder).
    for (const decl of decls) {
      if (decl.tag === "DFn" || decl.tag === "DSaga" || decl.tag === "DLet" || decl.tag === "DInputmap") env.define(decl.name, { tag: "VUnit" }); // placeholder
    }
    for (const decl of decls) await this.evalDecl(decl, env);
  }

  private async evalDecl(decl: Decl, env: Env): Promise<void> {
    switch (decl.tag) {
      case "DFn": {
        env.define(decl.name, { tag: "VFn", name: decl.name, clauses: decl.clauses, env });
        break;
      }
      case "DType": {
        if (decl.body.tag === "TBAdt") {
          for (const v of decl.body.variants) {
            if (v.payload) {
              const name = v.name;
              env.define(name, builtin(name, args => ({ tag: "VCtor", name, payload: args[0] ?? { tag: "VUnit" } })));
            } else {
              env.define(v.name, { tag: "VCtor", name: v.name, payload: null });
            }
          }
          break;
        }
        // Refinement type: expose `TypeName.parse` — runs the `where` predicate
        // (with the candidate bound to `value`) and returns Ok(value)/Error(msg).
        if (decl.body.tag === "TBAlias" && decl.body.pred) {
          const pred = decl.body.pred;
          const typeName = decl.name;
          const defEnv = env;
          const parse = builtin(`${typeName}.parse`, async (args) => {
            const value = args[0] ?? { tag: "VUnit" };
            const child = defEnv.child();
            child.define("value", value);
            const ok = await this.evalExpr(pred, child);
            if (ok.tag === "VBool" && ok.v) return { tag: "VCtor", name: "Ok", payload: value };
            return { tag: "VCtor", name: "Error", payload: parseErrorVal(typeName, display(value), `fails the '${typeName}' refinement`) };
          });
          env.define(typeName, { tag: "VRecord", fields: new Map([["parse", parse]]) });
        }
        break;
      }
      case "DLet": {
        // A module-level constant/token: evaluate its RHS once and bind it.
        env.define(decl.name, await this.evalExpr(decl.value, env));
        break;
      }
      case "DModule":
        await this.evalDecls(decl.decls, env);
        break;
      case "DStore":
        await this.evalStore(decl, env);
        break;
      case "DSaga":
        env.define(decl.name, {
          tag: "VSaga", name: decl.name, params: decl.params,
          steps: decl.steps, store: decl.store, env,
        });
        break;
      case "DStream": {
        // The declaration-site backpressure policy rides into the queue (SPEC §10.1).
        const q = new VStreamQueue(decl.policy);
        env.define(decl.name, { tag: "VStream", name: decl.name, q });
        // Register Push and Done constructors so producers can call them.
        env.define("Push", builtin("Push", args => ({ tag: "VCtor", name: "Push", payload: args[0] ?? { tag: "VUnit" } })));
        env.define("Done", { tag: "VCtor", name: "Done", payload: null });
        break;
      }
      case "DInputmap": {
        // The inputmap IS the drain loop over its stream (multitarget-design
        // �4.0); construction is shared with `++` layering via makeInputmap.
        env.define(decl.name, this.makeInputmap(decl.name, decl.stream,
          decl.rows.map(row => ({ row, env }))));
        break;
      }
      case "DImport": {
        // File-local import (loader.ts merged the imported file's decls): the
        // merged DModule decls already define these bindings in `env`. Nothing
        // to bind here.
        if (decl.local) break;
        // Mirror infer.ts's named-vs-namespace decision: a SINGLE name that is
        // NOT a member of the module is a NAMESPACE alias (`import String from
        // "std/string"` → bind the whole record); otherwise every name is a
        // NAMED import (`import { toUpper } from "String"` → bind that member).
        const mod = STDLIB_RUNTIME[decl.path];
        if (!mod) break; // unknown/opaque module — nothing to bind at runtime
        const isNamespace = decl.names.length === 1 && !(decl.names[0]!.name in mod);
        if (isNamespace) {
          const n = decl.names[0]!;
          env.define(n.alias ?? n.name, { tag: "VRecord", fields: new Map(Object.entries(mod)) });
        } else {
          for (const { name, alias } of decl.names) {
            const member = mod[name];
            if (member) env.define(alias ?? name, member);
          }
        }
        break;
      }
      // DMachine: skip
    }
  }

  // ── Machines & sagas (state machines) ───────────────────────────────────────
  //
  // A `machine` is a pure jump-table FSM. A `saga StoreName` is the same FSM with
  // two extra capabilities, carried in a SagaCtx:
  //   • a JOURNAL — every transition is recorded to `sagaJournals[store]`, so the
  //     run's progress is durable and inspectable (`journalOf "Store"`).
  //   • COMPENSATIONS — `expr ? rollback :step` defers an undo action; if the saga
  //     later transitions into `:abort`, the deferred steps run in reverse order.
  //   • `expr ?: rollback :step` recovers immediately when `expr` is a failure.

  private sagaJournals = new Map<string, SagaJournalEntry[]>();

  private async evalMachine(expr: Extract<Expr, { tag: "Machine" }>, env: Env): Promise<Value> {
    const steps = new Map(expr.steps.map(s => [s.name, s] as const));
    // Inline-saga journals are keyed by store name (legacy, singleton-per-store).
    const journal: SagaJournalEntry[] | null = expr.store ? [] : null;
    const ctx: SagaCtx | undefined = expr.store
      ? { store: expr.store, comps: [], steps, journal }
      : undefined;
    if (ctx) this.sagaJournals.set(ctx.store, journal!);  // fresh journal per run
    return this.runMachine(expr.steps[0]?.name, [], steps, env, ctx, journal);
  }

  // Bind a saga's constructor inputs into a fresh child of its closure env.
  private sagaEnv(saga: Extract<Value, { tag: "VSaga" }>, args: Value[]): Env {
    const env = saga.env.child();
    saga.params.forEach((p, idx) => {
      const b = matchPat(p.pat, args[idx] ?? { tag: "VUnit" });
      if (b) for (const [k, v] of b) env.define(k, v);
    });
    return env;
  }

  // Run a live first-class saga instance: bind its constructor inputs, journal
  // every transition into the per-INSTANCE `journal` (so concurrent instances
  // don't collide), and record final status. The same journal is also exposed
  // under the store name for `journalOf`. A `crash` mid-flight leaves the journal
  // intact (status `crashed`) so the instance can be `resume`d.
  async runSagaInstance(
    saga: Extract<Value, { tag: "VSaga" }>,
    args: Value[],
    journal: SagaJournalEntry[],
    status: SagaStatus,
  ): Promise<Value> {
    const steps = new Map(saga.steps.map(s => [s.name, s] as const));
    const storeName = saga.store ?? saga.name;
    const ctx: SagaCtx = { store: storeName, comps: [], steps, journal };
    this.sagaJournals.set(storeName, journal);
    return this.settleSaga(this.runMachine(saga.steps[0]?.name, [], steps, this.sagaEnv(saga, args), ctx, journal), journal, status);
  }

  // Re-hydrate a crashed saga from its durable journal and continue it. The
  // already-recorded steps are NOT re-executed; instead the compensation stack is
  // rebuilt from the journal's `comp` entries, and execution resumes at the last
  // recorded step (re-running just that one — at-least-once for the crash point).
  async resumeSagaInstance(
    saga: Extract<Value, { tag: "VSaga" }>,
    args: Value[],
    status: SagaStatus,
  ): Promise<Value> {
    const steps = new Map(saga.steps.map(s => [s.name, s] as const));
    const storeName = saga.store ?? saga.name;
    const journal = this.sagaJournals.get(storeName) ?? [];
    // Rebuild the compensation stack from the log (registration order; runs LIFO).
    const comps = journal.flatMap(e => e.kind === "comp" ? [{ target: e.target, args: e.args }] : []);
    const ctx: SagaCtx = { store: storeName, comps, steps, journal };

    // Resume at the last recorded step (the one we crashed in); if there is none,
    // start fresh from the entry step.
    const lastStep = [...journal].reverse().find(e => e.kind === "step") as Extract<SagaJournalEntry, { kind: "step" }> | undefined;
    const start = lastStep?.step ?? saga.steps[0]?.name;
    const startArgs = lastStep?.args ?? [];
    return this.settleSaga(
      this.runMachine(start, startArgs, steps, this.sagaEnv(saga, args), ctx, journal, /*skipFirstJournal*/ true),
      journal, status,
    );
  }

  // Await a saga's result, mapping the outcome to a status. A `SagaCrashSignal`
  // is swallowed (the journal survives for `resume`); other errors propagate.
  private async settleSaga(run: Promise<Value>, journal: SagaJournalEntry[], status: SagaStatus): Promise<Value> {
    try {
      const result = await run;
      status.value = journal.some(e => e.kind === "step" && e.step === "abort") ? "aborted" : "done";
      return result;
    } catch (e) {
      if (e instanceof SagaCrashSignal) {
        status.value = "crashed";
        return { tag: "VCtor", name: "Crashed", payload: { tag: "VStr", v: e.message } };
      }
      status.value = "aborted";
      throw e;
    }
  }

  // The shared transition loop for machines and sagas.
  private async runMachine(
    start: string | undefined,
    startArgs: Value[],
    steps: Map<string, import("./ast.js").MachineStep>,
    env: Env,
    ctx: SagaCtx | undefined,
    journal: SagaJournalEntry[] | null,
    skipFirstJournal = false,
  ): Promise<Value> {
    let current = start;
    let args: Value[] = startArgs;
    const MAX_TRANSITIONS = 100000;

    for (let i = 0; i < MAX_TRANSITIONS; i++) {
      if (current === undefined) return { tag: "VUnit" };
      const step = steps.get(current);
      if (!step) throw new RuntimeError(`${ctx ? "saga" : "machine"}: no such state ':${current}'`);

      // Journal the transition before running the step (so a crash mid-step still
      // leaves a record that we entered it). On `resume` the first step is already
      // in the journal, so we don't duplicate it.
      if (journal && !(skipFirstJournal && i === 0)) journal.push({ kind: "step", step: current, args });

      const stepEnv = env.child();
      step.params.forEach((p, idx) => stepEnv.define(p, args[idx] ?? { tag: "VUnit" }));

      const outcome = await this.runSagaBody(step.body, stepEnv, ctx);
      if (outcome.kind === "goto") {
        // Entering `:abort` triggers compensation: run deferred undos in reverse.
        if (ctx && outcome.target === "abort") await this.runCompensations(ctx, env);
        current = outcome.target; args = outcome.args; continue;
      }
      return outcome.value;   // terminal
    }
    throw new RuntimeError(`machine exceeded ${MAX_TRANSITIONS} transitions (infinite loop?)`);
  }

  // Run each registered compensation step, most-recent first. Compensations are
  // side-effecting cleanup (release stock, refund, ...) — any transition they
  // attempt is ignored; they run to settle the saga's external effects.
  // Slice-extraction (§2.11): a sub-region of a container. List/String slices are
  // value copies; a pointer slice is an aliasing VIEW — read/write splice through the
  // parent buffer in place, so the slice genuinely carries the parent's storage (the
  // borrow checker ties its lifetime to the parent's).
  private slice(obj: Value, lo: number, hi: number): Value {
    if (obj.tag === "VList") return { tag: "VList", elems: obj.elems.slice(lo, hi) };
    if (obj.tag === "VStr")  return { tag: "VStr", v: obj.v.slice(lo, hi) };
    if (obj.tag === "VPtr") {
      return {
        tag: "VPtr",
        label: `${obj.label}[${lo}..${hi}]`,
        read:  () => this.slice(obj.read(), lo, hi),
        write: (v) => {
          const base = obj.read();
          if (base.tag === "VList" && v.tag === "VList") {
            base.elems.splice(lo, hi - lo, ...v.elems);
            obj.write(base);
          } else if (base.tag === "VStr" && v.tag === "VStr") {
            obj.write({ tag: "VStr", v: base.v.slice(0, lo) + v.v + base.v.slice(hi) });
          } else {
            throw new RuntimeError("cannot write through this slice");
          }
        },
      };
    }
    throw new RuntimeError(`cannot slice ${obj.tag}`);
  }

  private async runCompensations(ctx: SagaCtx, env: Env): Promise<void> {
    while (ctx.comps.length > 0) {
      const c = ctx.comps.pop()!;
      const step = ctx.steps.get(c.target);
      if (!step) continue;
      const cenv = env.child();
      step.params.forEach((p, idx) => cenv.define(p, c.args[idx] ?? { tag: "VUnit" }));
      await this.runSagaBody(step.body, cenv, undefined);  // no nested compensation
    }
  }

  // Run a step/branch body. Either it transitions (goto) or yields a value.
  private async runSagaBody(body: import("./ast.js").SagaStmt[], env: Env, ctx: SagaCtx | undefined): Promise<{ kind: "goto"; target: string; args: Value[] } | { kind: "value"; value: Value }> {
    let last: Value = { tag: "VUnit" };
    for (const stmt of body) {
      switch (stmt.tag) {
        case "SBindS":
          env.define(stmt.name, await this.evalExpr(stmt.value, env));
          break;
        case "Goto":
          return { kind: "goto", target: stmt.target, args: await this.evalAll(stmt.args, env) };
        case "Yield":
          last = await this.evalExpr(stmt.expr, env);
          break;
        case "Rollback": {
          const v = await this.evalExpr(stmt.expr, env);
          if (stmt.mode === "defer") {
            // `expr ? rollback :step` — register an undo, passing the subject value
            // (e.g. the reservation to release). Runs in reverse on `:abort`, and
            // is logged to the journal so `resume` can rebuild the comp stack.
            if (ctx) {
              ctx.comps.push({ target: stmt.target, args: [v] });
              ctx.journal?.push({ kind: "comp", target: stmt.target, args: [v] });
            }
          } else {
            // `expr ?: rollback :step` — recover NOW if the subject is a failure.
            if (isFailure(v)) return { kind: "goto", target: stmt.target, args: [failurePayload(v)] };
          }
          break;
        }
        case "SagaMatch": {
          const subj = await this.evalExpr(stmt.subject, env);
          return await this.matchSagaBranches(subj, stmt.branches, env, "match", ctx);
        }
        case "SagaIf": {
          const cond = await this.evalExpr(stmt.cond, env);
          if (cond.tag !== "VBool") throw new RuntimeError(`machine: if condition must be Bool, got ${display(cond)}`);
          return await this.runSagaBody(cond.v ? stmt.then : stmt.else_, env.child(), ctx);
        }
        case "SagaGo":
          // Fire-and-forget: spawn a concurrent task, ignore its future.
          this.sched.spawn(() => this.evalExpr(stmt.expr, env));
          break;
        case "SagaJoin": {
          // Spawn all tasks concurrently, then join on the tuple of results.
          const futs = stmt.tasks.map(t => this.sched.spawn(() => this.evalExpr(t, env)));
          const results: Value[] = [];
          for (const f of futs) results.push(await this.sched.awaitFuture(f));
          const subject: Value = results.length === 1 ? results[0]! : { tag: "VTuple", elems: results };
          return await this.matchSagaBranches(subject, stmt.branches, env, "join", ctx);
        }
        case "SagaRace": {
          // Spawn every arm; the first to resolve wins. `after` sleeps then yields
          // Timeout; `until` yields Cancelled when its condition holds, else loses.
          const futs = stmt.arms.map(arm => {
            if (arm.kind === "after") return this.sched.spawn(async () => {
              await this.sched.sleep(arm.expr ? num(await this.evalExpr(arm.expr, env)) : 0);
              return { tag: "VCtor", name: "Timeout", payload: null } as Value;
            });
            if (arm.kind === "until") return this.sched.spawn(async () => {
              const c = arm.expr ? await this.evalExpr(arm.expr, env) : { tag: "VBool", v: false } as Value;
              if (c.tag === "VBool" && c.v) return { tag: "VCtor", name: "Cancelled", payload: null } as Value;
              return this.sched.never();
            });
            return this.sched.spawn(() => this.evalExpr(arm.expr!, env));
          });
          const subject = await this.sched.awaitFirst(futs);
          return await this.matchSagaBranches(subject, stmt.branches, env, "race", ctx);
        }
      }
    }
    return { kind: "value", value: last };
  }

  private async matchSagaBranches(subject: Value, branches: import("./ast.js").SagaBranch[], env: Env, what: string, ctx: SagaCtx | undefined): Promise<{ kind: "goto"; target: string; args: Value[] } | { kind: "value"; value: Value }> {
    for (const br of branches) {
      const b = matchPat(br.pat, subject);
      if (b) {
        const bs = env.child();
        for (const [k, v] of b) bs.define(k, v);
        return await this.runSagaBody(br.body, bs, ctx);
      }
    }
    throw new RuntimeError(`machine: no ${what} branch matched ${display(subject)}`);
  }

  // ── Stores ────────────────────────────────────────────────────────────────────

  private async evalStore(decl: Extract<Decl, { tag: "DStore" }>, env: Env): Promise<void> {
    const fields = new Map<string, Value>();
    for (const f of decl.fields) {
      fields.set(f.name, f.default_ ? await this.evalExpr(f.default_, env) : { tag: "VUnit" });
    }
    const state: Extract<Value, { tag: "VRecord" }> = { tag: "VRecord", fields };
    const rt: StoreRuntime = { state, fieldNames: decl.fields.map(f => f.name), pubs: decl.pubs, env, tail: Promise.resolve(), handlers: new Map() };
    this.stores.set(decl.name, rt);

    env.define(decl.name, state);
    await this.recomputePubs(rt);

    // Each message is callable; invoking it serializes through the store's
    // mailbox so concurrent senders never interleave (the actor guarantee).
    const handlers = new Map(decl.messages.map(m => [m.name, m] as const));
    rt.handlers = handlers;
    for (const msg of decl.messages) {
      env.define(msg.name, builtin(msg.name, async args => { await this.deliver(rt, msg.name, args); return { tag: "VUnit" }; }));
    }
  }

  // Run a store message handler under the store's exclusive lock, mutating its
  // state and recomputing pubs. Returns the store's state record (the reply).
  private deliver(rt: StoreRuntime, name: string, args: Value[]): Promise<Value> {
    const run = rt.tail.then(async () => {
      const msg = rt.handlers.get(name);
      if (!msg) throw new RuntimeError(`store has no message '${name}'`);
      const henv = this.storeScope(rt);
      msg.params.forEach((p, i) => {
        const b = matchPat(p.pat, args[i] ?? { tag: "VUnit" });
        if (b) for (const [k, v] of b) henv.define(k, v);
      });
      const result = await this.evalExpr(msg.body, henv);
      if (result.tag === "VRecord") {
        for (const [k, v] of result.fields) if (rt.fieldNames.includes(k)) rt.state.fields.set(k, v);
      }
      await this.recomputePubs(rt);
      return rt.state;
    });
    rt.tail = run.then(() => {}, () => {}); // next message waits for this one, success or fail
    return run;
  }

  private storeScope(rt: StoreRuntime): Env {
    const scope = rt.env.child();
    for (const name of rt.fieldNames) scope.define(name, rt.state.fields.get(name) ?? { tag: "VUnit" });
    return scope;
  }

  private async recomputePubs(rt: StoreRuntime): Promise<void> {
    const scope = this.storeScope(rt);
    for (const pub of rt.pubs) {
      const val = pub.body ? await this.evalExpr(pub.body, scope) : rt.state.fields.get(pub.name) ?? { tag: "VUnit" };
      rt.state.fields.set(pub.name, val);
    }
  }

  // ── Expressions ─────────────────────────────────────────────────────────────

  private async evalAll(exprs: Expr[], env: Env): Promise<Value[]> {
    const out: Value[] = [];
    for (const e of exprs) out.push(await this.evalExpr(e, env));
    return out;
  }

  async evalExpr(expr: Expr, env: Env): Promise<Value> {
    switch (expr.tag) {
      case "Lit":    return litToValue(expr.lit);
      case "Var":    return this.lookupVar(expr.name, env);
      case "Tuple":  return { tag: "VTuple", elems: await this.evalAll(expr.elems, env) };
      case "List":   return { tag: "VList",  elems: await this.evalAll(expr.elems, env) };
      case "Record": {
        const fields = new Map<string, Value>();
        if (expr.spread) {
          const base = await this.evalExpr(expr.spread, env);
          if (base.tag === "VRecord") for (const [k, v] of base.fields) fields.set(k, v);
        }
        for (const f of expr.fields) fields.set(f.name, await this.evalExpr(f.value, env));
        return { tag: "VRecord", fields };
      }

      case "Call": {
        const fn   = await this.evalExpr(expr.fn, env);
        const slots = fnSlots(fn);
        let args: Value[];
        if (needsResolution(slots, expr.named.length)) {
          // Evaluate positional then named values (left-to-right, preserving
          // effect order), then slot them onto the parameters and fill defaults.
          const positional = await this.evalAll(expr.args, env);
          const named: { name: string; value: Value }[] = [];
          for (const na of expr.named) named.push({ name: na.name, value: await this.evalExpr(na.value, env) });
          args = await this.resolveArgs(slots!, positional, named, env);
        } else {
          args = await this.evalAll(expr.args, env);
        }
        return await this.applyFn(fn, args, expr.fn.tag === "Var" ? expr.fn.name : "?");
      }

      case "Lambda": {
        const clause: FnClause = { params: expr.params, body: expr.body, ret: null, effects: [], effectTails: [], where_: [], lifetimeConstraints: [], surface: null, span: expr.span };
        return { tag: "VFn", name: "<lambda>", clauses: [clause], env };
      }

      case "BinOp":  return await this.evalBinOp(expr.op, expr.left, expr.right, env);
      case "UnOp":   return await this.evalUnOp(expr.op, expr.expr, env);

      case "Field": {
        const obj = await this.evalExpr(expr.obj, env);
        if (obj.tag === "VRecord") {
          const v = obj.fields.get(expr.field);
          if (v !== undefined) return v;
        }
        // Saga-handle introspection (per-instance journal/status/current step).
        if (obj.tag === "VSagaHandle") {
          const stepNames = obj.journal.flatMap(e => e.kind === "step" ? [e.step] : []);
          switch (expr.field) {
            case "journal": return { tag: "VList", elems: stepNames.map(s => ({ tag: "VAtom", name: s } as Value)) };
            case "status":  return { tag: "VAtom", name: obj.status.value };
            case "step":    return { tag: "VAtom", name: stepNames.at(-1) ?? "idle" };
            case "result":  return await this.sched.awaitFuture(obj.future);
          }
        }
        throw new RuntimeError(`no field '${expr.field}' on ${display(obj)}`);
      }

      case "Index": {
        // Slice-extraction (§2.11): a Range index returns a sub-region of the
        // container (detected syntactically — `xs[lo..hi]`). List/String slices are
        // value copies; a pointer slice is an aliasing view carrying the parent.
        if (expr.index.tag === "Range") {
          const target = await this.evalExpr(expr.obj, env);
          const from = await this.evalExpr(expr.index.from, env);
          const to   = await this.evalExpr(expr.index.to, env);
          if (from.tag !== "VNum" || to.tag !== "VNum") throw new RuntimeError("slice bounds must be numbers");
          const lo = Math.floor(from.v);
          const hi = expr.index.inclusive ? Math.floor(to.v) + 1 : Math.floor(to.v);
          return this.slice(target, lo, hi);
        }
        const obj = await this.evalExpr(expr.obj, env);
        const idx = await this.evalExpr(expr.index, env);
        if (obj.tag === "VList" && idx.tag === "VNum") {
          const i = Math.floor(idx.v);
          if (i < 0 || i >= obj.elems.length) throw new RuntimeError(`index ${i} out of bounds`);
          return obj.elems[i]!;
        }
        if (obj.tag === "VStr" && idx.tag === "VNum") return { tag: "VStr", v: obj.v[Math.floor(idx.v)] ?? "" };
        if (obj.tag === "VDict") {
          const slot = obj.entries.get(dictKey(idx));
          if (!slot) throw new RuntimeError(`key not found: ${display(idx)}`);
          return slot[1];
        }
        throw new RuntimeError(`cannot index ${obj.tag} with ${display(idx)}`);
      }

      case "AddrOf": {
        // Borrow an lvalue: a pointer to a `Var` aliases its env binding, so a
        // later write through the pointer is observable at the name and vice
        // versa. Any other expression is an rvalue — snapshot it into a cell.
        if (expr.expr.tag === "Var") {
          const name = expr.expr.name;
          return {
            tag: "VPtr",
            label: name,
            read:  () => this.lookupVar(name, env),
            write: (v) => env.set(name, v),
          };
        }
        // Pointer into an aggregate: `xs[i].&` / `rec.f.&`. The container value is
        // held by reference (a JS array / Map), so read/write through the captured
        // slot are observable at the original binding — true aliasing, no copy.
        if (expr.expr.tag === "Index") {
          const obj = await this.evalExpr(expr.expr.obj, env);
          const idx = await this.evalExpr(expr.expr.index, env);
          const lbl = exprLabel(expr.expr.obj);
          if (obj.tag === "VList" && idx.tag === "VNum") {
            const i = Math.floor(idx.v);
            const inBounds = () => { if (i < 0 || i >= obj.elems.length) throw new RuntimeError(`pointer index ${i} out of bounds`); };
            inBounds();
            return {
              tag: "VPtr",
              label: `${lbl}[${i}]`,
              read:  () => { inBounds(); return obj.elems[i]!; },
              write: (v) => { inBounds(); obj.elems[i] = v; },
            };
          }
          if (obj.tag === "VDict") {
            const k = dictKey(idx);
            return {
              tag: "VPtr",
              label: `${lbl}[${display(idx)}]`,
              read:  () => { const s = obj.entries.get(k); if (!s) throw new RuntimeError(`key not found: ${display(idx)}`); return s[1]; },
              write: (v) => { obj.entries.set(k, [idx, v]); },
            };
          }
          if (obj.tag === "VStr" && idx.tag === "VNum") {
            const i = Math.floor(idx.v);
            const inBounds = () => { if (i < 0 || i >= obj.v.length) throw new RuntimeError(`pointer index ${i} out of bounds`); };
            inBounds();
            return {
              tag: "VPtr",
              label: `${lbl}[${i}]`,
              read:  () => { inBounds(); return { tag: "VStr", v: obj.v[i]! }; },
              write: (v) => { inBounds(); if (v.tag !== "VStr") throw new RuntimeError(`cannot assign ${v.tag} to a string index`); obj.v = obj.v.slice(0, i) + v.v + obj.v.slice(i + 1); },
            };
          }
        }
        if (expr.expr.tag === "Field") {
          const obj = await this.evalExpr(expr.expr.obj, env);
          if (obj.tag === "VRecord") {
            const f = expr.expr.field;
            if (!obj.fields.has(f)) throw new RuntimeError(`cannot borrow unknown field '${f}'`);
            return {
              tag: "VPtr",
              label: `${exprLabel(expr.expr.obj)}.${f}`,
              read:  () => obj.fields.get(f)!,
              write: (v) => { obj.fields.set(f, v); },
            };
          }
        }
        let cell = await this.evalExpr(expr.expr, env);
        return { tag: "VPtr", label: "_", read: () => cell, write: (v) => { cell = v; } };
      }

      case "Deref": {
        const p = await this.evalExpr(expr.expr, env);
        if (p.tag !== "VPtr") throw new RuntimeError(`cannot dereference non-pointer ${display(p)}`);
        return p.read();
      }

      case "Match":  return await this.evalMatch(expr.subject, expr.branches, env);

      case "If": {
        const cond = await this.evalExpr(expr.cond, env);
        if (cond.tag !== "VBool") throw new RuntimeError(`if condition must be Bool, got ${display(cond)}`);
        if (cond.v) return await this.evalExpr(expr.then, env);
        if (expr.else_) return await this.evalExpr(expr.else_, env);
        return { tag: "VUnit" };
      }

      case "Do":   return await this.evalBlock(expr.stmts, env);
      case "Loop": return await this.evalLoop(expr.stmts, env);

      case "Break":    throw new BreakSignal(expr.value ? await this.evalExpr(expr.value, env) : null);
      case "Continue": throw new ContinueSignal();

      case "Machine": return await this.evalMachine(expr, env);

      case "Go": {
        // `go Checkout(args)` spawns a live saga instance with its own journal &
        // status, returning a handle; `go expr` otherwise yields a plain future.
        if (expr.expr.tag === "Call" && expr.expr.fn.tag === "Var") {
          const saga = env.lookup(expr.expr.fn.name);
          if (saga?.tag === "VSaga") {
            let args = await this.evalAll(expr.expr.args, env);
            if (args.length === 1 && args[0]!.tag === "VUnit") args = [];
            const journal: SagaJournalEntry[] = [];
            const status: SagaStatus = { value: "running" };
            const future = this.sched.spawn(() => this.runSagaInstance(saga, args, journal, status));
            return { tag: "VSagaHandle", name: saga.name, future, journal, status };
          }
        }
        return { tag: "VFuture", future: this.sched.spawn(() => this.evalExpr(expr.expr, env)) };
      }

      case "Resume": {
        // `resume Checkout(args)` re-hydrates a crashed saga from its journal and
        // runs it to completion synchronously (returning the result). A non-saga
        // `resume` is the identity on its inner value.
        if (expr.expr.tag === "Call" && expr.expr.fn.tag === "Var") {
          const saga = env.lookup(expr.expr.fn.name);
          if (saga?.tag === "VSaga") {
            let args = await this.evalAll(expr.expr.args, env);
            if (args.length === 1 && args[0]!.tag === "VUnit") args = [];
            return await this.resumeSagaInstance(saga, args, { value: "running" });
          }
        }
        return await this.evalExpr(expr.expr, env);
      }

      case "Drop": {
        // Evaluate the operand for its effects, then discard it. Runtime is GC'd,
        // so this is observably a no-op beyond evaluation; the borrow checker is
        // where `drop` carries its real (compile-time) meaning. Yields Unit.
        await this.evalExpr(expr.expr, env);
        return { tag: "VUnit" };
      }

      case "Try":
        // Implicit: each line auto-unwraps its Result; first failure collapses the
        // block; value is `Ok(last)`. See evalTryBody.
        return await this.evalTryBody(expr.stmts, env);

      case "Retry": {
        // Run the body like a `try`; on Error (success path `Ok` or a `?`-collapse)
        // re-run, up to `count` attempts if given, else until it succeeds. Yields
        // the first non-failure value, or the last Error once attempts run out.
        let max = Infinity;
        let schedule: number[] | null = null;     // per-retry delay schedule (ms)
        if (expr.count) {
          const cv = await this.evalExpr(expr.count, env);
          if (cv.tag === "VNum") {
            max = cv.v;
          } else if (cv.tag === "VList") {
            // backoff schedule: len+1 attempts, with these delays before each retry
            schedule = cv.elems.map(e => e.tag === "VNum" ? e.v : 0);
            max = schedule.length + 1;
          } else {
            throw new RuntimeError(`retry count must be a Number or a list of delays, got ${display(cv)}`);
          }
        }
        let fixedDelay = 0;                        // `after D` — same delay each retry
        if (expr.delay) {
          const dv = await this.evalExpr(expr.delay, env);
          if (dv.tag !== "VNum") throw new RuntimeError(`retry delay must be a Number/Duration, got ${display(dv)}`);
          fixedDelay = dv.v;
        }
        let last: Value = { tag: "VCtor", name: "Error", payload: { tag: "VUnit" } };
        for (let attempt = 0; attempt < max; attempt++) {
          if (attempt > 0) {                       // delay before a retry, not the first try
            const d = schedule ? (schedule[attempt - 1] ?? 0) : fixedDelay;
            if (d > 0) await this.sched.sleep(d);
          }
          const result = await this.evalTryBody(expr.stmts, env);
          if (!isFailure(result)) return result;   // Ok → done
          last = result;                            // Error → retry
        }
        return last;
      }

      case "Await": {
        const v = await this.evalExpr(expr.expr, env);
        let resolved: Value;
        if (v.tag === "VStream") {
          // Block until the stream produces the next value, then pattern match.
          resolved = await v.q.next();
        } else {
          resolved = v.tag === "VFuture" || v.tag === "VSagaHandle"
            ? await this.sched.awaitFuture(v.future) : v;
        }
        if (expr.branches.length === 0) return resolved;
        return await this.matchBranches(resolved, expr.branches, env);
      }

      case "For": {
        const results: Value[] = [];
        const step = async (i: number, scope: Env): Promise<boolean> => {
          if (i === expr.clauses.length) {
            try { results.push(await this.evalExpr(expr.body, scope)); }
            catch (e) {
              if (e instanceof BreakSignal) return false;
              if (e instanceof ContinueSignal) return true;
              throw e;
            }
            return true;
          }
          const clause = expr.clauses[i]!;
          if (clause.tag === "Filter") {
            const c = await this.evalExpr(clause.cond, scope);
            if (c.tag === "VBool" && !c.v) return true;
            if (c.tag !== "VBool") throw new RuntimeError(`for filter must be Bool, got ${display(c)}`);
            return await step(i + 1, scope);
          }
          for (const elem of toList(await this.evalExpr(clause.iter, scope))) {
            const inner = scope.child();
            const bindings = matchPat(clause.binding, elem);
            if (!bindings) throw new RuntimeError(`for binding failed on ${display(elem)}`);
            for (const [k, v] of bindings) inner.define(k, v);
            if (!(await step(i + 1, inner))) return false;
          }
          return true;
        };
        await step(0, env);
        return { tag: "VList", elems: results };
      }

      case "Range": {
        const from = await this.evalExpr(expr.from, env);
        const to   = await this.evalExpr(expr.to, env);
        if (from.tag !== "VNum" || to.tag !== "VNum") throw new RuntimeError("range requires numbers");
        const elems: Value[] = [];
        const end = expr.inclusive ? to.v : to.v - 1;
        for (let i = from.v; i <= end; i++) elems.push({ tag: "VNum", v: i });
        return { tag: "VList", elems };
      }

      case "Propagate": {
        const v = await this.evalExpr(expr.expr, env);
        if (v.tag === "VCtor" && v.name === "Ok") return v.payload ?? { tag: "VUnit" };
        if (v.tag === "VCtor" && v.name === "Error") throw new ReturnSignal(v);
        return v;
      }

      case "PropWith": {
        const v = await this.evalExpr(expr.expr, env);
        if (v.tag === "VCtor" && v.name === "Ok") return v.payload ?? { tag: "VUnit" };
        return await this.evalExpr(expr.alt, env);
      }

      case "TypeTest": {
        const v = await this.evalExpr(expr.expr, env);
        const name = expr.against.tag === "TRNamed" ? expr.against.name : null;
        if (!name) return { tag: "VBool", v: true };
        return { tag: "VBool", v: v.tag === "VCtor" && v.name === name };
      }

      case "Send": {
        // Evaluate the message, then route to the stream queue or store mailbox.
        const msg = await this.evalExpr(expr.msg, env);
        const target = env.lookup(expr.store);
        if (target?.tag === "VStream") {
          // Stream: hand the VCtor value (Push(v) or Done) to the queue under the
          // stream's declared backpressure policy — a `block` stream parks this
          // producer here until a consumer takes the value.
          await target.q.send(msg);
          return { tag: "VUnit" };
        }
        // Regular store: msg is already evaluated (e.g. Increment() dispatched its mailbox)
        // The message call already ran the handler; nothing more to do.
        return { tag: "VUnit" };
      }

      case "Transaction": {
        // Atomic store coordination (SPEC §8). Snapshot every store, run the
        // body: on success keep the writes (commit) → `Ok result`; on failure
        // restore every store (rollback). `within { maxRetry }` retries on
        // failure up to maxRetry times, then yields `Conflict { retries }`;
        // `within { to }` bounds it by the virtual clock → `Timeout { after }`.
        let maxRetry = 0;
        let deadline: number | null = null;
        if (expr.config) {
          const cfg = await this.evalExpr(expr.config, env);
          if (cfg.tag === "VRecord") {
            const mr = cfg.fields.get("maxRetry");
            if (mr?.tag === "VNum") maxRetry = mr.v;
            const to = cfg.fields.get("to");
            if (to?.tag === "VNum") deadline = to.v;
          }
        }
        let retries = 0;
        for (;;) {
          if (deadline !== null && this.sched.now() > deadline) {
            return { tag: "VCtor", name: "Timeout",
              payload: { tag: "VRecord", fields: new Map([["after", { tag: "VNum", v: this.sched.now() }]]) } };
          }
          const snapshot = this.snapshotStores();
          let failure: Value | null = null;   // non-null ⇒ the body aborted with this Error/None
          try {
            const result = await this.evalBlock(expr.body, env);
            if (!isFailure(result)) return { tag: "VCtor", name: "Ok", payload: result }; // commit
            failure = result;                 // body's last expr was Error/None
          } catch (e) {
            if (e instanceof SagaCrashSignal) {
              this.restoreStores(snapshot);
              return { tag: "VCtor", name: "Cancelled", payload: null };  // nullary — matches `| Cancelled ->`
            }
            if (e instanceof ReturnSignal && isFailure(e.value)) {
              failure = e.value;              // `?` propagated an Error inside the txn
            } else {
              this.restoreStores(snapshot);   // RuntimeError / Break / Continue
              throw e;
            }
          }
          // Abort path: roll back, then retry or surface the outcome.
          this.restoreStores(snapshot);
          if (retries < maxRetry) { retries++; continue; }
          if (expr.config) {
            return { tag: "VCtor", name: "Conflict",
              payload: { tag: "VRecord", fields: new Map([["retries", { tag: "VNum", v: retries }]]) } };
          }
          return failure;                     // bare transaction: surface the raw Error/None
        }
      }

      case "Element": {
        // Build a VElement value tree. Props evaluate to a name→value map; the
        // leading content (`Text "hi"`) becomes the node's text; `on …` handler
        // children are captured as zero-arg closures in `events` (run on dispatch,
        // not now); every other child evaluates to a child node (lists flatten).
        const text = expr.content ? await this.evalExpr(expr.content, env) : null;
        const props = new Map<string, Value>();
        for (const p of expr.props) {
          // A prop referencing self/parent/prev/next/children is held unevaluated
          // and resolved by the convergence pass (§6), once the tree is concrete.
          if (hasConvRef(p.value)) props.set(p.name, { tag: "VDeferred", expr: p.value, env });
          else {
            let pv = await this.evalExpr(p.value, env);
            // Responsive(Length) auto-collapse (§9.3): a prop value that is a
            // `Breakpoint -> Length` function (one Breakpoint param) is applied to the
            // live viewport root's breakpoint HERE, before emit — so a viewport swap
            // (setViewport) re-collapses it on the next render, exactly as a theme swap
            // re-folds theme reads. No prop legitimately holds a function value, and
            // infer has already gated which functions reach here, so this is unambiguous.
            if (pv.tag === "VFn" && pv.clauses[0]?.params.length === 1) {
              const vp = env.lookup("viewport");
              const bp = vp?.tag === "VRecord" ? vp.fields.get("breakpoint") : undefined;
              if (bp) pv = await this.applyFn(pv, [bp], "responsive");
            }
            props.set(p.name, pv);
          }
        }
        const events = new Map<string, Value>();
        const children: Value[] = [];
        for (const c of expr.children) {
          if (c.tag === "Handler") {
            const body = c.body, param = c.param, capturedEnv = env;
            events.set(c.event, { tag: "VBuiltin", name: `on:${c.event}`, fn: (args: Value[]) => {
              if (!param) return this.evalExpr(body, capturedEnv);
              const e2 = capturedEnv.child();
              e2.define(param, args[0] ?? emptyEvent());
              return this.evalExpr(body, e2);
            } });
          } else {
            children.push(await this.evalExpr(c, env));
          }
        }
        return { tag: "VElement", name: expr.name, text, props, children, events };
      }

      case "Handler": {
        // A handler reached outside an element child position: capture as a thunk
        // that binds its optional event param when invoked.
        const body = expr.body, param = expr.param, capturedEnv = env;
        return { tag: "VBuiltin", name: `on:${expr.event}`, fn: (args: Value[]) => {
          if (!param) return this.evalExpr(body, capturedEnv);
          const e2 = capturedEnv.child();
          e2.define(param, args[0] ?? emptyEvent());
          return this.evalExpr(body, e2);
        } };
      }

      case "JSExpr": {
        // Evaluate raw JS code. The code runs in a context with access to JS globals
        // and a `$velve` object for Velve ↔ JS interop. Current env bindings are
        // exposed as a plain JS object on `$velve.env`.
        const jsEnv: Record<string, unknown> = {};
        for (const [k, v] of env.allBindings()) jsEnv[k] = velveToJs(v);
        let result: unknown;
        try {
          // eslint-disable-next-line no-new-func
          result = new Function("$velve", `"use strict"; return (${expr.code})`)({ env: jsEnv });
        } catch (e: unknown) {
          throw new RuntimeError(`@js error: ${e instanceof Error ? e.message : String(e)}`);
        }
        return jsToVelve(result);
      }
    }
  }

  // ── Block / loop ─────────────────────────────────────────────────────────────

  // Implicit `try` body: each line auto-unwraps its Result — `Ok v` binds/yields
  // `v`, `Error`/`None` collapses the whole block to that failure, a non-Result
  // passes through unchanged. The block's value is `Ok(last)` (or the last value
  // if it is already a Result). An explicit `?` inside still works (its
  // ReturnSignal is caught at the boundary).
  private async evalTryBody(stmts: Stmt[], parentEnv: Env): Promise<Value> {
    let env = parentEnv.child();
    let last: Value = { tag: "VUnit" };
    const peel = (v: Value): { fail: Value | null; val: Value } => {
      if (v.tag === "VCtor" && v.name === "Ok") return { fail: null, val: v.payload ?? { tag: "VUnit" } };
      if (v.tag === "VCtor" && (v.name === "Error" || v.name === "None")) return { fail: v, val: v };
      return { fail: null, val: v };
    };
    try {
      for (const stmt of stmts) {
        switch (stmt.tag) {
          case "SBind": {
            const u = peel(await this.evalExpr(stmt.value, env));
            if (u.fail) return u.fail;
            if (!stmt.declares && stmt.pat.tag === "PVar" && env.lookup(stmt.pat.name) !== undefined) {
              env.set(stmt.pat.name, u.val); last = { tag: "VUnit" }; break;
            }
            const next = env.child();
            const bindings = matchPat(stmt.pat, u.val);
            if (!bindings) throw new RuntimeError(`pattern match failed in try bind: ${display(u.val)}`);
            for (const [k, v] of bindings) next.define(k, v);
            env = next; last = { tag: "VUnit" }; break;
          }
          case "SExpr": {
            const u = peel(await this.evalExpr(stmt.expr, env));
            if (u.fail) return u.fail;
            last = u.val; break;
          }
          case "SAssign": await this.evalAssign(stmt.target, stmt.value, env); last = { tag: "VUnit" }; break;
          case "SReturn": throw new ReturnSignal(stmt.value ? await this.evalExpr(stmt.value, env) : { tag: "VUnit" });
          case "SBreak":  throw new BreakSignal(stmt.value ? await this.evalExpr(stmt.value, env) : null);
        }
      }
    } catch (e) {
      if (e instanceof ReturnSignal && isFailure(e.value)) return e.value;
      throw e;
    }
    if (last.tag === "VCtor" && (last.name === "Ok" || last.name === "Error")) return last;
    return { tag: "VCtor", name: "Ok", payload: last };
  }

  private async evalBlock(stmts: Stmt[], parentEnv: Env): Promise<Value> {
    let env = parentEnv.child();
    let last: Value = { tag: "VUnit" };
    for (const stmt of stmts) {
      switch (stmt.tag) {
        case "SBind": {
          const val = await this.evalExpr(stmt.value, env);
          if (!stmt.declares && stmt.pat.tag === "PVar" && env.lookup(stmt.pat.name) !== undefined) {
            env.set(stmt.pat.name, val);
            last = { tag: "VUnit" };
            break;
          }
          const next = env.child();
          const bindings = matchPat(stmt.pat, val);
          if (!bindings) throw new RuntimeError(`pattern match failed in bind: ${display(val)}`);
          for (const [k, v] of bindings) next.define(k, v);
          env = next;
          last = { tag: "VUnit" };
          break;
        }
        case "SExpr":   last = await this.evalExpr(stmt.expr, env); break;
        case "SAssign": await this.evalAssign(stmt.target, stmt.value, env); last = { tag: "VUnit" }; break;
        case "SReturn": throw new ReturnSignal(stmt.value ? await this.evalExpr(stmt.value, env) : { tag: "VUnit" });
        case "SBreak":  throw new BreakSignal(stmt.value ? await this.evalExpr(stmt.value, env) : null);
      }
    }
    return last;
  }

  // Write through an lvalue: `p.* = v` (pointer), `xs[i] = v` (list element), or
  // `rec.f = v` (record field). All mutate a by-reference container in place, so
  // the write is observable wherever the container is bound or aliased.
  private async evalAssign(target: Expr, value: Expr, env: Env): Promise<void> {
    const v = await this.evalExpr(value, env);
    if (target.tag === "Deref") {
      const p = await this.evalExpr(target.expr, env);
      if (p.tag !== "VPtr") throw new RuntimeError(`cannot assign through non-pointer ${display(p)}`);
      p.write(v);
      return;
    }
    if (target.tag === "Index") {
      const obj = await this.evalExpr(target.obj, env);
      const idx = await this.evalExpr(target.index, env);
      if (obj.tag === "VList" && idx.tag === "VNum") {
        const i = Math.floor(idx.v);
        if (i < 0 || i >= obj.elems.length) throw new RuntimeError(`index ${i} out of bounds`);
        obj.elems[i] = v;
        return;
      }
      if (obj.tag === "VDict") {                       // insert or update the slot
        obj.entries.set(dictKey(idx), [idx, v]);
        return;
      }
      if (obj.tag === "VStr" && idx.tag === "VNum") {   // replace one character in place
        const i = Math.floor(idx.v);
        if (i < 0 || i >= obj.v.length) throw new RuntimeError(`index ${i} out of bounds`);
        if (v.tag !== "VStr") throw new RuntimeError(`cannot assign ${v.tag} to a string index`);
        obj.v = obj.v.slice(0, i) + v.v + obj.v.slice(i + 1);
        return;
      }
      throw new RuntimeError(`cannot index-assign ${obj.tag}`);
    }
    if (target.tag === "Field") {
      const obj = await this.evalExpr(target.obj, env);
      if (obj.tag === "VRecord") { obj.fields.set(target.field, v); return; }
      throw new RuntimeError(`cannot field-assign ${obj.tag}`);
    }
    throw new RuntimeError(`invalid assignment target`);
  }

  // ── Transactions ─────────────────────────────────────────────────────────────
  // Shallow-copy every store's field map so a failed `transaction` can restore
  // the exact pre-transaction state. Store mutation is by value-replacement
  // (handlers merge a partial record), so a shallow copy of the field map is a
  // complete snapshot; nested values are never mutated in place.
  private snapshotStores(): Map<string, Map<string, Value>> {
    const snap = new Map<string, Map<string, Value>>();
    for (const [name, rt] of this.stores) snap.set(name, new Map(rt.state.fields));
    return snap;
  }

  private restoreStores(snap: Map<string, Map<string, Value>>): void {
    for (const [name, fields] of snap) {
      const rt = this.stores.get(name);
      if (!rt) continue;
      rt.state.fields.clear();
      for (const [k, v] of fields) rt.state.fields.set(k, v);
    }
  }

  private async evalLoop(stmts: Stmt[], env: Env): Promise<Value> {
    for (;;) {
      try { await this.evalBlock(stmts, env); }
      catch (e) {
        if (e instanceof BreakSignal) return e.value ?? { tag: "VUnit" };
        if (e instanceof ContinueSignal) continue;
        throw e;
      }
    }
  }

  // ── Match ────────────────────────────────────────────────────────────────────

  private async evalMatch(subjectExpr: Expr, branches: Branch[], env: Env): Promise<Value> {
    return await this.matchBranches(await this.evalExpr(subjectExpr, env), branches, env);
  }

  private async matchBranches(subject: Value, branches: Branch[], env: Env): Promise<Value> {
    for (const branch of branches) {
      const bindings = matchPat(branch.pat, subject);
      if (!bindings) continue;
      const inner = env.child();
      for (const [k, v] of bindings) inner.define(k, v);
      if (branch.guard) {
        const g = await this.evalExpr(branch.guard, inner);
        if (g.tag !== "VBool" || !g.v) continue;
      }
      return await this.evalExpr(branch.body, inner);
    }
    throw new RuntimeError(`non-exhaustive match on ${display(subject)}`);
  }

  // Slot evaluated positional + named values onto a function's parameters and
  // fill any defaults (evaluated lazily in `env`). The type-checker has already
  // validated the call, so this stays lenient: a missing arg just yields a
  // short vector, which applyFn then treats as partial application.
  private async resolveArgs(
    slots: ParamSlot[], positional: Value[], named: { name: string; value: Value }[], env: Env,
  ): Promise<Value[]> {
    const bound: (Value | undefined)[] = new Array(slots.length).fill(undefined);
    for (let i = 0; i < positional.length && i < slots.length; i++)
      if (!slots[i]!.keywordOnly) bound[i] = positional[i];
    for (const { name, value } of named) {
      const idx = slots.findIndex(p => p.name === name);
      if (idx >= 0) bound[idx] = value;
    }
    const out: Value[] = [];
    for (let i = 0; i < slots.length; i++) {
      if (bound[i] !== undefined) out.push(bound[i]!);
      else if (slots[i]!.default_) out.push(await this.evalExpr(slots[i]!.default_!, env));
    }
    return out;
  }

  // ── Function application ─────────────────────────────────────────────────────

  async applyFn(fn: Value, args: Value[], callSite: string): Promise<Value> {
    // f() lowers to Call { args: [Unit] } — strip to zero args.
    if (args.length === 1 && args[0]!.tag === "VUnit") args = [];

    if (fn.tag === "VBuiltin") return await fn.fn(args);
    // Calling a saga by name runs it to completion and yields its result.
    if (fn.tag === "VSaga") {
      return await this.runSagaInstance(fn, args, [], { value: "running" });
    }
    if (fn.tag !== "VFn") throw new RuntimeError(`cannot call ${display(fn)}`);

    // Exact-arity clauses take priority (preserves multi-arity dispatch).
    for (const clause of fn.clauses) {
      if (clause.params.length !== args.length) continue;
      const r = await this.runClause(fn, clause, args.slice(0, clause.params.length));
      if (r.ok) return r.value;
    }

    // Over-application (currying): `g(1)(3)` and curried `g 1 3` both parse as a
    // single multi-arg call. Let a clause consume the first N args and apply the
    // resulting function to the remainder.
    for (const clause of fn.clauses) {
      const n = clause.params.length;
      if (n === 0 || n >= args.length) continue;
      const r = await this.runClause(fn, clause, args.slice(0, n));
      if (r.ok) return await this.applyFn(r.value, args.slice(n), callSite);
    }

    // Under-application (partial application): fewer args than every clause's
    // arity → return a closure that captures these args and waits for the rest,
    // then re-invokes the original function with the full set (keeps multi-clause
    // dispatch correct — clause selection happens once all args are present).
    const fnVal = fn;
    const minArity = Math.min(...fn.clauses.map(c => c.params.length));
    if (args.length > 0 && args.length < minArity) {
      const bound = args;
      return {
        tag: "VBuiltin",
        name: `${callSite}(partial)`,
        fn: (more: Value[]) => this.applyFn(fnVal, [...bound, ...more], callSite),
      };
    }

    throw new RuntimeError(`non-exhaustive patterns in '${callSite}' for args: ${args.map(display).join(", ")}`);
  }

  // Bind one clause against exactly `args` (length must equal clause arity).
  // Returns {ok:false} if a parameter pattern fails so the caller can try the
  // next clause; throws for genuine runtime errors inside the body.
  private async runClause(
    fn: Value & { tag: "VFn" },
    clause: FnClause,
    args: Value[],
  ): Promise<{ ok: true; value: Value } | { ok: false }> {
    const inner = fn.env.child();
    for (let i = 0; i < clause.params.length; i++) {
      const b = matchPat(clause.params[i]!.pat, args[i]!);
      if (!b) return { ok: false };
      for (const [k, v] of b) inner.define(k, v);
    }
    for (const { pat, value } of clause.where_) {
      const wv = await this.evalExpr(value, inner);
      const wb = matchPat(pat, wv);
      if (!wb) throw new RuntimeError(`where binding failed`);
      for (const [k, v] of wb) inner.define(k, v);
    }
    // `using surface = <expr>` (inline form) introduces a body-scoped binding.
    if (clause.surface?.value) {
      inner.define(clause.surface.name, await this.evalExpr(clause.surface.value, inner));
    }
    try {
      return { ok: true, value: await this.evalExpr(clause.body, inner) };
    } catch (e) {
      if (e instanceof ReturnSignal) return { ok: true, value: e.value };
      throw e;
    }
  }

  // ── Operators ────────────────────────────────────────────────────────────────

  private async evalBinOp(op: string, leftExpr: Expr, rightExpr: Expr, env: Env): Promise<Value> {
    if (op === "&&") {
      const l = await this.evalExpr(leftExpr, env);
      if (l.tag !== "VBool") throw new RuntimeError(`&& requires Bool`);
      if (!l.v) return { tag: "VBool", v: false };
      return await this.evalExpr(rightExpr, env);
    }
    if (op === "||") {
      const l = await this.evalExpr(leftExpr, env);
      if (l.tag !== "VBool") throw new RuntimeError(`|| requires Bool`);
      if (l.v) return { tag: "VBool", v: true };
      return await this.evalExpr(rightExpr, env);
    }
    if (op === "|>") {
      const l = await this.evalExpr(leftExpr, env);
      const f = await this.evalExpr(rightExpr, env);
      return await this.applyFn(f, [l], "|>");
    }

    const l = await this.evalExpr(leftExpr, env);
    const r = await this.evalExpr(rightExpr, env);

    switch (op) {
      case "+":  return numOp(l, r, (a, b) => a + b);
      case "-":  return numOp(l, r, (a, b) => a - b);
      case "*":  return numOp(l, r, (a, b) => a * b);
      case "/":  return numOp(l, r, (a, b) => a / b);
      case "%":  return numOp(l, r, (a, b) => a % b);
      case "**": return numOp(l, r, (a, b) => a ** b);
      case "^":  return numOp(l, r, (a, b) => a ** b);
      case "<":  return cmpOp(l, r, (a, b) => a < b);
      case ">":  return cmpOp(l, r, (a, b) => a > b);
      case "<=": return cmpOp(l, r, (a, b) => a <= b);
      case ">=": return cmpOp(l, r, (a, b) => a >= b);
      case "==": return { tag: "VBool", v: equal(l, r) };
      case "!=": return { tag: "VBool", v: !equal(l, r) };
      case "++": {
        // Inputmap layering (SPEC �10.5): `base ++ overrides`  an unguarded
        // override row REPLACES the same-pattern base row in place (so help
        // keeps the base ordering); everything else appends after the base
        // rows. Guarded rows never replace and are never replaced (a guard may
        // fail, so they don't claim a pattern). Same-stream is checked at
        // check time (the Inputmap type carries the stream).
        const li = this.inputmapInfo.get(l), ri = this.inputmapInfo.get(r);
        if (li && ri) {
          const replaced = li.rows.map(le => {
            if (le.row.guard) return le;
            const ov = ri.rows.find(re => !re.row.guard && patKey(re.row.pat) === patKey(le.row.pat));
            return ov ?? le;
          });
          const added = ri.rows.filter(re =>
            re.row.guard || !li.rows.some(le => !le.row.guard && patKey(le.row.pat) === patKey(re.row.pat)));
          return this.makeInputmap(`${li.name}++${ri.name}`, li.stream, [...replaced, ...added]);
        }
        if (l.tag === "VStr" && r.tag === "VStr") return { tag: "VStr", v: l.v + r.v };
        if (l.tag === "VList" && r.tag === "VList") return { tag: "VList", elems: [...l.elems, ...r.elems] };
        throw new RuntimeError(`++ requires two Strings or two Lists, got ${display(l)} and ${display(r)}`);
      }
    }
    throw new RuntimeError(`unknown operator: ${op}`);
  }

  private async evalUnOp(op: string, exprNode: Expr, env: Env): Promise<Value> {
    const v = await this.evalExpr(exprNode, env);
    switch (op) {
      case "-":   if (v.tag === "VNum") return { tag: "VNum", v: -v.v }; break;
      case "!":   if (v.tag === "VBool") return { tag: "VBool", v: !v.v }; break;
      case "not": if (v.tag === "VBool") return { tag: "VBool", v: !v.v }; break;
    }
    throw new RuntimeError(`cannot apply ${op} to ${display(v)}`);
  }

  private lookupVar(name: string, env: Env): Value {
    const v = env.lookup(name);
    if (v !== undefined) return v;
    // Ambient stdlib namespace (mirrors resolve/infer, SPEC 5.5): Math.sqrt(x)
    // with no import. Capitalized aliases only, and only after a normal lookup
    // fails, so user bindings shadow modules. Lowercase/path forms stay import-only.
    if (/^[A-Z]/.test(name)) {
      const mod = STDLIB_RUNTIME[name];
      if (mod) return { tag: "VRecord", fields: new Map(Object.entries(mod)) };
    }
    throw new RuntimeError(`undefined variable: ${name}`);
  }
}

// The parameter slots of a callable value, for named-argument / default
// resolution. Only user functions (VFn) carry declared parameters; builtins and
// constructors take their args positionally (undefined → fast positional path).
function fnSlots(fn: Value): ParamSlot[] | undefined {
  if (fn.tag === "VFn" && fn.clauses[0]) {
    return fn.clauses[0].params.map((p: Param) => ({
      name: paramName(p),
      keywordOnly: p.keywordOnly === true,
      ...(p.default_ ? { default_: p.default_ } : {}),
    }));
  }
  return undefined;
}

function paramName(p: Param): string {
  return p.pat.tag === "PVar" ? p.pat.name : "";
}

// ── Pattern matching ──────────────────────────────────────────────────────────

function matchPat(pat: Pat, val: Value): Map<string, Value> | null {
  const b = new Map<string, Value>();
  return matchInto(pat, val, b) ? b : null;
}

// A short human-readable name for a pointer target, used only for VPtr labels.
function exprLabel(e: Expr): string {
  switch (e.tag) {
    case "Var":   return e.name;
    case "Field": return `${exprLabel(e.obj)}.${e.field}`;
    case "Index": return `${exprLabel(e.obj)}[…]`;
    default:      return "_";
  }
}

function matchInto(pat: Pat, val: Value, b: Map<string, Value>): boolean {
  switch (pat.tag) {
    case "PWild":   return true;
    case "PVar":    b.set(pat.name, val); return true;
    case "PTyped":  b.set(pat.name, val); return true;
    case "PAtom":   return val.tag === "VAtom" && val.name === pat.name;
    case "PLit":    return litMatch(pat.lit, val);
    case "PCtor":
      if (val.tag !== "VCtor" || val.name !== pat.name) return false;
      if (!pat.inner) return val.payload === null;
      if (val.payload === null) return false;
      return matchInto(pat.inner, val.payload, b);
    case "PTuple":
      if (val.tag !== "VTuple" || val.elems.length !== pat.elems.length) return false;
      return pat.elems.every((p, i) => matchInto(p, val.elems[i]!, b));
    case "PRecord":
      if (val.tag !== "VRecord") return false;
      for (const f of pat.fields) {
        const fval = val.fields.get(f.name);
        if (fval === undefined) return false;
        if (!matchInto(f.pat, fval, b)) return false;
      }
      return true;
    default: return false;
  }
}

function litMatch(lit: Lit, val: Value): boolean {
  switch (lit.tag) {
    case "Num":  return val.tag === "VNum"  && val.v === lit.value;
    case "Str":  return val.tag === "VStr"  && val.v === lit.value;
    case "Bool": return val.tag === "VBool" && val.v === lit.value;
    case "Unit": return val.tag === "VUnit";
    case "Atom": return val.tag === "VAtom" && val.name === lit.name;
    default:     return false;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function litToValue(lit: Lit): Value {
  switch (lit.tag) {
    case "Num":      return { tag: "VNum",  v: lit.value };
    case "Str":      return { tag: "VStr",  v: lit.value };
    case "Bool":     return { tag: "VBool", v: lit.value };
    case "Unit":     return { tag: "VUnit" };
    case "Atom":     return { tag: "VAtom", name: lit.name };
    case "Duration": return { tag: "VNum",  v: lit.ms };
  }
}

function toList(v: Value): Value[] {
  if (v.tag === "VList") return v.elems;
  throw new RuntimeError(`expected List, got ${display(v)}`);
}

function numOp(l: Value, r: Value, f: (a: number, b: number) => number): Value {
  if (l.tag !== "VNum" || r.tag !== "VNum")
    throw new RuntimeError(`arithmetic requires numbers, got ${display(l)} and ${display(r)}`);
  return { tag: "VNum", v: f(l.v, r.v) };
}

function cmpOp(l: Value, r: Value, f: (a: number, b: number) => boolean): Value {
  if (l.tag === "VNum"  && r.tag === "VNum")  return { tag: "VBool", v: f(l.v, r.v) };
  if (l.tag === "VStr"  && r.tag === "VStr")  return { tag: "VBool", v: f(l.v < r.v ? -1 : l.v > r.v ? 1 : 0, 0) };
  throw new RuntimeError(`comparison requires two numbers or two strings`);
}

// sortBy key ordering  same num-or-string rule the `<`/`>` operators use (cmpOp).
function keyGt(a: Value, b: Value): boolean {
  if (a.tag === "VNum" && b.tag === "VNum") return a.v > b.v;
  if (a.tag === "VStr" && b.tag === "VStr") return a.v > b.v;
  throw new RuntimeError(`sortBy keys must be two numbers or two strings, got ${display(a)} and ${display(b)}`);
}

function equal(a: Value, b: Value): boolean {
  if (a.tag !== b.tag) return false;
  switch (a.tag) {
    case "VNum":    return a.v === (b as typeof a).v;
    case "VStr":    return a.v === (b as typeof a).v;
    case "VBool":   return a.v === (b as typeof a).v;
    case "VAtom":   return a.name === (b as typeof a).name;
    case "VUnit":   return true;
    case "VTuple":  return a.elems.every((e, i) => equal(e, (b as typeof a).elems[i]!));
    case "VList":   return a.elems.length === (b as typeof a).elems.length && a.elems.every((e, i) => equal(e, (b as typeof a).elems[i]!));
    case "VCtor":   return a.name === (b as typeof a).name && (a.payload === null ? (b as typeof a).payload === null : (b as typeof a).payload !== null && equal(a.payload, (b as typeof a).payload!));
    default:        return false;
  }
}

function builtin(name: string, fn: (args: Value[]) => Value | Promise<Value>): Value {
  return { tag: "VBuiltin", name, fn };
}

// First element (depth-first, flattening dynamic lists) whose `id` prop matches —
// the retained runtime's event-target lookup.
function findById(v: Value, id: string): Extract<Value, { tag: "VElement" }> | null {
  if (v.tag !== "VElement") return null;
  const k = v.props.get("id");
  if (k && k.tag === "VStr" && k.v === id) return v;
  for (const c of v.children) {
    if (c.tag === "VList") { for (const e of c.elems) { const r = findById(e, id); if (r) return r; } }
    else { const r = findById(c, id); if (r) return r; }
  }
  return null;
}

// ── Prelude ───────────────────────────────────────────────────────────────────

// A theme root value: a record of role → hex string (the §4.2 `Color` prop form).
function themeValue(roles: { readonly [role: string]: string }): Value {
  return { tag: "VRecord", fields: new Map<string, Value>(
    Object.entries(roles).map(([k, v]) => [k, { tag: "VStr", v } as Value])) };
}

// Structured parse failure (prelude ParseError ADT, TODO 3.5): builds the
// ParseError({expected, got, detail}) ctor value. Callers wrap it in Error(...).
function parseErrorVal(expected: string, got: string, detail: string): Value {
  return { tag: "VCtor", name: "ParseError", payload: { tag: "VRecord", fields: new Map<string, Value>([
    ["expected", { tag: "VStr", v: expected }],
    ["got",      { tag: "VStr", v: got }],
    ["detail",   { tag: "VStr", v: detail }],
  ]) } };
}

function buildPrelude(): Env {
  const env = new Env();

  const def = (name: string, fn: (args: Value[]) => Value | Promise<Value>) =>
    env.define(name, builtin(name, fn));

  env.define("Ok",    builtin("Ok",    args => ({ tag: "VCtor", name: "Ok",    payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Error", builtin("Error", args => ({ tag: "VCtor", name: "Error", payload: args[0] ?? { tag: "VUnit" } })));
  // Named parse-error ADT (single ctor, shared name) - payload {expected, got, detail}
  env.define("ParseError", builtin("ParseError", args => ({ tag: "VCtor", name: "ParseError", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Some",  builtin("Some",  args => ({ tag: "VCtor", name: "Some",  payload: args[0] ?? { tag: "VUnit" } })));
  env.define("None",  { tag: "VCtor", name: "None", payload: null });

  // Async loading-state ADT (SPEC §2.10): `Before | During | After(a) | Error e`.
  // Before/During are nullary values; After carries the payload. (Error is shared
  // with Result, defined above.)
  env.define("Before", { tag: "VCtor", name: "Before", payload: null });
  env.define("During", { tag: "VCtor", name: "During", payload: null });
  env.define("After",  builtin("After", args => ({ tag: "VCtor", name: "After", payload: args[0] ?? { tag: "VUnit" } })));

  // Layout `Length` constructors (Px/Fr/Pct carry a Number; Fit/Fill nullary).
  env.define("Px",   builtin("Px",  args => ({ tag: "VCtor", name: "Px",  payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Fr",   builtin("Fr",  args => ({ tag: "VCtor", name: "Fr",  payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Pct",  builtin("Pct", args => ({ tag: "VCtor", name: "Pct", payload: args[0] ?? { tag: "VUnit" } })));
  env.define("Fit",  { tag: "VCtor", name: "Fit",  payload: null });
  env.define("Fill", { tag: "VCtor", name: "Fill", payload: null });
  // `Clamp lo hi` — fluid band; payload is a 2-tuple (lo, hi) so render can emit
  // `clamp(lo, 100%, hi)`.
  env.define("Clamp", builtin("Clamp", args => ({
    tag: "VCtor", name: "Clamp",
    payload: { tag: "VTuple", elems: [args[0] ?? { tag: "VUnit" }, args[1] ?? { tag: "VUnit" }] },
  })));
  // Layout `Breakpoint` — closed responsive variant (nullary).
  env.define("Mobile",  { tag: "VCtor", name: "Mobile",  payload: null });
  env.define("Tablet",  { tag: "VCtor", name: "Tablet",  payload: null });
  env.define("Desktop", { tag: "VCtor", name: "Desktop", payload: null });
  env.define("Wide",    { tag: "VCtor", name: "Wide",    payload: null });
  // `viewport` — read-only reactive root (§9.1). Default to a Desktop viewport;
  // a live runtime would update these and re-collapse responsive matches.
  env.define("viewport", { tag: "VRecord", fields: new Map<string, Value>([
    ["width",      { tag: "VNum", v: 1280 }],
    ["height",     { tag: "VNum", v: 800 }],
    ["breakpoint", { tag: "VCtor", name: "Desktop", payload: null }],
  ]) });
  // `theme` — the second read-only reactive root (§9.1, theme-design Slice 4). Its
  // default roles are derived via std/color (shared `DEFAULT_THEME`), so the hex
  // `theme.text` renders is the exact hex the check-time fold proved legible. The
  // host swaps it via `setTheme` (patchHOF) — overwriting this global slot, which
  // every captured env sees on its next lookup, so a re-rendered view picks up the
  // new theme (the runtime swap). Reads are read-only; `setTheme` is the one channel.
  env.define("theme", themeValue(DEFAULT_THEME));

  // ── State taxonomy (§12) — closed interaction + content-state variants. ────────
  const atom = (n: string): Value => ({ tag: "VCtor", name: n, payload: null });
  for (const n of ["Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled",
                   "Empty", "Loading", "Partial", "Failed", "Ideal"])
    env.define(n, atom(n));
  // Precedence resolver (Disabled > Pressed > Dragged > Focused > Hovered > Idle).
  env.define("interactionOf", builtin("interactionOf", args => {
    const r = args[0];
    const on = (k: string): boolean => {
      const v = r && r.tag === "VRecord" ? r.fields.get(k) : undefined;
      return v?.tag === "VBool" ? v.v : false;
    };
    return atom(on("disabled") ? "Disabled" : on("pressed") ? "Pressed" : on("dragged") ? "Dragged"
             : on("focused") ? "Focused" : on("hovered") ? "Hovered" : "Idle");
  }));
  // Orthogonal facet enums (§12.1): toggle/selection + validation axes.
  for (const n of ["Off", "On", "Mixed", "Valid", "Invalid", "Pending"]) env.define(n, atom(n));
  const allOf = (ns: string[]): Value => ({ tag: "VRecord", fields: new Map<string, Value>([["all", { tag: "VList", elems: ns.map(atom) }]]) });
  env.define("Interaction", allOf(["Idle", "Hovered", "Focused", "Pressed", "Dragged", "Disabled"]));
  env.define("UIState",     allOf(["Empty", "Loading", "Partial", "Failed", "Ideal"]));
  env.define("Toggle",      allOf(["Off", "On", "Mixed"]));
  env.define("Validity",    allOf(["Valid", "Invalid", "Pending"]));
  // `raw(n)` — off-scale escape; runtime identity (renders as a bare number → px).
  env.define("raw",  builtin("raw", args => args[0] ?? { tag: "VUnit" }));

  // `print` writes WITHOUT a trailing newline (Rust `print!`); `println` adds one
  // (Rust `println!`). Both join multiple args with a space. `process.stdout` is
  // guarded so the browser bundle (no `process`) falls back to `console.log`.
  def("print",   args => {
    const s = args.map(display).join(" ");
    if (typeof process !== "undefined" && process.stdout) process.stdout.write(s);
    else console.log(s);
    return { tag: "VUnit" };
  });
  def("println", args => { console.log(args.map(display).join(" ")); return { tag: "VUnit" }; });
  def("toString", args => ({ tag: "VStr", v: display(args[0] ?? { tag: "VUnit" }) }));

  // Aggregates over a list of Numbers — used by convergence `sum(children.p)` /
  // `avg(children.p)`, but ordinary list functions too.
  const nums = (v: Value): number[] =>
    (v.tag === "VList" ? v.elems : []).flatMap(e => e.tag === "VNum" ? [e.v] : []);
  def("sum", args => ({ tag: "VNum", v: nums(args[0]!).reduce((a, b) => a + b, 0) }));
  def("avg", args => { const ns = nums(args[0]!); return { tag: "VNum", v: ns.length ? ns.reduce((a, b) => a + b, 0) / ns.length : 0 }; });

  def("abs",   args => ({ tag: "VNum", v: Math.abs(num(args[0])) }));
  def("floor", args => ({ tag: "VNum", v: Math.floor(num(args[0])) }));
  def("ceil",  args => ({ tag: "VNum", v: Math.ceil(num(args[0])) }));
  def("round", args => ({ tag: "VNum", v: Math.round(num(args[0])) }));
  def("sqrt",  args => ({ tag: "VNum", v: Math.sqrt(num(args[0])) }));
  def("max",   args => ({ tag: "VNum", v: Math.max(num(args[0]), num(args[1])) }));
  def("min",   args => ({ tag: "VNum", v: Math.min(num(args[0]), num(args[1])) }));
  def("int",   args => ({ tag: "VNum", v: Math.trunc(num(args[0])) }));
  def("not",   args => ({ tag: "VBool", v: !bool(args[0]) }));

  def("length", args => {
    const v = args[0]!;
    if (v.tag === "VList") return { tag: "VNum", v: v.elems.length };
    if (v.tag === "VStr")  return { tag: "VNum", v: v.v.length };
    throw new RuntimeError(`length: expected List or String`);
  });
  def("isEmpty", args => ({ tag: "VBool", v: toList(args[0]!).length === 0 }));
  def("identity", args => args[0] ?? ({ tag: "VUnit" as const }));
  // Total head: Ok(first) / Error("empty list") - the typed prelude's listHead.
  def("listHead", args => {
    const elems = toList(args[0]!);
    return elems.length
      ? { tag: "VCtor" as const, name: "Ok", payload: elems[0]! }
      : { tag: "VCtor" as const, name: "Error", payload: { tag: "VStr" as const, v: "empty list" } };
  });
  def("head", args => {
    const elems = toList(args[0]!);
    if (!elems.length) throw new RuntimeError("head: empty list");
    return elems[0]!;
  });
  def("tail", args => {
    const elems = toList(args[0]!);
    if (!elems.length) throw new RuntimeError("tail: empty list");
    return { tag: "VList" as const, elems: elems.slice(1) };
  });
  def("append",  args => ({ tag: "VList", elems: [...toList(args[0]!), args[1]!] }));
  def("prepend", args => ({ tag: "VList", elems: [args[0]!, ...toList(args[1]!)] }));
  def("concat",  args => ({ tag: "VList", elems: toList(args[0]!).flatMap(v => toList(v)) }));
  def("reverse", args => ({ tag: "VList", elems: [...toList(args[0]!)].reverse() }));
  def("slice",   args => ({ tag: "VList", elems: toList(args[0]!).slice(num(args[1]), num(args[2])) }));
  def("zip", args => {
    const a = toList(args[0]!), b = toList(args[1]!);
    const len = Math.min(a.length, b.length);
    return { tag: "VList" as const, elems: Array.from({ length: len }, (_, i) => ({ tag: "VTuple" as const, elems: [a[i]!, b[i]!] })) };
  });
  def("range", args => {
    const from = num(args[0]), to = num(args[1]);
    const elems: Value[] = [];
    for (let i = from; i < to; i++) elems.push({ tag: "VNum", v: i });
    return { tag: "VList", elems };
  });

  def("trim",     args => ({ tag: "VStr", v: str(args[0]).trim() }));
  def("split",    args => ({ tag: "VList", elems: str(args[0]).split(str(args[1])).map(s => ({ tag: "VStr" as const, v: s })) }));
  def("join",     args => ({ tag: "VStr", v: toList(args[0]!).map(v => display(v)).join(str(args[1])) }));
  def("contains", args => ({ tag: "VBool", v: str(args[0]).includes(str(args[1])) }));
  def("matches",  args => ({ tag: "VBool", v: new RegExp(str(args[1])).test(str(args[0])) }));
  def("startsWith", args => ({ tag: "VBool", v: str(args[0]).startsWith(str(args[1])) }));
  def("endsWith",   args => ({ tag: "VBool", v: str(args[0]).endsWith(str(args[1])) }));
  def("toUpperCase", args => ({ tag: "VStr", v: str(args[0]).toUpperCase() }));
  def("toLowerCase", args => ({ tag: "VStr", v: str(args[0]).toLowerCase() }));
  def("parseInt",  args => {
    const n = parseInt(str(args[0]), 10);
    return isNaN(n)
      ? { tag: "VCtor" as const, name: "Error", payload: { tag: "VStr" as const, v: "not a number" } }
      : { tag: "VCtor" as const, name: "Ok", payload: { tag: "VNum" as const, v: n } };
  });
  def("parseFloat", args => {
    const n = parseFloat(str(args[0]));
    return isNaN(n)
      ? { tag: "VCtor" as const, name: "Error", payload: { tag: "VStr" as const, v: "not a number" } }
      : { tag: "VCtor" as const, name: "Ok", payload: { tag: "VNum" as const, v: n } };
  });
  // The canonical boundary parser (SPEC 2.6): whole-string parse via Number(),
  // so trailing garbage ("3abc") is an Error, with the structured ParseError.
  def("parseNumber", args => {
    const s = str(args[0]);
    const n = s.trim() === "" ? NaN : Number(s);
    return isNaN(n)
      ? { tag: "VCtor" as const, name: "Error", payload: parseErrorVal("Number", s, "not a number") }
      : { tag: "VCtor" as const, name: "Ok", payload: { tag: "VNum" as const, v: n } };
  });

  return env;
}

// ── HOF patching ──────────────────────────────────────────────────────────────
// Higher-order functions call back into the (async) evaluator, so they're async.

export function patchHOF(env: Env, ev: Evaluator): void {
  const def = (name: string, fn: (args: Value[]) => Value | Promise<Value>) =>
    env.define(name, { tag: "VBuiltin", name, fn });

  def("map", async args => {
    const f = args[0]!, list = toList(args[1]!);
    const out: Value[] = [];
    for (const v of list) out.push(await ev.applyFn(f, [v], "map"));
    return { tag: "VList", elems: out };
  });

  // `setTheme(theme)` — the host swap channel for the read-only `theme` root
  // (§9.1, theme-design Slice 4). Overwrites the global `theme` slot; because every
  // captured env reaches this global via its parent chain, the next `view()` render
  // resolves `theme.*` to the new roles — the runtime theme swap, with no field ever
  // written from a view (reads stay read-only; this single action is the only writer).
  def("setTheme", args => { const t = args[0]; if (t) ev.defineGlobal("theme", t); return { tag: "VUnit" }; });
  // `setViewport(viewport)` — the host swap channel for the read-only `viewport` root
  // (the parallel of `setTheme`). Overwrites the global slot, so the next `view()`
  // re-collapses every `Responsive(Length)` prop against the new breakpoint.
  def("setViewport", args => { const v = args[0]; if (v) ev.defineGlobal("viewport", v); return { tag: "VUnit" }; });

  // `html(element)` — render a view-DSL element tree to an HTML string. The
  // convergence pass (§6) resolves cross-element prop references first, so the
  // renderer is handed a fully concrete tree (its existing contract).
  def("html", async args => ({ tag: "VStr", v: renderHtml(await ev.converge(args[0]!)) }));

  // `uiModel(element)` — render the element tree to an analyzable text outline.
  def("uiModel", async args => ({ tag: "VStr", v: renderModel(await ev.converge(args[0]!)) }));

  // `analyze(element)` — lint the tree (§13.2) for inconsistency / duplication /
  // a11y / structure, returning a findings report.
  def("analyze", async args => ({ tag: "VStr", v: analyzeModel(await ev.converge(args[0]!)) }));

  // `uiJson(element)` — the UI model as JSON (structure for tools/LLMs).
  def("uiJson", async args => ({ tag: "VStr", v: renderJson(await ev.converge(args[0]!)) }));

  // `sandbox(name, variants, render)` — a text Storybook (§13.3). Drives `render`
  // over each variant (e.g. `Interaction.all`), converges each result, and dumps
  // the uiModel + html per variant. Reuses #9 (taxonomy), #10 (model), html.
  def("sandbox", async args => {
    const name = args[0]?.tag === "VStr" ? args[0].v : "component";
    const variants = toList(args[1]!);
    const render = args[2]!;
    const blocks: string[] = [];
    for (const variant of variants) {
      const tree = await ev.converge(await ev.applyFn(render, [variant], "sandbox"));
      blocks.push(
        `=== ${name} / ${display(variant)} ===\n${renderModel(tree)}\n--- html ---\n${renderHtml(tree)}`,
      );
    }
    return { tag: "VStr", v: blocks.join("\n\n") };
  });

  // `interactive(view, steps)` — the headless retained runtime (§8). Render the
  // view, then for each scripted step `{ target, event }` fire the matching
  // element's handler (→ store mutates), re-render, and DIFF against the previous
  // tree, emitting the minimal patch list a browser host would apply. Proves
  // handlers fire + stores update + reconciliation, end-to-end.
  def("interactive", async args => {
    const view = args[0]!;
    const steps = args[1] && args[1].tag === "VList" ? args[1].elems : [];
    const lines: string[] = [];
    let tree = await ev.converge(await ev.applyFn(view, [], "view"));
    lines.push("=== initial ===", renderHtml(tree));
    for (const w of keylessListWarnings(tree)) lines.push(w);
    let n = 0;
    for (const step of steps) {
      n++;
      const rec = step.tag === "VRecord" ? step.fields : new Map<string, Value>();
      const tgt = rec.get("target"), evt = rec.get("event");
      const targetId = tgt?.tag === "VStr" ? tgt.v : "";
      const eventName = evt?.tag === "VStr" ? evt.v : "";
      const header = `=== step ${n}: ${eventName} on #${targetId} ===`;
      const node = findById(tree, targetId);
      const handler = node?.events.get(eventName);
      if (!handler) {
        lines.push(header, node ? `  (no ${eventName} handler on #${targetId})` : `  (no element with id "${targetId}")`);
        continue;
      }
      await ev.applyFn(handler, [], `event:${eventName}`);
      await ev.settle();
      const next = await ev.converge(await ev.applyFn(view, [], "view"));
      const patches = diff(tree, next);
      lines.push(header, ...(patches.length ? patches.map(p => "  " + patchLabel(p)) : ["  (no change)"]));
      tree = next;
    }
    return { tag: "VStr", v: lines.join("\n") };
  });

  // `domHost(view, steps)` — the browser host (§8 follow-on). Same loop as
  // `interactive`, but emits a self-contained HTML page that mounts the initial
  // render and REPLAYS the recorded event→patch session against the live DOM via
  // the JS applier (the browser counterpart of runtime.ts `diff`).
  def("domHost", async args => {
    const view = args[0]!;
    const steps = args[1] && args[1].tag === "VList" ? args[1].elems : [];
    let tree = await ev.converge(await ev.applyFn(view, [], "view"));
    const initialHtml = renderHtml(tree);
    const session: HostStep[] = [];
    for (const step of steps) {
      const rec = step.tag === "VRecord" ? step.fields : new Map<string, Value>();
      const tgt = rec.get("target"), evt = rec.get("event");
      const targetId = tgt?.tag === "VStr" ? tgt.v : "";
      const eventName = evt?.tag === "VStr" ? evt.v : "";
      const node = findById(tree, targetId);
      const handler = node?.events.get(eventName);
      if (!handler) { session.push({ label: `${eventName} on #${targetId} (no handler)`, patches: [] }); continue; }
      await ev.applyFn(handler, [], `event:${eventName}`);
      await ev.settle();
      const next = await ev.converge(await ev.applyFn(view, [], "view"));
      session.push({ label: `${eventName} on #${targetId}`, patches: diff(tree, next) });
      tree = next;
    }
    return { tag: "VStr", v: domHostPage(initialHtml, session, "velve") };
  });

  // ── Parallel combinators ─────────────────────────────────────────────────────
  // Data-first (`xs |> pmap f`) so they chain. Each element's computation is
  // spawned as its own task on the cooperative scheduler, so independent async
  // work (sleep / await / go / httpGet) overlaps instead of running strictly
  // sequentially; we then await every task in order. A task that itself yields a
  // VFuture/VSagaHandle is awaited through, so the result list holds plain values.
  const settle = async (v: Value): Promise<Value> =>
    v.tag === "VFuture" || v.tag === "VSagaHandle" ? await ev.sched.awaitFuture(v.future) : v;

  def("pmap", async args => {
    const list = toList(args[0]!), f = args[1]!;
    const futs = list.map(v => ev.sched.spawn(() => ev.applyFn(f, [v], "pmap")));
    const out: Value[] = [];
    for (const fut of futs) out.push(await settle(await ev.sched.awaitFuture(fut)));
    return { tag: "VList", elems: out };
  });

  def("pfilter", async args => {
    const list = toList(args[0]!), f = args[1]!;
    const futs = list.map(v => ev.sched.spawn(() => ev.applyFn(f, [v], "pfilter")));
    const out: Value[] = [];
    for (let i = 0; i < list.length; i++) {
      if (bool(await settle(await ev.sched.awaitFuture(futs[i]!)))) out.push(list[i]!);
    }
    return { tag: "VList", elems: out };
  });

  // `parallel [t1, t2, …]` — await a list of already-spawned tasks (or plain
  // values) and collect their results in order. Pairs with `go`/async producers.
  def("parallel", async args => {
    const list = toList(args[0]!);
    const out: Value[] = [];
    for (const v of list) out.push(await settle(v));
    return { tag: "VList", elems: out };
  });

  // ── Stream combinators ──────────────────────────────────────────────────────
  // Each spawns a consumer that drains the source's queue and pushes transformed
  // values to a fresh stream, propagating `Done`. Data-first so they chain via `|>`.
  const asStream = (v: Value | undefined, who: string): { name: string; q: VStreamQueue } => {
    if (v?.tag === "VStream") return v;
    throw new RuntimeError(`${who} expects a Stream, got ${v ? display(v) : "nothing"}`);
  };
  const isPush = (v: Value): v is { tag: "VCtor"; name: "Push"; payload: Value } =>
    v.tag === "VCtor" && v.name === "Push";
  const DONE: Value = { tag: "VCtor", name: "Done", payload: { tag: "VUnit" } };
  const push = (v: Value): Value => ({ tag: "VCtor", name: "Push", payload: v });

  // The FFI primitive for input: `externSource(setup)` makes a fresh stream and hands
  // the setup fn two injectors — `push value` and `done` — to wire to a host source
  // (timer, DOM/MIDI callback via @js, or any producer). Returns the Stream the rest
  // of the program consumes. Built-in device libraries use `ev.makeStream()` directly;
  // this is the velve-facing door so user code can define custom inputs.
  def("externSource", async args => {
    const setup = args[0];
    const src = ev.makeStream("source");
    const pushFn = builtin("push", a => { src.push(a[0] ?? { tag: "VUnit" }); return { tag: "VUnit" }; });
    const doneFn = builtin("done", _a => { src.done(); return { tag: "VUnit" }; });
    if (setup) await ev.applyFn(setup, [pushFn, doneFn], "externSource");
    return src.stream;
  });

  // help(map)  an inputmap's labelled rows as derived data (SPEC �10.5):
  // List({pattern, label}). The table is registered at declaration eval and
  // looked up by value identity, so aliases work.
  def("help", args => {
    const table = args[0] ? ev.inputmapInfo.get(args[0])?.help : undefined;
    if (!table) throw new RuntimeError("help expects an inputmap");
    return table;
  });

  def("streamMap", async args => {
    const src = asStream(args[0], "streamMap"), f = args[1]!;
    const out: Value = { tag: "VStream", name: `${src.name}.map`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      for (;;) {
        const v = await src.q.next();
        if (isPush(v)) out.q.push(push(await ev.applyFn(f, [v.payload], "streamMap")));
        else { out.q.push(DONE); return { tag: "VUnit" }; }
      }
    });
    return out;
  });

  def("streamFilter", async args => {
    const src = asStream(args[0], "streamFilter"), pred = args[1]!;
    const out: Value = { tag: "VStream", name: `${src.name}.filter`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      for (;;) {
        const v = await src.q.next();
        if (isPush(v)) { if (bool(await ev.applyFn(pred, [v.payload], "streamFilter"))) out.q.push(v); }
        else { out.q.push(DONE); return { tag: "VUnit" }; }
      }
    });
    return out;
  });

  def("streamTake", async args => {
    const src = asStream(args[0], "streamTake"), n = num(args[1]);
    const out: Value = { tag: "VStream", name: `${src.name}.take`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let taken = 0;
      while (taken < n) {
        const v = await src.q.next();
        if (isPush(v)) { out.q.push(v); taken++; }
        else { out.q.push(DONE); return { tag: "VUnit" }; }
      }
      out.q.push(DONE);
      return { tag: "VUnit" };
    });
    return out;
  });

  def("streamFold", async args => {
    // Terminal: drains the stream and returns the accumulated value.
    const src = asStream(args[0], "streamFold"), f = args[2]!;
    let acc = args[1]!;
    for (;;) {
      const v = await src.q.next();
      if (isPush(v)) acc = await ev.applyFn(f, [acc, v.payload], "streamFold");
      else return acc;
    }
  });

  // Combine two sources into one; only emits `Done` after BOTH sources are done.
  def("streamMerge", async args => {
    const a = asStream(args[0], "streamMerge"), b = asStream(args[1], "streamMerge");
    const out: Value = { tag: "VStream", name: `${a.name}+${b.name}`, q: new VStreamQueue() };
    let live = 2;
    const drainInto = (src: { name: string; q: VStreamQueue }) => ev.sched.spawn(async () => {
      for (;;) {
        const v = await src.q.next();
        if (isPush(v)) out.q.push(v);
        else { if (--live === 0) out.q.push(DONE); return { tag: "VUnit" }; }
      }
    });
    drainInto(a); drainInto(b);
    return out;
  });

  // Trailing debounce: emit a value only after `ms` of virtual-time quiet; a newer
  // value within the window supersedes the pending one. On `Done`, flush the last.
  def("streamDebounce", async args => {
    const src = asStream(args[0], "streamDebounce"), ms = num(args[1]);
    const out: Value = { tag: "VStream", name: `${src.name}.debounce`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let pending: Value | undefined = undefined;   // latest un-emitted Push
      for (;;) {
        if (pending === undefined) {
          const v = await src.q.next();
          if (isPush(v)) pending = v;
          else { out.q.push(DONE); return { tag: "VUnit" }; }
        } else {
          const v = await src.q.nextWithin(ms, ev.sched);
          if (v === undefined) { out.q.push(pending); pending = undefined; }   // quiet → emit
          else if (isPush(v)) pending = v;                                     // newer → supersede
          else { out.q.push(pending); out.q.push(DONE); return { tag: "VUnit" }; }  // done → flush last
        }
      }
    });
    return out;
  });

  // Leading-edge throttle: emit a value, then drop everything for `ms` virtual time.
  def("streamThrottle", async args => {
    const src = asStream(args[0], "streamThrottle"), ms = num(args[1]);
    const out: Value = { tag: "VStream", name: `${src.name}.throttle`, q: new VStreamQueue() };
    ev.sched.spawn(async () => {
      let lastEmit = -Infinity;
      for (;;) {
        const v = await src.q.next();
        if (isPush(v)) {
          const now = ev.sched.now();
          if (now - lastEmit >= ms) { out.q.push(v); lastEmit = now; }   // else drop within window
        } else { out.q.push(DONE); return { tag: "VUnit" }; }
      }
    });
    return out;
  });
  def("filter", async args => {
    const f = args[0]!, list = toList(args[1]!);
    const out: Value[] = [];
    for (const v of list) if (bool(await ev.applyFn(f, [v], "filter"))) out.push(v);
    return { tag: "VList", elems: out };
  });
  def("foldl", async args => {
    const f = args[0]!;
    let acc = args[1]!;
    for (const v of toList(args[2]!)) acc = await ev.applyFn(f, [acc, v], "foldl");
    return acc;
  });
  def("foldr", async args => {
    const f = args[0]!;
    let acc = args[1]!;
    for (const v of [...toList(args[2]!)].reverse()) acc = await ev.applyFn(f, [v, acc], "foldr");
    return acc;
  });
  def("forEach", async args => {
    const f = args[0]!, list = toList(args[1]!);
    for (const v of list) await ev.applyFn(f, [v], "forEach");
    return { tag: "VUnit" };
  });
  def("flatMap", async args => {
    const f = args[0]!, list = toList(args[1]!);
    const out: Value[] = [];
    for (const v of list) out.push(...toList(await ev.applyFn(f, [v], "flatMap")));
    return { tag: "VList", elems: out };
  });
  def("any", async args => {
    const f = args[0]!, list = toList(args[1]!);
    for (const v of list) if (bool(await ev.applyFn(f, [v], "any"))) return { tag: "VBool", v: true };
    return { tag: "VBool", v: false };
  });
  def("all", async args => {
    const f = args[0]!, list = toList(args[1]!);
    for (const v of list) if (!bool(await ev.applyFn(f, [v], "all"))) return { tag: "VBool", v: false };
    return { tag: "VBool", v: true };
  });
  def("sortBy", async args => {
    // Key-fn form, data-first: sortBy(xs, keyFn) returns xs sorted ascending by the
    // extracted key. Matches infer (sortBy : (List a, a -> b) -> List a) and the
    // listMap/listFilter convention, so it chains under |>. Keys are read once up
    // front (decorate-sort-undecorate), then a stable insertion sort  the key
    // extractor is async and may call back into the scheduler.
    const list = [...toList(args[0]!)], f = args[1]!;
    const keys: Value[] = [];
    for (const x of list) keys.push(await ev.applyFn(f, [x], "sortBy"));
    for (let i = 1; i < list.length; i++) {
      const x = list[i]!, kx = keys[i]!;
      let j = i - 1;
      while (j >= 0 && keyGt(keys[j]!, kx)) { list[j + 1] = list[j]!; keys[j + 1] = keys[j]!; j--; }
      list[j + 1] = x; keys[j + 1] = kx;
    }
    return { tag: "VList", elems: list };
  });

  // Concurrency: sleep parks the caller on the scheduler's virtual clock.
  def("sleep", async args => { await ev.sleep(num(args[0])); return { tag: "VUnit" }; });

  // Saga introspection: the list of step names a saga's backing store has
  // journaled (durable transition history). Demonstrates saga persistence.
  def("journalOf", args => ({ tag: "VList", elems: ev.journalOf(str(args[0])).map(s => ({ tag: "VStr", v: s } as Value)) }));

  // Abort the current saga instance mid-flight. The journal survives, so the
  // instance can be re-hydrated and continued with `resume`.
  def("crash", args => { throw new SagaCrashSignal(args[0] ? str(args[0]) : "crashed"); });

  // Dict HOFs need the evaluator to apply their function arg, so they're patched
  // onto the (otherwise static) Dict runtime here. `map` transforms each value;
  // `filter` keeps entries whose value satisfies the predicate. Keys preserved.
  DICT_RT.map = { tag: "VBuiltin", name: "Dict.map", fn: async args => {
    const f = args[1]!, next = new Map<string, [Value, Value]>();
    for (const [ck, [k, v]] of dictEntries(args[0])) next.set(ck, [k, await ev.applyFn(f, [v], "Dict.map")]);
    return { tag: "VDict", entries: next };
  } };
  DICT_RT.filter = { tag: "VBuiltin", name: "Dict.filter", fn: async args => {
    const f = args[1]!, next = new Map<string, [Value, Value]>();
    for (const [ck, [k, v]] of dictEntries(args[0])) if (bool(await ev.applyFn(f, [v], "Dict.filter"))) next.set(ck, [k, v]);
    return { tag: "VDict", entries: next };
  } };

  // Set HOFs (same reason — need ev.applyFn). `map` re-canonicalizes keys since
  // the transform can collide distinct elements; `filter` keeps matching elems.
  SET_RT.map = { tag: "VBuiltin", name: "Set.map", fn: async args => {
    const f = args[1]!, next = new Map<string, Value>();
    for (const x of setElems(args[0]).values()) { const y = await ev.applyFn(f, [x], "Set.map"); next.set(dictKey(y), y); }
    return { tag: "VSet", elems: next };
  } };
  SET_RT.filter = { tag: "VBuiltin", name: "Set.filter", fn: async args => {
    const f = args[1]!, next = new Map<string, Value>();
    for (const [k, x] of setElems(args[0])) if (bool(await ev.applyFn(f, [x], "Set.filter"))) next.set(k, x);
    return { tag: "VSet", elems: next };
  } };
}

// ── @js{} interop helpers ─────────────────────────────────────────────────────

function velveToJs(v: Value): unknown {
  switch (v.tag) {
    case "VNum":    return v.v;
    case "VStr":    return v.v;
    case "VBool":   return v.v;
    case "VUnit":   return null;
    case "VList":   return v.elems.map(velveToJs);
    case "VTuple":  return v.elems.map(velveToJs);
    case "VRecord": return Object.fromEntries([...v.fields.entries()].map(([k, val]) => [k, velveToJs(val)]));
    case "VCtor":   return v.payload ? { _tag: v.name, value: velveToJs(v.payload) } : { _tag: v.name };
    default:        return undefined;
  }
}

function jsToVelve(v: unknown): Value {
  if (v === null || v === undefined) return { tag: "VUnit" };
  if (typeof v === "number")  return { tag: "VNum",  v };
  if (typeof v === "string")  return { tag: "VStr",  v };
  if (typeof v === "boolean") return { tag: "VBool", v };
  if (Array.isArray(v))       return { tag: "VList", elems: v.map(jsToVelve) };
  if (typeof v === "object") {
    const fields = new Map<string, Value>();
    for (const [k, val] of Object.entries(v as Record<string, unknown>))
      fields.set(k, jsToVelve(val));
    return { tag: "VRecord", fields };
  }
  return { tag: "VStr", v: String(v) };
}

// ── Stdlib runtime modules ────────────────────────────────────────────────────
// Maps module path aliases → record of runtime VBuiltin values.
// Mirrors stdlib.ts but at the value level; functions delegate to JS built-ins.

const STRING_RT: Record<string, Value> = {
  split:      builtin("split",      args => ({ tag: "VList", elems: str(args[0]).split(str(args[1])).map(s => ({ tag: "VStr" as const, v: s })) })),
  join:       builtin("join",       args => {
    const elems = args[0]?.tag === "VList" ? args[0].elems : [];
    return { tag: "VStr", v: elems.map(v => v.tag === "VStr" ? v.v : display(v)).join(str(args[1])) };
  }),
  length:     builtin("length",     args => ({ tag: "VNum", v: str(args[0]).length })),
  trim:       builtin("trim",       args => ({ tag: "VStr", v: str(args[0]).trim() })),
  trimStart:  builtin("trimStart",  args => ({ tag: "VStr", v: str(args[0]).trimStart() })),
  trimEnd:    builtin("trimEnd",    args => ({ tag: "VStr", v: str(args[0]).trimEnd() })),
  startsWith: builtin("startsWith", args => ({ tag: "VBool", v: str(args[0]).startsWith(str(args[1])) })),
  endsWith:   builtin("endsWith",   args => ({ tag: "VBool", v: str(args[0]).endsWith(str(args[1])) })),
  includes:   builtin("includes",   args => ({ tag: "VBool", v: str(args[0]).includes(str(args[1])) })),
  indexOf:    builtin("indexOf",    args => ({ tag: "VNum", v: str(args[0]).indexOf(str(args[1])) })),
  slice:      builtin("slice",      args => ({ tag: "VStr", v: str(args[0]).slice(num(args[1]), num(args[2])) })),
  sliceFrom:  builtin("sliceFrom",  args => ({ tag: "VStr", v: str(args[0]).slice(num(args[1])) })),
  replace:    builtin("replace",    args => ({ tag: "VStr", v: str(args[0]).replace(str(args[1]), str(args[2])) })),
  replaceAll: builtin("replaceAll", args => ({ tag: "VStr", v: str(args[0]).replaceAll(str(args[1]), str(args[2])) })),
  toUpper:    builtin("toUpper",    args => ({ tag: "VStr", v: str(args[0]).toUpperCase() })),
  toLower:    builtin("toLower",    args => ({ tag: "VStr", v: str(args[0]).toLowerCase() })),
  chars:      builtin("chars",      args => ({ tag: "VList", elems: [...str(args[0])].map(c => ({ tag: "VStr" as const, v: c })) })),
  repeat:     builtin("repeat",     args => ({ tag: "VStr", v: str(args[0]).repeat(num(args[1])) })),
  padStart:   builtin("padStart",   args => ({ tag: "VStr", v: str(args[0]).padStart(num(args[1]), str(args[2])) })),
  padEnd:     builtin("padEnd",     args => ({ tag: "VStr", v: str(args[0]).padEnd(num(args[1]), str(args[2])) })),
  fromNumber: builtin("fromNumber", args => ({ tag: "VStr", v: String(num(args[0])) })),
  toNumber:   builtin("toNumber",   args => {
    const n = parseFloat(str(args[0]));
    return isNaN(n) ? { tag: "VCtor" as const, name: "Error", payload: { tag: "VStr" as const, v: "not a number" } }
                    : { tag: "VCtor" as const, name: "Ok",    payload: { tag: "VNum" as const, v: n } };
  }),
  isEmpty:    builtin("isEmpty",    args => ({ tag: "VBool", v: str(args[0]).length === 0 })),
  lines:      builtin("lines",      args => ({ tag: "VList", elems: str(args[0]).split("\n").map(s => ({ tag: "VStr" as const, v: s })) })),
};

const MATH_RT: Record<string, Value> = {
  floor:    builtin("floor",   args => ({ tag: "VNum", v: Math.floor(num(args[0])) })),
  ceil:     builtin("ceil",    args => ({ tag: "VNum", v: Math.ceil(num(args[0])) })),
  round:    builtin("round",   args => ({ tag: "VNum", v: Math.round(num(args[0])) })),
  abs:      builtin("abs",     args => ({ tag: "VNum", v: Math.abs(num(args[0])) })),
  sqrt:     builtin("sqrt",    args => ({ tag: "VNum", v: Math.sqrt(num(args[0])) })),
  cbrt:     builtin("cbrt",    args => ({ tag: "VNum", v: Math.cbrt(num(args[0])) })),
  pow:      builtin("pow",     args => ({ tag: "VNum", v: Math.pow(num(args[0]), num(args[1])) })),
  max:      builtin("max",     args => ({ tag: "VNum", v: Math.max(num(args[0]), num(args[1])) })),
  min:      builtin("min",     args => ({ tag: "VNum", v: Math.min(num(args[0]), num(args[1])) })),
  clamp:    builtin("clamp",   args => ({ tag: "VNum", v: Math.min(Math.max(num(args[0]), num(args[1])), num(args[2])) })),
  log:      builtin("log",     args => ({ tag: "VNum", v: Math.log(num(args[0])) })),
  log2:     builtin("log2",    args => ({ tag: "VNum", v: Math.log2(num(args[0])) })),
  log10:    builtin("log10",   args => ({ tag: "VNum", v: Math.log10(num(args[0])) })),
  exp:      builtin("exp",     args => ({ tag: "VNum", v: Math.exp(num(args[0])) })),
  sin:      builtin("sin",     args => ({ tag: "VNum", v: Math.sin(num(args[0])) })),
  cos:      builtin("cos",     args => ({ tag: "VNum", v: Math.cos(num(args[0])) })),
  tan:      builtin("tan",     args => ({ tag: "VNum", v: Math.tan(num(args[0])) })),
  asin:     builtin("asin",    args => ({ tag: "VNum", v: Math.asin(num(args[0])) })),
  acos:     builtin("acos",    args => ({ tag: "VNum", v: Math.acos(num(args[0])) })),
  atan:     builtin("atan",    args => ({ tag: "VNum", v: Math.atan(num(args[0])) })),
  atan2:    builtin("atan2",   args => ({ tag: "VNum", v: Math.atan2(num(args[0]), num(args[1])) })),
  sign:     builtin("sign",    args => ({ tag: "VNum", v: Math.sign(num(args[0])) })),
  trunc:    builtin("trunc",   args => ({ tag: "VNum", v: Math.trunc(num(args[0])) })),
  isNaN:    builtin("isNaN",   args => ({ tag: "VBool", v: isNaN(num(args[0])) })),
  isFinite: builtin("isFinite",args => ({ tag: "VBool", v: isFinite(num(args[0])) })),
  pi:       { tag: "VNum", v: Math.PI },
  e:        { tag: "VNum", v: Math.E },
  random:   builtin("random",  _args => ({ tag: "VNum", v: Math.random() })),
};

// ── Color runtime (std `Color`) — OKLCH model + harmony + gamut cusp + APCA ───
// A colour is the record { l, c, h }. Helpers are the same maths validated in the
// theme devtool: perceptual (OKLab), gamut-aware (cusp), legibility via APCA.
function mkColor(l: number, c: number, h: number): Value {
  return { tag: "VRecord", fields: new Map<string, Value>([
    ["l", { tag: "VNum", v: l }],
    ["c", { tag: "VNum", v: Math.max(0, c) }],
    ["h", { tag: "VNum", v: ((h % 360) + 360) % 360 }],
  ]) };
}
function colorLCH(v: Value | undefined): [number, number, number] {
  if (v?.tag === "VRecord") {
    const g = (k: string) => { const x = v.fields.get(k); return x && x.tag === "VNum" ? x.v : 0; };
    return [g("l"), g("c"), g("h")];
  }
  throw new RuntimeError(`expected a Color {l,c,h}, got ${v ? display(v) : "nothing"}`);
}
// OKLCH/APCA maths now live in ./color.ts — the SINGLE source of truth shared
// with the compile-time fold (infer.ts `constEval`), so a derived theme role
// folds at check time to the exact hex the runtime computes (theme-design §Slice 3).
const colVal  = (t: LCH): Value => mkColor(t[0], t[1], t[2]);
const lchList = (ts: LCH[]): Value => ({ tag: "VList", elems: ts.map(colVal) });
// CVD simulation matrices, applied in LINEAR sRGB (Viénot/Brettel/Mollon).
const CVD_MATRICES: Record<string, [number,number,number,number,number,number,number,number,number]> = {
  protanopia:   [0.152286, 1.052583, -0.204868,  0.114503, 0.786281,  0.099216, -0.003882, -0.048116, 1.051998],
  deuteranopia: [0.367322, 0.860646, -0.227968,  0.280085, 0.672501,  0.047413, -0.011820, 0.042940,  0.968881],
  tritanopia:   [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602,  0.004733, 0.691367,  0.303900],
};
// The 16 standard ANSI terminal colours (xterm defaults), as sRGB hex.
const ANSI16 = ["#000000","#cd0000","#00cd00","#cdcd00","#0000ee","#cd00cd","#00cdcd","#e5e5e5","#7f7f7f","#ff0000","#00ff00","#ffff00","#5c5cff","#ff00ff","#00ffff","#ffffff"];
const ANSI16_LCH: LCH[] = ANSI16.map(hexToOklch3);
const harmony = (c: Value | undefined, ...rot: number[]): Value => {
  const [L,C,H] = colorLCH(c);
  return { tag: "VList", elems: rot.map(d => mkColor(L, C, H + d)) };
};

const COLOR_RT: Record<string, Value> = {
  oklch: builtin("oklch", a => mkColor(num(a[0]), num(a[1]), num(a[2]))),
  hex:   builtin("hex",   a => colVal(hexToOklch3(str(a[0])))),
  gray:  builtin("gray",  a => colVal(cGray(num(a[0])))),
  lighten:    builtin("lighten",    a => colVal(cLighten(colorLCH(a[0]), num(a[1])))),
  darken:     builtin("darken",     a => colVal(cDarken(colorLCH(a[0]), num(a[1])))),
  saturate:   builtin("saturate",   a => colVal(cSaturate(colorLCH(a[0]), num(a[1])))),
  desaturate: builtin("desaturate", a => colVal(cDesaturate(colorLCH(a[0]), num(a[1])))),
  rotate:     builtin("rotate",     a => colVal(cRotate(colorLCH(a[0]), num(a[1])))),
  complement: builtin("complement", a => colVal(cComplement(colorLCH(a[0])))),
  analogous:       builtin("analogous",       a => harmony(a[0], -30, 0, 30)),
  triad:           builtin("triad",           a => harmony(a[0], 0, 120, 240)),
  tetrad:          builtin("tetrad",          a => harmony(a[0], 0, 90, 180, 270)),
  splitComplement: builtin("splitComplement", a => harmony(a[0], 0, 150, 210)),
  mix:       builtin("mix",       a => colVal(cMix(colorLCH(a[0]), colorLCH(a[1]), num(a[2])))),
  cusp:      builtin("cusp",      a => colVal(cCusp(colorLCH(a[0])))),
  contrast:  builtin("contrast",  a => ({ tag: "VNum", v: apcaTriple(colorLCH(a[0]), colorLCH(a[1])) })),
  legibleOn: builtin("legibleOn", a => colVal(cLegibleOn(colorLCH(a[0])))),
  toHex: builtin("toHex", a => { const [L,C,H] = colorLCH(a[0]); return { tag: "VStr", v: oklchToHex(L, C, H) }; }),
  css:   builtin("css",   a => { const [L,C,H]=colorLCH(a[0]); return { tag: "VStr", v: `oklch(${L.toFixed(3)} ${C.toFixed(3)} ${H.toFixed(1)})` }; }),
  toLinear: builtin("toLinear", a => { const [L,C,H]=colorLCH(a[0]); const g = oklchRaw3(L,C,H); const cl = (x: number) => Math.min(1, Math.max(0, x));
    return { tag: "VTuple", elems: [{ tag: "VNum", v: cl(g[0]) }, { tag: "VNum", v: cl(g[1]) }, { tag: "VNum", v: cl(g[2]) }] }; }),
  // perceptual distance (ΔEOK in OKLab) — the modern distinguishability metric
  deltaE: builtin("deltaE", a => ({ tag: "VNum", v: deltaEOK(colorLCH(a[0]), colorLCH(a[1])) })),
  // n tones of the hue, evenly in lightness dark→light, chroma gamut-clamped
  ramp:   builtin("ramp",   a => lchList(cRamp(colorLCH(a[0]), num(a[1])))),
  // n steps darker (toward L=0.1) / lighter (toward L=0.98), hue kept, chroma gamut-clamped
  shades: builtin("shades", a => lchList(cShades(colorLCH(a[0]), num(a[1])))),
  tints:  builtin("tints",  a => lchList(cTints(colorLCH(a[0]), num(a[1])))),
  // colour-vision-deficiency simulation (matrices in linear sRGB); unknown → unchanged
  simulate: builtin("simulate", a => {
    const [L, C, H] = colorLCH(a[0]); const kind = str(a[1]);
    const lin = oklchRaw3(L, C, H);
    const r = lin[0], g = lin[1], b = lin[2];
    if (kind === "achromatopsia") {
      const y = 0.2126*r + 0.7152*g + 0.0722*b;
      const o = linToOklch3(y, y, y); return mkColor(o[0], o[1], o[2]);
    }
    const m = CVD_MATRICES[kind];
    if (!m) return mkColor(L, C, H);
    const nr = m[0]*r + m[1]*g + m[2]*b, ng = m[3]*r + m[4]*g + m[5]*b, nb = m[6]*r + m[7]*g + m[8]*b;
    const o = linToOklch3(nr, ng, nb); return mkColor(o[0], o[1], o[2]);
  }),
  // index 0–15 of the nearest standard ANSI terminal colour (min ΔEOK)
  nearestAnsi: builtin("nearestAnsi", a => {
    const c = colorLCH(a[0]); let best = 0, bestD = Infinity;
    for (let i = 0; i < ANSI16_LCH.length; i++) { const d = deltaEOK(c, ANSI16_LCH[i]!); if (d < bestD) { bestD = d; best = i; } }
    return { tag: "VNum", v: best };
  }),
  // named hue constructors — values seated at the hue's gamut cusp
  rose:    (() => { const [l,c] = cusp(12);  return mkColor(l, c, 12);  })(),
  amber:   (() => { const [l,c] = cusp(70);  return mkColor(l, c, 70);  })(),
  lime:    (() => { const [l,c] = cusp(125); return mkColor(l, c, 125); })(),
  emerald: (() => { const [l,c] = cusp(155); return mkColor(l, c, 155); })(),
  teal:    (() => { const [l,c] = cusp(185); return mkColor(l, c, 185); })(),
  cyan:    (() => { const [l,c] = cusp(212); return mkColor(l, c, 212); })(),
  azure:   (() => { const [l,c] = cusp(250); return mkColor(l, c, 250); })(),
  indigo:  (() => { const [l,c] = cusp(275); return mkColor(l, c, 275); })(),
  violet:  (() => { const [l,c] = cusp(300); return mkColor(l, c, 300); })(),
  plum:    (() => { const [l,c] = cusp(330); return mkColor(l, c, 330); })(),
};

// ── Dict runtime (std `Dict`) ─────────────────────────────────────────────────
// VDict is immutable: every mutating op copies the entries map. `map`/`filter`
// need to apply a function, so they're attached in patchHOF (which has the
// evaluator); the pure ops live here.
function dictEntries(v: Value | undefined): Map<string, [Value, Value]> {
  if (v?.tag === "VDict") return v.entries;
  throw new RuntimeError(`expected Dict, got ${v ? display(v) : "nothing"}`);
}
function mkDict(entries: Map<string, [Value, Value]>): Value { return { tag: "VDict", entries }; }
const SOME = (v: Value): Value => ({ tag: "VCtor", name: "Some", payload: v });
const NONE: Value = { tag: "VCtor", name: "None", payload: null };

const DICT_RT: Record<string, Value> = {
  empty:    builtin("empty",    _args => mkDict(new Map())),
  get:      builtin("get",      args => {
    const e = dictEntries(args[0]).get(dictKey(args[1]!));
    return e ? SOME(e[1]) : NONE;
  }),
  getOr:    builtin("getOr",    args => {
    const e = dictEntries(args[0]).get(dictKey(args[1]!));
    return e ? e[1] : args[2]!;
  }),
  set:      builtin("set",      args => {
    const next = new Map(dictEntries(args[0]));
    next.set(dictKey(args[1]!), [args[1]!, args[2]!]);
    return mkDict(next);
  }),
  delete:   builtin("delete",   args => {
    const next = new Map(dictEntries(args[0]));
    next.delete(dictKey(args[1]!));
    return mkDict(next);
  }),
  has:      builtin("has",      args => ({ tag: "VBool", v: dictEntries(args[0]).has(dictKey(args[1]!)) })),
  keys:     builtin("keys",     args => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k]) => k) })),
  values:   builtin("values",   args => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([, v]) => v) })),
  entries:  builtin("entries",  args => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k, v]) => ({ tag: "VTuple" as const, elems: [k, v] })) })),
  size:     builtin("size",     args => ({ tag: "VNum", v: dictEntries(args[0]).size })),
  isEmpty:  builtin("isEmpty",  args => ({ tag: "VBool", v: dictEntries(args[0]).size === 0 })),
  toList:   builtin("toList",   args => ({ tag: "VList", elems: [...dictEntries(args[0]).values()].map(([k, v]) => ({ tag: "VTuple" as const, elems: [k, v] })) })),
  fromList: builtin("fromList", args => {
    const next = new Map<string, [Value, Value]>();
    const list = args[0]?.tag === "VList" ? args[0].elems : [];
    for (const pair of list) {
      if (pair.tag === "VTuple" && pair.elems.length >= 2) next.set(dictKey(pair.elems[0]!), [pair.elems[0]!, pair.elems[1]!]);
    }
    return mkDict(next);
  }),
  merge:    builtin("merge",    args => {
    const next = new Map(dictEntries(args[0]));
    for (const [k, kv] of dictEntries(args[1])) next.set(k, kv);
    return mkDict(next);
  }),
};

// ── Set runtime (std `Set`) ───────────────────────────────────────────────────
// VSet is immutable (every op copies). Same canonical-key scheme as VDict.
function setElems(v: Value | undefined): Map<string, Value> {
  if (v?.tag === "VSet") return v.elems;
  throw new RuntimeError(`expected Set, got ${v ? display(v) : "nothing"}`);
}
function mkSet(elems: Map<string, Value>): Value { return { tag: "VSet", elems }; }

const SET_RT: Record<string, Value> = {
  empty:      builtin("empty",      _args => mkSet(new Map())),
  add:        builtin("add",        args => {
    const next = new Map(setElems(args[0])); next.set(dictKey(args[1]!), args[1]!); return mkSet(next);
  }),
  remove:     builtin("remove",     args => {
    const next = new Map(setElems(args[0])); next.delete(dictKey(args[1]!)); return mkSet(next);
  }),
  has:        builtin("has",        args => ({ tag: "VBool", v: setElems(args[0]).has(dictKey(args[1]!)) })),
  size:       builtin("size",       args => ({ tag: "VNum", v: setElems(args[0]).size })),
  isEmpty:    builtin("isEmpty",    args => ({ tag: "VBool", v: setElems(args[0]).size === 0 })),
  toList:     builtin("toList",     args => ({ tag: "VList", elems: [...setElems(args[0]).values()] })),
  fromList:   builtin("fromList",   args => {
    const next = new Map<string, Value>();
    const list = args[0]?.tag === "VList" ? args[0].elems : [];
    for (const x of list) next.set(dictKey(x), x);
    return mkSet(next);
  }),
  union:      builtin("union",      args => {
    const next = new Map(setElems(args[0])); for (const [k, x] of setElems(args[1])) next.set(k, x); return mkSet(next);
  }),
  intersect:  builtin("intersect",  args => {
    const b = setElems(args[1]), next = new Map<string, Value>();
    for (const [k, x] of setElems(args[0])) if (b.has(k)) next.set(k, x);
    return mkSet(next);
  }),
  difference: builtin("difference", args => {
    const b = setElems(args[1]), next = new Map<string, Value>();
    for (const [k, x] of setElems(args[0])) if (!b.has(k)) next.set(k, x);
    return mkSet(next);
  }),
};

// ── Json runtime (std `Json`) ─────────────────────────────────────────────────
const OK  = (v: Value): Value => ({ tag: "VCtor", name: "Ok",    payload: v });
const ERR = (m: string): Value => ({ tag: "VCtor", name: "Error", payload: { tag: "VStr", v: m } });

const JSON_RT: Record<string, Value> = {
  parse:       builtin("parse",       args => {
    try { return OK(jsToVelve(JSON.parse(str(args[0])))); }
    catch (e) { return { tag: "VCtor", name: "Error", payload: parseErrorVal("Json", str(args[0]), e instanceof Error ? e.message : "invalid JSON") }; }
  }),
  stringify:   builtin("stringify",   args => ({ tag: "VStr", v: JSON.stringify(velveToJs(args[0]!)) ?? "null" })),
  prettyPrint: builtin("prettyPrint", args => ({ tag: "VStr", v: JSON.stringify(velveToJs(args[0]!), null, num(args[1])) ?? "null" })),
};

// ── io runtime (std `io`) ─────────────────────────────────────────────────────
// Async file/system ops. The interpreter awaits builtin promises, so each op
// returns its Result/Bool/value directly. Failures become `Error message`.
const IO_RT: Record<string, Value> = {
  readFile:   builtin("readFile",   async args => {
    try { return OK({ tag: "VStr", v: await (await loadFs()).readFile(str(args[0]), "utf8") }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "read failed"); }
  }),
  writeFile:  builtin("writeFile",  async args => {
    try { await (await loadFs()).writeFile(str(args[0]), str(args[1])); return OK({ tag: "VUnit" }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "write failed"); }
  }),
  appendFile: builtin("appendFile", async args => {
    try { await (await loadFs()).appendFile(str(args[0]), str(args[1])); return OK({ tag: "VUnit" }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "append failed"); }
  }),
  deleteFile: builtin("deleteFile", async args => {
    try { await (await loadFs()).unlink(str(args[0])); return OK({ tag: "VUnit" }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "delete failed"); }
  }),
  exists:     builtin("exists",     async args => {
    try { await (await loadFs()).access(str(args[0])); return { tag: "VBool", v: true }; }
    catch { return { tag: "VBool", v: false }; }
  }),
  readDir:    builtin("readDir",    async args => {
    try { return OK({ tag: "VList", elems: (await (await loadFs()).readdir(str(args[0]))).map(n => ({ tag: "VStr" as const, v: n })) }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "readDir failed"); }
  }),
  mkdir:      builtin("mkdir",      async args => {
    try { await (await loadFs()).mkdir(str(args[0]), { recursive: true }); return OK({ tag: "VUnit" }); }
    catch (e) { return ERR(e instanceof Error ? e.message : "mkdir failed"); }
  }),
  cwd:        builtin("cwd",        _args => ({ tag: "VStr", v: typeof process !== "undefined" ? process.cwd() : "/" })),
  env:        builtin("env",        args => {
    const val = typeof process !== "undefined" ? process.env[str(args[0])] : undefined;
    return val === undefined ? { tag: "VCtor", name: "None", payload: null } : SOME({ tag: "VStr", v: val });
  }),
};

const DURATION_RT: Record<string, Value> = {
  // Durations are ms numbers at runtime, so the conversions are identities
  // (fromSeconds scales to ms). The type checker enforces the Number/Duration line.
  fromMs:      builtin("fromMs",      args => ({ tag: "VNum", v: num(args[0]) })),
  fromSeconds: builtin("fromSeconds", args => ({ tag: "VNum", v: num(args[0]) * 1000 })),
  toMs:        builtin("toMs",        args => ({ tag: "VNum", v: num(args[0]) })),
};

const STDLIB_RUNTIME: Record<string, Record<string, Value>> = {
  "Color": COLOR_RT, "color": COLOR_RT,
  "std/Color": COLOR_RT, "std/color": COLOR_RT,
  "Duration": DURATION_RT, "duration": DURATION_RT,
  "std/Duration": DURATION_RT, "std/duration": DURATION_RT,
  "String": STRING_RT, "string": STRING_RT,
  "std/String": STRING_RT, "std/string": STRING_RT,
  "Math": MATH_RT, "math": MATH_RT,
  "std/Math": MATH_RT, "std/math": MATH_RT,
  "Dict": DICT_RT, "dict": DICT_RT,
  "std/Dict": DICT_RT, "std/dict": DICT_RT,
  "Set": SET_RT, "set": SET_RT,
  "std/Set": SET_RT, "std/set": SET_RT,
  "Json": JSON_RT, "json": JSON_RT,
  "std/Json": JSON_RT, "std/json": JSON_RT,
  "io": IO_RT, "std/io": IO_RT, "IO": IO_RT,
  "JSON": JSON_RT,
};

function num(v: Value | undefined): number {
  if (v?.tag === "VNum") return v.v;
  throw new RuntimeError(`expected Number, got ${v ? display(v) : "nothing"}`);
}
function str(v: Value | undefined): string {
  if (v?.tag === "VStr") return v.v;
  throw new RuntimeError(`expected String, got ${v ? display(v) : "nothing"}`);
}
function bool(v: Value | undefined): boolean {
  if (v?.tag === "VBool") return v.v;
  throw new RuntimeError(`expected Bool, got ${v ? display(v) : "nothing"}`);
}

// A value counts as a failure for `?:` recovery if it is `Error _` or `None`.
function isFailure(v: Value): boolean {
  return v.tag === "VCtor" && (v.name === "Error" || v.name === "None");
}
// The payload threaded to the recovery step (the error/None value itself if bare).
function failurePayload(v: Value): Value {
  return v.tag === "VCtor" && v.payload !== null ? v.payload : v;
}
