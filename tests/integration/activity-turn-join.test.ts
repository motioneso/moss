/**
 * #2956 slice B end to end: one real HTTP chat turn writes an owned answer
 * line, files the session under the same turn id while it runs, and releases
 * it when the turn ends. The audit row written with that id joins the answer
 * line by turn id — read back from the database, not the UI.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { AiRepository, SessionTokenRegistry } from "@moss/ai";
import type { ChatEngineFactory } from "@moss/module-registry";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import type {
  CliChatEngine,
  EngineLaunchOpts,
  TranscriptRecord
} from "../../packages/chat/src/live/types.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

class FakeLiveEngine implements CliChatEngine {
  private pending: TranscriptRecord[] = [];

  constructor(public readonly provider: CliChatEngine["provider"]) {}

  async launch(_opts: EngineLaunchOpts): Promise<{ offset: number }> {
    return { offset: 0 };
  }

  async submit(text: string): Promise<void> {
    this.pending = [{ kind: "reply", text: `echo:${text}` }];
  }

  async readNew(
    afterOffset: number
  ): Promise<{ records: TranscriptRecord[]; offset: number; complete: boolean }> {
    if (this.pending.length === 0) {
      return { records: [], offset: afterOffset, complete: false };
    }
    const records = this.pending;
    this.pending = [];
    return { records, offset: afterOffset + 1, complete: true };
  }

  async isAlive(): Promise<boolean> {
    return true;
  }

  async kill(): Promise<void> {}

  async interrupt(): Promise<void> {}
}

const fakeEngineFactory: ChatEngineFactory = (provider) => new FakeLiveEngine(provider);

function userAContext() {
  return { actorUserId: ids.userA, requestId: "request:activity-turn-join" };
}

describe("activity turn join (#2956 slice B)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;
  let toolsListReadySpy: ReturnType<typeof vi.spyOn>;
  let toolsListObservationCountSpy: ReturnType<typeof vi.spyOn>;
  const setTurnCalls: Array<[string, string]> = [];
  const clearTurnCalls: string[] = [];
  let setTurnSpy: ReturnType<typeof vi.spyOn>;
  let clearTurnSpy: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-activity-turn-join-secret-key";

    // Same readiness stubs as the live-API suite: the fake engine runs no MCP
    // client, so readiness and tools/list observations resolve immediately.
    toolsListReadySpy = vi
      .spyOn(SessionTokenRegistry.prototype, "waitForToolsListObserved")
      .mockResolvedValue(true);
    let toolsListObservationCounter = 0;
    toolsListObservationCountSpy = vi
      .spyOn(SessionTokenRegistry.prototype, "getToolsListObservationCount")
      .mockImplementation(() => ++toolsListObservationCounter);
    // The turn filing itself IS under test: watch set against clear.
    setTurnSpy = vi
      .spyOn(SessionTokenRegistry.prototype, "setCurrentTurnId")
      .mockImplementation(function (this: SessionTokenRegistry, sessionId, turnId) {
        setTurnCalls.push([sessionId, turnId]);
      });
    clearTurnSpy = vi
      .spyOn(SessionTokenRegistry.prototype, "clearCurrentTurnId")
      .mockImplementation(function (this: SessionTokenRegistry, sessionId) {
        clearTurnCalls.push(sessionId);
      });

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    server = createApiServer({
      appDb,
      logger: false,
      chatEngineFactory: fakeEngineFactory
    });
    await server.ready();

    const providerResponse = await server.inject({
      method: "POST",
      url: "/api/ai/providers",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: { providerKind: "anthropic", displayName: "Activity Provider", authMethod: "cli" }
    });
    const providerId = providerResponse.json<{ provider: { id: string } }>().provider.id;
    await server.inject({
      method: "POST",
      url: "/api/ai/models",
      headers: { authorization: `Bearer ${ids.sessionAdmin}` },
      payload: {
        providerConfigId: providerId,
        providerModelId: "claude-activity",
        displayName: "Claude Activity",
        capabilities: ["chat"]
      }
    });
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    toolsListReadySpy?.mockRestore();
    toolsListObservationCountSpy?.mockRestore();
    setTurnSpy?.mockRestore();
    clearTurnSpy?.mockRestore();
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("one chat turn writes an answer line its audit rows join by turn id", async () => {
    const response = await server.inject({
      method: "POST",
      url: "/api/chat/turn",
      headers: { authorization: `Bearer ${ids.sessionA}` },
      payload: { text: "what is on today" }
    });
    expect(response.statusCode).toBe(200);

    // The turn filed itself under one id and released it when it ended.
    expect(setTurnCalls).toHaveLength(1);
    expect(clearTurnCalls).toHaveLength(1);
    expect(clearTurnCalls[0]).toBe(setTurnCalls[0]?.[0]);
    const turnId = setTurnCalls[0]?.[1];
    expect(typeof turnId).toBe("string");

    const answer = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      new AiRepository()
        .listModelActivity(scopedDb, { limit: 10 })
        .then((rows) => rows.find((row) => row.action_code === "chat.answer"))
    );
    expect(answer).toBeDefined();
    expect(answer?.id).toBe(turnId);
    expect(answer?.turn_id).toBe(turnId);
    expect(answer?.owner_user_id).toBe(ids.userA);

    // A tool row filed under the same turn joins the answer line by turn id.
    const aiRepository = new AiRepository();
    await dataContext.withDataContext(userAContext(), (scopedDb) =>
      aiRepository.insertActionAuditLog(scopedDb, {
        id: "00000000-0000-4000-8000-0000000000a1",
        ownerUserId: ids.userA,
        toolModuleId: "calendar",
        toolName: "calendar.list",
        actionFamilyId: null,
        actionKind: "write",
        approvalMode: "auto",
        outcome: "success",
        errorClass: null,
        requestId: "request:activity-turn-join",
        chatSessionId: setTurnCalls[0]?.[0] ?? null,
        turnId,
        sourceSurface: "chat",
        inputSummary: null,
        durationMs: 12
      })
    );

    const joined = await dataContext.withDataContext(userAContext(), (scopedDb) =>
      scopedDb.db
        .selectFrom("app.moss_model_activity_log as activity")
        .innerJoin("app.moss_action_audit_log as audit", "audit.turn_id", "activity.turn_id")
        .where("activity.turn_id", "=", turnId ?? "")
        .select(["activity.id as activityId", "audit.tool_name as toolName"])
        .execute()
    );
    expect(joined).toHaveLength(1);
    expect(joined[0]).toMatchObject({
      activityId: turnId,
      toolName: "calendar.list"
    });
  });
});
