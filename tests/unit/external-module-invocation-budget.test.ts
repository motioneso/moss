// tests/unit/external-module-invocation-budget.test.ts
//
// #1286 Task 2e: the stall-budget/hard-ceiling/lane-isolation/deadline-visibility
// contract for external module invocations. Covers the 17 cases in
// docs/superpowers/handoffs/2026-07-27-job-search/parts/07-task02e-deadline.md
// ("Tests" section), grouped below in the same order: budget behavior (1-4, 9),
// lane isolation (5-7), deadline wiring (8, 10), manifest validation (11-12),
// invoke-call wiring (13-15), and host-side cancellation forwarding (16-17).
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";
import type { Job } from "pg-boss";

import type { DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import type { ExternalModuleJobPayload } from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import {
  createExternalModuleRpcHandler,
  DEADLINE_MARGIN_MS,
  ExternalModuleWorkerRuntime,
  MAX_INVOCATION_MS,
  resolveHardTimeout,
  validateExternalModuleManifest
} from "@moss/module-registry/node";
import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";
import type { ModuleCredentialCipher } from "@moss/settings";

import { createExternalModuleJobHandler } from "../../apps/worker/src/external-module-job-handler.js";
import { createExternalBriefingInvoker } from "../../apps/worker/src/external-module-invoke.js";

const OWNER_A = "00000000-0000-4000-8000-00000000000a";

// Temp dirs from fixture()/spawnWorker() below; cleaned up after every test so a
// failed run doesn't leave .tmp-invocation-budget-* directories behind.
const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

function deferred<T = unknown>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/**
 * A worker.js speaking the raw module.invoke wire protocol directly (no SDK), covering
 * every handler this file's runtime-level tests need:
 *   - "spin": silent forever — never RPCs, never responds (stall/hard-ceiling kills).
 *   - "await-rpc": makes exactly one host RPC carrying input.actorUserId, awaits it,
 *     echoes { pid, result } — the "blocked on a slow/latched host RPC" shape.
 *   - "progress": makes host RPCs back-to-back (capped at 50) — the "makes progress but
 *     still exceeds the ceiling" shape.
 *   - "reflect-deadline": echoes params.deadlineAt straight off the wire.
 *   - "echo-fast": resolves immediately with { pid } — a same-tick foreground call.
 */
async function fixture(): Promise<ExternalModuleDiscovery> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-invocation-budget-"));
  dirs.push(dir);
  await writeFile(
    join(dir, "worker.js"),
    `let buffer = "";
process.stdin.setEncoding("utf8");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ jsonrpc: "2.0", method: "worker.ready", params: { version: 1 } });
const pendingHost = new Map();
process.stdin.on("data", chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf("\\n")) >= 0) {
    const line = buffer.slice(0, i);
    buffer = buffer.slice(i + 1);
    if (!line) continue;
    void handle(JSON.parse(line));
  }
});
function callHost(method, params) {
  const id = "worker:" + Math.random().toString(36).slice(2);
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pendingHost.set(id, { resolve, reject }));
}
async function handle(message) {
  if (message.method !== "module.invoke") {
    const waiter = message.id && pendingHost.get(message.id);
    if (!waiter) return;
    pendingHost.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  const { handler, input, deadlineAt } = message.params;
  if (handler === "spin") return;
  if (handler === "reflect-deadline") {
    send({ jsonrpc: "2.0", id: message.id, result: { deadlineAt } });
    return;
  }
  if (handler === "echo-fast") {
    send({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid } });
    return;
  }
  if (handler === "await-rpc") {
    const result = await callHost("test.rpc", { actorUserId: input.actorUserId });
    send({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid, result } });
    return;
  }
  if (handler === "progress") {
    for (let i = 0; i < 50; i++) await callHost("test.tick", { i });
    send({ jsonrpc: "2.0", id: message.id, result: { pid: process.pid } });
  }
}`
  );
  return {
    id: "acme",
    dir,
    manifest: {
      schemaVersion: 1,
      id: "acme",
      name: "Acme",
      version: "1.0.0",
      publisher: "Acme",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      runtime: { workerEntrypoint: "worker.js", workerContractVersion: 1 }
    },
    manifestHash: "sha256:test",
    packageHash: "sha256:test"
  };
}

