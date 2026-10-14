import { EventEmitter } from "node:events";
import Fastify, { type RouteHandlerMethod } from "fastify";
import { describe, expect, it, vi } from "vitest";

import { registerChatLiveRoutes } from "./live-routes.js";
import { PageContextStore } from "./live/page-context-store.js";
import { ChatSessionManager } from "./live/chat-session-manager.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

const PRIVATE_MARKER = "PRIVATE_2737_MARKER";

async function openStream(ensureSession: () => Promise<unknown>) {
  const logLines: string[] = [];
  const app = Fastify({
    logger: { level: "trace", stream: { write: (line: string) => logLines.push(line) } }
  });
  const subscribedSurfaces: (string | undefined)[] = [];
  const statusCodes: number[] = [];

  let settle: () => void = () => undefined;
  const settled = new Promise<void>((resolve) => (settle = resolve));

  // The stream never ends on its own, so record the status the handler sends, then end it.
  app.addHook("onRequest", (_request, reply, done) => {
    const raw = reply.raw;
    const writeHead = raw.writeHead.bind(raw);
    raw.writeHead = ((statusCode: number, ...rest: unknown[]) => {
      statusCodes.push(statusCode);
      settle();
      return (writeHead as (...args: unknown[]) => typeof raw)(statusCode, ...rest);
    }) as typeof raw.writeHead;
    void settled.then(() => setImmediate(() => raw.end()));
    done();
  });
  registerChatLiveRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId: ACTOR, requestId: "request:stream-test" }),
    runtime: {
      resolveUserName: async () => "Stream Tester",
      manager: {
        ensureSession,
        subscribe: (_actorUserId: string, _fn: unknown, surface?: string) => {
          subscribedSurfaces.push(surface);
          return () => undefined;
        }
      }
    } as never,
    pageContextStore: new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 })
  });
  await app.ready();
  try {
    await app.inject({ method: "GET", url: "/api/chat/stream?surface=drawer" });
  } finally {
    await app.close();
  }
  return { subscribedSurfaces, statusCodes, logLines };
}

describe("GET /api/chat/stream session pre-start", () => {
  it.each(["success", "failure"])(
    "leaves no subscriber when the client closes during a %s pre-start",
    async (outcome) => {
      const { app, handler, manager, request, requestRaw, reply, raw } = await streamLifecycle();
      let start: () => void = () => undefined;
      let release: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (start = resolve));
      const startup = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(manager, "ensureSession").mockImplementation(async () => {
        start();
        await startup;
        if (outcome === "failure") throw new Error("launch failed");
        return undefined as never;
      });
      try {
        const running = handler.call(app, request, reply);
        await started;
        requestRaw.emit("close");
        raw.destroyed = true;
        raw.emit("close");
        release();
        await running;

        expect(manager["countSubscribers"](ACTOR)).toBe(0);
        expect(raw.writeHead).toHaveBeenCalledTimes(1);
      } finally {
        await app.close();
      }
    }
  );

  it.each([
    ["plain reminder", "Reminder: stretch", undefined],
    ["scheduled report", "I checked the task.", "tasks"]
  ] as const)(
    "delivers a %s while the chat agent is still starting",
    async (_kind, text, source) => {
      const { app, handler, manager, request, reply, raw } = await streamLifecycle();
      let release: () => void = () => undefined;
      let start: () => void = () => undefined;
      const started = new Promise<void>((resolve) => (start = resolve));
      const startup = new Promise<void>((resolve) => (release = resolve));
      vi.spyOn(manager, "ensureSession").mockImplementation(async () => {
        start();
        await startup;
        return undefined as never;
      });
      vi.spyOn(manager, "getPrivacyState").mockResolvedValue({
        incognito: false,
        threadId: "main"
      });
      const running = handler.call(app, request, reply);
      try {
        await started;
        await manager.deliverBackgroundMessage({
          actorUserId: ACTOR,
          threadId: "main",
          record: {
            kind: "reply",
            text,
            ...(source ? { scheduledReadSource: source } : {}),
            messageId: "result",
            background: true,
            backgroundThreadId: "main"
          }
        });
        expect(raw.writeHead).toHaveBeenCalledWith(200, expect.any(Object));
        expect(raw.write).toHaveBeenCalledWith(expect.stringContaining(text));
      } finally {
        release();
        await running;
        raw.emit("close");
        await app.close();
      }
    }
  );

  it("keeps a connected subscriber until the response connection closes", async () => {
    const { app, handler, manager, request, requestRaw, reply, raw } = await streamLifecycle();
    vi.spyOn(manager, "ensureSession").mockResolvedValue(undefined as never);
    try {
      await handler.call(app, request, reply);
      expect(manager["countSubscribers"](ACTOR)).toBe(1);
      requestRaw.emit("close");
      expect(manager["countSubscribers"](ACTOR)).toBe(1);
      raw.emit("close");
      expect(manager["countSubscribers"](ACTOR)).toBe(0);
    } finally {
      await app.close();
    }
  });

  it("subscribes before a successful pre-start", async () => {
    const result = await openStream(async () => undefined);

    expect(result.subscribedSurfaces).toEqual(["drawer"]);
    expect(result.statusCodes).toEqual([200]);
  });

  // #2737: EventSource never reconnects after an HTTP error, so a refused stream left the drawer
  // blind to every later action result and approval request until a page reload.
  it.each([
    ["no chat model yet", new Error("No active chat-capable model is configured")],
    ["a failed launch", new Error("cli launch failed")]
  ])("still subscribes when pre-start fails with %s", async (_label, error) => {
    const result = await openStream(async () => {
      throw error;
    });

    expect(result.subscribedSurfaces).toEqual(["drawer"]);
    expect(result.statusCodes).toEqual([200]);
  });

  it("logs a pre-start failure without any of the error's own text", async () => {
    const error = new Error(`message ${PRIVATE_MARKER}`, {
      cause: new Error(`cause ${PRIVATE_MARKER}`)
    });
    error.name = `Name${PRIVATE_MARKER}`;

    const result = await openStream(async () => {
      throw error;
    });

    const log = result.logLines.join("\n");
    expect(log).toContain("chat stream session pre-start failed");
    expect(log).not.toContain(PRIVATE_MARKER);
  });
});

async function streamLifecycle() {
  const app = Fastify();
  let handler: RouteHandlerMethod | undefined;
  app.addHook("onRoute", (route) => {
    if (route.url === "/api/chat/stream" && route.method === "GET") handler = route.handler;
  });
  const manager = new ChatSessionManager({} as never);
  registerChatLiveRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId: ACTOR, requestId: "request:disconnect" }),
    runtime: { manager, resolveUserName: async () => "Stream Tester" } as never,
    pageContextStore: new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 })
  });
  await app.ready();
  if (!handler) throw new Error("Chat stream route missing");
  const raw = Object.assign(new EventEmitter(), {
    destroyed: false,
    writableEnded: false,
    writeHead: vi.fn(),
    write: vi.fn(),
    end: vi.fn()
  });
  const requestRaw = new EventEmitter();
  const request = { raw: requestRaw, query: { surface: "drawer" } } as never;
  const reply = { raw, log: { warn: vi.fn() } } as never;
  return { app, handler, manager, request, requestRaw, reply, raw };
}
