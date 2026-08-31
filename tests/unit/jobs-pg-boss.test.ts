import { beforeEach, describe, expect, it, vi } from "vitest";

import type { PgBoss, Queue } from "pg-boss";

const bossInstances: PgBossMock[] = [];
const ctorOptions: Array<Record<string, unknown>> = [];

class PgBossMock {
  readonly events: Array<{ event: string; handler: (error: unknown) => void }> = [];
  readonly calls: Array<{ method: string; args: unknown[] }> = [];
  queues = new Map<string, Queue>();

  constructor(options: Record<string, unknown>) {
    ctorOptions.push(options);
    bossInstances.push(this);
  }

  on(event: string, handler: (error: unknown) => void): void {
    this.events.push({ event, handler });
  }

  async start(): Promise<void> {
    this.calls.push({ method: "start", args: [] });
  }

  async stop(options?: unknown): Promise<void> {
    this.calls.push({ method: "stop", args: [options] });
  }

  async getQueue(name: string): Promise<Queue | null> {
    this.calls.push({ method: "getQueue", args: [name] });
    return this.queues.get(name) ?? null;
  }

  async createQueue(name: string, options?: Omit<Queue, "name">): Promise<void> {
    this.calls.push({ method: "createQueue", args: [name, options] });
    if (!this.queues.has(name)) {
      this.queues.set(name, { name, policy: options?.policy ?? "standard", ...(options ?? {}) });
    }
  }

  async updateQueue(name: string, options?: unknown): Promise<void> {
    this.calls.push({ method: "updateQueue", args: [name, options] });
  }

  async deleteQueue(name: string): Promise<void> {
    this.calls.push({ method: "deleteQueue", args: [name] });
    this.queues.delete(name);
  }

  async send(name: string, data: object, options?: object): Promise<string> {
    this.calls.push({ method: "send", args: [name, data, options] });
    return "job-1";
  }
}

vi.mock("pg-boss", () => ({ PgBoss: PgBossMock }));