describe("ExternalModuleWorkerRuntime stall budget and hard ceiling (#1286 Task 2e)", () => {
  it("does not kill an invocation blocked on a slow host RPC (the stall budget measures silence, not RPC duration)", async () => {
    const module = await fixture();
    // stallMs (150) is well under the host RPC's own delay (400) — under the old flat
    // timer this invocation would have died; the ref-counted suspension must keep it alive.
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 150,
      invocationHardTimeoutMs: 5_000
    });
    const rpc = async () => new Promise((resolve) => setTimeout(() => resolve("host-done"), 400));
    const result = (await runtime.invoke(module, "await-rpc", {}, rpc, { lane: "queue" })) as {
      result: unknown;
    };
    expect(result.result).toBe("host-done");
    await runtime.close();
  });

  it("kills an invocation that goes quiet longer than the stall budget", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 150,
      invocationHardTimeoutMs: 5_000
    });
    const started = Date.now();
    await expect(
      runtime.invoke(module, "spin", {}, async () => null, { lane: "queue" })
    ).rejects.toMatchObject({ code: "timeout" });
    // Killed on the (small) stall schedule, not left to run to the (large) hard ceiling.
    expect(Date.now() - started).toBeLessThan(2_000);
    await runtime.close();
  });

  it("kills an invocation that exceeds the hard ceiling even while making progress", async () => {
    const module = await fixture();
    // The handler RPCs back-to-back with near-zero host latency, so no single gap ever
    // reaches the (comparatively large) stall budget — only the absolute ceiling can stop it.
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 300,
      invocationHardTimeoutMs: 400
    });
    let ticks = 0;
    const rpc = async () => {
      ticks += 1;
      // Each gap stays well under stallMs (300) so the stall timer never fires; the
      // cumulative time across iterations is what exceeds hardTimeoutMs (400).
      await new Promise((resolve) => setTimeout(resolve, 20));
      return "ok";
    };
    await expect(
      runtime.invoke(module, "progress", {}, rpc, { lane: "queue" })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(ticks).toBeGreaterThan(0);
    await runtime.close();
  });

  it("honours a queue's declared ceiling but clamps it to the host maximum", () => {
    expect(resolveHardTimeout({ timeoutMs: 600_000 })).toBe(600_000);
    expect(resolveHardTimeout({ timeoutMs: 86_400_000 })).toBe(MAX_INVOCATION_MS);
  });

  it("still kills at the ceiling a handler that ignores its deadline (deadline is cooperative; the ceiling is the bound)", async () => {
    const module = await fixture();
    // stallMs is deliberately far larger than hardTimeoutMs: if the stall timer fired
    // first this would be indistinguishable from the stall-kill case above.
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 10_000,
      invocationHardTimeoutMs: 300
    });
    const started = Date.now();
    await expect(
      runtime.invoke(module, "spin", {}, async () => null, { lane: "queue" })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - started).toBeLessThan(2_000);
    await runtime.close();
  });
});

