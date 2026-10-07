import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AiRepository, type GatewaySessionRecord } from "@moss/ai";
import { dataContextBrand, type ChatMessage, type DataContextDb } from "@moss/db";
import type { ChatMessageDto } from "@moss/shared";
import { ChatGatewayNotifier } from "../../packages/chat/src/gateway-notifier.js";
import {
  ChatSessionManager,
  type ChatPersistencePort
} from "../../packages/chat/src/live/chat-session-manager.js";
import type { CliChatEngine, TranscriptRecord } from "../../packages/chat/src/live/types.js";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const THREAD = "33333333-3333-4333-8333-333333333333";
const ACTION = "44444444-4444-4444-8444-444444444444";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

/** Real routes/repository payloads; the in-memory transaction is not a DB or RLS proof. */
function fixture() {
  const stored: ChatMessage[] = [];
  const repository = new ChatRepository();
  const thread = {
    id: THREAD,
    owner_user_id: OWNER,
    incognito: false,
    surface: "drawer"
  };
  const getThread = vi
    .spyOn(repository, "getThreadById")
    .mockImplementation(async (_db, id) => (id === THREAD ? (thread as never) : undefined));
  const listMessages = vi.spyOn(repository, "listMessages").mockImplementation(async () => stored);
  const scopedDb = {
    [dataContextBrand]: true,
    db: {
      insertInto: (table: string) => {
        expect(table).toBe("app.chat_messages");
        return {
          values: (row: ChatMessage) => ({
            returningAll: () => ({
              executeTakeFirstOrThrow: async () => {
                const message = JSON.parse(JSON.stringify({ ...row, owner_user_id: OWNER }));
                stored.push(message);
                return message;
              }
            })
          })
        };
      }
    }
  } as unknown as DataContextDb;
  let actor = OWNER;
  const dataContext = {
    withDataContext: async (
      access: { actorUserId: string },
      work: (db: DataContextDb) => Promise<unknown>
    ) => {
      actor = access.actorUserId;
      return work(scopedDb);
    }
  };
  vi.spyOn(AiRepository.prototype, "cancelStalePendingAssistantActions").mockResolvedValue(0);
  const getAction = vi
    .spyOn(AiRepository.prototype, "getAssistantAction")
    .mockImplementation(async (_db, id) =>
      actor === OWNER && id === ACTION
        ? ({ id: ACTION, owner_user_id: OWNER, status: "pending" } as never)
        : undefined
    );
  const resolveAction = vi
    .spyOn(AiRepository.prototype, "resolveAssistantAction")
    .mockRejectedValue(new Error("This expired request must never be resolved"));
  const app = Fastify({ logger: false });
  apps.push(app);
  registerChatRoutes(app, {
    rootDb: {} as never,
    dataContext: dataContext as never,
    repository,
    // Authentication is a fixture boundary; route ownership/gateway checks remain real.
    resolveAccessContext: async (request) => ({
      actorUserId: request.headers["x-test-actor"] === OTHER ? OTHER : OWNER,
      requestId: "route-test"
    }),
    chatEngineFactory: () => {
      throw new Error("History routes must not launch an engine");
    },
    resolveActiveModules: async () => [],
    mcpServerUrl: "http://mcp.test/api/mcp"
  });
  return { app, repository, scopedDb, stored, getThread, listMessages, getAction, resolveAction };
}

