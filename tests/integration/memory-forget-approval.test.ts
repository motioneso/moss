import { randomUUID } from "node:crypto";

import { sql, type Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import {
  AiRepository,
  AssistantToolGateway,
  ConfirmationRegistry,
  SessionTokenRegistry,
  type GatewaySessionRecord,
  type GatewayToolResponse
} from "@moss/ai";
import {
  assertDataContextDb,
  createDatabase,
  DataContextRunner,
  type DataContextDb,
  type MossDatabase
} from "@moss/db";
import { MemoryForgetService, memoryModuleManifest } from "@moss/memory";
import type { MossModuleManifest } from "@moss/module-sdk";

import { appActionCatalog, appActionManifests } from "../fixtures/app-actions-gateway.js";
import { buildChatGatewayDependencies } from "../../packages/chat/src/gateway-services.js";
import { createCleanConversationFixture } from "./fixtures/clean-conversations.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const memory = new MemoryForgetService();
const consentKey = "memory.forget-test-consent";
const changedError =
  "The memory changed or is no longer available. Find it again and review a new request.";
let appDb: Kysely<MossDatabase>;
let concurrentDb: Kysely<MossDatabase>;
let runner: DataContextRunner;
let concurrentRunner: DataContextRunner;
const pending: Array<{
  harness: Awaited<ReturnType<typeof gatewayFor>>;
  call: Promise<GatewayToolResponse>;
}> = [];

beforeAll(async () => {
  await resetFoundationDatabase();
  // The gateway must release its only connection while waiting for a person's decision.
  appDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 1 });
  concurrentDb = createDatabase({ connectionString: connectionStrings.app, maxConnections: 2 });
  runner = new DataContextRunner(appDb);
  concurrentRunner = new DataContextRunner(concurrentDb);
});

afterEach(async () => {
  for (const { harness } of pending) {
    for (const record of harness.records) {
      if (
        record.kind === "action_request" &&
        harness.confirmations.isAwaiting(record.actionRequestId)
      ) {
        await harness.gateway.resolveActionRequest(
          harness.actor,
          record.actionRequestId,
          "rejected"
        );
      }
    }
  }
  await Promise.all(pending.splice(0).map(({ call }) => call));
});

afterAll(async () => {
  await Promise.all([appDb?.destroy(), concurrentDb?.destroy()]);
});

