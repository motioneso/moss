import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import type { Kysely } from "kysely";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { HttpError, type MossModuleManifest, type ToolExecute } from "@moss/module-sdk";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { exampleToolCalls, exampleToolModule } from "./fixtures/example-tool-module.js";

describe("AssistantToolGateway", () => {
  let appDb: Kysely<MossDatabase>;
  let bootstrapDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repository: AiRepository;
  let tokens: SessionTokenRegistry;
  let confirmations: ConfirmationRegistry;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];
  let gateway: AssistantToolGateway;

  function firstActionRequest(): { actionRequestId: string; toolName: string; summary: string } {
    const entry = emitted[0];
    if (!entry || entry.record.kind !== "action_request") {
      throw new Error("expected an action_request card to have been emitted");
    }
    return entry.record;
  }

  async function waitForActionRequest() {
    await vi.waitFor(() => expect(emitted).toHaveLength(1), { timeout: 5_000 });
    return firstActionRequest();
  }

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    bootstrapDb = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    runner = new DataContextRunner(appDb);
    repository = new AiRepository();
  });

  afterAll(async () => {
    await bootstrapDb.destroy();
    await appDb.destroy();
  });

  beforeEach(() => {
    exampleToolCalls.length = 0;
    // #1308 defect 2: build the array as a local `sink` first and close the shared gateway's
    // notifier over that local, not over the outer `emitted` binding. `emitted` is a `let` that
    // every beforeEach reassigns to a new array; if the notifier closed over `emitted` instead,
    // a call left dangling by a failed assertion in a prior test could still emit into whatever
    // array `emitted` points to by the time it settles — i.e. a LATER test's array. Assigning
    // `emitted = sink` keeps every test's existing `emitted.find(...)`/`emitted.push(...)` reads
    // working unchanged.
    const sink: { chatSessionId: string; record: GatewaySessionRecord }[] = [];
    emitted = sink;
    tokens = new SessionTokenRegistry();
    confirmations = new ConfirmationRegistry();
    gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => sink.push({ chatSessionId, record }) },
      // Generous so the approve always lands before the await times out, even under heavy
      // full-suite DB load (vitest runs integration files concurrently). The post-timeout
      // no-op path is covered separately by the 20ms `fastTimeoutGateway` test below.
      confirmTimeoutMs: 30_000
    });
  });

  afterEach(async () => {
    // #1308 defect 2/3 belt-and-suspenders: an assertion thrown between issuing a destructive/
    // write call and reaching its own resolveActionRequest/`await call` cleanup leaves that
    // call blocked on the ConfirmationRegistry waiter. Sink isolation above stops its late emit
    // from landing in a later test's array, but the call itself should still be settled rather
    // than left in flight. Cancel every action_request this test emitted; resolveActionRequest
    // is a documented no-op once a row is no longer pending (or owned by a different actor), so
    // trying both fixture actors on every outstanding id cannot disturb an unrelated row.
    for (const entry of emitted) {
      if (entry.record.kind !== "action_request") continue;
      await Promise.all(
        [ids.userA, ids.userB].map((actorUserId) =>
          gateway.resolveActionRequest(actorUserId, entry.record.actionRequestId, "cancelled")
        )
      );
    }
  });

  it("lists only tools that have an execute handler", async () => {
    const names = (await gateway.listToolsForActor(ids.userA)).map((tool) => tool.name);
    expect(names).toContain("example.read");
    expect(names).toContain("example.write");
    expect(names).toContain("example.destroy");
    expect(names).not.toContain("example.declaration-only");
  });

  it("does not list Wellness tools when Wellness is not active", async () => {
    const names = (await gateway.listToolsForActor(ids.userA)).map((tool) => tool.name);
    expect(names).toContain("example.read");
    expect(names).not.toContain("wellness.recentCheckIns");
    expect(names).not.toContain("wellness.medicationAdherence");
  });

  it("lists and invokes web research tools through the assistant gateway", async () => {
    const { setWebSearchProviderForTests, webModuleManifest } = await import("@moss/web-research");
    setWebSearchProviderForTests({
      name: "fake",
      search: async () => ({
        results: [{ title: "Now", url: "https://example.com/now", snippet: "current" }],
        trace: { provider: "fake" }
      })
    });
    const webGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [webModuleManifest],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 1000
    });

    try {
      const listed = await webGateway.listToolsForActor(ids.userA);
      expect(listed.map((tool) => tool.name)).toEqual(["web.search", "web.read"]);

      const token = tokens.mint({
        actorUserId: ids.userA,
        chatSessionId: "web-s1",
        allowedToolNames: null
      });
      const response = await webGateway.callTool(token, "web.search", {
        query: "today",
        limit: 10
      });
      expect(response.ok).toBe(true);
      if (!response.ok) throw new Error("expected ok");
      expect((response.data as { text: string }).text).toContain("https://example.com/now");
    } finally {
      setWebSearchProviderForTests(undefined);
    }
  });

  it("fails closed: a throwing resolveActiveModules rejects listToolsForActor and callTool", async () => {
    let resolverCalls = 0;
    const failing = new AssistantToolGateway({
      resolveActiveModules: async () => {
        resolverCalls += 1;
        throw new Error("resolver/DB unavailable");
      },
      repository,
      runner,
      tokens, // SHARED registry from beforeEach, so the minted token below verifies
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 1000
    });
    // listToolsForActor reaches the resolver directly.
    await expect(failing.listToolsForActor(ids.userA)).rejects.toThrow();
    // callTool: mint a VALID token (allowedToolNames: null) so it clears token verification
    // and proceeds into executableTools → resolver, which throws → reject (not a degraded set).
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "fail-closed",
      allowedToolNames: null
    });
    await expect(failing.callTool(token, "example.read", {})).rejects.toThrow();
    expect(resolverCalls).toBeGreaterThanOrEqual(2); // both surfaces actually invoked the resolver
  });

  it("only exposes explicitly safe HttpError messages from handler failures", async () => {
    const failingTool = (name: string, error: unknown, safeErrors?: true) => ({
      name,
      description: "Throws an error.",
      permissionId: "safe-errors.view",
      actionFamilyId: "safe-errors",
      risk: "write" as const,
      executionPolicy: "auto" as const,
      ...(safeErrors ? { safeErrors } : {}),
      inputSchema: { type: "object", properties: {} },
      execute: async () => {
        throw error;
      }
    });
    const safeErrorModule = {
      id: "safe-errors",
      name: "Safe errors",
      version: "0",
      publisher: "test",
      lifecycle: "optional" as const,
      compatibility: { jarv1s: "*" },
      assistantActionFamilies: [
        {
          id: "safe-errors",
          label: "Safe errors",
          description: "Test handler errors.",
          defaultTier: "ask_each_time" as const,
          allowedTiers: ["ask_each_time", "trusted_auto"] as const
        }
      ],
      assistantTools: [
        failingTool("safe-errors.opted-in", new HttpError(400, "safe message"), true),
        failingTool("safe-errors.default", new HttpError(400, "should stay hidden")),
        failingTool("safe-errors.hostile", new Error("SECRET token=private-value"), true)
      ]
    } satisfies MossModuleManifest;
    const safeGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [safeErrorModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 1000,
      actionPolicy: () => ({
        getFamilyTier: async () => "trusted_auto",
        getFamilyManifest: async () => safeErrorModule.assistantActionFamilies[0] ?? null
      })
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "safe-errors",
      allowedToolNames: null
    });

    await expect(safeGateway.callTool(token, "safe-errors.opted-in", {})).resolves.toEqual({
      ok: false,
      error: "safe message"
    });
    await expect(safeGateway.callTool(token, "safe-errors.default", {})).resolves.toEqual({
      ok: false,
      error: "Tool safe-errors.default failed"
    });
    await expect(safeGateway.callTool(token, "safe-errors.hostile", {})).resolves.toEqual({
      ok: false,
      error: "Tool safe-errors.hostile failed"
    });
  });

  it("auto write tools can receive declared services while read tools cannot", async () => {
    const calls: unknown[] = [];
    const module = {
      id: "svc",
      name: "Services",
      version: "0",
      publisher: "test",
      lifecycle: "optional",
      compatibility: { jarv1s: "*" },
      assistantActionFamilies: [
        {
          id: "dummy",
          label: "Dummy family",
          description: "Dummy family for tests",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        }
      ],
      assistantTools: [
        {
          name: "svc.read",
          description: "bad read",
          permissionId: "svc.view",
          risk: "read" as const,
          requiresServices: ["demo"],
          inputSchema: { type: "object", properties: {} },
          execute: async () => {
            calls.push("read");
            return { data: { ok: true } };
          }
        },
        {
          name: "svc.autoWrite",
          description: "good write",
          permissionId: "svc.write",
          risk: "write" as const,
          executionPolicy: "auto" as const,
          actionFamilyId: "dummy",
          requiresServices: ["demo"],
          inputSchema: { type: "object", properties: {} },
          execute: (async (_db, _input, _ctx, services) => {
            calls.push((services?.demo as { value: string }).value);
            return { data: { ok: true } };
          }) satisfies ToolExecute
        }
      ]
    } satisfies MossModuleManifest;
    const serviceGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [module],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 1000,

      actionPolicy: () => ({
        getFamilyTier: async (moduleId, familyId) => "trusted_auto",
        getFamilyManifest: async () => ({
          id: "dummy",
          label: "Dummy",
          description: "Dummy family",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        })
      }),
      toolServices: { demo: { value: "service reached" } }
    });

    const listed = await serviceGateway.listToolsForActor(ids.userA);
    expect(listed.map((tool) => tool.name)).toEqual(["svc.autoWrite"]);

    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "svc-session",
      allowedToolNames: null
    });
    const result = await serviceGateway.callTool(token, "svc.autoWrite", {});

    expect(result.ok).toBe(true);
    expect(calls).toEqual(["service reached"]);
  });

  it("runs a read tool immediately under the caller's RLS scope", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s1",
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "example.read", { value: "hi" });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const parsed = JSON.parse((res.data as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ echo: "hi", actor: ids.userA });
    expect(exampleToolCalls).toHaveLength(1);
    expect(emitted).toHaveLength(0);
  });

  it("blocks a write until approved, emits a card, then executes", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s1",
      allowedToolNames: null
    });
    const call = gateway.callTool(token, "example.write", { value: "hello" });

    const card = await waitForActionRequest();
    expect(emitted).toHaveLength(1);
    expect(card.toolName).toBe("example.write");
    expect(card.summary).toBe('Write the value "hello"');
    expect(exampleToolCalls).toHaveLength(0);

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    const res = await call;

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const parsed = JSON.parse((res.data as { text: string }).text) as Record<string, unknown>;
    expect(parsed).toMatchObject({ echo: "hello", actor: ids.userA });
    expect(exampleToolCalls).toHaveLength(1);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_request", "action_result"]);
  });

  it("confirms a write:auto tool when module agency trust is off", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-auto-write",
      allowedToolNames: null
    });

    const call = gateway.callTool(token, "example.autoWrite", { value: "quiet" });
    const request = await waitForActionRequest();
    expect(request.toolName).toBe("example.autoWrite");
    expect(exampleToolCalls).toHaveLength(0);

    await gateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
    await call;
  });

  it("runs a write:auto tool immediately when module agency trust is on", async () => {
    const trustedGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      actionPolicy: () => ({
        getFamilyTier: async (moduleId, familyId) => "trusted_auto",
        getFamilyManifest: async () => ({
          id: "dummy",
          label: "Dummy",
          description: "Dummy family",
          defaultTier: "ask_each_time",
          allowedTiers: ["ask_each_time", "trusted_auto"]
        })
      })
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-trusted-auto-write",
      allowedToolNames: null
    });

    const res = await trustedGateway.callTool(token, "example.autoWrite", { value: "quiet" });

    expect(res.ok).toBe(true);
    expect(exampleToolCalls).toEqual([
      { name: "example.autoWrite", input: { value: "quiet" }, actorUserId: ids.userA }
    ]);
    expect(emitted).toEqual([
      {
        chatSessionId: "s-trusted-auto-write",
        record: expect.objectContaining({
          kind: "action_result",
          toolName: "example.autoWrite",
          outcome: "executed"
        })
      }
    ]);
    expect(emitted[0]?.record.actionRequestId).toMatch(/^mcp_/);
  });

  it("always confirms destructive tools even if executionPolicy is auto", async () => {
    const destructiveAutoModule = {
      ...exampleToolModule,
      assistantTools: exampleToolModule.assistantTools?.map((tool) =>
        tool.name === "example.destroy" ? { ...tool, executionPolicy: "auto" as const } : tool
      )
    };
    const destructiveGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [destructiveAutoModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-destructive-auto",
      allowedToolNames: null
    });

    const call = destructiveGateway.callTool(token, "example.destroy", { value: "boom" });
    const request = await waitForActionRequest();
    expect(request.toolName).toBe("example.destroy");
    expect(exampleToolCalls).toHaveLength(0);
    await destructiveGateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
    await call;
  });

  it("auto-runs destructive tools under YOLO and records yolo audit mode", async () => {
    const yoloGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => true
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-yolo",
      allowedToolNames: null
    });

    const result = await yoloGateway.callTool(token, "example.destroy", { value: "boom" });
    // #1308: wait on the condition actually being awaited (the action_result card has landed)
    // instead of a fixed 50ms delay. The gateway's own promise can resolve before its
    // notifier's emit (which does a DB-backed audit write) settles, so a fixed sleep can read
    // `emitted` before the emit lands on a loaded CI runner.
    await vi.waitFor(() => {
      expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);
    });

    expect(result.ok).toBe(true);
    expect(exampleToolCalls).toEqual([
      { name: "example.destroy", input: { value: "boom" }, actorUserId: ids.userA }
    ]);
    expect(emitted.map((entry) => entry.record.kind)).toEqual(["action_result"]);

    const audit = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "test:yolo-audit" },
      (scopedDb) => repository.listActionAuditLog(scopedDb, { since: new Date(0), limit: 20 })
    );
    expect(
      audit.some((row) => row.tool_name === "example.destroy" && row.approval_mode === "yolo")
    ).toBe(true);
  });

  it("falls back to confirmation when YOLO resolver is false", async () => {
    const gatedGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => false
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-yolo-off",
      allowedToolNames: null
    });

    const call = gatedGateway.callTool(token, "example.destroy", { value: "boom" });
    const request = await waitForActionRequest();

    expect(request.toolName).toBe("example.destroy");
    expect(exampleToolCalls).toHaveLength(0);
    await gatedGateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
    await call;
  });

  it("does not lose an Approve emitted immediately with the action_request", async () => {
    const eagerGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: {
        emit: (chatSessionId, record) => {
          emitted.push({ chatSessionId, record });
          if (record.kind === "action_request") {
            void eagerGateway.resolveActionRequest(ids.userA, record.actionRequestId, "confirmed");
          }
        }
      },
      confirmTimeoutMs: 1_000
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-eager",
      allowedToolNames: null
    });

    const res = await eagerGateway.callTool(token, "example.write", { value: "eager" });

    expect(res.ok).toBe(true);
    expect(exampleToolCalls).toHaveLength(1);
    const rows = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-eager-check" },
      (scopedDb) => repository.listAssistantActions(scopedDb)
    );
    expect(rows.find((r) => r.id === firstActionRequest().actionRequestId)?.status).toBe(
      "confirmed"
    );
  });

  it("an Approve arriving after the confirm timeout never executes and never marks the row confirmed", async () => {
    // Short timeout so the wait expires before we Approve. confirmTimeoutMs is set per-gateway.
    const fastTimeoutGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 20
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-timeout",
      allowedToolNames: null
    });

    const res = await fastTimeoutGateway.callTool(token, "example.write", { value: "late" });
    // The call gave up: timed-out denial, handler never ran.
    expect(res).toEqual({
      ok: false,
      denied: true,
      reason: "Timed out awaiting confirmation — still pending in your drawer."
    });
    expect(exampleToolCalls).toHaveLength(0);

    const card = firstActionRequest();

    // Operator clicks Approve after the timeout — must be a no-op (fails closed).
    await fastTimeoutGateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");

    // The handler still never ran...
    expect(exampleToolCalls).toHaveLength(0);
    // ...and the DB row was NOT flipped to 'confirmed' (no phantom-success divergence).
    const rows = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-timeout-check" },
      (scopedDb) => repository.listAssistantActions(scopedDb)
    );
    const row = rows.find((r) => r.id === card.actionRequestId);
    expect(row?.status).toBe("pending");
  });

  it("cancels stale pending assistant actions while leaving fresh pending actions pending", async () => {
    const staleId = "90000000-0000-4000-8000-000000000001";
    const otherStaleId = "90000000-0000-4000-8000-000000000002";
    let freshId = "";

    await sql`
      INSERT INTO app.ai_assistant_action_requests (
        id,
        owner_user_id,
        tool_module_id,
        tool_module_name,
        tool_name,
        permission_id,
        risk,
        status,
        input_summary,
        request_id,
        requested_at,
        resolved_at,
        updated_at
      )
      VALUES
        (
          ${staleId}::uuid,
          ${ids.userA}::uuid,
          'example',
          'Example',
          'example.write',
          'example.write',
          'write',
          'pending',
          '{"inputKeyCount":0}'::jsonb,
          'stale-a',
          now() - interval '10 minutes',
          NULL,
          now() - interval '10 minutes'
        ),
        (
          ${otherStaleId}::uuid,
          ${ids.userB}::uuid,
          'example',
          'Example',
          'example.write',
          'example.write',
          'write',
          'pending',
          '{"inputKeyCount":0}'::jsonb,
          'stale-b',
          now() - interval '10 minutes',
          NULL,
          now() - interval '10 minutes'
        )
    `.execute(bootstrapDb);

    await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-stale-seed-fresh" },
      async (scopedDb) => {
        const fresh = await repository.createPendingAssistantAction(scopedDb, {
          toolModuleId: "example",
          toolModuleName: "Example",
          toolName: "example.write",
          permissionId: "example.write",
          risk: "write",
          inputSummary: { inputKeyCount: 0 },
          requestId: "fresh"
        });
        freshId = fresh.id;
      }
    );

    const cancelled = await repository.cancelStalePendingAssistantActions(appDb, {
      olderThan: new Date(Date.now() - 5 * 60_000)
    });

    expect(cancelled).toBe(2);
    const userARows = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-stale-check" },
      (scopedDb) => repository.listAssistantActions(scopedDb)
    );
    const userBRows = await runner.withDataContext(
      { actorUserId: ids.userB, requestId: "r-stale-check-b" },
      (scopedDb) => repository.listAssistantActions(scopedDb)
    );
    expect(userARows.find((r) => r.id === staleId)?.status).toBe("cancelled");
    expect(userARows.find((r) => r.id === staleId)?.resolved_at).toBeTruthy();
    expect(userARows.find((r) => r.id === freshId)?.status).toBe("pending");
    expect(userBRows.find((r) => r.id === otherStaleId)?.status).toBe("cancelled");
  });

  it("returns a denied result without calling the handler", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s1",
      allowedToolNames: null
    });
    const call = gateway.callTool(token, "example.write", { value: "nope" });

    const card = await waitForActionRequest();

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "rejected");
    const res = await call;

    expect(res).toEqual({ ok: false, denied: true, reason: "Denied by user." });
    expect(exampleToolCalls).toHaveLength(0);
  });

  it("blocks destructive tools the same as writes (no run-immediately path)", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s1",
      allowedToolNames: null
    });
    const call = gateway.callTool(token, "example.destroy", { value: "x" });

    const card = await waitForActionRequest();
    expect(card.toolName).toBe("example.destroy");
    expect(exampleToolCalls).toHaveLength(0);

    await gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    await call;
    expect(exampleToolCalls.map((entry) => entry.name)).toEqual(["example.destroy"]);
  });

  it("returns a safe error and never leaks internal details", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s1",
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "example.boom", {});

    expect(res).toEqual({ ok: false, error: "Tool example.boom failed" });
    expect(JSON.stringify(res)).not.toContain("SECRET");
    expect(JSON.stringify(res)).not.toContain("postgres://");
  });

  it("acts only as the token's user; input cannot override identity", async () => {
    const token = tokens.mint({
      actorUserId: ids.userB,
      chatSessionId: "s2",
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "example.read", {
      value: "v",
      actorUserId: ids.userA
    });

    expect(res.ok).toBe(true);
    expect(exampleToolCalls[0]?.actorUserId).toBe(ids.userB);
  });

  it("rejects an unknown/revoked token", async () => {
    await expect(gateway.callTool("jst_bogus", "example.read", {})).rejects.toThrow();
  });

  it("renders a uniform-list tool result as a Markdown pipe table (end-to-end)", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-tabular",
      allowedToolNames: null
    });
    const res = await gateway.callTool(token, "example.list", {});

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("expected ok");
    const text = (res.data as { text: string }).text;
    expect(text).toContain("| id | name | status |");
    expect(text).toContain("| --- | --- | --- |");
    expect(text).toContain("| a1 | Alpha | active |");
    expect(text).toContain("| a2 | Beta | inactive |");
    expect(text).not.toContain('"items"');
  });

  it("blocks a tool call when allowedToolNames is set and the tool is not in it", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-allowlist",
      allowedToolNames: new Set(["example.write"])
    });

    const res = await gateway.callTool(token, "example.read", { value: "blocked" });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected not ok");
    if ("denied" in res) throw new Error("expected error, not denied");
    expect(res.error).toContain("not in session allowlist");
    expect(exampleToolCalls).toHaveLength(0);
  });

  it("allows a tool call when allowedToolNames is null (unrestricted)", async () => {
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-unrestricted",
      allowedToolNames: null
    });

    const res = await gateway.callTool(token, "example.read", { value: "allowed" });

    expect(res.ok).toBe(true);
    expect(exampleToolCalls).toHaveLength(1);
  });

  it("listToolsForActor is actor-scoped — a different actor gets a different list", async () => {
    // resolveActiveModules returns the example module ONLY for userA; userB gets nothing.
    // If listToolsForActor ignored its argument (the bug listTools() had), userB would
    // get the same non-empty list and this test would fail — which is exactly the point.
    const scopedGateway = new AssistantToolGateway({
      resolveActiveModules: async (actorUserId) =>
        actorUserId === ids.userA ? [exampleToolModule] : [],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: () => {} },
      confirmTimeoutMs: 1000
    });

    const aNames = (await scopedGateway.listToolsForActor(ids.userA)).map((tool) => tool.name);
    const bNames = (await scopedGateway.listToolsForActor(ids.userB)).map((tool) => tool.name);

    expect(aNames).toContain("example.read");
    expect(aNames).toContain("example.write");
    expect(bNames).toEqual([]);
  });

  it("does not list or execute an excluded tool with YOLO on", async () => {
    const excludedCalls: string[] = [];
    // moduleId "settings" + "settings.yolo." prefix matches SELF_OPERATION_EXCLUSIONS
    // self_authority.settings — Jarvis may never grant its own YOLO authority (#1263).
    const excludedModule: MossModuleManifest = {
      id: "settings",
      name: "Settings",
      version: "0.0.0",
      publisher: "test",
      lifecycle: "optional",
      compatibility: { jarv1s: "*" },
      assistantTools: [
        {
          name: "settings.yolo.enable",
          description: "Enable YOLO mode.",
          permissionId: "settings.yolo.enable",
          risk: "write",
          inputSchema: { type: "object", properties: {} },
          execute: async (_db, _input, ctx) => {
            excludedCalls.push(ctx.actorUserId);
            return { data: { ok: true } };
          }
        }
      ]
    };
    const excludedGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [excludedModule],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => true
    });

    const names = (await excludedGateway.listToolsForActor(ids.userA)).map((tool) => tool.name);
    expect(names).not.toContain("settings.yolo.enable");

    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-excluded-yolo",
      allowedToolNames: null
    });
    const result = await excludedGateway.callTool(token, "settings.yolo.enable", {});

    expect(result.ok).toBe(false);
    expect(excludedCalls).toHaveLength(0);
  });

  function confirmMechanismsModule(calls: string[]): MossModuleManifest {
    return {
      id: "example-confirm",
      name: "Example Confirm",
      version: "0.0.0",
      publisher: "test",
      lifecycle: "optional",
      compatibility: { jarv1s: "*" },
      assistantTools: [
        {
          name: "example-confirm.destructive",
          description: "Ordinary destructive tool.",
          permissionId: "example-confirm.destructive",
          risk: "destructive",
          inputSchema: { type: "object", properties: {} },
          execute: async () => {
            calls.push("destructive");
            return { data: { ok: true } };
          }
        },
        {
          name: "example-confirm.confirmAlways",
          description: "Destructive tool that also declares confirm_always.",
          permissionId: "example-confirm.confirmAlways",
          risk: "destructive",
          selfOperationGrant: "confirm_always",
          inputSchema: { type: "object", properties: {} },
          execute: async () => {
            calls.push("confirmAlways");
            return { data: { ok: true } };
          }
        },
        {
          name: "example-confirm.perCall",
          description: "Write tool that always requires confirmation for this call.",
          permissionId: "example-confirm.perCall",
          risk: "write",
          requiresConfirmation: () => true,
          inputSchema: { type: "object", properties: {} },
          execute: async () => {
            calls.push("perCall");
            return { data: { ok: true } };
          }
        }
      ]
    };
  }

  it("YOLO still runs confirm_always destructive and per-call-confirm tools", async () => {
    const calls: string[] = [];
    const yoloGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [confirmMechanismsModule(calls)],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => true
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-yolo-confirm-mechanisms",
      allowedToolNames: null
    });

    const results = await Promise.all([
      yoloGateway.callTool(token, "example-confirm.destructive", {}),
      yoloGateway.callTool(token, "example-confirm.confirmAlways", {}),
      yoloGateway.callTool(token, "example-confirm.perCall", {})
    ]);

    expect(results.every((result) => result.ok)).toBe(true);
    expect([...calls].sort()).toEqual(["confirmAlways", "destructive", "perCall"]);
  });

  it("YOLO off still confirms confirm_always destructive and per-call-confirm tools", async () => {
    const calls: string[] = [];
    const gatedGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [confirmMechanismsModule(calls)],
      repository,
      runner,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000,
      yoloMode: async () => false
    });
    const token = tokens.mint({
      actorUserId: ids.userA,
      chatSessionId: "s-yolo-off-confirm-mechanisms",
      allowedToolNames: null
    });

    for (const toolName of [
      "example-confirm.destructive",
      "example-confirm.confirmAlways",
      "example-confirm.perCall"
    ]) {
      emitted.length = 0;
      const call = gatedGateway.callTool(token, toolName, {});
      const request = await waitForActionRequest();
      expect(request.toolName).toBe(toolName);
      await gatedGateway.resolveActionRequest(ids.userA, request.actionRequestId, "cancelled");
      await call;
    }

    expect(calls).toHaveLength(0);
  });
});
