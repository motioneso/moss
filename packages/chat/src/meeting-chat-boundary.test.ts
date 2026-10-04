import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";
import { meetingChatSurface } from "@moss/shared";
import { registerChatLiveRoutes, type ChatLiveRoutesDependencies } from "./live-routes.js";
import { PageContextStore } from "./live/page-context-store.js";
import type { MeetingChatRuntime } from "./live/meeting-chat-runtime.js";
import { registerMeetingChatBoundary } from "./meeting-chat-boundary.js";

const meetingId = "12345678-1234-4234-9234-123456789abc";
const surface = meetingChatSurface(meetingId);
const selection = { meetingId, selectionId: "selection-a" };
const access = { actorUserId: "owner", requestId: "meeting-route-test" };
const apps: FastifyInstance[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function server(options: { boundary?: boolean; available?: boolean } = {}) {
  const app = Fastify();
  apps.push(app);
  // A stream must end even when a regression incorrectly lets it reach the general engine.
  app.addHook("onRequest", (_request, reply, done) => {
    const writeHead = reply.raw.writeHead.bind(reply.raw);
    reply.raw.writeHead = ((...args: Parameters<typeof writeHead>) => {
      const result = writeHead(...args);
      setImmediate(() => reply.raw.end());
      return result;
    }) as typeof writeHead;
    done();
  });
  const manager = {
    submitTurn: vi.fn(async () => ({ reply: "GENERAL_ENGINE" })),
    ensureSession: vi.fn(async () => undefined),
    seedContext: vi.fn(async () => undefined),
    switchProvider: vi.fn(async () => undefined),
    resumeThread: vi.fn(async () => undefined),
    subscribe: vi.fn(() => () => undefined),
    clear: vi.fn(async () => undefined),
    getPrivacyState: vi.fn(async () => ({ incognito: true })),
    stopTurn: vi.fn(async () => undefined),
    endPrivateSession: vi.fn(async () => undefined)
  };
  const source = { isAvailable: vi.fn(async () => options.available !== false) };
  const service = {
    submit: vi.fn(async () => ({ reply: "MEETING_ONLY" })),
    cancel: vi.fn()
  };
  if (options.boundary !== false) {
    registerMeetingChatBoundary(app, {
      resolveAccessContext: async () => access,
      runtime: { source, service } as unknown as MeetingChatRuntime
    });
  }
  registerChatLiveRoutes(app, {
    resolveAccessContext: async () => access,
    runtime: {
      resolveUserName: async () => "Owner",
      manager
    } as unknown as ChatLiveRoutesDependencies["runtime"],
    pageContextStore: new PageContextStore({ now: () => 0, ttlMs: 300_000 })
  });
  return { app, manager, source, service };
}

function expectNoEngine(manager: ReturnType<typeof server>["manager"]) {
  for (const key of [
    "submitTurn",
    "ensureSession",
    "seedContext",
    "switchProvider",
    "resumeThread",
    "subscribe"
  ] as const) {
    expect(manager[key], key).not.toHaveBeenCalled();
  }
}

const chatPrefixes = ["/api/chat", "/%61pi/chat", "/api/%63hat", "/%61%70%69/%63%68%61%74"];

describe("meeting chat decoded route boundary", () => {
  it.each(chatPrefixes)(
    "handles an encoded meeting turn at %s through only the meeting service",
    async (prefix) => {
      const { app, manager, service } = server();
      const response = await app.inject({
        method: "POST",
        url: `${prefix}/%74urn`,
        payload: { surface, meetingContext: selection, text: "When?" }
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ reply: "MEETING_ONLY" });
      expect(service.submit).toHaveBeenCalledWith(access, surface, selection, "When?");
      expectNoEngine(manager);
    }
  );

  it.each(chatPrefixes)(
    "rejects unauthorized encoded turns at %s before any engine",
    async (prefix) => {
      const { app, manager, service } = server({ available: false });
      const response = await app.inject({
        method: "POST",
        url: `${prefix}/turn`,
        payload: { surface, meetingContext: selection, text: "When?" }
      });
      expect(response.statusCode).toBe(404);
      expect(service.submit).not.toHaveBeenCalled();
      expectNoEngine(manager);
    }
  );

  it.each(chatPrefixes)("protects all encoded engine routes at %s", async (prefix) => {
    const { app, manager } = server();
    for (const route of ["seed", "switch", "evening-interview", "threads/id/resume"]) {
      const response = await app.inject({
        method: "POST",
        url: `${prefix}/${route}?surface=${surface}`,
        payload: { surface, seed: "meeting text", idempotencyKey: "key" }
      });
      expect(response.statusCode, route).toBe(400);
    }
    const stream = await app.inject(`${prefix}/stream?surface=${surface}`);
    expect(stream.statusCode).toBe(400);
    expectNoEngine(manager);
  });

  it.each(chatPrefixes)(
    "reauthorizes encoded history release at %s using the matched parameterized route",
    async (prefix) => {
      const { app, source } = server();
      app.get("/api/chat/threads/:id/messages", async () => {
        source.isAvailable.mockResolvedValue(false);
        return { messages: ["PRIVATE_TRANSCRIPT"] };
      });
      const response = await app.inject(`${prefix}/threads/thread-id/messages?surface=${surface}`);
      expect(response.statusCode).toBe(404);
      expect(response.body).not.toContain("PRIVATE_TRANSCRIPT");
      expect(source.isAvailable).toHaveBeenCalledTimes(2);
    }
  );

  it.each(chatPrefixes)(
    "preserves encoded meeting privacy, cancel, clear and availability at %s",
    async (prefix) => {
      const { app, manager, service } = server();
      expect((await app.inject(`${prefix}/privacy?surface=${surface}`)).json()).toEqual({
        incognito: false
      });
      expect((await app.inject(`${prefix}/meeting-context?surface=${surface}`)).json()).toEqual({
        available: true
      });
      expect(
        (await app.inject({ method: "POST", url: `${prefix}/turn/cancel?surface=${surface}` }))
          .statusCode
      ).toBe(200);
      expect(
        (await app.inject({ method: "POST", url: `${prefix}/clear?surface=${surface}` })).statusCode
      ).toBe(204);
      expect(service.cancel).toHaveBeenCalledTimes(2);
      expect(manager.stopTurn).not.toHaveBeenCalled();
      expect(manager.getPrivacyState).not.toHaveBeenCalled();
      expect(manager.clear).toHaveBeenCalledWith(access.actorUserId, undefined, surface);
      expectNoEngine(manager);
    }
  );

  it.each([
    "/%2561pi/chat/turn",
    "/api/%2563hat/turn",
    "/api/chat/%2574urn",
    "/api%2fchat/turn",
    "/api/chat/%",
    "/api/chat/%GGurn",
    "/api/chat/%C0%AFturn"
  ])("does not recursively decode or dispatch malformed path %s", async (url) => {
    const { app, manager, service } = server();
    const response = await app.inject({
      method: "POST",
      url,
      payload: { surface, meetingContext: selection, text: "When?" }
    });
    expect([400, 404]).toContain(response.statusCode);
    expect(service.submit).not.toHaveBeenCalled();
    expectNoEngine(manager);
  });
});

describe("general live handlers without the meeting hook", () => {
  const routes = [
    ["POST", "turn"],
    ["POST", "seed"],
    ["POST", "switch"],
    ["POST", "evening-interview"],
    ["POST", "threads/id/resume"],
    ["GET", "stream"],
    ["GET", "privacy"],
    ["POST", "turn/cancel"],
    ["POST", "private/end"]
  ] as const;

  describe.each(routes)("%s /api/chat/%s", (method, route) => {
    it.each([surface, "mtg-00", "mtg-"])("rejects reserved surface %s", async (reservedSurface) => {
      const { app, manager } = server({ boundary: false });
      const response = await app.inject({
        method,
        url: `/api/chat/${route}?surface=${reservedSurface}`,
        ...(method === "POST"
          ? {
              payload: {
                surface: reservedSurface,
                text: "When?",
                seed: "meeting text",
                idempotencyKey: "key"
              }
            }
          : {})
      });
      for (const call of Object.values(manager)) expect(call).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });

    it("rejects context-only requests on ordinary surfaces", async () => {
      const { app, manager } = server({ boundary: false });
      const response = await app.inject({
        method,
        url: `/api/chat/${route}?surface=drawer${method === "GET" ? "&meetingContext=selected-a" : ""}`,
        ...(method === "POST"
          ? {
              payload: {
                surface: "drawer",
                text: "When?",
                seed: "meeting text",
                idempotencyKey: "key",
                meetingContext: selection
              }
            }
          : {})
      });
      for (const call of Object.values(manager)) expect(call).not.toHaveBeenCalled();
      expect(response.statusCode).toBe(400);
    });
  });

  it.each(["turn", "seed", "switch", "evening-interview", "threads/id/resume"])(
    "rejects body/query surface masking and null context on %s",
    async (route) => {
      const { app, manager } = server({ boundary: false });
      for (const [querySurface, extra] of [
        ["drawer", { surface }],
        [surface, { surface: "drawer" }],
        ["drawer", { surface: "drawer", meetingContext: null }]
      ] as const) {
        const response = await app.inject({
          method: "POST",
          url: `/api/chat/${route}?surface=${querySurface}`,
          payload: { text: "When?", seed: "meeting text", idempotencyKey: "key", ...extra }
        });
        expect(response.statusCode).toBe(400);
      }
      expectNoEngine(manager);
    }
  );

  it("preserves ordinary turns, seed, switch, resume, stream, privacy and clear", async () => {
    const { app, manager } = server();
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/%61pi/chat/turn",
          payload: { surface: "drawer", text: "Hello" }
        })
      ).statusCode
    ).toBe(200);
    expect(
      (
        await app.inject({
          method: "POST",
          url: "/api/chat/seed",
          payload: { surface: "module-notes", seed: "Notes", idempotencyKey: "key" }
        })
      ).statusCode
    ).toBe(204);
    expect(
      (await app.inject({ method: "POST", url: "/api/chat/switch?surface=drawer" })).statusCode
    ).toBe(200);
    expect(
      (await app.inject({ method: "POST", url: "/api/chat/threads/id/resume?surface=drawer" }))
        .statusCode
    ).toBe(204);
    expect((await app.inject("/api/chat/stream?surface=drawer")).statusCode).toBe(200);
    expect((await app.inject("/api/chat/privacy?surface=drawer")).json()).toEqual({
      incognito: true
    });
    expect(
      (await app.inject({ method: "POST", url: "/api/chat/clear?surface=drawer&incognito=true" }))
        .statusCode
    ).toBe(204);
    expect(manager.submitTurn).toHaveBeenCalledWith(
      access.actorUserId,
      "Owner",
      "Hello",
      undefined,
      "drawer"
    );
    expect(manager.seedContext).toHaveBeenCalledWith(
      access.actorUserId,
      "Owner",
      "Notes",
      "key",
      "module-notes"
    );
    expect(manager.switchProvider).toHaveBeenCalledWith(access.actorUserId, "Owner", "drawer");
    expect(manager.resumeThread).toHaveBeenCalledWith(access.actorUserId, "id", "drawer");
    expect(manager.ensureSession).toHaveBeenCalledOnce();
    expect(manager.subscribe).toHaveBeenCalledOnce();
    expect(manager.clear).toHaveBeenCalledWith(access.actorUserId, { incognito: true }, "drawer");
  });
});