describe("memory.forget owner-bound approval through the production gateway", () => {
  it.each([false, true])(
    "generic app deletion uses the exact approved database version (changed=%s)",
    async (changed) => {
      const fact = await seedFact(ids.userA);
      const h = await gatewayFor(ids.userA, memoryModuleManifest, false, true);
      const { call, card } = await requestForget(h, fact.id, true);
      expect(card.details?.target).toBe(`Subject: prefers: ${fact.text}`);
      if (changed)
        await asActor(ids.userA, (db) =>
          sql`UPDATE app.memory_facts SET object_text = object_text WHERE id = ${fact.id}::uuid`.execute(
            db.db
          )
        );
      await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
      expect((await call).ok).toBe(!changed);
      if (changed) expect(await readFact(fact.id)).toBeDefined();
      else expect(await readFact(fact.id)).toBeUndefined();
      expect(await searchStatus(fact.id)).toBe(changed ? "active" : "inactive");
    }
  );

  it("shows the complete exact target, admits it before the card, and commits deletion with the search update on pool size one", async () => {
    const text = "Keep the complete memory text in the approval. ".repeat(80) + "FINAL DETAIL";
    const fact = await seedFact(ids.userA, text);
    const sameText = await seedFact(ids.userA, text);
    const foreign = await seedFact(ids.userB, text);
    const h = await gatewayFor(ids.userA);
    const { call, card } = await requestForget(h, fact.id);
    expect(card.details).toEqual({
      presentation: "human",
      approvalKind: "memory_delete",
      target: `Subject: prefers: ${text}`,
      fields: []
    });
    // Forgetting a memory always asks, so outside content is not the reason.
    expect(card.outsideContentNotice).toBe(false);
    expect(await h.provenance.isTainted(ids.userA, h.threadId)).toBe(true);
    // Both reads acquire the SAME one-connection pool while the approval is still pending.
    expect(await readFact(fact.id)).toMatchObject({ object_text: text });
    expect(await searchStatus(fact.id)).toBe("active");
    const persisted = await asActor(ids.userA, (db) =>
      new AiRepository().getAssistantAction(db, card.actionRequestId)
    );
    expect(persisted?.status).toBe("pending");
    expect(JSON.stringify(persisted)).not.toContain(text);
    expect(await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed")).toBe(
      "resolved"
    );
    expect(await call).toMatchObject({ ok: true, structuredData: { deleted: true } });
    expect(await readFact(fact.id)).toBeUndefined();
    expect(await searchStatus(fact.id)).toBe("inactive");
    expect(await readFact(sameText.id)).toBeDefined();
    expect(await searchStatus(sameText.id)).toBe("active");
    expect(await readFact(foreign.id, ids.userB)).toBeDefined();
    expect(await searchStatus(foreign.id, ids.userB)).toBe("active");
    expect(h.records).toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "executed" })
    );
  });

  it.each([ids.userB, ids.adminUser])(
    "refuses foreign targets for actor %s without exposing a card or creating an action",
    async (actor) => {
      const fact = await seedFact(ids.userA, "owner-private target");
      const h = await gatewayFor(actor);
      const before = await actionCount(actor);
      const foreign = await h.gateway.callTool(h.token, "memory.forget", { factId: fact.id });
      const missing = await h.gateway.callTool(h.token, "memory.forget", { factId: randomUUID() });
      expect(foreign).toEqual({ ok: false, denied: true, reason: "unknown_route" });
      expect(missing).toEqual(foreign);
      expect(h.records).toEqual([]);
      expect(await actionCount(actor)).toBe(before);
      expect(await h.provenance.isTainted(actor, h.threadId)).toBe(false);
      // Even an explicit owner argument cannot widen the runtime actor's RLS visibility.
      const ownedTarget = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
      expect(await asActor(actor, (db) => memory.target(db, ids.userA, fact.id))).toBeNull();
      expect(
        await asActor(actor, (db) =>
          memory.forgetApproved(db, ids.userA, fact.id, ownedTarget!.version)
        )
      ).toBe(false);
      expect(await readFact(fact.id)).toBeDefined();
      expect(await searchStatus(fact.id)).toBe("active");
    }
  );

  it.each([ids.userB, ids.adminUser])(
    "does not let actor %s approve another owner's pending deletion",
    async (actor) => {
      const fact = await seedFact(ids.userA);
      const h = await gatewayFor(ids.userA);
      const { call, card } = await requestForget(h, fact.id);
      expect(await h.gateway.resolveActionRequest(actor, card.actionRequestId, "confirmed")).toBe(
        "not_found"
      );
      expect(h.confirmations.isAwaiting(card.actionRequestId)).toBe(true);
      expect(await readFact(fact.id)).toBeDefined();
      await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "rejected");
      expect(await call).toMatchObject({ ok: false, denied: true });
      expect(await searchStatus(fact.id)).toBe("active");
    }
  );

  it.each([
    "text edit",
    "same-label subject replacement",
    "subject rename",
    "fact edit and restore",
    "entity edit and restore",
    "same-id fact replacement",
    "deleted target"
  ] as const)("refuses a %s while approval waits", async (change) => {
    const fact = await seedFact(ids.userA);
    const before = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
    const h = await gatewayFor(ids.userA);
    const { call, card } = await requestForget(h, fact.id);
    if (change === "text edit" || change === "fact edit and restore") {
      await asActor(ids.userA, (db) =>
        sql`UPDATE app.memory_facts SET object_text = 'changed private text' WHERE id = ${fact.id}::uuid`.execute(
          db.db
        )
      );
      if (change === "fact edit and restore") {
        await asActor(ids.userA, (db) =>
          sql`UPDATE app.memory_facts SET object_text = ${fact.text} WHERE id = ${fact.id}::uuid`.execute(
            db.db
          )
        );
      }
    } else if (change === "same-label subject replacement") {
      const replacement = await seedEntity(ids.userA, "Subject");
      await asActor(ids.userA, (db) =>
        sql`UPDATE app.memory_facts SET subject_entity_id = ${replacement}::uuid WHERE id = ${fact.id}::uuid`.execute(
          db.db
        )
      );
    } else if (change === "subject rename" || change === "entity edit and restore") {
      await asActor(ids.userA, (db) =>
        sql`UPDATE app.memory_entities SET name = 'renamed subject' WHERE id = ${fact.subjectId}::uuid`.execute(
          db.db
        )
      );
      if (change === "entity edit and restore") {
        await asActor(ids.userA, (db) =>
          sql`UPDATE app.memory_entities SET name = 'Subject' WHERE id = ${fact.subjectId}::uuid`.execute(
            db.db
          )
        );
      }
    } else {
      await asActor(ids.userA, (db) =>
        sql`DELETE FROM app.memory_facts WHERE id = ${fact.id}::uuid`.execute(db.db)
      );
      if (change === "same-id fact replacement") {
        await insertFact(fact.id, ids.userA, fact.subjectId, fact.text);
      }
    }
    const after = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
    if (
      [
        "same-label subject replacement",
        "fact edit and restore",
        "entity edit and restore",
        "same-id fact replacement"
      ].includes(change)
    ) {
      expect(after?.label).toBe(before?.label);
      expect(after?.version).not.toBe(before?.version);
    }
    await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    expect(await call).toEqual({ ok: false, error: changedError });
    expect(await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id))).toEqual(after);
    expect(await searchStatus(fact.id)).toBe("active");
    expect(h.records).toContainEqual(
      expect.objectContaining({ kind: "action_result", outcome: "error" })
    );
  });

  it.each(["rename", "same-label replacement"] as const)(
    "rejects object entity %s after the card was displayed",
    async (change) => {
      const fact = await seedFact(ids.userA, null);
      const h = await gatewayFor(ids.userA);
      const { call, card } = await requestForget(h, fact.id);
      expect(card.details?.target).toBe(`Subject: prefers: Object`);
      if (change === "rename") {
        await asActor(ids.userA, (db) =>
          sql`UPDATE app.memory_entities SET name = 'new object name' WHERE id = ${fact.objectId}::uuid`.execute(
            db.db
          )
        );
      } else {
        const replacement = await seedEntity(ids.userA, "Object");
        await asActor(ids.userA, (db) =>
          sql`UPDATE app.memory_facts SET object_entity_id = ${replacement}::uuid WHERE id = ${fact.id}::uuid`.execute(
            db.db
          )
        );
      }
      await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
      expect(await call).toEqual({ ok: false, error: changedError });
      expect(await readFact(fact.id)).toBeDefined();
      expect(await searchStatus(fact.id)).toBe("active");
    }
  );

  it("rechecks module availability when the owner approves", async () => {
    const fact = await seedFact(ids.userA);
    const h = await gatewayFor(ids.userA);
    const { call, card } = await requestForget(h, fact.id);
    h.modules.splice(0);
    await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    expect(await call).toEqual({ ok: false, error: changedError });
    expect(await readFact(fact.id)).toBeDefined();
    expect(await searchStatus(fact.id)).toBe("active");
  });

  it("rechecks stored module consent after approval and refuses consent-off requests before a card", async () => {
    const fact = await seedFact(ids.userA);
    await setConsent(true);
    const h = await gatewayFor(ids.userA, consentManifest());
    const { call, card } = await requestForget(h, fact.id);
    await setConsent(false);
    await h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
    expect(await call).toEqual({
      ok: false,
      error: "Memory AI consent is off. Review it in Settings before requesting this action again."
    });
    expect(await readFact(fact.id)).toBeDefined();
    expect(await searchStatus(fact.id)).toBe("active");
    const before = await actionCount(ids.userA);
    const fresh = await gatewayFor(ids.userA, consentManifest());
    expect(await fresh.gateway.callTool(fresh.token, "memory.forget", { factId: fact.id })).toEqual(
      { ok: false, denied: true, reason: "consent_off" }
    );
    expect(fresh.records).toEqual([]);
    expect(await actionCount(ids.userA)).toBe(before);
    expect(await fresh.provenance.isTainted(ids.userA, fresh.threadId)).toBe(false);
  });

  it("fails before the pending row and target card if outside-content admission fails", async () => {
    const fact = await seedFact(ids.userA);
    const h = await gatewayFor(ids.userA, memoryModuleManifest, true);
    const before = await actionCount(ids.userA);
    expect(await h.gateway.callTool(h.token, "memory.forget", { factId: fact.id })).toMatchObject({
      ok: false
    });
    expect(h.records).toEqual([]);
    expect(await actionCount(ids.userA)).toBe(before);
    expect(await readFact(fact.id)).toBeDefined();
    expect(await searchStatus(fact.id)).toBe("active");
  });
});

