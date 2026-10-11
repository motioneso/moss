import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord
} from "@moss/ai";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
import { createCleanConversationFixture } from "./fixtures/clean-conversations.js";
import { exampleToolCalls, exampleToolModule } from "./fixtures/example-tool-module.js";

describe("AssistantToolGateway approval expiry", () => {
  let appDb: Kysely<MossDatabase>;
  let bootstrapDb: Kysely<MossDatabase>;
  let runner: DataContextRunner;
  let repository: AiRepository;
  let conversations: Awaited<ReturnType<typeof createCleanConversationFixture>>;
  let tokens: SessionTokenRegistry;
  let confirmations: ConfirmationRegistry;
  let emitted: { chatSessionId: string; record: GatewaySessionRecord }[];
  let gateway: AssistantToolGateway;

  function firstActionRequest() {
    const entry = emitted[0];
    if (!entry || entry.record.kind !== "action_request") {
      throw new Error("expected an action_request card to have been emitted");
    }
    return entry.record;
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

  beforeEach(async () => {
    conversations = await createCleanConversationFixture(runner, [ids.userA, ids.userB]);
    exampleToolCalls.length = 0;
    // Keep each test's notifier sink isolated from later tests, even during cleanup.
    const sink: { chatSessionId: string; record: GatewaySessionRecord }[] = [];
    emitted = sink;
    tokens = new SessionTokenRegistry();
    confirmations = new ConfirmationRegistry();
    gateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      ...conversations.gatewayDependencies,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => sink.push({ chatSessionId, record }) },
      confirmTimeoutMs: 30_000
    });
  });

  afterEach(async () => {
    // Preserve cleanup if an assertion interrupts a pending approval.
    for (const entry of emitted) {
      if (entry.record.kind !== "action_request") continue;
      await Promise.all(
        [ids.userA, ids.userB].map((actorUserId) =>
          gateway.resolveActionRequest(actorUserId, entry.record.actionRequestId, "cancelled")
        )
      );
    }
  });

  it("an Approve arriving after the confirm timeout never executes and never marks the row confirmed", async () => {
    // Short timeout so the wait expires before we Approve. confirmTimeoutMs is set per-gateway.
    const fastTimeoutGateway = new AssistantToolGateway({
      resolveActiveModules: async () => [exampleToolModule],
      repository,
      ...conversations.gatewayDependencies,
      tokens,
      confirmations,
      notifier: { emit: (chatSessionId, record) => emitted.push({ chatSessionId, record }) },
      confirmTimeoutMs: 20
    });
    const token = tokens.mint({
      ...conversations.bindingFor(ids.userA),
      chatSessionId: "s-timeout",
      allowedToolNames: null
    });

    const res = await fastTimeoutGateway.callTool(token, "example.write", { value: "late" });
    // The call gave up: timed-out denial, handler never ran.
    expect(res).toEqual({
      ok: false,
      denied: true,
      reason:
        "Approval timed out, so this action was not done. Do not try it again; let the user know."
    });
    expect(exampleToolCalls).toHaveLength(0);

    const card = firstActionRequest();

    // The healthy timeout path awaits the expiry transaction before returning the denial.
    // Read through a fresh data context now, before a late click can itself expire the row.
    const timedOut = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-timeout-before-late-approve" },
      (scopedDb) => repository.getAssistantAction(scopedDb, card.actionRequestId)
    );
    expect(timedOut?.status).toBe("timed_out");
    expect(timedOut?.resolved_at).toBeInstanceOf(Date);

    // Operator clicks Approve after the timeout — must be a no-op (fails closed).
    await expect(
      fastTimeoutGateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed")
    ).resolves.toBe("expired");

    // The handler still never ran...
    expect(exampleToolCalls).toHaveLength(0);
    // ...and the DB row was NOT flipped to 'confirmed' (no phantom-success divergence).
    const rows = await runner.withDataContext(
      { actorUserId: ids.userA, requestId: "r-timeout-check" },
      (scopedDb) => repository.listAssistantActions(scopedDb)
    );
    const row = rows.find((r) => r.id === card.actionRequestId);
    expect(row?.status).toBe("timed_out");
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
});
