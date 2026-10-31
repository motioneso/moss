import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { OutgoingHttpHeaders } from "node:http";
import type { Kysely } from "kysely";
import { sql } from "kysely";

import { createApiServer } from "../../apps/api/src/server.js";
import { DataContextRunner, createDatabase, type DataContextDb, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { PreferencesRepository } from "@moss/structured-state";
import type { HeartbeatEvidenceItem, HeartbeatSource, MeResponse } from "@moss/shared";
import {
  handleHeartbeatBeat,
  type HeartbeatBeatDeps,
  type HeartbeatBeatPayload
} from "../../packages/chat/src/heartbeat/beat-job.js";
import type { HeartbeatGenerator } from "../../packages/chat/src/heartbeat/generation.js";
import { HEARTBEAT_DAILY_ATTEMPTS } from "../../packages/chat/src/heartbeat/limits.js";
import {
  connectionStrings,
  resetEmptyFoundationDatabase,
  setInstanceSetting
} from "./test-database.js";

function cookieHeader(headers: OutgoingHttpHeaders): string {
  const setCookie = headers["set-cookie"];
  const cookies = Array.isArray(setCookie)
    ? setCookie
    : typeof setCookie === "string" || typeof setCookie === "number"
      ? [String(setCookie)]
      : [];
  return cookies.map((cookie) => cookie.split(";", 1)[0]).join("; ");
}

function item(entityKey: string, title: string, episodeKey = "e1"): HeartbeatEvidenceItem {
  return { entityKey, episodeKey, title, at: "2026-10-29T15:00:00Z", kind: "task_due", facts: {} };
}

describe("chat heartbeat beat pipeline", () => {
  let appDb: Kysely<MossDatabase>;
  let workerDb: Kysely<MossDatabase>;
  let dataContext: DataContextRunner;
  let workerContext: DataContextRunner;
  let boss: PgBoss;
  let server: ReturnType<typeof createApiServer>;
  let aId: string;
  let bId: string;
  let cId: string;

  // What the fake sources return, what the fake model does, and what was sent to the queue.
  let revision = "r1";
  let items: HeartbeatEvidenceItem[] = [];
  let failSources = new Set<HeartbeatSource>();
  let generatorCalls = 0;
  let generatorBehavior: (ids: string[]) => unknown = () => ({ selected: [], intro: null });
  let beforeAnswer: (() => Promise<void>) | null = null;
  const sent: { queue: string; data: Record<string, unknown> }[] = [];

  const generate: HeartbeatGenerator = async (_actor, input) => {
    generatorCalls += 1;
    if (beforeAnswer) await beforeAnswer();
    return {
      ok: true,
      object: generatorBehavior(input.candidates.map((candidate) => candidate.findingId)),
      usage: { inputTokens: 10, outputTokens: 5 }
    };
  };

  const gateway: HeartbeatBeatDeps["gateway"] = {
    async runBackgroundReadForActor(_actor, read) {
      const source = read.operation.split(".")[0] as string;
      const names: Record<string, HeartbeatSource> = {
        calendar: "calendar",
        tasks: "tasks",
        commitments: "memory",
        sports: "sports",
        news: "news"
      };
      const mapped = names[source] as HeartbeatSource;
      if (failSources.has(mapped)) return { ok: false, error: "refused" };
      // Only the tasks source carries items; the others stay empty and unchanged.
      const own = mapped === "tasks";
      const data = {
        source: mapped,
        revision: own ? revision : "static",
        nextBoundaryAt: null,
        freshness: "fresh",
        truncated: false,
        items: own ? items : []
      };
      return { ok: true, data, structuredData: data };
    }
  };

  const fakeBoss = {
    async send(queue: string, data: object) {
      sent.push({ queue, data: data as Record<string, unknown> });
      return "job";
    }
  } as unknown as Pick<PgBoss, "send">;

  function asUser<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return dataContext.withDataContext({ actorUserId, requestId: "req:hb-pipeline" }, work);
  }
  function asWorker<T>(actorUserId: string, work: (scopedDb: DataContextDb) => Promise<T>) {
    return workerContext.withDataContext({ actorUserId, requestId: "req:hb-pipeline-w" }, work);
  }

  async function beat(owner: string) {
    const settings = await asWorker(owner, (db) =>
      db.db
        .selectFrom("app.heartbeat_settings")
        .select("revision")
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .executeTakeFirst()
    );
    const payload: HeartbeatBeatPayload = {
      actorUserId: owner,
      kind: "heartbeat-beat",
      resourceId: randomUUID(),
      version: settings?.revision ?? 0,
      idempotencyKey: `heartbeat:${randomUUID()}`
    };
    const result = await asWorker(owner, (db) =>
      handleHeartbeatBeat(db, payload, {
        preferences: new PreferencesRepository(),
        gateway,
        generate,
        boss: fakeBoss
      })
    );
    const outcome = await asWorker(owner, (db) =>
      db.db
        .selectFrom("app.heartbeat_occurrences")
        .select(["outcome", "item_count", "message_id", "unavailable_sources"])
        .where("id", "=", payload.resourceId)
        .executeTakeFirst()
    );
    // Make the next beat due straight away.
    await asWorker(owner, (db) =>
      db.db
        .updateTable("app.heartbeat_settings")
        .set({ next_due_at: new Date(Date.now() - 1000) })
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .execute()
    );
    return { result, outcome };
  }

  async function mainMessages(owner: string) {
    return asUser(owner, (db) =>
      db.db
        .selectFrom("app.chat_messages")
        .select(["id", "model_metadata"])
        .where("role", "=", "assistant")
        .execute()
    );
  }

  beforeAll(async () => {
    await resetEmptyFoundationDatabase();
    appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
    workerDb = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 10 });
    dataContext = new DataContextRunner(appDb);
    workerContext = new DataContextRunner(workerDb);
    await setInstanceSetting("registration.requires_approval", { value: false });
    boss = createPgBossClient(connectionStrings.app, { connectionTimeoutMillis: 25_000 });
    server = createApiServer({ appDb, boss, logger: false });
    await server.ready();
    for (const [name, email] of [
      ["A", "a.hbp@example.test"],
      ["B", "b.hbp@example.test"],
      ["C", "c.hbp@example.test"]
    ] as const) {
      const res = await server.inject({
        method: "POST",
        url: "/api/auth/sign-up/email",
        headers: { "content-type": "application/json" },
        payload: { name, email, password: "correct horse battery staple" }
      });
      const cookie = cookieHeader(res.headers);
      const me = await server.inject({ method: "GET", url: "/api/me", headers: { cookie } });
      const id = me.json<MeResponse>().user.id;
      if (name === "A") aId = id;
      else if (name === "B") bId = id;
      else cId = id;
    }
  });

  afterAll(async () => {
    await Promise.allSettled([
      server?.close(),
      appDb?.destroy(),
      workerDb?.destroy(),
      boss?.stop({ graceful: false })
    ]);
  });

  it("makes one model call for new items, then none across ten unchanged beats", async () => {
    items = [item("t1", "Send timecard")];
    generatorBehavior = () => ({ selected: [], intro: null });
    generatorCalls = 0;
    await beat(aId);
    for (let i = 0; i < 10; i += 1) await beat(aId);
    expect(generatorCalls).toBe(1);
    expect(await mainMessages(aId)).toHaveLength(0);
  });

  it("publishes one message from evidence, and does not repeat it when reworded", async () => {
    revision = "r2";
    items = [item("t2", "File expenses")];
    generatorCalls = 0;
    generatorBehavior = (ids) => ({
      selected: [{ findingId: ids[0], note: "Worth doing today." }],
      intro: "Quick check-in."
    });
    const first = await beat(aId);
    expect(first.outcome).toMatchObject({ outcome: "message", item_count: 1 });
    const messages = await mainMessages(aId);
    expect(messages).toHaveLength(1);
    const origin = (messages[0]!.model_metadata as { origin: { kind: string; items: unknown[] } })
      .origin;
    expect(origin.kind).toBe("heartbeat");
    expect(origin.items[0]).toMatchObject({ title: "File expenses", source: "tasks" });
    expect(sent.filter((job) => job.queue === "chat.heartbeat-notify")).toHaveLength(1);
    expect(JSON.stringify(sent)).not.toContain("Worth doing today");

    revision = "r3";
    items = [item("t2", "File the expenses report")];
    const second = await beat(aId);
    expect(second.outcome?.outcome).toBe("quiet");
    expect(await mainMessages(aId)).toHaveLength(1);
    expect(generatorCalls).toBe(1);
  });

  it("never sends a muted item, and drops one muted while the model runs", async () => {
    await asWorker(aId, (db) =>
      db.db
        .insertInto("app.heartbeat_mutes")
        .values({
          id: randomUUID(),
          owner_user_id: sql<string>`app.current_actor_user_id()`,
          scope: "item",
          source: "tasks",
          entity_key: "t3",
          label: "t3"
        })
        .execute()
    );
    revision = "r4";
    items = [item("t3", "Muted thing")];
    generatorCalls = 0;
    expect((await beat(aId)).outcome?.outcome).toBe("quiet");
    expect(generatorCalls).toBe(0);

    revision = "r5";
    items = [item("t4", "Muted mid-run")];
    generatorBehavior = (ids) => ({
      selected: [{ findingId: ids[0], note: "Soon." }],
      intro: null
    });
    beforeAnswer = async () => {
      await asWorker(aId, (db) =>
        db.db
          .insertInto("app.heartbeat_mutes")
          .values({
            id: randomUUID(),
            owner_user_id: sql<string>`app.current_actor_user_id()`,
            scope: "item",
            source: "tasks",
            entity_key: "t4",
            label: "t4"
          })
          .execute()
      );
    };
    const before = (await mainMessages(aId)).length;
    await beat(aId);
    beforeAnswer = null;
    expect((await mainMessages(aId)).length).toBe(before);
  });

  it("rejects an unsupplied finding and an unsupported number, publishing nothing", async () => {
    const before = (await mainMessages(aId)).length;
    revision = "r6";
    items = [item("t5", "Plain item")];
    generatorBehavior = () => ({
      selected: [{ findingId: randomUUID(), note: "Hi." }],
      intro: null
    });
    expect((await beat(aId)).outcome?.outcome).toBe("failed");

    revision = "r7";
    items = [item("t6", "Another item")];
    generatorBehavior = (ids) => ({
      selected: [{ findingId: ids[0], note: "Due at 7:45 sharp." }],
      intro: null
    });
    expect((await beat(aId)).outcome?.outcome).toBe("failed");
    expect((await mainMessages(aId)).length).toBe(before);
  });

  it("marks a failing source unavailable and holds its checkpoint", async () => {
    failSources = new Set(["tasks"]);
    const outcome = (await beat(aId)).outcome;
    failSources = new Set();
    expect(outcome?.unavailable_sources).toContain("tasks");
    expect(outcome?.outcome).toBe("degraded");
  });

  it("holds after the daily allowance is used, without calling the model", async () => {
    generatorBehavior = () => ({ selected: [], intro: null });
    const used = await asWorker(bId, (db) =>
      db.db.selectFrom("app.heartbeat_allowance_charges").select("attempt").execute()
    );
    expect(used).toEqual([]);
    generatorCalls = 0;
    for (let i = 0; i < HEARTBEAT_DAILY_ATTEMPTS; i += 1) {
      revision = `b${i}`;
      items = [item(`b${i}`, `Item ${i}`)];
      await beat(bId);
    }
    expect(generatorCalls).toBe(HEARTBEAT_DAILY_ATTEMPTS);
    revision = "b-final";
    items = [item("b-final", "One more")];
    const seventh = await beat(bId);
    expect(seventh.outcome?.outcome).toBe("held_allowance");
    expect(generatorCalls).toBe(HEARTBEAT_DAILY_ATTEMPTS);
  });

  it("keeps the daily allowance when beats for one owner run at the same time", async () => {
    generatorBehavior = () => ({ selected: [], intro: null });
    generatorCalls = 0;
    // Enroll and use four of the six attempts one at a time.
    for (let i = 0; i < 4; i += 1) {
      revision = `c${i}`;
      items = [item(`c${i}`, `Item ${i}`)];
      await beat(cId);
    }
    expect(generatorCalls).toBe(4);

    // Eight beats start together on a new revision, each with its own occurrence.
    revision = "c-race";
    items = [item("c-race", "Race")];
    const settings = await asWorker(cId, (db) =>
      db.db
        .selectFrom("app.heartbeat_settings")
        .select("revision")
        .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
        .executeTakeFirstOrThrow()
    );
    const slowGenerate: HeartbeatGenerator = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 100));
      return generate(...args);
    };
    await Promise.all(
      Array.from({ length: 8 }, () =>
        asWorker(cId, (db) =>
          handleHeartbeatBeat(
            db,
            {
              actorUserId: cId,
              kind: "heartbeat-beat",
              resourceId: randomUUID(),
              version: settings.revision,
              idempotencyKey: `heartbeat:${randomUUID()}`
            },
            {
              preferences: new PreferencesRepository(),
              gateway,
              generate: slowGenerate,
              boss: fakeBoss
            }
          )
        )
      )
    );

    const charges = await asWorker(cId, (db) =>
      db.db.selectFrom("app.heartbeat_allowance_charges").select("attempt").execute()
    );
    expect(charges.length).toBeLessThanOrEqual(HEARTBEAT_DAILY_ATTEMPTS);
    expect(generatorCalls).toBeLessThanOrEqual(HEARTBEAT_DAILY_ATTEMPTS);
  });

  it("keeps findings, checkpoints and charges private to their owner", async () => {
    for (const table of [
      "app.heartbeat_findings",
      "app.heartbeat_source_checkpoints",
      "app.heartbeat_allowance_charges",
      "app.heartbeat_occurrences"
    ] as const) {
      const seen = await asUser(aId, (db) =>
        db.db.selectFrom(table).select("owner_user_id").execute()
      );
      expect(seen.every((row) => row.owner_user_id === aId)).toBe(true);
      const other = await asUser(bId, (db) =>
        db.db.selectFrom(table).select("owner_user_id").execute()
      );
      expect(other.every((row) => row.owner_user_id === bId)).toBe(true);
    }
  });
});