describe("ExternalModuleWorkerRuntime lane isolation (#1286 Task 2e)", () => {
  it("runs two lanes of one module in two separate child processes", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      invocationHardTimeoutMs: 10_000
    });
    const latch = deferred<unknown>();
    const rpcASeen = deferred<void>();
    let seenActorUserId: unknown;
    const rpcA = async (_method: string, params: unknown) => {
      seenActorUserId = (params as { actorUserId?: string }).actorUserId;
      rpcASeen.resolve();
      return latch.promise;
    };
    const queueCall = runtime.invoke(module, "await-rpc", { actorUserId: OWNER_A }, rpcA, {
      lane: "queue"
    }) as Promise<{ pid: number; result: unknown }>;
    const toolResult = (await runtime.invoke(module, "echo-fast", {}, async () => null, {
      lane: "tool"
    })) as { pid: number };
    // The queue lane's child process takes its own time to spawn and hand off its first
    // RPC — wait for that to actually happen rather than assuming it beat the (fast,
    // no-RPC) tool-lane call above.
    await rpcASeen.promise;
    // The queue-lane RPC dispatched under the actor identity the queue call carried,
    // proving each lane keeps its own invocation closure rather than sharing one.
    expect(seenActorUserId).toBe(OWNER_A);
    latch.resolve("released");
    const queueResult = await queueCall;
    expect(queueResult.result).toBe("released");
    // Two distinct child processes, not one shared child serving both lanes.
    expect(queueResult.pid).not.toBe(toolResult.pid);
    await runtime.close();
  });

  it("does not queue a foreground tool call behind a running background job", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      invocationHardTimeoutMs: 10_000
    });
    const latch = deferred<unknown>();
    const queueCall = runtime.invoke(module, "await-rpc", {}, async () => latch.promise, {
      lane: "queue"
    });
    // A never-resolving queue invocation must not delay a same-tick tool-lane call; if it
    // did, this race would time out instead of resolving.
    const toolResult = await Promise.race([
      runtime.invoke(module, "echo-fast", {}, async () => null, { lane: "tool" }),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("tool call was blocked")), 1_000)
      )
    ]);
    expect(toolResult).toMatchObject({ pid: expect.any(Number) });
    latch.resolve("done");
    await queueCall;
    await runtime.close();
  });

  it("kills only the timing-out lane's child, leaving a concurrent lane's invocation alive", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      invocationHardTimeoutMs: 5_000
    });
    const latch = deferred<unknown>();
    // Under one shared child, stop(state) for the timing-out queue lane would kill this
    // latched tool-lane invocation too.
    const toolCall = runtime.invoke(module, "await-rpc", {}, async () => latch.promise, {
      lane: "tool"
    }) as Promise<{ result: unknown }>;
    await expect(
      runtime.invoke(module, "spin", {}, async () => null, { lane: "queue", timeoutMs: 200 })
    ).rejects.toMatchObject({ code: "timeout" });
    latch.resolve("still-alive");
    await expect(toolCall).resolves.toMatchObject({ result: "still-alive" });
    await runtime.close();
  });
});

describe("ExternalModuleWorkerRuntime deadline visibility (#1286 Task 2e)", () => {
  it("ships an absolute deadline in the invoke params, inside the hard ceiling", async () => {
    const module = await fixture();
    const runtime = new ExternalModuleWorkerRuntime({ invocationHardTimeoutMs: 10_000 });
    const before = Date.now();
    // Asserted at the wire: the child echoes back exactly the deadlineAt value it read
    // off params, not a value read from a runtime getter.
    const result = (await runtime.invoke(module, "reflect-deadline", {}, async () => null, {
      lane: "queue"
    })) as { deadlineAt: number };
    expect(Number.isFinite(result.deadlineAt)).toBe(true);
    expect(result.deadlineAt).toBeGreaterThan(before);
    expect(result.deadlineAt).toBeLessThanOrEqual(before + 10_000 - DEADLINE_MARGIN_MS + 250);
    await runtime.close();
  });

  it("defaults deadlineAt when the host does not send one, and exposes no signal", async () => {
    // Drives the real SDK (packages/module-sdk/src/worker.ts) directly over its own
    // stdio protocol, bypassing ExternalModuleWorkerRuntime entirely, so this fails
    // closed if a future host regression ever omits deadlineAt again.
    const dir = await mkdtemp(join(process.cwd(), ".tmp-invocation-budget-sdk-"));
    dirs.push(dir);
    const entry = join(dir, "worker.mjs");
    const workerSrc = JSON.stringify(join(process.cwd(), "packages/module-sdk/src/worker.ts"));
    await writeFile(
      entry,
      `import { defineModuleWorker } from ${workerSrc};
defineModuleWorker({
  handlers: {
    reflect: async (ctx) => ({ deadlineAt: ctx.deadlineAt, hasSignal: "signal" in ctx })
  }
});
`
    );
    const child = spawn(process.execPath, ["--import", "tsx", entry], {
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    const lines: Record<string, unknown>[] = [];
    const waiters: ((line: Record<string, unknown>) => void)[] = [];
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let index: number;
      while ((index = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const parsed = JSON.parse(line) as Record<string, unknown>;
        const waiter = waiters.shift();
        if (waiter) waiter(parsed);
        else lines.push(parsed);
      }
    });
    const next = (): Promise<Record<string, unknown>> =>
      lines.length > 0
        ? Promise.resolve(lines.shift()!)
        : new Promise((resolve) => waiters.push(resolve));
    try {
      await next(); // worker.ready
      const before = Date.now();
      // Deliberately omits deadlineAt from params — simulating a host built before this task.
      child.stdin.write(
        `${JSON.stringify({
          jsonrpc: "2.0",
          id: "host:1",
          method: "module.invoke",
          params: { handler: "reflect", input: {} }
        })}\n`
      );
      const response = (await next()) as { result: { deadlineAt: number; hasSignal: boolean } };
      expect(response.result.hasSignal).toBe(false);
      expect(Number.isFinite(response.result.deadlineAt)).toBe(true);
      expect(response.result.deadlineAt).toBeGreaterThan(before);
      expect(response.result.deadlineAt).toBeLessThanOrEqual(before + 30_000 + 5_000);
    } finally {
      child.kill();
    }
  }, 20_000);
});

const MANIFEST_BASE = {
  schemaVersion: 1,
  id: "acme",
  name: "Acme",
  version: "0.1.0",
  publisher: "Acme, Inc.",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 }
} as const;

