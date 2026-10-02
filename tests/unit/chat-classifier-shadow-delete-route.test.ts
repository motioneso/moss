/**
 * #2908 — `DELETE /api/chat/classifier/shadow-records` must run the owner delete through the
 * caller's actor data context, so row-level security scopes it. No database here: the route is
 * exercised on a bare Fastify instance with the shadow repository spied, proving the production
 * route calls `deleteForOwner` under the resolved actor and returns its count. The RLS proof
 * (owner deletes only their own; another user and an admin cannot) lives in
 * `tests/integration/chat-classifier-shadow.test.ts`.
 */
import Fastify from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ClassifierShadowRepository } from "../../packages/chat/src/classifier-shadow-repository.js";
import { registerChatRoutes } from "../../packages/chat/src/routes.js";

const ACTOR_ID = "11111111-1111-4111-8111-111111111111";

describe("DELETE /api/chat/classifier/shadow-records (#2908)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("deletes the caller's own records under their actor context and returns the count", async () => {
    const scopedDb = { db: {} } as never;
    const withDataContext = vi.fn(async (_access: unknown, work: (db: never) => Promise<unknown>) =>
      work(scopedDb)
    );
    const deleteForOwner = vi
      .spyOn(ClassifierShadowRepository.prototype, "deleteForOwner")
      .mockResolvedValue(3);

    const server = Fastify({ logger: false });
    registerChatRoutes(server, {
      rootDb: {} as never,
      dataContext: { withDataContext } as never,
      resolveAccessContext: async () => ({ actorUserId: ACTOR_ID, requestId: "req-1" })
    });

    const response = await server.inject({
      method: "DELETE",
      url: "/api/chat/classifier/shadow-records"
    });
    await server.close();

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ deleted: 3 });
    expect(withDataContext).toHaveBeenCalledWith(
      expect.objectContaining({ actorUserId: ACTOR_ID }),
      expect.any(Function)
    );
    expect(deleteForOwner).toHaveBeenCalledWith(scopedDb);
  });
});
