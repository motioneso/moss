import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DataContextRunner, createDatabase, type MossDatabase } from "@moss/db";
import Fastify from "fastify";
import type { Kysely } from "kysely";
import { registerScratchpadRoutes } from "@moss/scratchpad";

import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

// #2236 slice 1: exercises the scratchpad's HTTP behavior end to end against a real database,
// through the module's own route registration rather than the full API app - covers the cases
// the reviewer flagged as missing: a stale-revision conflict, an over-limit write, the newline
// rule between two appends, a full pad refusing an append politely, and the settings guardrails.

function contextFor(actorUserId: string) {
  return { actorUserId, requestId: `req:scratchpad-routes-${actorUserId}` };
}

describe("scratchpad routes", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let server: ReturnType<typeof Fastify>;

  beforeAll(async () => {
    await resetFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
    dataContext = new DataContextRunner(appDb);

    server = Fastify({ logger: false });
    registerScratchpadRoutes(server, {
      resolveAccessContext: async () => contextFor(ids.userA),
      dataContext
    });
    await server.ready();
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy()]);
  });

  it("PUT rejects a body over the character limit with 413", async () => {
    const res = await server.inject({
      method: "PUT",
      url: "/api/scratchpad",
      payload: { body: "a".repeat(64001), revision: 0 }
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "scratchpad_too_large" });
  });

  it("PUT with a stale revision returns 409 and the current stored state", async () => {
    const first = await server.inject({
      method: "PUT",
      url: "/api/scratchpad",
      payload: { body: "first draft", revision: 0 }
    });
    expect(first.statusCode).toBe(200);

    const stale = await server.inject({
      method: "PUT",
      url: "/api/scratchpad",
      payload: { body: "second draft, wrong revision", revision: 0 }
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ error: "scratchpad_conflict", body: "first draft" });
  });

  it("POST append adds a leading newline, since the pad already has text from the previous test", async () => {
    const firstAppend = await server.inject({
      method: "POST",
      url: "/api/scratchpad/append",
      payload: { text: "note one" }
    });
    expect(firstAppend.statusCode).toBe(200);
    expect(firstAppend.json().appended).toBe("\nnote one");

    const secondAppend = await server.inject({
      method: "POST",
      url: "/api/scratchpad/append",
      payload: { text: "note two" }
    });
    expect(secondAppend.statusCode).toBe(200);
    expect(secondAppend.json().appended).toBe("\nnote two");

    const state = await server.inject({ method: "GET", url: "/api/scratchpad" });
    expect(state.json().body).toBe("first draft\nnote one\nnote two");
  });

  it("POST append on an already-full pad returns 413, not a server error", async () => {
    await dataContext.withDataContext(contextFor(ids.userA), (scopedDb) =>
      scopedDb.db
        .updateTable("app.scratchpads")
        .set({ body: "a".repeat(64000) })
        .where("user_id", "=", ids.userA)
        .execute()
    );

    const res = await server.inject({
      method: "POST",
      url: "/api/scratchpad/append",
      payload: { text: "one more line" }
    });
    expect(res.statusCode).toBe(413);
    expect(res.json()).toMatchObject({ code: "scratchpad_too_large" });
  });

  it("PATCH settings rejects an invalid shortcut with 400", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/scratchpad/settings",
      payload: { shortcut: "shift+s" }
    });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ code: "scratchpad_shortcut_invalid" });
  });

  it("PATCH settings refuses to turn on notes syncing with no notes folder configured, 409", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/scratchpad/settings",
      payload: { syncToNotes: true }
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toMatchObject({ code: "scratchpad_notes_folder_missing" });
  });

  it("PATCH settings accepts a valid shortcut", async () => {
    const res = await server.inject({
      method: "PATCH",
      url: "/api/scratchpad/settings",
      payload: { shortcut: "mod+shift+j" }
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ shortcut: "mod+shift+j" });
  });
});