describe("memory deletion transaction and concurrent claim", () => {
  it.each(["active", "stale", "conflicting", "superseded", "expired", "rejected"] as const)(
    "deletes an unchanged owned %s fact and deactivates its search document",
    async (status) => {
      const fact = await seedFact(ids.userA);
      await asActor(ids.userA, (db) =>
        sql`UPDATE app.memory_facts SET status = ${status} WHERE id = ${fact.id}::uuid`.execute(
          db.db
        )
      );
      const target = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
      expect(target).not.toBeNull();
      expect(
        await asActor(ids.userA, (db) =>
          memory.forgetApproved(db, ids.userA, fact.id, target!.version)
        )
      ).toBe(true);
      expect(await readFact(fact.id)).toBeUndefined();
      expect(await searchStatus(fact.id)).toBe("inactive");
    }
  );

  it("rolls back both the fact deletion and the search deactivation if the actor transaction fails", async () => {
    const fact = await seedFact(ids.userA);
    const target = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
    await expect(
      asActor(ids.userA, async (db) => {
        expect(await memory.forgetApproved(db, ids.userA, fact.id, target!.version)).toBe(true);
        expect(
          (await sql`SELECT id FROM app.memory_facts WHERE id = ${fact.id}::uuid`.execute(db.db))
            .rows
        ).toEqual([]);
        expect(
          (
            await sql<{
              status: string;
            }>`SELECT status FROM app.memory_search_documents WHERE target_id = ${fact.id}::uuid`.execute(
              db.db
            )
          ).rows
        ).toEqual([{ status: "inactive" }]);
        throw new Error("rollback the approved deletion");
      })
    ).rejects.toThrow("rollback the approved deletion");
    expect(await readFact(fact.id)).toMatchObject({ object_text: fact.text });
    expect(await searchStatus(fact.id)).toBe("active");
  });

  it("rolls back immediately when a competing deletion holds the search document", async () => {
    const fact = await seedFact(ids.userA);
    const h = await gatewayFor(ids.userA);
    const { call, card } = await requestForget(h, fact.id);
    const locked = deferred<void>();
    const release = deferred<void>();
    const rival = concurrentRunner.withDataContext({ actorUserId: ids.userA }, async (db) => {
      await sql`SELECT id FROM app.memory_search_documents WHERE target_id = ${fact.id}::uuid FOR UPDATE`.execute(
        db.db
      );
      locked.resolve();
      await release.promise;
    });
    let resolution: Promise<unknown> | undefined;
    try {
      await locked.promise;
      resolution = h.gateway.resolveActionRequest(ids.userA, card.actionRequestId, "confirmed");
      let outcome: GatewayToolResponse | undefined;
      void call.then((value) => {
        outcome = value;
      });
      // The rival keeps its lock until after this assertion: waiting on it would fail the test.
      await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 5_000 });
      expect(outcome).toEqual({
        ok: false,
        error: "Memory deletion is not ready. Start a new chat and try again."
      });
      expect(await readFact(fact.id)).toMatchObject({ object_text: fact.text });
      expect(await searchStatus(fact.id)).toBe("active");
    } finally {
      release.resolve();
      await Promise.allSettled([rival, ...(resolution ? [resolution] : [])]);
    }
  });

  it("rejects a concurrent fact edit committed after the final target lookup without changing its search document", async () => {
    const fact = await seedFact(ids.userA);
    const target = await asActor(ids.userA, (db) => memory.target(db, ids.userA, fact.id));
    const locked = deferred<number>();
    const release = deferred<void>();
    const deletingPid = deferred<number>();
    const rival = concurrentRunner.withDataContext({ actorUserId: ids.userA }, async (db) => {
      await sql`SELECT id FROM app.memory_facts WHERE id = ${fact.id}::uuid FOR UPDATE`.execute(
        db.db
      );
      const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db.db);
      locked.resolve(pid.rows[0]!.pid);
      await release.promise;
      await sql`UPDATE app.memory_facts SET object_text = 'concurrent replacement text' WHERE id = ${fact.id}::uuid`.execute(
        db.db
      );
    });
    let deletion: Promise<boolean> | undefined;
    try {
      const rivalPid = await locked.promise;
      deletion = asActor(ids.userA, async (db) => {
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(db.db);
        deletingPid.resolve(pid.rows[0]!.pid);
        return memory.forgetApproved(db, ids.userA, fact.id, target!.version);
      });
      const pid = await deletingPid.promise;
      // Wait for PostgreSQL's lock graph, not elapsed time: the real DELETE has
      // completed both target lookups and is blocked behind the rival row lock.
      await vi.waitFor(
        async () => {
          const blocked = await concurrentRunner.withDataContext({ actorUserId: ids.userA }, (db) =>
            sql<{
              query: string;
              blockers: number[];
            }>`SELECT query, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = ${pid}`.execute(
              db.db
            )
          );
          expect(blocked.rows[0]?.query).toMatch(/DELETE FROM app\.memory_facts/);
          expect(blocked.rows[0]?.blockers).toContain(rivalPid);
        },
        { timeout: 5_000 }
      );
      release.resolve();
      await rival;
      expect(await deletion).toBe(false);
    } finally {
      release.resolve();
      await Promise.allSettled([rival, ...(deletion ? [deletion] : [])]);
    }
    expect(await readFact(fact.id)).toMatchObject({ object_text: "concurrent replacement text" });
    expect(await searchStatus(fact.id)).toBe("active");
  });
});

