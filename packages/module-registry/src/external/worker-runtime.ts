import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { join } from "node:path";

import {
  MAX_INVOCATION_MS,
  MODULE_WORKER_CONTRACT_VERSION,
  type ExternalModulePreferenceValue
} from "@moss/module-sdk";

import type { ExternalModuleDiscovery } from "./types.js";

// #1286 Task 2e: re-export so callers of this (node-only) module don't also need to
// import from @moss/module-sdk directly. The constant itself lives in module-sdk
// because validate.ts (browser-safe, re-exported from this package's browser entry)
// needs it too and cannot pull in this file's node:child_process import.
export { MAX_INVOCATION_MS };

// #1286 Task 2e: one child process per (module, lane). Splitting only the promise
// queue while sharing a single child was the bug this task fixes — the RPC handler's
// per-invocation closure state (resolvedSecrets, actorUserId, the AI-call budget) is
// bound to whichever invocation currently owns the shared process, so two lanes
// racing on one child could run under, or leak into, the wrong actor's grant. A
// dedicated child per lane makes that structurally impossible: lanes never share
// process state, stdio, or environment.
export type WorkerLane = "queue" | `queue:${string}` | "tool" | "briefing";

// Margin subtracted from the hard ceiling when computing the absolute deadline shipped
// to the module (ctx.deadlineAt). Leaves the host time to observe the ceiling, abort
// in-flight host RPCs, and kill the child before the module's own "surely I've timed
// out" logic would fire on a deadline that has already passed host-side.
export const DEADLINE_MARGIN_MS = 5_000;

/**
 * The absolute ceiling for one invocation, honouring a queue's declared `timeoutMs`
 * (already clamped once by validate.ts) but re-clamping defensively here too — this
 * function is the single source of truth callers rely on, not a trust boundary that
 * assumes validate.ts always ran first. Falls back to 120_000ms (the constructor's
 * `invocationHardTimeoutMs` default) when no `timeoutMs` is given at all.
 */
export function resolveHardTimeout(options: { readonly timeoutMs?: number }): number {
  return Math.min(options.timeoutMs ?? 120_000, MAX_INVOCATION_MS);
}

type Rpc = (
  method: string,
  params: unknown,
  rememberSecret: (value: string) => void,
  // Host-side only (#1286 Task 2e): the per-invocation AbortController's signal,
  // aborted when the hard ceiling fires. Never serialized onto the wire — the module
  // never sees it and never gets a ctx.signal; cancelling host-held work (a pinned
  // fetch, an AI call) is the host's job alone.
  hostSignal?: AbortSignal
) => Promise<unknown>;

interface Invocation {
  readonly rpc: Rpc;
  readonly secrets: Set<string>;
  stdout: string;
  stderr: string;
  readonly controller: AbortController;
  // Reference count, not a boolean (B6/B7): a handler may have a fetch and an
  // ai.generateStructured in flight at once, and the first to finish must not resume
  // the stall clock while the second is still blocked on the host.
  inFlightRpcs: number;
  stallTimer?: ReturnType<typeof setTimeout>;
  // Arms (or re-arms) the silence-budget timer for a fresh full window. Defined as an
  // arrow property (not a method) so it closes over the runtime instance's `this` and
  // over `stallMs`/`kill` from the enclosing `run()` call, not over whatever object it
  // happens to be a property of.
  readonly armStall: () => void;
}

interface ProcessState {
  readonly child: ChildProcessWithoutNullStreams;
  readonly pending: Map<
    string | number,
    { resolve(value: unknown): void; reject(error: Error): void }
  >;
  readonly ready: Promise<void>;
  resolveReady(): void;
  rejectReady(error: Error): void;
  buffer: string;
  current?: Invocation;
  idleTimer?: ReturnType<typeof setTimeout>;
}

export class ExternalModuleWorkerError extends Error {
  constructor(readonly code: "protocol" | "timeout" | "crash" | "handler_failed") {
    super(`External module worker ${code}`);
    this.name = "ExternalModuleWorkerError";
  }
}

function laneKey(moduleId: string, lane: WorkerLane): string {
  return `${moduleId}:${lane}`;
}

export class ExternalModuleWorkerRuntime {
  // Keyed by `${moduleId}:${lane}` (#1286 Task 2e), not by moduleId alone — see
  // WorkerLane above for why a shared key (and therefore a shared child) is the bug.
  private readonly states = new Map<string, ProcessState>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private nextId = 0;

