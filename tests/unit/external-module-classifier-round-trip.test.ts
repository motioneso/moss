// tests/unit/external-module-classifier-round-trip.test.ts
//
// Plan 2.2 (#2882): the installed fixture round trip. A real worker subprocess declared with a
// classifier opt-in is validated, mapped into a runtime manifest, and its candidate hook is run
// through the same sandbox/RPC boundary production uses — read-only, actor-scoped and bounded.
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { checkClassifierEligibility, normalizeClassifierCandidates } from "@moss/module-sdk";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import {
  createExternalModuleRpcHandler,
  createExternalToolManifests,
  ExternalModuleWorkerRuntime,
  validateExternalModuleManifest
} from "@moss/module-registry/node";

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true }))));

const ACTOR_A = "00000000-0000-4000-8000-00000000000a";
const ACTOR_B = "00000000-0000-4000-8000-00000000000b";

/**
 * A worker speaking the raw module.invoke wire protocol. `demo.candidates` echoes the actor id
 * so actor scoping is observable; `probeMutation` makes it attempt a KV write; `demo.hang` never
 * answers; `demo.throw` fails the handler.
 */
async function fixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(process.cwd(), ".tmp-external-classifier-"));
  dirs.push(dir);
  await mkdir(join(dir, "dist"), { recursive: true });
  await writeFile(
    join(dir, "dist", "worker.js"),
    `let buffer = "";
process.stdin.setEncoding("utf8");
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
send({ jsonrpc: "2.0", method: "worker.ready", params: { version: 1 } });
const pending = new Map();
function callHost(method, params) {
  const id = "worker:" + Math.random().toString(36).slice(2);
  send({ jsonrpc: "2.0", id, method, params });
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
}
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
async function handle(message) {
  if (message.method !== "module.invoke") {
    const waiter = message.id && pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message));
    else waiter.resolve(message.result);
    return;
  }
  const { handler, input } = message.params;
  try {
    if (handler === "demo.hang") return;
    if (handler === "demo.throw") throw new Error("candidate hook failed");
    if (handler === "demo.candidates") {
      if (input.probeMutation) {
        try {
          await callHost("kv.set", { scope: "user", namespace: "demo.state", key: "k", value: { x: 1 } });
        } catch {
          send({ jsonrpc: "2.0", id: message.id, result: { mutationBlocked: true } });
          return;
        }
        send({ jsonrpc: "2.0", id: message.id, result: { mutationBlocked: false } });
        return;
      }
      send({ jsonrpc: "2.0", id: message.id, result: [{ id: input.actorUserId, label: input.actorUserId }] });
      return;
    }
    send({ jsonrpc: "2.0", id: message.id, result: { ok: true } });
  } catch {
    send({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "handler_failed" } });
  }
}`
  );
  return dir;
}

function rawManifest(candidatesHandler: string) {
  return {
    schemaVersion: 1,
    id: "demo",
    name: "Demo",
    version: "0.1.0",
    publisher: "Test",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.1.0" },
    runtime: { workerEntrypoint: "dist/worker.js", workerContractVersion: 1 },
    storage: [{ namespace: "demo.state", scopes: ["user"] }],
    assistantTools: [
      {
        name: "demo.switch",
        permissionId: "demo.switch",
        description: "Switch a demo device.",
        risk: "read",
        inputSchema: {
          type: "object",
          properties: { device: { type: "string" } },
          required: ["device"]
        },
        outputSchema: { type: "object", properties: { name: { type: "string" } } },
        handler: "demo.run",
        classifier: {
          description: "Switch a demo device",
          arguments: { device: { kind: "candidates" } },
          candidatesHandler,
          replyTemplate: "Switched {name}."
        }
      }
    ]
  };
}

/** The same RPC construction as apps/api/src/external-module-tools.ts: read risk, actor bound. */
function readRpc(module: ExternalModuleDiscovery, actorUserId: string) {
  return createExternalModuleRpcHandler({
    module,
    toolRisk: "read",
    actorUserId,
    requestId: "req-1",
    // Only reached by db.query/kv paths; kv.set is refused by risk before it is used for a write.
    workerDataContext: {
      withDataContext: async (_access: unknown, run: (db: unknown) => unknown) =>
        run({ db: { executeQuery: async () => ({ rows: [] }) } })
    } as never,
    isActorAdmin: async () => false,
    embeddingProvider: null as never
  });
}

