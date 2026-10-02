import { beforeAll, afterAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { ChatRepository } from "@moss/chat";
import type { ChatTurnOriginV1 } from "@moss/shared";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// Task 4.1 (#2901) — a gate-answered reply must record NO model execution and NO usage on its
// assistant message. The reply came from a validated tool result (or a fixed failure string), so
// recording a provider/model or a token count would be fiction. This drives the real repository
// write against the real schema and reads the stored model_metadata back.

const ORIGIN: ChatTurnOriginV1 = {
  version: 1,
  kind: "classifier_gate",
  decisionId: "decision-integration-1",
  moduleId: "calendar",
  toolName: "calendar.listVisibleEvents",
  outcome: "executed-success"
};

let appDb: Kysely<MossDatabase>;
let dataContext: DataContextRunner;
const repository = new ChatRepository();

const asUserA = <T>(
  work: (db: Parameters<Parameters<DataContextRunner["withDataContext"]>[1]>[0]) => Promise<T>
) =>
  dataContext.withDataContext(
    { actorUserId: ids.userA, requestId: "gate-origin-integration" } satisfies AccessContext,
    work
  );

beforeAll(async () => {
  await resetFoundationDatabase();
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  dataContext = new DataContextRunner(appDb);
});

afterAll(async () => {
  await appDb?.destroy();
});

describe("gate-answered chat turn records no model or usage (#2901)", () => {
  it("stores the gate origin and omits executed and usage; a model turn keeps executed", async () => {
    const { gateMessage, modelMessage } = await asUserA(async (scopedDb) => {
      const gateThread = await repository.openNewThread(scopedDb, { title: "Gate turn" });
      const gate = await repository.recordGateCompletedTurn(
        scopedDb,
        gateThread.id,
        "what's on today?",
        "You have 2 events today.",
        ORIGIN
      );
      if (!gate) throw new Error("gate turn not recorded");

      const modelThread = await repository.openNewThread(scopedDb, { title: "Model turn" });
      const model = await repository.recordCompletedTurn(
        scopedDb,
        modelThread.id,
        "hello",
        "Hi back.",
        { provider: "anthropic", model: "claude-x" },
        { usage: { inputTokens: 5, outputTokens: 7 } }
      );
      if (!model) throw new Error("model turn not recorded");

      return { gateMessage: gate.assistantMessage, modelMessage: model.assistantMessage };
    });

    const rows = await sql<{ id: string; model_metadata: Record<string, unknown> }>`
      SELECT id, model_metadata FROM app.chat_messages
      WHERE id IN (${gateMessage.id}::uuid, ${modelMessage.id}::uuid)
    `.execute(appDb);
    const byId = new Map(rows.rows.map((row) => [row.id, row.model_metadata]));

    const gateMeta = byId.get(gateMessage.id) ?? {};
    expect(gateMeta.executed).toBeUndefined();
    expect(gateMeta.usage).toBeUndefined();
    expect(gateMeta.origin).toEqual(ORIGIN);

    // A normal model turn is unchanged: it still carries the executed provider/model and usage.
    const modelMeta = byId.get(modelMessage.id) ?? {};
    expect(modelMeta.executed).toEqual({ provider: "anthropic", model: "claude-x" });
    expect(modelMeta.usage).toEqual({ inputTokens: 5, outputTokens: 7 });
    expect(modelMeta.origin).toBeUndefined();
  });
});
