import { randomUUID } from "node:crypto";

import { describe, expect, it, vi } from "vitest";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler
} from "kysely";

import type { AccessContext, DataContextDb, DataContextRunner, MossDatabase } from "@moss/db";
import type { ExternalModuleDiscovery } from "@moss/module-registry";
import {
  AI_CALLS_PER_INVOCATION_CAP,
  createExternalModuleRpcHandler,
  type ExternalModuleAiResult
} from "@moss/module-registry/node";
import type { CreateNotificationInput } from "@moss/notifications";

describe("external worker ctx.notify port (Task 2b, #1283)", () => {
  const module = {
    id: "job-search",
    dir: "/unused",
    manifest: {
      schemaVersion: 1,
      id: "job-search",
      name: "Job Search",
      version: "1.0.0",
      publisher: "Jarvis",
      lifecycle: "optional",
      compatibility: { jarv1s: ">=0.0.0" }
    },
    manifestHash: "sha256:a",
    packageHash: "sha256:a"
  } satisfies ExternalModuleDiscovery;

  // notify.post is served before withDataContext, same harness shape as the
  // embed/attachments port tests — the null casts below are never dereferenced.
  const rpcFor = (
    toolRisk: "read" | "write",
    postNotification?: (access: AccessContext, input: CreateNotificationInput) => Promise<void>
  ) =>
    createExternalModuleRpcHandler({
      module,
      toolRisk,
      actorUserId: randomUUID(),
      requestId: randomUUID(),
      workerDataContext: null as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      embeddingProvider: null as never,
      postNotification
    });

  it("posts a notification with the caller's fields and no extras", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);

    await expect(
      rpcFor("write", postNotification)(
        "notify.post",
        { key: "sync-complete", title: "Sync complete", body: "42 postings found", href: "/jobs" },
        () => undefined
      )
    ).resolves.toBeUndefined();

    expect(postNotification).toHaveBeenCalledTimes(1);
    const [access, input] = postNotification.mock.calls[0] as [
      AccessContext,
      CreateNotificationInput
    ];
    expect(access).toMatchObject({
      actorUserId: expect.any(String),
      requestId: expect.any(String)
    });
    // key is renamed to eventKey ONLY at this host boundary — never before it.
    expect(input).toEqual({
      moduleId: "job-search",
      title: "Sync complete",
      body: "42 postings found",
      eventKey: "sync-complete",
      href: "/jobs"
    });
  });

  it("omits href entirely when the caller does not supply one", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);

    await rpcFor("write", postNotification)(
      "notify.post",
      { key: "k", title: "t", body: "b" },
      () => undefined
    );

    const [, input] = postNotification.mock.calls[0] as [AccessContext, CreateNotificationInput];
    expect(input).not.toHaveProperty("href");
  });

  it("rejects an oversized key, title, or body without calling postNotification", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);
    const rpc = rpcFor("write", postNotification);

    await expect(
      rpc("notify.post", { key: "k".repeat(201), title: "t", body: "b" }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc", detail: /at most 200/ });
    await expect(
      rpc("notify.post", { key: "k", title: "t".repeat(201), body: "b" }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc", detail: /at most 200/ });
    await expect(
      rpc("notify.post", { key: "k", title: "t", body: "b".repeat(2001) }, () => undefined)
    ).rejects.toMatchObject({ code: "invalid_rpc", detail: /at most 2000/ });
    expect(postNotification).not.toHaveBeenCalled();
  });

  it("rejects a non-same-origin href (absolute URL, protocol-relative, or scheme)", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);
    const rpc = rpcFor("write", postNotification);

    for (const href of ["https://evil.example.com", "//evil.example.com", "javascript:alert(1)"]) {
      await expect(
        rpc("notify.post", { key: "k", title: "t", body: "b", href }, () => undefined)
      ).rejects.toMatchObject({ code: "invalid_rpc", detail: /same-origin path/ });
    }
    expect(postNotification).not.toHaveBeenCalled();
  });

  it("rate-limits after 5 calls in one invocation", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);
    const rpc = rpcFor("write", postNotification);
    const post = (key: string) =>
      rpc("notify.post", { key, title: "t", body: "b" }, () => undefined);

    await post("1");
    await post("2");
    await post("3");
    await post("4");
    await post("5");
    await expect(post("6")).rejects.toMatchObject({ code: "rate_limited" });

    expect(postNotification).toHaveBeenCalledTimes(5);
  });

  it("rejects notify.post for a read-risk tool call, mirroring kv.set/setCredential/ai calls", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);

    await expect(
      rpcFor("read", postNotification)(
        "notify.post",
        { key: "k", title: "t", body: "b" },
        () => undefined
      )
    ).rejects.toMatchObject({ code: "forbidden_notify_mutation" });

    expect(postNotification).not.toHaveBeenCalled();
  });

  // #1334: aiCalls and notifyCalls are two separate `let` counters in the same
  // createExternalModuleRpcHandler closure (worker-rpc-host.ts) — nothing at the type level
  // stops a future edit from reading or incrementing the wrong one (e.g. a copy-paste of the
  // AI cap check landing inside the notify branch). That bug would pass every existing test
  // here, because each budget is only ever exercised in isolation. This drives both RPCs on
  // ONE handler instance — the shape a real invocation like runScore's actually uses (many AI
  // calls, then one notify.post) — so a misplaced counter shows up as a wrongly-timed
  // rate_limited/usage_limited rather than as silently-passing coverage.
  it("keeps the AI-call budget and the notify-call budget as two independent counters", async () => {
    const postNotification = vi.fn().mockResolvedValue(undefined);
    let aiCallCount = 0;
    const ai = async (): Promise<ExternalModuleAiResult> => {
      aiCallCount += 1;
      return { ok: true, object: {} };
    };
    const scopedDb = new Kysely<MossDatabase>({
      dialect: {
        createAdapter: () => new PostgresAdapter(),
        createDriver: () => new DummyDriver(),
        createIntrospector: (kyselyDb) => new PostgresIntrospector(kyselyDb),
        createQueryCompiler: () => new PostgresQueryCompiler()
      }
    });
    const rpc = createExternalModuleRpcHandler({
      module,
      toolRisk: "write",
      actorUserId: randomUUID(),
      requestId: randomUUID(),
      workerDataContext: {
        withDataContext: async (_access: unknown, fn: (db: DataContextDb) => unknown) =>
          fn({ db: scopedDb } as unknown as DataContextDb)
      } as unknown as DataContextRunner,
      isActorAdmin: async () => false,
      embeddingProvider: null as never,
      postNotification,
      ai
    });

    // Spend the entire AI budget on this one handler. Counted off the constant rather than a
    // literal: the cap is a runaway guard whose value is a product decision and it has already
    // moved once (8 -> 500), and a loop pinned to the old number stops exhausting anything the
    // moment it changes — leaving the "one call past the cap is refused" assertion below testing
    // nothing at all while still passing.
    for (let i = 0; i < AI_CALLS_PER_INVOCATION_CAP; i++) {
      await expect(
        rpc("ai.generateStructured", { schema: {}, prompt: "x" }, () => undefined)
      ).resolves.toEqual({ ok: true, object: {} });
    }
    await expect(
      rpc("ai.generateStructured", { schema: {}, prompt: "x" }, () => undefined)
    ).resolves.toEqual({ ok: false, error: "usage_limited" });
    expect(aiCallCount).toBe(AI_CALLS_PER_INVOCATION_CAP);

    // If notifyCalls were the counter actually touched above, the notify budget (cap 5)
    // would already read as spent — the very first post below would throw rate_limited
    // instead of succeeding.
    for (let i = 0; i < 5; i++) {
      await expect(
        rpc("notify.post", { key: `k${i}`, title: "t", body: "b" }, () => undefined)
      ).resolves.toBeUndefined();
    }
    expect(postNotification).toHaveBeenCalledTimes(5);
    // And the notify cap still fires on its own 6th call — proving notifyCalls was
    // incrementing for real over those five, not merely never reached.
    await expect(
      rpc("notify.post", { key: "k5", title: "t", body: "b" }, () => undefined)
    ).rejects.toMatchObject({ code: "rate_limited" });
  });
});