function asActor<T>(actor: string, work: (db: DataContextDb) => Promise<T>): Promise<T> {
  return runner.withDataContext({ actorUserId: actor }, work);
}

async function seedEntity(owner: string, name: string): Promise<string> {
  const id = randomUUID();
  await asActor(owner, (db) =>
    sql`INSERT INTO app.memory_entities (id, owner_user_id, kind, name) VALUES (${id}::uuid, ${owner}::uuid, 'person', ${name})`.execute(
      db.db
    )
  );
  return id;
}

async function insertFact(
  id: string,
  owner: string,
  subjectId: string,
  text: string | null,
  objectId: string | null = null
) {
  await asActor(owner, (db) =>
    sql`INSERT INTO app.memory_facts (id, owner_user_id, subject_entity_id, predicate, object_text, object_entity_id) VALUES (${id}::uuid, ${owner}::uuid, ${subjectId}::uuid, 'prefers', ${text}, ${objectId}::uuid)`.execute(
      db.db
    )
  );
}

async function seedFact(owner: string, text: string | null = "full original memory") {
  const id = randomUUID();
  const subjectId = await seedEntity(owner, "Subject");
  const objectId = text === null ? await seedEntity(owner, "Object") : null;
  await insertFact(id, owner, subjectId, text, objectId);
  await asActor(owner, (db) =>
    sql`INSERT INTO app.memory_search_documents (owner_user_id, target_kind, target_id, search_text) VALUES (${owner}::uuid, 'fact', ${id}::uuid, ${text ?? "Object"})`.execute(
      db.db
    )
  );
  return { id, subjectId, objectId, text };
}