describe("worker queue timeoutMs validation (validate.ts, #1286 Task 2e)", () => {
  it("rejects a queue whose timeoutMs is not a positive integer", () => {
    for (const bad of [0, -1, 1.5, NaN, "600000", null]) {
      const result = validateExternalModuleManifest(
        {
          ...MANIFEST_BASE,
          worker: { queues: [{ name: "acme.crawl", handler: "crawl", timeoutMs: bad }] }
        },
        "acme",
        "0.1.0"
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.errors.join(" ")).toContain(
          "worker queue timeoutMs must be a positive integer"
        );
      }
    }
  });

  it("clamps a timeoutMs above the platform ceiling on the normalized manifest, not the input", () => {
    const result = validateExternalModuleManifest(
      {
        ...MANIFEST_BASE,
        worker: { queues: [{ name: "acme.crawl", handler: "crawl", timeoutMs: 86_400_000 }] }
      },
      "acme",
      "0.1.0"
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      const queues = result.manifest.worker?.queues as
        | readonly { timeoutMs?: number }[]
        | undefined;
      expect(queues?.[0]?.timeoutMs).toBe(MAX_INVOCATION_MS);
    }
  });
});

function fakeWorkerDb(
  row: { status: string; manifest_hash: string; package_hash: string } | undefined
): Kysely<MossDatabase> {
  // A minimal chainable stand-in for the one query createVerifiedExternalModuleInvoker
  // runs (selectFrom/select/where/executeTakeFirst) — a full Kysely instance would need
  // a real Postgres connection this unit test has no business opening.
  const builder = {
    selectFrom: () => builder,
    select: () => builder,
    where: () => builder,
    executeTakeFirst: async () => row
  };
  return builder as unknown as Kysely<MossDatabase>;
}

function verifiedInvokerDeps(
  invoke: (...args: unknown[]) => Promise<unknown>,
  module: ExternalModuleDiscovery
) {
  return {
    workerDb: fakeWorkerDb({
      status: "enabled",
      manifest_hash: module.manifestHash,
      package_hash: module.packageHash
    }),
    getDiscoveryById: (id: string) => (id === module.id ? module : undefined),
    listDiscoveredModuleIds: () => [module.id],
    // DataContextRunner has a private constructor-bound rootDb; this test only ever
    // exercises the withDataContext contract, so a structural stand-in is cast rather
    // than constructed for real.
    dataContext: {
      withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
        fn({} as DataContextDb)
    } as unknown as DataContextRunner,
    cipher: {} as unknown as ModuleCredentialCipher,
    runtime: { invoke },
    listActiveUserIds: async () => [OWNER_A]
  };
}