  constructor(
    private readonly options: {
      // Max time the module may go WITHOUT progress (#1286 Task 2e). Measures
      // silence, not duration: suspended for as long as any host RPC is in flight, so
      // slow host-side work (a large fetch, a slow model) is never charged against
      // the module's own budget. Default 30_000.
      readonly invocationStallMs?: number;
      // Absolute ceiling on one invocation regardless of progress, never suspended.
      // Default 120_000. A per-queue manifest `timeoutMs` (clamped to
      // MAX_INVOCATION_MS) overrides this per call — see resolveHardTimeout.
      readonly invocationHardTimeoutMs?: number;
      readonly idleTimeoutMs?: number;
      readonly logger?: { warn(data: Record<string, unknown>, message?: string): void };
    } = {}
  ) {}

  invoke(
    module: ExternalModuleDiscovery,
    handler: string,
    input: Record<string, unknown>,
    rpc: Rpc,
    options: {
      readonly lane: WorkerLane;
      readonly timeoutMs?: number;
      /** #1725: this actor's resolved on/off switches, surfaced to the module as ctx.preferences. */
      readonly preferences?: Readonly<Record<string, ExternalModulePreferenceValue>>;
      /** #1789: the actor's IANA zone, surfaced to the module as ctx.localTimezone. */
      readonly localTimezone?: string;
    }
  ): Promise<unknown> {
    const key = laneKey(module.id, options.lane);
    const prior = this.queues.get(key) ?? Promise.resolve();
    const call = prior
      .catch(() => undefined)
      .then(() => this.run(module, handler, input, rpc, options));
    this.queues.set(key, call);
    void call
      .finally(() => {
        if (this.queues.get(key) === call) this.queues.delete(key);
      })
      .catch(() => undefined);
    return call;
  }

  async close(): Promise<void> {
    const states = [...this.states.values()];
    this.states.clear();
    for (const state of states) this.stop(state, new ExternalModuleWorkerError("crash"));
    await Promise.allSettled(states.map((state) => this.waitForExit(state.child)));
  }

  private async run(
    module: ExternalModuleDiscovery,
    handler: string,
    input: Record<string, unknown>,
    rpc: Rpc,
    options: {
      readonly lane: WorkerLane;
      readonly timeoutMs?: number;
      /** #1725: this actor's resolved on/off switches, surfaced to the module as ctx.preferences. */
      readonly preferences?: Readonly<Record<string, ExternalModulePreferenceValue>>;
      /** #1789: the actor's IANA zone, surfaced to the module as ctx.localTimezone. */
      readonly localTimezone?: string;
    }
  ): Promise<unknown> {
    const key = laneKey(module.id, options.lane);
    const state = this.states.get(key) ?? this.start(module, options.lane, key);
    clearTimeout(state.idleTimer);
    const stallMs = this.options.invocationStallMs ?? 30_000;
    const hardTimeoutMs = resolveHardTimeout({
      timeoutMs: options.timeoutMs ?? this.options.invocationHardTimeoutMs
    });
    // Owned by the host alone (#1286 Task 2e): passed into `rpc(...)` as a 4th,
    // host-side-only argument so the RPC handler can forward it into a pinned fetch or
    // generateStructured call. Never put on the wire, never exposed as ctx.signal.
    const controller = new AbortController();
    const kill = (error: ExternalModuleWorkerError): void => {
      controller.abort();
      if (this.states.get(key) === state) this.states.delete(key);
      this.stop(state, error);
    };
    const invocation: Invocation = {
      rpc,
      secrets: new Set(),
      stdout: "",
      stderr: "",
      controller,
      inFlightRpcs: 0,
      armStall: () => {
        clearTimeout(invocation.stallTimer);
        invocation.stallTimer = setTimeout(
          () => kill(new ExternalModuleWorkerError("timeout")),
          stallMs
        );
      }
    };
    invocation.armStall();
    const hardTimer = setTimeout(
      () => kill(new ExternalModuleWorkerError("timeout")),
      hardTimeoutMs
    );
    try {
      await state.ready;
      state.current = invocation;
      const id = `host:${++this.nextId}`;
      const response = new Promise<unknown>((resolve, reject) =>
        state.pending.set(id, { resolve, reject })
      );
      // Absolute epoch-ms deadline the module can read off ctx.deadlineAt (#1286 Task
      // 2e) — computed fresh at send time, margin-adjusted so the module's own
      // "am I nearly out of time" checks land before the host's hard kill, never after.
      const deadlineAt = Date.now() + Math.max(1_000, hardTimeoutMs - DEADLINE_MARGIN_MS);
      this.writeToChild(
        state,
        `${JSON.stringify({
          jsonrpc: "2.0",
          id,
          method: "module.invoke",
          // #1725: preferences are resolved by the CALLER (which holds the actor's data
          // context) and passed through here. The runtime never reads them itself — it has
          // no access context, and inventing one here would be the bypass this whole design
          // exists to avoid.
          // #1789: the actor's timezone travels the same way and for the same reason. The
          // runtime cannot look it up — resolving a user's locale needs their data context,
          // which only the caller holds. Omitted entirely when the caller has none, so the
          // module can tell "no answer" from a deliberate UTC.
          params: {
            handler,
            input,
            deadlineAt,
            ...(options.preferences ? { preferences: options.preferences } : {}),
            ...(options.localTimezone ? { localTimezone: options.localTimezone } : {})
          }
        })}\n`
      );
      return await response;
    } finally {
      clearTimeout(hardTimer);
      clearTimeout(invocation.stallTimer);
      // stdout and stderr are independent pipes; let already-written child output
      // reach their data handlers before flushing this invocation's logs.
      await new Promise<void>((resolve) => setImmediate(resolve));
      this.flushLogs(module.id, options.lane, invocation);
      state.current = undefined;
      if (this.states.get(key) === state) {
        state.idleTimer = setTimeout(() => {
          this.states.delete(key);
          this.stop(state, new ExternalModuleWorkerError("crash"));
        }, this.options.idleTimeoutMs ?? 60_000);
      }
    }
  }

