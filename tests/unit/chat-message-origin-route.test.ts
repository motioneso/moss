// #3195: the browser's reconnect catch-up adds a delivered reminder from Main's history only
// when the history message carries its origin. These cases run the real history route and its
// response schema, so a field the schema forgets is stripped here exactly as in production.

import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { dataContextBrand, type ChatMessage, type DataContextDb } from "@moss/db";
import type { ChatMessageDto } from "@moss/shared";

import { ChatRepository } from "../../packages/chat/src/repository.js";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

const OWNER = "11111111-1111-4111-8111-111111111111";
const THREAD = "33333333-3333-4333-8333-333333333333";
const apps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  vi.restoreAllMocks();
});

function row(id: string, origin?: Record<string, unknown>): ChatMessage {
  return {
    id,
    thread_id: THREAD,
    owner_user_id: OWNER,
    role: "assistant",
    status: "stored",
    body: `Body of ${id}`,
    model_metadata: origin ? { origin } : {},
    tool_metadata: {},
    created_at: new Date("2026-10-10T12:00:00.000Z"),
    updated_at: new Date("2026-10-10T12:00:00.000Z")
  } as ChatMessage;
}

async function history(rows: ChatMessage[]): Promise<ChatMessageDto[]> {
  const repository = new ChatRepository();
  vi.spyOn(repository, "getThreadById").mockResolvedValue({
    id: THREAD,
    owner_user_id: OWNER
  } as never);
  vi.spyOn(repository, "listMessages").mockResolvedValue(rows);
  const scopedDb = { [dataContextBrand]: true } as unknown as DataContextDb;
  const app = Fastify({ logger: false });
  apps.push(app);
  registerChatRoutes(app, {
    rootDb: {} as never,
    dataContext: {
      withDataContext: async (_access: unknown, work: (db: DataContextDb) => Promise<unknown>) =>
        work(scopedDb)
    } as never,
    repository,
    // Authentication is a fixture boundary; serialization and the response schema stay real.
    resolveAccessContext: async () => ({ actorUserId: OWNER, requestId: "route-test" }),
    chatEngineFactory: () => {
      throw new Error("History routes must not launch an engine");
    },
    resolveActiveModules: async () => [],
    mcpServerUrl: "http://mcp.test/api/mcp"
  });
  const response = await app.inject({ url: `/api/chat/threads/${THREAD}/messages` });
  expect(response.statusCode).toBe(200);
  return response.json<{ messages: ChatMessageDto[] }>().messages;
}

describe("chat history keeps each message's origin", () => {
  it("returns a delivered reminder's origin", async () => {
    const [message] = await history([
      row("reminder-1", {
        version: 1,
        kind: "reminder",
        event: "delivered",
        reminderId: "saved-1",
        late: true
      })
    ]);
    expect(message!.origin).toEqual({
      version: 1,
      kind: "reminder",
      event: "delivered",
      reminderId: "saved-1",
      late: true
    });
  });

  it("returns a classifier gate origin", async () => {
    const [message] = await history([
      row("gate-1", {
        version: 1,
        kind: "classifier_gate",
        decisionId: "decision-1",
        moduleId: null,
        toolName: "app.callAction",
        outcome: "executed-success"
      })
    ]);
    expect(message!.origin).toEqual({
      version: 1,
      kind: "classifier_gate",
      decisionId: "decision-1",
      moduleId: null,
      toolName: "app.callAction",
      outcome: "executed-success"
    });
  });

  it("leaves origin off an ordinary reply", async () => {
    const [message] = await history([row("reply-1")]);
    expect(message).not.toHaveProperty("origin");
  });
});
