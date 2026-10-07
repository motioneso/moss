/**
 * #1284 — unit tests for the generic POST /api/chat/seed route: the seed seam every surface
 * owner uses (evening-interview being one dedicated caller). Runs `registerChatLiveRoutes`
 * against a bare Fastify instance with a fake runtime/manager — no real DB, no real chat engine —
 * so these assert only the route's own body validation, argument plumbing, and error mapping.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import Fastify, { type FastifyInstance } from "fastify";

import { registerChatLiveRoutes } from "../../packages/chat/src/live-routes.js";
import { PageContextStore } from "../../packages/chat/src/live/page-context-store.js";
import type { AccessContext } from "@moss/db";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

function buildApp(options: {
  readonly seedContext: ReturnType<typeof vi.fn>;
  readonly submitTurn?: ReturnType<typeof vi.fn>;
  readonly resolveAccessContext?: (request: unknown) => Promise<AccessContext>;
}): FastifyInstance {
  const app = Fastify({ logger: false });
  registerChatLiveRoutes(app, {
    resolveAccessContext:
      options.resolveAccessContext ??
      (async () => ({ actorUserId: ACTOR_ID, requestId: "test-request" })),
    // Cast: ChatSessionManager is a concrete class; the route only ever touches
    // `runtime.manager.seedContext` and `runtime.resolveUserName` for this route, so a minimal
    // structural fake is enough (same pattern used by other live-routes unit tests).
    runtime: {
      manager: { seedContext: options.seedContext, submitTurn: options.submitTurn },
      resolveUserName: async () => "Test User",
      resolveEveningInterviewSeed: async () => ({
        context: "Evening briefing marker",
        openingPrompt: "Prep me for tomorrow."
      })
    } as never,
    pageContextStore: new PageContextStore({ now: () => Date.now(), ttlMs: 300_000 })
  });
  return app;
}

describe("POST /api/chat/seed", () => {
  let app: FastifyInstance | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it("labels evening briefing seeds for admission before submitting the opening prompt", async () => {
    const seedContext = vi.fn(async () => undefined);
    const submitTurn = vi.fn(async () => ({ reply: "What went well?" }));
    app = buildApp({ seedContext, submitTurn });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/evening-interview",
      payload: { surface: "drawer" }
    });
    expect(response.statusCode).toBe(200);
    expect(seedContext).toHaveBeenCalledExactlyOnceWith(
      ACTOR_ID,
      "Test User",
      "Evening briefing marker",
      undefined,
      "drawer",
      "evening_seed"
    );
    expect(seedContext.mock.invocationCallOrder[0]).toBeLessThan(
      submitTurn.mock.invocationCallOrder[0]!
    );
  });

  it("does not submit an evening opening prompt after seed admission fails", async () => {
    const seedContext = vi.fn(async () => {
      throw new Error("Conversation provenance could not be recorded");
    });
    const submitTurn = vi.fn();
    app = buildApp({ seedContext, submitTurn });
    const response = await app.inject({
      method: "POST",
      url: "/api/chat/evening-interview",
      payload: { surface: "drawer" }
    });
    expect(response.statusCode).toBe(500);
    expect(submitTurn).not.toHaveBeenCalled();
  });

  it("seeds the requested surface and returns 204", async () => {
    const seedContext = vi.fn(async () => undefined);
    app = buildApp({ seedContext });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/seed",
      payload: {
        seed: "Frame this thread.",
        idempotencyKey: "key-1",
        surface: "m-deadbeefcafef00d"
      }
    });

    expect(response.statusCode).toBe(204);
    expect(response.body).toBe("");
    expect(seedContext).toHaveBeenCalledWith(
      ACTOR_ID,
      "Test User",
      "Frame this thread.",
      "key-1",
      "m-deadbeefcafef00d"
    );
  });

  it("passes a repeat idempotency key straight through — the manager owns the dedupe", async () => {
    // #1284 — guards the real failure this seam exists for: a module remount must not silently
    // stop reaching the manager just because it reuses the same key. The route's only job is to
    // pass the key through every time; dedupe is the manager's responsibility (chat-session-manager
    // seededContextKeys), not the route's.
    const seedContext = vi.fn(async () => undefined);
    app = buildApp({ seedContext });
    await app.ready();

    const payload = {
      seed: "Frame this thread.",
      idempotencyKey: "key-1",
      surface: "m-deadbeefcafef00d"
    };
    await app.inject({ method: "POST", url: "/api/chat/seed", payload });
    const second = await app.inject({ method: "POST", url: "/api/chat/seed", payload });

    expect(second.statusCode).toBe(204);
    expect(seedContext).toHaveBeenCalledTimes(2);
    expect(seedContext).toHaveBeenNthCalledWith(
      2,
      ACTOR_ID,
      "Test User",
      "Frame this thread.",
      "key-1",
      "m-deadbeefcafef00d"
    );
  });

  it("rejects a seed over 8000 characters with 400", async () => {
    const seedContext = vi.fn(async () => undefined);
    app = buildApp({ seedContext });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/seed",
      payload: { seed: "a".repeat(8001), idempotencyKey: "key-1" }
    });

    expect(response.statusCode).toBe(400);
    expect(seedContext).not.toHaveBeenCalled();
  });

  it("maps an illegal surface to 400, not a 500", async () => {
    // #1284 — the surface must be rejected by the route's own body validation (readSeedBody →
    // readOptionalSurface → normalizeChatSurface), never escape as an unhandled throw from inside
    // the try/catch that only wraps the manager call.
    const seedContext = vi.fn(async () => undefined);
    app = buildApp({ seedContext });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/seed",
      payload: {
        seed: "Frame this thread.",
        idempotencyKey: "key-1",
        surface: "module:job-search:p1"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(seedContext).not.toHaveBeenCalled();
  });

  it("returns 401 for an unauthenticated call", async () => {
    const seedContext = vi.fn(async () => undefined);
    app = buildApp({
      seedContext,
      resolveAccessContext: async () => {
        throw new Error("Session is missing or expired");
      }
    });
    await app.ready();

    const response = await app.inject({
      method: "POST",
      url: "/api/chat/seed",
      payload: { seed: "Frame this thread.", idempotencyKey: "key-1" }
    });

    expect(response.statusCode).toBe(401);
    expect(seedContext).not.toHaveBeenCalled();
  });
});