async function readFact(id: string, owner: string = ids.userA) {
  return asActor(
    owner,
    async (db) =>
      (
        await sql<{
          object_text: string | null;
        }>`SELECT object_text FROM app.memory_facts WHERE id = ${id}::uuid`.execute(db.db)
      ).rows[0]
  );
}

async function searchStatus(id: string, owner: string = ids.userA) {
  return asActor(
    owner,
    async (db) =>
      (
        await sql<{
          status: string;
        }>`SELECT status FROM app.memory_search_documents WHERE target_kind = 'fact' AND target_id = ${id}::uuid`.execute(
          db.db
        )
      ).rows[0]?.status
  );
}

async function actionCount(actor: string) {
  return asActor(
    actor,
    async (db) =>
      (
        await sql<{
          count: number;
        }>`SELECT count(*)::integer AS count FROM app.ai_assistant_action_requests`.execute(db.db)
      ).rows[0]!.count
  );
}

async function gatewayFor(
  actor: string,
  manifest = memoryModuleManifest,
  rejectAdmission = false,
  generic = false
) {
  const conversations = await createCleanConversationFixture(runner, [actor]);
  const tokens = new SessionTokenRegistry();
  const confirmations = new ConfirmationRegistry();
  const records: GatewaySessionRecord[] = [];
  const modules: MossModuleManifest[] = [
    manifest,
    ...(generic ? appActionManifests.filter((m) => m.id === "settings") : [])
  ];
  const provenance = conversations.gatewayDependencies.provenance;
  const binding = conversations.bindingFor(actor);
  const deps = buildChatGatewayDependencies({
    runner,
    repository: new AiRepository(),
    tokens,
    confirmations,
    resolveActiveModules: async () => modules,
    conversationProvenance: rejectAdmission
      ? {
          isTainted: provenance.isTainted.bind(provenance),
          recordAdmission: async () => {
            throw new Error("admission unavailable");
          }
        }
      : provenance,
    notifier: { emit: (_sessionId, record) => records.push(record) },
    ...(generic
      ? {
          appActions: {
            catalog: () => appActionCatalog,
            call: async () => {
              throw new Error("Unversioned DELETE must never run");
            }
          }
        }
      : {}),
    collaborators: {}
  });
  const gateway = new AssistantToolGateway({ ...deps, confirmTimeoutMs: 15_000 });
  const token = tokens.mint({ ...binding, chatSessionId: randomUUID(), allowedToolNames: null });
  return {
    gateway,
    token,
    confirmations,
    records,
    actor,
    modules,
    provenance,
    threadId: binding.threadId
  };
}

