/**
 * Regression test for #1037 — the resume route's ownership check is enforced entirely by RLS
 * (packages/chat/src/repository.ts:283-302's `touchThread` has no explicit `owner_user_id`
 * filter). If RLS ever regresses, this route would silently touch or return another actor's
 * thread. See docs/superpowers/plans/2026-08-16-1037-chat-resume-rls-test.md for the full seam
 * chain (live-routes.ts -> chat-session-manager.ts -> persistence.ts -> repository.ts).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { ChatRepository } from "@moss/chat";
import { DataContextRunner, createDatabase, type AccessContext, type MossDatabase } from "@moss/db";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

describe("Chat resume RLS (#1037)", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let repository: ChatRepository;
  let server: ReturnType<typeof createApiServer>;
  let originalSecretKey: string | undefined;

  beforeAll(async () => {
    originalSecretKey = process.env.JARVIS_AI_SECRET_KEY;
    process.env.JARVIS_AI_SECRET_KEY = "test-chat-resume-privacy-secret-key";

    await resetFoundationDatabase();

    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);
    repository = new ChatRepository();
    server = createApiServer({ appDb, logger: false });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
    if (originalSecretKey === undefined) {
      delete process.env.JARVIS_AI_SECRET_KEY;
    } else {
      process.env.JARVIS_AI_SECRET_KEY = originalSecretKey;
    }
  });

  it("POST /api/chat/threads/:id/resume denies actor B resuming actor A's private thread", async () => {
    const thread = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "A's private thread" });
      await repository.recordCompletedTurn(scopedDb, created.id, "a question", "an answer", {
        provider: "anthropic",
        model: "claude-live"
      });
      return created;
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/chat/threads/${thread.id}/resume`,
      headers: { authorization: `Bearer ${ids.sessionB}` }
    });

    expect(response.statusCode).toBe(404);
    expect(response.json<{ error: string }>().error).toBe("Chat thread not found.");

    // Ownership is validated FIRST (chat-session-manager.ts:674-675) — B's denied attempt must not
    // have touched A's row at all.
    const reread = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const threads = await repository.listThreadsByActivity(scopedDb, 50);
      return threads.find((t) => t.id === thread.id);
    });
    expect(reread).toBeDefined();
    expect(reread!.last_active_at).toEqual(thread.last_active_at);
  });

  it("POST /api/chat/threads/:id/resume lets actor A resume their own thread", async () => {
    const thread = await dataContext.withDataContext(userAContext(), async (scopedDb) => {
      const created = await repository.openNewThread(scopedDb, { title: "A's own thread" });
      await repository.recordCompletedTurn(scopedDb, created.id, "a question", "an answer", {
        provider: "anthropic",
        model: "claude-live"
      });
      return created;
    });

    const response = await server.inject({
      method: "POST",
      url: `/api/chat/threads/${thread.id}/resume`,
      headers: { authorization: `Bearer ${ids.sessionA}` }
    });

    expect(response.statusCode).toBe(204);
  });
});

function userAContext(): AccessContext {
  return { actorUserId: ids.userA, requestId: "request:chat-resume-privacy-a" };
}
