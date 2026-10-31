import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import type { DataContextRunner } from "@moss/db";
import { assertModuleJobPayload } from "@moss/jobs";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import { createExternalModuleRpcHandler } from "@moss/module-registry/node";
import type { ExternalModuleQueueDeclaration } from "@moss/module-sdk";

type Enqueue = NonNullable<Parameters<typeof createExternalModuleRpcHandler>[0]["enqueueJob"]>;

const MANIFEST_HASH = `sha256:${"a".repeat(64)}`;

const generate: ExternalModuleQueueDeclaration = {
  name: "meals.generate",
  handler: "generate",
  allowModuleEnqueue: true,
  paramsSchema: {
    type: "object",
    fields: { planId: { type: "uuid" }, day: { type: "integer", min: 0, max: 31 } }
  }
} as ExternalModuleQueueDeclaration;
const closed: ExternalModuleQueueDeclaration = { name: "meals.closed", handler: "closed" };

const module = {
  id: "meals",
  dir: "/unused",
  manifest: {
    schemaVersion: 1,
    id: "meals",
    name: "Meals",
    version: "1.0.0",
    publisher: "Jarvis",
    lifecycle: "optional",
    compatibility: { jarv1s: ">=0.0.0" },
    worker: { queues: [generate, closed] }
  },
  manifestHash: "sha256:a",
  packageHash: "sha256:a"
} as unknown as ExternalModuleDiscovery;

const call = {
  queue: "meals.generate",
  jobKind: "generate-day",
  idempotencyKey: "plan-1:day-2",
  params: { planId: randomUUID(), day: 2 }
};

function rpcFor(toolRisk: "read" | "write", enqueueJob?: Enqueue) {
  return createExternalModuleRpcHandler({
    module,
    toolRisk,
    actorUserId: randomUUID(),
    requestId: randomUUID(),
    workerDataContext: null as unknown as DataContextRunner,
    isActorAdmin: async () => false,
    embeddingProvider: null as never,
    enqueueJob
  });
}

const run = (rpc: ReturnType<typeof rpcFor>, params: unknown) =>
  rpc("jobs.enqueue", params, () => undefined);

afterEach(() => vi.restoreAllMocks());

