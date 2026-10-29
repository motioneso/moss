import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import type { ChatHeartbeatOriginV1, MeResponse } from "@moss/shared";
import { ChatRepository } from "../../packages/chat/src/repository.js";
import { resolveHeartbeatMute } from "../../packages/chat/src/heartbeat/mute-command.js";
import { loadMuteRules, markPublished } from "../../packages/chat/src/heartbeat/store.js";
import { isMuted } from "../../packages/chat/src/heartbeat/filter.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

const MUTES_URL = "/api/me/heartbeat/mutes";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

describe("chat heartbeat stop topic", () => {
  let appDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let ownerCookie: string;
  let otherCookie: string;
  let ownerId: string;
  let otherId: string;
  const timecardId = randomUUID();
  const harborOneId = randomUUID();
  const harborTwoId = randomUUID();

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    dataContext = new DataContextRunner(appDb);
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    ownerCookie = await signUp("Owner", "owner.stop@example.test");
    otherCookie = await signUp("Other", "other.stop@example.test");
    ownerId = await userId(ownerCookie);
    otherId = await userId(otherCookie);
    await publish(ownerId);
  });

  afterAll(async () => {
    await Promise.allSettled([server?.close(), appDb?.destroy(), boss?.stop({ graceful: false })]);
  });

  it("returns candidates and saves nothing when a phrase matches several items", async () => {
    const result = await asUser(ownerId, (db) => resolveHeartbeatMute(db, { phrase: "harbor" }));
    expect(result.status).toBe("choose");
    if (result.status !== "choose") return;
    expect(result.candidates.map((c) => c.findingId).sort()).toEqual(
      [harborOneId, harborTwoId].sort()
    );
    expect((await get(ownerCookie, MUTES_URL)).json().mutes).toEqual([]);
  });

  it("saves one topic mute for a single match, tolerating a plural, and stays idempotent", async () => {
    const first = await asUser(ownerId, (db) => resolveHeartbeatMute(db, { phrase: "Timecards" }));
    const second = await asUser(ownerId, (db) => resolveHeartbeatMute(db, { phrase: "timecards" }));
    expect(first).toMatchObject({ status: "muted", mute: { scope: "topic", label: "Timecards" } });
    expect(second).toEqual(first);
    const rules = await asUser(ownerId, (db) => loadMuteRules(db));
    expect(rules).toHaveLength(1);
    const item = {
      entityKey: "x",
      episodeKey: "",
      title: "Send the quarterly timecard",
      at: null,
      kind: "",
      facts: {}
    };
    expect(isMuted(rules, "tasks", item)).toBe(true);
  });

  it("mutes one item by finding ID through the route and removes it with Undo", async () => {
    const res = await post(ownerCookie, { findingId: harborOneId });
    expect(res.statusCode).toBe(200);
    const mute = res.json().mute as { id: string; scope: string; label: string };
    expect(mute).toMatchObject({ scope: "item", label: "Harbor FC fixture one" });
    expect(await mutesFor(ownerCookie)).toHaveLength(2);
    const del = await server.inject({
      method: "DELETE",
      url: `${MUTES_URL}/${mute.id}`,
      headers: { cookie: ownerCookie }
    });
    expect(del.statusCode).toBe(200);
    expect(await mutesFor(ownerCookie)).toHaveLength(1);
  });

  it("will not mute another owner's finding and saves nothing for them", async () => {
    const res = await post(otherCookie, { findingId: harborOneId });
    expect(res.statusCode).toBe(404);
    expect(await mutesFor(otherCookie)).toEqual([]);
    const phrase = await asUser(otherId, (db) =>
      resolveHeartbeatMute(db, { findingId: timecardId })
    );
    expect(phrase).toEqual({ status: "not_found" });
  });

  async function publish(actorUserId: string): Promise<void> {
    const occurrenceId = randomUUID();
    const items = [
      { id: timecardId, source: "tasks", title: "Send the quarterly timecard", key: "task-1" },
      { id: harborOneId, source: "sports", title: "Harbor FC fixture one", key: "fx-1" },
      { id: harborTwoId, source: "sports", title: "Harbor FC fixture two", key: "fx-2" }
    ] as const;
    const origin: ChatHeartbeatOriginV1 = {
      version: 1,
      kind: "heartbeat",
      occurrenceId,
      intro: "Two things.",
      items: items.map((item) => ({
        findingId: item.id,
        source: item.source,
        title: item.title,
        at: null,
        note: "Note."
      }))
    };
    await asUser(actorUserId, async (db) => {
      const chat = new ChatRepository();
      const thread = await chat.ensureMainThread(db, actorUserId);
      await chat.insertReservedAssistantMessage(db, {
        id: randomUUID(),
        threadId: thread.id,
        body: "Two things.",
        origin,
        now: new Date()
      });
      await db.db
        .insertInto("app.heartbeat_occurrences")
        .values({
          id: occurrenceId,
          owner_user_id: actorUserId,
          settings_revision: 1,
          started_at: new Date(),
          outcome: "message"
        })
        .execute();
      await markPublished(
        db,
        occurrenceId,
        new Date(),
        items.map((item) => ({
          id: item.id,
          source: item.source,
          entityKey: item.key,
          episodeKey: "e1"
        }))
      );
    });
  }

  async function mutesFor(cookie: string) {
    return (await get(cookie, MUTES_URL)).json().mutes as unknown[];
  }

  function get(cookie: string, url: string) {
    return server.inject({ method: "GET", url, headers: { cookie } });
  }

  function post(cookie: string, payload: Record<string, unknown>) {
    return server.inject({
      method: "POST",
      url: MUTES_URL,
      headers: { cookie, "content-type": "application/json" },
      payload
    });
  }

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:heartbeat-stop-it" }, work);
  }

  async function signUp(name: string, email: string): Promise<string> {
    const res = await server.inject({
      method: "POST",
      url: "/api/auth/sign-up/email",
      headers: { "content-type": "application/json" },
      payload: { name, email, password: "correct horse battery staple" }
    });
    expect(res.statusCode).toBe(200);
    return cookieHeader(res.headers);
  }

  async function userId(cookie: string): Promise<string> {
    const res = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });
    return res.json<MeResponse>().user.id;
  }
});