describe("createExternalModuleJobHandler invoke-call wiring (#1286 Task 2e)", () => {
  function jobModule(): ExternalModuleDiscovery {
    return {
      id: "acme",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      // createExternalModuleRpcHandler reads manifest.auth/storage/fetchHosts
      // unconditionally (each `?? []`) — an empty manifest is enough since these
      // wiring tests never actually reach the child process.
      manifest: {}
    } as unknown as ExternalModuleDiscovery;
  }

  function jobFixture(queue: ExternalModuleQueueDeclaration) {
    const module = jobModule();
    const invoke = vi.fn().mockResolvedValue("done");
    const handler = createExternalModuleJobHandler({
      module,
      queue,
      ...verifiedInvokerDeps(invoke, module)
    });
    return { handler, invoke, module };
  }

  function job(module: ExternalModuleDiscovery): Job<ExternalModuleJobPayload> {
    return {
      id: "job-1",
      data: {
        actorUserId: OWNER_A,
        moduleId: module.id,
        jobKind: "scheduled-crawl",
        manifestHash: module.manifestHash
      }
    } as unknown as Job<ExternalModuleJobPayload>;
  }

  it("passes the queue's normalized timeoutMs into runtime.invoke", async () => {
    const { handler, invoke, module } = jobFixture({
      name: "acme.crawl",
      handler: "crawl",
      timeoutMs: 600_000
    });
    await handler(job(module));
    // toMatchObject, not toEqual: the real call always carries an own `timeoutMs` key
    // (undefined when the queue declares none) — see case 14's undefined-timeoutMs call.
    expect(invoke.mock.calls[0]?.[4]).toMatchObject({
      lane: "queue:acme.crawl",
      timeoutMs: 600_000
    });
  });

  it("invokes with the default ceiling when a queue declares no timeoutMs", async () => {
    const { handler, invoke, module } = jobFixture({ name: "acme.crawl", handler: "crawl" });
    await handler(job(module));
    expect(invoke.mock.calls[0]?.[4]).toMatchObject({ lane: "queue:acme.crawl" });
    expect((invoke.mock.calls[0]?.[4] as { lane: string }).lane).not.toBe("briefing");
  });
});

describe("createExternalBriefingInvoker invoke-call wiring (#1286 Task 2e)", () => {
  it("invokes a briefing contribution on the briefing lane, not the queue lane a running crawl would hold", async () => {
    const module = {
      id: "acme",
      manifestHash: `sha256:${"a".repeat(64)}`,
      packageHash: `sha256:${"b".repeat(64)}`,
      manifest: {}
    } as unknown as ExternalModuleDiscovery;
    const invoke = vi.fn().mockResolvedValue({ headline: "done" });
    // The REAL adapter — createVerifiedExternalModuleInvoker's shared trust gate, not a
    // hand-built options object — so a rejection here would prove nothing about the
    // production path.
    const briefingInvoke = createExternalBriefingInvoker(verifiedInvokerDeps(invoke, module));
    await briefingInvoke({
      moduleId: "acme",
      handler: "morningSummary",
      actorUserId: OWNER_A,
      requestId: "req-1",
      section: "morning"
    });
    expect(invoke.mock.calls[0]?.[4]).toMatchObject({ lane: "briefing" });
    expect((invoke.mock.calls[0]?.[4] as { lane: string }).lane).not.toBe("queue");
  });
});

function fakeScopedDb(): DataContextDb {
  // DummyDriver backs a real (but connectionless) Kysely instance, satisfying
  // worker-rpc-host.ts's `sql\`...\`.execute(scopedDb.db)` call without opening a
  // real Postgres connection — this stays a unit test.
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new DummyDriver(),
      createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  return { db } as unknown as DataContextDb;
}