describe("migratePgBoss queue convergence (#158)", () => {
  beforeEach(() => {
    bossInstances.length = 0;
    ctorOptions.length = 0;
  });

  it("uses the shared constructor path and honors caller overrides", async () => {
    const { migratePgBoss } = await import("@moss/jobs");

    await migratePgBoss("postgres://migration", [], { schedule: true });

    expect(ctorOptions.at(-1)).toMatchObject({
      connectionString: "postgres://migration",
      schema: "pgboss",
      migrate: true,
      createSchema: true,
      schedule: true
    });
    expect(bossInstances.at(-1)!.calls.map((call) => call.method)).toEqual(["start", "stop"]);
  });

  it("creates first and then applies updatable options so concurrent migrators converge", async () => {
    const { migratePgBoss } = await import("@moss/jobs");

    await migratePgBoss("postgres://migration", [
      {
        name: "queue",
        options: {
          policy: "standard",
          retryLimit: 3,
          retentionSeconds: 60
        }
      }
    ]);

    expect(bossInstances.at(-1)!.calls.map((call) => call.method)).toEqual([
      "start",
      "getQueue",
      "createQueue",
      "updateQueue",
      "stop"
    ]);
    expect(bossInstances.at(-1)!.calls.find((call) => call.method === "updateQueue")).toEqual({
      method: "updateQueue",
      args: ["queue", { retryLimit: 3, retentionSeconds: 60 }]
    });
  });

  it("exports a dedicated module-job sender", async () => {
    const jobs = await import("@moss/jobs");
    expect(jobs.sendModuleJob).toBeTypeOf("function");
    expect(jobs.assertModuleJobPayload).toBeTypeOf("function");
    expect(jobs.sendModuleControl).toBeTypeOf("function");
    expect(jobs.FOUNDATION_QUEUES.map((queue) => queue.name)).toContain("platform.module-control");
  });

  it("bounds module-build heartbeat well under pg-boss's 900s expiry default (#2160)", async () => {
    const jobs = await import("@moss/jobs");
    const moduleBuildQueue = jobs.FOUNDATION_QUEUES.find(
      (queue) => queue.name === jobs.MODULE_BUILD_QUEUE
    );

    expect(moduleBuildQueue?.options?.heartbeatSeconds).toBe(
      jobs.MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS
    );
    expect(jobs.MODULE_BUILD_QUEUE_HEARTBEAT_SECONDS).toBeLessThan(300);
  });

  it("binds the actor and trusted module metadata when sending", async () => {
    const { sendModuleJob } = await import("@moss/jobs");
    const boss = new PgBossMock({});
    const jobId = await sendModuleJob(
      boss as unknown as PgBoss,
      {
        actorUserId: "00000000-0000-4000-8000-000000000001",
        requestId: "request-1"
      },
      { id: "fixture", manifestHash: `sha256:${"a".repeat(64)}` },
      {
        name: "fixture.sync",
        handler: "sync",
        paramsSchema: { type: "object", fields: { resourceId: { type: "uuid" } } }
      },
      {
        jobKind: "manual-sync",
        params: { resourceId: "00000000-0000-4000-8000-000000000002" }
      },
      { singletonKey: "manual:fixture:fixture.sync:user" }
    );

    expect(jobId).toBe("job-1");
    expect(boss.calls.at(-1)).toEqual({
      method: "send",
      args: [
        "fixture.sync",
        {
          actorUserId: "00000000-0000-4000-8000-000000000001",
          moduleId: "fixture",
          manifestHash: `sha256:${"a".repeat(64)}`,
          jobKind: "manual-sync",
          params: { resourceId: "00000000-0000-4000-8000-000000000002" }
        },
        { singletonKey: "manual:fixture:fixture.sync:user" }
      ]
    });
  });

  it("validates the dedicated module envelope without widening the global allowlist", async () => {
    const { ALLOWED_PAYLOAD_KEYS, assertModuleJobPayload } = await import("@moss/jobs");
    const queue = {
      name: "fixture.sync",
      handler: "sync",
      paramsSchema: { type: "object", fields: { resourceId: { type: "uuid" } } }
    } as const;
    const payload = {
      actorUserId: "00000000-0000-4000-8000-000000000001",
      moduleId: "fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      jobKind: "manual-sync",
      params: { resourceId: "00000000-0000-4000-8000-000000000002" }
    };

    expect(() => assertModuleJobPayload(queue, payload)).not.toThrow();
    expect(ALLOWED_PAYLOAD_KEYS.has("params")).toBe(false);
    expect(ALLOWED_PAYLOAD_KEYS.has("moduleId")).toBe(false);
    expect(ALLOWED_PAYLOAD_KEYS.has("manifestHash")).toBe(false);
  });

  it.each([
    ["content-bearing top-level key", { content: "private" }],
    ["malformed actor", { actorUserId: "not-a-uuid" }],
    ["foreign module", { moduleId: "other" }],
    ["invalid manifest hash", { manifestHash: "sha256:nope" }],
    ["invalid job kind", { jobKind: "UPPER SPACE" }],
    ["schema-invalid params", { params: { resourceId: "not-a-uuid" } }],
    ["unknown params", { params: { privateText: "secret" } }]
  ])("rejects module payloads with %s", async (_name, patch) => {
    const { assertModuleJobPayload } = await import("@moss/jobs");
    const queue = {
      name: "fixture.sync",
      handler: "sync",
      paramsSchema: { type: "object", fields: { resourceId: { type: "uuid" } } }
    } as const;
    const payload = {
      actorUserId: "00000000-0000-4000-8000-000000000001",
      moduleId: "fixture",
      manifestHash: `sha256:${"a".repeat(64)}`,
      jobKind: "manual-sync",
      params: { resourceId: "00000000-0000-4000-8000-000000000002" },
      ...patch
    };
    expect(() => assertModuleJobPayload(queue, payload)).toThrow();
  });

  it("sends only exact metadata-only module control messages", async () => {
    const { sendModuleControl } = await import("@moss/jobs");
    const boss = new PgBossMock({});
    await expect(
      sendModuleControl(boss as unknown as PgBoss, {
        moduleId: "fixture",
        action: "reconcile"
      })
    ).resolves.toBe("job-1");
    expect(boss.calls.at(-1)).toEqual({
      method: "send",
      args: ["platform.module-control", { moduleId: "fixture", action: "reconcile" }, undefined]
    });
    await expect(
      sendModuleControl(
        boss as unknown as PgBoss,
        {
          moduleId: "fixture",
          action: "reconcile",
          content: "private"
        } as never
      )
    ).rejects.toThrow();
  });
});
