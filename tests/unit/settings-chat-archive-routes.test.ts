import Fastify, { type FastifyInstance } from "fastify";
import { beforeEach, describe, expect, it } from "vitest";

import { registerChatArchiveRoutes } from "@moss/settings";

const USER_ID = "11111111-1111-1111-1111-111111111111";

interface Harness {
  readonly server: FastifyInstance;
  readonly store: Map<string, unknown>;
}

const buildHarness = async (): Promise<Harness> => {
  const store = new Map<string, unknown>();
  const server = Fastify();

  registerChatArchiveRoutes(server, {
    dataContext: {
      withDataContext: async (_accessContext: unknown, run: (db: never) => unknown) =>
        run({} as never)
    } as never,
    resolveAccessContext: async () => ({ actorUserId: USER_ID, requestId: "req-1" }) as never,
    preferencesRepository: {
      get: async (_db: unknown, key: string) => store.get(key) ?? null,
      upsert: async (_db: unknown, key: string, value: unknown) => {
        store.set(key, value);
      }
    } as never
  });

  await server.ready();
  return { server, store };
};

describe("chat archive settings routes (#1951)", () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildHarness();
  });

  it("is off by default with no prior PUT", async () => {
    const response = await harness.server.inject({ method: "GET", url: "/api/me/chat-archive" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ enabled: false, folder: "Moss/Chats" });
  });

  it("rejects a bad folder and writes neither preference key", async () => {
    const response = await harness.server.inject({
      method: "PUT",
      url: "/api/me/chat-archive",
      payload: { enabled: true, folder: "/etc/passwd" }
    });
    expect(response.statusCode).toBe(400);
    expect(harness.store.size).toBe(0);
  });

  it("persists a good folder and reflects it on the next GET", async () => {
    const putResponse = await harness.server.inject({
      method: "PUT",
      url: "/api/me/chat-archive",
      payload: { enabled: true, folder: "Journal/Chats" }
    });
    expect(putResponse.statusCode).toBe(200);
    expect(putResponse.json()).toEqual({ enabled: true, folder: "Journal/Chats" });

    const getResponse = await harness.server.inject({ method: "GET", url: "/api/me/chat-archive" });
    expect(getResponse.json()).toEqual({ enabled: true, folder: "Journal/Chats" });
  });
});