async function requestForget(
  harness: Awaited<ReturnType<typeof gatewayFor>>,
  factId: string,
  generic = false
) {
  const call = generic
    ? harness.gateway.callTool(harness.token, "app.callAction", {
        method: "DELETE",
        path: `/api/memory/graph/facts/${factId}`
      })
    : harness.gateway.callTool(harness.token, "memory.forget", { factId });
  pending.push({ harness, call });
  await vi.waitFor(
    () => expect(harness.records.some((record) => record.kind === "action_request")).toBe(true),
    { timeout: 5_000 }
  );
  const card = harness.records.find((record) => record.kind === "action_request");
  if (!card || card.kind !== "action_request") throw new Error("Expected an approval card");
  return { call, card };
}

function consentManifest(): MossModuleManifest {
  return {
    ...memoryModuleManifest,
    aiConsent: {
      key: consentKey,
      async isGranted(db) {
        assertDataContextDb(db);
        const result = await sql<{
          granted: boolean;
        }>`SELECT value_json = 'true'::jsonb AS granted FROM app.preferences WHERE key = ${consentKey}`.execute(
          db.db
        );
        return result.rows[0]?.granted === true;
      }
    }
  };
}

async function setConsent(granted: boolean) {
  await asActor(ids.userA, (db) =>
    sql`INSERT INTO app.preferences (owner_user_id, key, value_json) VALUES (${ids.userA}::uuid, ${consentKey}, ${JSON.stringify(granted)}::jsonb) ON CONFLICT (owner_user_id, key) DO UPDATE SET value_json = EXCLUDED.value_json`.execute(
      db.db
    )
  );
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
