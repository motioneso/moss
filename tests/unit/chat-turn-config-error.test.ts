/**
 * The runner refuses to launch chat without per-user mode
 * ("acpSpawn requires per-user identity: refusing the shared home"). That is a
 * host-setup problem, not a transient failure, so the turn route must answer
 * with a message that names the fix instead of the generic 500. Runs
 * `registerChatLiveRoutes` against a bare Fastify instance with a fake
 * runtime/manager — no real DB, no real chat engine.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerChatLiveRoutes } from "../../packages/chat/src/live-routes.js";
import { PageContextStore } from "../../packages/chat/src/live/page-context-store.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function buildApp(submitTurn: ReturnType<typeof vi.fn>): FastifyInstance {
  const app = Fastify({ logger: false });
  registerChatLiveRoutes(app, {
    resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "test-request" }),
    // Cast: the turn route only ever touches `runtime.manager.submitTurn` and
    // `runtime.resolveUserName`, so a minimal structural fake is enough.
    runtime: {
      manager: { submitTurn },
      resolveUserName: async () => "Test User"
    } as never,
    pageContextStore: new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 })
  });
  return app;
}

describe("POST /api/chat/turn without per-user mode", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("returns 503 with the per-user fix, not the generic 500", async () => {
    const submitTurn = vi.fn(async () => {
      throw new Error("acpSpawn requires per-user identity: refusing the shared home");
    });
    app = buildApp(submitTurn);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/turn",
      payload: { text: "hello" }
    });

    expect(response.statusCode).toBe(503);
    expect(response.json<{ error: string }>().error).toBe(
      "Chat needs per-user mode on this host: set JARVIS_CLI_PER_USER_UID=1 and recreate the app container, then try again."
    );
  });

  it("still returns the generic 500 for other unexpected failures", async () => {
    const submitTurn = vi.fn(async () => {
      throw new Error("something entirely different broke");
    });
    app = buildApp(submitTurn);
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/turn",
      payload: { text: "hello" }
    });

    expect(response.statusCode).toBe(500);
    expect(response.json<{ error: string }>().error).toBe(
      "Live chat is temporarily unavailable."
    );
  });
});
