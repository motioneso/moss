import Fastify from "fastify";
import { describe, expect, it } from "vitest";

import { registerChatLiveRoutes } from "./live-routes.js";
import { PageContextStore } from "./live/page-context-store.js";

const ACTOR = "00000000-0000-4000-8000-0000000000a1";

async function openStream(ensureSession: () => Promise<unknown>) {
  const app = Fastify({ logger: false });
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
  return { subscribedSurfaces, statusCodes };
}

describe("GET /api/chat/stream session pre-start", () => {
  it("subscribes after a successful pre-start", async () => {
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
});