async function recordApproval(
  f: ReturnType<typeof fixture>,
  decision: Pick<Extract<GatewaySessionRecord, { kind: "action_result" }>, "outcome" | "decidedBy">
) {
  const live: TranscriptRecord[] = [];
  let submitted = false;
  const engine: CliChatEngine = {
    provider: "anthropic",
    launch: async () => ({ offset: 0 }),
    submit: async () => {
      submitted = true;
      notifier.emit(OWNER, {
        kind: "action_request",
        actionRequestId: ACTION,
        toolName: "app.callAction",
        summary: "Remove saved theme",
        outsideContentNotice: true,
        preview: { to: "private recipient", subject: "private subject", body: "private body" },
        details: {
          target: "private target",
          fields: [{ label: "Private", value: "private field" }]
        }
      });
      notifier.emit(OWNER, {
        kind: "action_result",
        actionRequestId: ACTION,
        toolName: "app.callAction",
        summary: "Remove saved theme",
        ...decision,
        holdDurationMs: 1200,
        ...(decision.outcome === "executed"
          ? { affectsModules: ["settings"], affectsQueryKeys: ["settings.themes"] }
          : {}),
        result: { privateResult: "private result" }
      });
    },
    readNew: async () => ({
      records: submitted ? [{ kind: "reply", text: "Finished." }] : [],
      offset: submitted ? 1 : 0,
      complete: true
    }),
    interrupt: async () => {},
    kill: async () => {},
    isAlive: async () => true
  };
  const persistence: ChatPersistencePort = {
    resolveActiveProvider: async () => ({ provider: "anthropic", model: "fixture-model" }),
    listPriorTurns: async () => ({ recent: [], oldSummary: null }),
    getCurrentThreadState: async () => ({ id: THREAD, incognito: false }),
    getThreadContext: async () => ({ threadTitle: null, localTimezone: null, incognito: false }),
    touchExistingThread: async () => true,
    openNewConversation: async () => {},
    recordTurn: async (_actor, userText, reply, executed, options) => {
      const result = await f.repository.recordCompletedTurn(
        f.scopedDb,
        THREAD,
        userText,
        reply,
        executed,
        options
      );
      expect(result).toBeDefined();
      return {
        userMessageId: result!.userMessage.id,
        assistantMessageId: result!.assistantMessage.id
      };
    }
  };
  const manager = new ChatSessionManager({
    persistence,
    engineFactory: () => engine,
    personaFs: { mkdir: async () => {}, writeFile: async () => {} },
    clock: { now: () => 0 },
    idleMs: 60_000,
    neutralBase: "/tmp",
    persona: "fixture persona",
    pollMs: 0
  });
  const notifier = new ChatGatewayNotifier(manager);
  manager.subscribe(OWNER, (record) => live.push(record));
  await manager.submitTurn(OWNER, "Owner", "Remove the theme");
  return live;
}

describe("approval history through real Fastify serialization", () => {
  it.each([
    { outcome: "executed", decidedBy: "person" },
    { outcome: "error", decidedBy: "person" },
    { outcome: "denied", decidedBy: "person" },
    { outcome: "denied", decidedBy: "timeout" },
    { outcome: "denied", decidedBy: "cancelled" }
  ] as const)(
    "preserves $outcome/$decidedBy after a completed turn and reload",
    async (decision) => {
      const f = fixture();
      const live = await recordApproval(f, decision);
      const response = await f.app.inject({ url: `/api/chat/threads/${THREAD}/messages` });
      expect(response.statusCode).toBe(200);
      const { messages } = response.json<{ messages: ChatMessageDto[] }>();
      const activity = messages.find((message) => message.role === "assistant")!.activity;
      expect(activity.map((record) => record.kind)).toEqual([
        "action_result",
        decision.outcome === "denied" ? "not_approved" : "approved"
      ]);
      for (const record of activity) {
        expect(record).toMatchObject({
          actionRequestId: ACTION,
          summary: "Remove saved theme",
          toolName: "app.callAction",
          ...decision
        });
        expect(record.sequence).toEqual(expect.any(Number));
        expect(record.durationMs).toBe(1200);
      }
      expect(response.body).not.toContain("private");
      expect(activity.some((record) => record.kind === "action_request")).toBe(false);
      expect(live.find((record) => record.kind === "action_request")?.details?.target).toBe(
        "private target"
      );
      if (decision.outcome === "executed") {
        expect(live.find((record) => record.kind === "action_result")?.affectsModules).toEqual([
          "settings"
        ]);
      }
    }
  );

  it("returns the same 404 for a foreign or missing history without listing messages", async () => {
    const f = fixture();
    for (const id of [THREAD, "55555555-5555-4555-8555-555555555555"]) {
      const response = await f.app.inject({
        url: `/api/chat/threads/${id}/messages`,
        headers: { "x-test-actor": OTHER }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Chat thread not found" });
    }
    expect(f.listMessages).not.toHaveBeenCalled();
  });
});

describe("approval resolution route ownership before expiry", () => {
  it("reports owned expiry without claiming approval or mutating it", async () => {
    const f = fixture();
    const response = await f.app.inject({
      method: "POST",
      url: `/api/chat/action-requests/${ACTION}/resolve`,
      payload: { status: "confirmed" }
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({ error: "This request expired — ask again." });
    expect(f.getAction).toHaveBeenCalledOnce();
    expect(f.resolveAction).not.toHaveBeenCalled();
    expect(f.stored).toEqual([]);
  });

  it("does not disclose expiry for another owner's action or an unknown ID", async () => {
    const f = fixture();
    for (const id of [ACTION, "unknown-action"]) {
      const response = await f.app.inject({
        method: "POST",
        url: `/api/chat/action-requests/${id}/resolve`,
        headers: { "x-test-actor": OTHER },
        payload: { status: "confirmed" }
      });
      expect(response.statusCode).toBe(404);
      expect(response.json()).toEqual({ error: "Action request not found" });
    }
    expect(f.resolveAction).not.toHaveBeenCalled();
  });
});