  private start(module: ExternalModuleDiscovery, lane: WorkerLane, key: string): ProcessState {
    const entrypoint = module.manifest.runtime?.workerEntrypoint;
    if (!entrypoint) throw new ExternalModuleWorkerError("protocol");
    const env: NodeJS.ProcessEnv = {};
    for (const envKey of ["LANG", "LC_ALL", "TZ"] as const) {
      if (process.env[envKey] !== undefined) env[envKey] = process.env[envKey];
    }
    const child = spawn(process.execPath, [join(module.dir, entrypoint)], {
      cwd: module.dir,
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let resolveReady!: () => void;
    let rejectReady!: (error: Error) => void;
    const ready = new Promise<void>((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    const state: ProcessState = {
      child,
      pending: new Map(),
      ready,
      resolveReady,
      rejectReady,
      buffer: ""
    };
    this.states.set(key, state);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.onStdout(module.id, key, state, chunk));
    child.stderr.on("data", (chunk: string) => this.capture(state, "stderr", chunk));
    child.once("error", () => this.failProcess(key, state, new ExternalModuleWorkerError("crash")));
    child.once("exit", () => this.failProcess(key, state, new ExternalModuleWorkerError("crash")));
    // #1317: `child.stdin` is a distinct EventEmitter from `child` itself — the
    // `error`/`exit` listeners above do NOT cover a broken pipe on the stdin stream.
    // A write into a pipe whose read end has already gone away (the module process
    // dying mid-teardown, e.g. under the hard-timeout `kill()` above) surfaces as an
    // unlistened 'error' event, which Node rethrows as an uncaught exception and
    // takes down the whole host process (API server or pg-boss worker). Deliberately
    // `.on`, not `.once`, unlike the child listeners above: after the first error the
    // stream is normally torn down for good, but staying attached costs nothing and
    // means a second error (however unlikely) still can't crash the host.
    child.stdin.on("error", () =>
      this.failProcess(key, state, new ExternalModuleWorkerError("crash"))
    );
    void lane; // reserved for lane-scoped diagnostics; not otherwise needed here
    return state;
  }

  private onStdout(moduleId: string, key: string, state: ProcessState, chunk: string): void {
    state.buffer += chunk;
    if (state.buffer.length > 1_048_576) {
      this.failProcess(key, state, new ExternalModuleWorkerError("protocol"));
      return;
    }
    for (;;) {
      const end = state.buffer.indexOf("\n");
      if (end < 0) return;
      const line = state.buffer.slice(0, end);
      state.buffer = state.buffer.slice(end + 1);
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(line) as Record<string, unknown>;
      } catch {
        this.capture(state, "stdout", `${line}\n`);
        continue;
      }
      if (message.method === "worker.ready") {
        const version = (message.params as { version?: unknown } | undefined)?.version;
        if (version !== MODULE_WORKER_CONTRACT_VERSION) {
          this.failProcess(key, state, new ExternalModuleWorkerError("protocol"));
        } else state.resolveReady();
        continue;
      }
      if (typeof message.method === "string" && message.id !== undefined) {
        const invocation = state.current;
        if (!invocation) {
          this.failProcess(key, state, new ExternalModuleWorkerError("protocol"));
          continue;
        }
        if (containsSecret(message.params, invocation.secrets)) {
          this.writeToChild(
            state,
            `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "rpc_failed" } })}\n`
          );
          continue;
        }
        // Stall budget suspension (#1286 Task 2e, B6/B7): the module just asked the
        // host for something, so silence stops counting against it until every
        // in-flight RPC settles. Ref-counted, not boolean — see Invocation.inFlightRpcs.
        invocation.inFlightRpcs += 1;
        if (invocation.inFlightRpcs === 1) {
          clearTimeout(invocation.stallTimer);
          invocation.stallTimer = undefined;
        }
        void invocation
          .rpc(
            message.method,
            message.params,
            (secret) => invocation.secrets.add(secret),
            invocation.controller.signal
          )
          .then(
            (result) =>
              this.writeToChild(
                state,
                `${JSON.stringify({ jsonrpc: "2.0", id: message.id, result })}\n`
              ),
            (error: unknown) => {
              // #1306: the module is told only "rpc_failed" — deliberately, so a host-side
              // failure can never become a detail channel back into module code. The host,
              // though, has to be able to see WHICH of its own RPCs broke: without this line a
              // failed embed/db/fetch call is invisible, and the only surviving evidence is a
              // module-side `handler_failed` whose stack points at the module's stdin reader.
              // Message text only, never the params — the arguments are the part that could
              // carry private content.
              this.options.logger?.warn(
                {
                  moduleId,
                  method: message.method,
                  reason: error instanceof Error ? error.message : String(error)
                },
                "external module rpc failed"
              );
              this.writeToChild(
                state,
                `${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32001, message: "rpc_failed" } })}\n`
              );
            }
          )
          .finally(() => {
            invocation.inFlightRpcs -= 1;
            // Only the invocation that's still current re-arms its own clock — a
            // straggling RPC settling after its invocation already finished (killed
            // by the hard ceiling, or resolved normally) must not schedule a kill
            // against a state that has moved on.
            if (invocation.inFlightRpcs === 0 && state.current === invocation) {
              invocation.armStall();
            }
          });
        continue;
      }
      const pending = state.pending.get(message.id as string | number);
      if (!pending) continue;
      state.pending.delete(message.id as string | number);
      if (message.error) pending.reject(new ExternalModuleWorkerError("handler_failed"));
      else if (containsSecret(message.result, state.current?.secrets)) {
        pending.reject(new ExternalModuleWorkerError("handler_failed"));
      } else pending.resolve(message.result);
    }
  }

  private capture(state: ProcessState, stream: "stdout" | "stderr", chunk: string): void {
    const invocation = state.current;
    if (!invocation) return;
    invocation[stream] = (invocation[stream] + chunk).slice(-16_384);
  }

  private flushLogs(moduleId: string, lane: WorkerLane, invocation: Invocation): void {
    for (const stream of ["stdout", "stderr"] as const) {
      let output = invocation[stream];
      if (!output) continue;
      for (const secret of [...invocation.secrets].sort((a, b) => b.length - a.length)) {
        if (secret) output = output.split(secret).join("[REDACTED]");
      }
      this.options.logger?.warn(
        { moduleId, lane, stream, output },
        "external module worker output"
      );
    }
  }

  // #1317: a torn-down pipe is a normal outcome of a timeout kill or the module
  // process dying mid-teardown, not an exceptional one. The `error` listener
  // attached in `start()` is what actually keeps a broken pipe from crashing the
  // host; this just skips the write once the stream is already known dead, so a
  // doomed write isn't attempted at all.
  private writeToChild(state: ProcessState, payload: string): void {
    if (state.child.stdin.destroyed) return;
    state.child.stdin.write(payload);
  }

  private failProcess(key: string, state: ProcessState, error: ExternalModuleWorkerError): void {
    if (this.states.get(key) === state) this.states.delete(key);
    this.stop(state, error);
  }

  private stop(state: ProcessState, error: ExternalModuleWorkerError): void {
    clearTimeout(state.idleTimer);
    state.rejectReady(error);
    for (const pending of state.pending.values()) pending.reject(error);
    state.pending.clear();
    if (!state.child.killed) state.child.kill();
  }

  private waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
    return new Promise((resolve) => child.once("exit", () => resolve()));
  }
}

function containsSecret(value: unknown, secrets: ReadonlySet<string> | undefined): boolean {
  if (!secrets?.size) return false;
  const encoded = JSON.stringify(value);
  return [...secrets].some((secret) => secret.length > 0 && encoded.includes(secret));
}