function rpcHostFixture(fetchHosts?: readonly string[]): ExternalModuleDiscovery {
  return {
    id: "acme",
    dir: process.cwd(),
    manifestHash: `sha256:${"a".repeat(64)}`,
    packageHash: `sha256:${"b".repeat(64)}`,
    manifest: {
      schemaVersion: 1,
      id: "acme",
      name: "Acme",
      version: "0.1.0",
      publisher: "Acme, Inc.",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" },
      ...(fetchHosts ? { fetchHosts } : {})
    }
  } as unknown as ExternalModuleDiscovery;
}

// #1286 Task 2e: these two drive createExternalModuleRpcHandler directly with a
// manually-aborted AbortController, exactly the contract ExternalModuleWorkerRuntime's
// kill() relies on (abort(), then treat the invocation as dead) — rather than through
// the full child-process runtime. Driving the full runtime here would exercise a
// pre-existing gap unrelated to this task (state.child.stdin has no "error" listener,
// so a post-kill rpc_failed write can throw); isolating to the rpc-host boundary keeps
// this a reliable unit test of exactly the wiring Task 2e adds (see report to team-lead).
describe("createExternalModuleRpcHandler cancellation forwarding (#1286 Task 2e)", () => {
  it("aborts an in-flight fetch.request at the hard ceiling instead of letting it resolve", async () => {
    let serverSawAbort = false;
    const server = createServer((req) => {
      // A real deferred handler: res.end() is deliberately never called, so the only
      // way this request ever settles is the client aborting it.
      req.on("aborted", () => {
        serverSawAbort = true;
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as AddressInfo).port;
    const controller = new AbortController();
    const rpc = createExternalModuleRpcHandler({
      module: rpcHostFixture(["127.0.0.1"]),
      toolRisk: "read",
      actorUserId: OWNER_A,
      requestId: "req-1",
      workerDataContext: {
        withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
          fn(fakeScopedDb())
      } as unknown as DataContextRunner,
      cipher: {} as unknown as ModuleCredentialCipher,
      isActorAdmin: () => Promise.resolve(false),
      embeddingProvider: () => Promise.reject(new Error("not used by fetch.request")),
      // Bypasses createHostPinnedFetch's SSRF host allowlist so the test can target its
      // own loopback server; the forwarding behavior under test lives entirely in the
      // ...(hostSignal ? { signal: hostSignal } : {}) spread, not in host pinning.
      createFetch: () => fetch as typeof fetch
    });
    const call = rpc(
      "fetch.request",
      { url: `http://127.0.0.1:${port}/` },
      () => undefined,
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 50));
    controller.abort();
    await expect(call).rejects.toThrow();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(serverSawAbort).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it("resolves an in-flight AI RPC as {ok: false, error: 'aborted'} at the hard ceiling", async () => {
    const controller = new AbortController();
    let sawSignal: AbortSignal | undefined;
    const rpc = createExternalModuleRpcHandler({
      module: rpcHostFixture(),
      toolRisk: "write",
      actorUserId: OWNER_A,
      requestId: "req-1",
      workerDataContext: {
        withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
          fn(fakeScopedDb())
      } as unknown as DataContextRunner,
      cipher: {} as unknown as ModuleCredentialCipher,
      isActorAdmin: () => Promise.resolve(false),
      embeddingProvider: () => Promise.reject(new Error("not used by ai.generateStructured")),
      // Stands in for generateStructured (packages/ai, out of this module's reach by
      // design — spec D6) but honours the same contract: awaits the forwarded signal and
      // resolves the typed "aborted" error the real implementation already produces.
      ai: (_scopedDb, request) => {
        sawSignal = request.signal;
        return new Promise((resolve) => {
          request.signal?.addEventListener(
            "abort",
            () => resolve({ ok: false, error: "aborted" }),
            {
              once: true
            }
          );
        });
      }
    });
    const call = rpc(
      "ai.generateStructured",
      { schema: {}, prompt: "x" },
      () => undefined,
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort();
    await expect(call).resolves.toEqual({ ok: false, error: "aborted" });
    expect(sawSignal).toBe(controller.signal);
  });
});