function candidateInvoker(runtime: ExternalModuleWorkerRuntime, timeoutMs?: number) {
  return async (
    module: ExternalModuleDiscovery,
    handler: string,
    access: { readonly actorUserId: string; readonly requestId: string },
    signal: AbortSignal
  ) =>
    runtime.invoke(
      module,
      handler,
      { actorUserId: access.actorUserId },
      readRpc(module, access.actorUserId),
      {
        lane: "tool",
        ...(timeoutMs === undefined ? {} : { timeoutMs }),
        signal
      }
    );
}

async function installed(candidatesHandler: string) {
  const dir = await fixtureDir();
  const validated = validateExternalModuleManifest(rawManifest(candidatesHandler), "demo", "0.1.0");
  expect(validated.ok).toBe(true);
  if (!validated.ok) throw new Error(validated.errors.join(", "));
  const discovery: ExternalModuleDiscovery = {
    id: "demo",
    dir,
    manifest: validated.manifest,
    manifestHash: "sha256:demo",
    packageHash: "sha256:demo"
  };
  return discovery;
}

describe("external classifier round trip (#2882)", () => {
  it("loads a valid opt-in into an eligible runtime tool", async () => {
    const discovery = await installed("demo.candidates");
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      idleTimeoutMs: 200
    });
    const [manifest] = createExternalToolManifests(
      [discovery],
      async () => ({ data: {} }),
      candidateInvoker(runtime)
    );
    const tool = manifest?.assistantTools?.[0];
    expect(checkClassifierEligibility(tool as never)).toEqual({ eligible: true });

    const provider = tool?.classifier?.candidates;
    expect(provider).toBeDefined();
    const raw = await provider!(null, { actorUserId: ACTOR_A, requestId: "r" } as never, {
      signal: new AbortController().signal
    });
    const normalized = normalizeClassifierCandidates(raw);
    expect(normalized.ok).toBe(true);
    if (normalized.ok) expect(normalized.candidates.map((c) => c.id)).toEqual([ACTOR_A]);
    await runtime.close();
  });

  it("scopes candidate values to the acting actor", async () => {
    const discovery = await installed("demo.candidates");
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      idleTimeoutMs: 200
    });
    const [manifest] = createExternalToolManifests(
      [discovery],
      async () => ({ data: {} }),
      candidateInvoker(runtime)
    );
    const provider = manifest!.assistantTools![0]!.classifier!.candidates!;
    const load = (actorUserId: string) =>
      provider(null, { actorUserId, requestId: "r" } as never, {
        signal: new AbortController().signal
      });
    expect(normalizeClassifierCandidates(await load(ACTOR_A))).toEqual({
      ok: true,
      candidates: [{ id: ACTOR_A, label: ACTOR_A }]
    });
    expect(normalizeClassifierCandidates(await load(ACTOR_B))).toEqual({
      ok: true,
      candidates: [{ id: ACTOR_B, label: ACTOR_B }]
    });
    await runtime.close();
  });

  it("refuses a KV write attempted by the hook (read-only sandbox)", async () => {
    const discovery = await installed("demo.candidates");
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      idleTimeoutMs: 200
    });
    const result = await runtime.invoke(
      discovery,
      "demo.candidates",
      { actorUserId: ACTOR_A, probeMutation: true },
      readRpc(discovery, ACTOR_A),
      { lane: "tool" }
    );
    expect(result).toEqual({ mutationBlocked: true });
    await runtime.close();
  });

  it("declines when the hook fails, without running the tool", async () => {
    const discovery = await installed("demo.throw");
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 5_000,
      idleTimeoutMs: 200
    });
    const invoke = vi.fn(async () => ({ data: {} }));
    const [manifest] = createExternalToolManifests([discovery], invoke, candidateInvoker(runtime));
    const provider = manifest!.assistantTools![0]!.classifier!.candidates!;
    await expect(
      provider(null, { actorUserId: ACTOR_A, requestId: "r" } as never, {
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "handler_failed" });
    expect(invoke).not.toHaveBeenCalled();
    await runtime.close();
  });

  it("bounds a stalled hook so it cannot strand the gate", async () => {
    const discovery = await installed("demo.hang");
    const runtime = new ExternalModuleWorkerRuntime({
      invocationStallMs: 30_000,
      idleTimeoutMs: 200
    });
    const [manifest] = createExternalToolManifests(
      [discovery],
      async () => ({ data: {} }),
      candidateInvoker(runtime, 200)
    );
    const provider = manifest!.assistantTools![0]!.classifier!.candidates!;
    const startedAt = Date.now();
    await expect(
      provider(null, { actorUserId: ACTOR_A, requestId: "r" } as never, {
        signal: new AbortController().signal
      })
    ).rejects.toMatchObject({ code: "timeout" });
    expect(Date.now() - startedAt).toBeLessThan(5_000);
    await runtime.close();
  });
});