describe("external worker ctx.jobs port (slice 3, #3721)", () => {
  it("passes the bound actor and the module's own queue declaration to the port", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "enqueued" });
    await expect(run(rpcFor("write", enqueueJob), call)).resolves.toEqual({ status: "enqueued" });
    const [access, request] = enqueueJob.mock.calls[0] as Parameters<Enqueue>;
    expect(access).toMatchObject({ actorUserId: expect.any(String) });
    expect(request.queue).toBe(generate);
    expect(request).toMatchObject({ jobKind: "generate-day", idempotencyKey: "plan-1:day-2" });
  });

  it("passes a duplicate through", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "duplicate" });
    await expect(run(rpcFor("write", enqueueJob), call)).resolves.toEqual({ status: "duplicate" });
  });

  it("throws invalid_rpc when no port is wired", async () => {
    await expect(run(rpcFor("write"), call)).rejects.toMatchObject({ code: "invalid_rpc" });
  });

  it("refuses a read-risk tool and a candidate hook (read risk) before anything else", async () => {
    const enqueueJob = vi.fn<Enqueue>();
    await expect(run(rpcFor("read", enqueueJob), call)).rejects.toMatchObject({
      code: "forbidden_enqueue_mutation"
    });
    // Risk is checked before the port-wired check, so even a bad body gets this code.
    await expect(run(rpcFor("read", enqueueJob), "junk")).rejects.toMatchObject({
      code: "forbidden_enqueue_mutation"
    });
    await expect(run(rpcFor("read"), call)).rejects.toMatchObject({
      code: "forbidden_enqueue_mutation"
    });
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses extra keys (actor and module spoofing) and bad formats; the port is never called", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "enqueued" });
    const rpc = rpcFor("write", enqueueJob);
    const bad: unknown[] = [
      { ...call, actorUserId: randomUUID() },
      { ...call, moduleId: "other" },
      { ...call, extra: 1 },
      { ...call, jobKind: "Bad Kind" },
      { ...call, jobKind: undefined },
      { ...call, idempotencyKey: "has space" },
      { ...call, idempotencyKey: "x".repeat(129) },
      { ...call, idempotencyKey: 7 },
      { ...call, queue: 7 },
      { ...call, params: [1] },
      { ...call, params: "s" },
      null,
      [call],
      "junk"
    ];
    for (const params of bad) {
      await expect(run(rpc, params)).rejects.toMatchObject({ code: "invalid_rpc" });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("refuses another module's queue, an undeclared queue and a queue without the opt-in", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "enqueued" });
    const rpc = rpcFor("write", enqueueJob);
    for (const queue of ["other.generate", "meals.nope", "meals.closed"]) {
      await expect(run(rpc, { ...call, queue })).rejects.toMatchObject({
        code: "undeclared_queue"
      });
    }
    expect(enqueueJob).not.toHaveBeenCalled();
  });

  it("does not count refused calls toward the invocation cap", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "enqueued" });
    const rpc = rpcFor("write", enqueueJob);
    for (let i = 0; i < 10; i += 1) {
      await expect(run(rpc, { ...call, queue: "meals.closed" })).rejects.toMatchObject({
        code: "undeclared_queue"
      });
    }
    await expect(run(rpc, call)).resolves.toEqual({ status: "enqueued" });
  });

  it("returns invalid_job_params when params fail the queue schema, and sends nothing", async () => {
    const sent = vi.fn();
    // The test port runs the real payload check, as the composition root will.
    const enqueueJob: Enqueue = async (access, request) => {
      try {
        assertModuleJobPayload(request.queue, {
          actorUserId: access.actorUserId,
          moduleId: "meals",
          jobKind: request.jobKind,
          manifestHash: MANIFEST_HASH,
          ...(request.params === undefined ? {} : { params: request.params })
        });
      } catch {
        return { status: "invalid_params" };
      }
      sent();
      return { status: "enqueued" };
    };
    const rpc = rpcFor("write", enqueueJob);
    await expect(
      run(rpc, { ...call, params: { planId: "not-a-uuid", day: 2 } })
    ).rejects.toMatchObject({ code: "invalid_job_params" });
    await expect(run(rpc, { ...call, params: { text: "free text" } })).rejects.toMatchObject({
      code: "invalid_job_params"
    });
    expect(sent).not.toHaveBeenCalled();
    await expect(run(rpc, call)).resolves.toEqual({ status: "enqueued" });
    expect(sent).toHaveBeenCalledTimes(1);
  });

  it("maps an inactive module to module_inactive", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "inactive" });
    await expect(run(rpcFor("write", enqueueJob), call)).rejects.toMatchObject({
      code: "module_inactive"
    });
  });

  it("turns any other port error into a generic RPC error with no key or params text", async () => {
    const enqueueJob = vi
      .fn<Enqueue>()
      .mockRejectedValue(new Error("db down: plan-1:day-2 secret-params"));
    const error = await run(rpcFor("write", enqueueJob), call).catch((e: unknown) => e);
    expect(error).toMatchObject({ code: "invalid_rpc" });
    expect(String((error as Error).message)).not.toMatch(/plan-1|secret/);
  });

  it("caps at five calls per invocation without calling the port, and a new handler restarts", async () => {
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "enqueued" });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const rpc = rpcFor("write", enqueueJob);
    for (let i = 0; i < 5; i += 1) {
      await expect(run(rpc, call)).resolves.toEqual({ status: "enqueued" });
    }
    await expect(run(rpc, call)).resolves.toEqual({ status: "limited", limit: "invocation" });
    expect(enqueueJob).toHaveBeenCalledTimes(5);
    expect(warn).toHaveBeenCalledTimes(1);
    const line = warn.mock.calls.flat().join(" ");
    expect(line).toContain("meals");
    expect(line).toContain("meals.generate");
    expect(line).toContain("generate-day");
    expect(line).toContain("invocation");
    expect(line).not.toMatch(/plan-1|planId/);

    await expect(run(rpcFor("write", enqueueJob), call)).resolves.toEqual({ status: "enqueued" });
  });

  it("logs one warning on a port-level limit and leaks no key or params", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const enqueueJob = vi.fn<Enqueue>().mockResolvedValue({ status: "limited", limit: "pending" });
    await expect(run(rpcFor("write", enqueueJob), call)).resolves.toEqual({
      status: "limited",
      limit: "pending"
    });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join(" ")).not.toMatch(/plan-1|planId/);
  });
});
