import Fastify from "fastify";
import { sql } from "kysely";
import { registerScheduledTaskRoutes } from "../../packages/chat/src/reminders/routes.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AiRepository } from "@moss/ai";
import { DataContextChatPersistence } from "@moss/chat";
import { ids } from "./test-database.js";
import { app, boss, bootstrap, chat, tasks, owner, gateway } from "./scheduled-read-fixture.js";
import { boundedActionScope } from "../../packages/chat/src/responsibility-agreements/terms.js";
import {
  consumeResponsibilityProposal,
  pendingResponsibilityProposal
} from "../../packages/chat/src/responsibility-agreements/repository.js";
import { listApprovedActionScopes } from "../../packages/chat/src/responsibility-agreements/settings.js";
import { BOUNDED_ACTION_PROPOSAL_KIND } from "../../packages/chat/src/responsibility-agreements/prepare.js";
function persistence(available = true) {
  return new DataContextChatPersistence({
    dataContext: app,
    chatRepository: chat,
    aiRepository: new AiRepository(),
    boss,
    canProposeBoundedAction: async () => available
  });
}
async function propose(delayMs = 600_000) {
  const task = await owner((db) => tasks.create(db, { title: `Agreement ${randomUUID()}` }));
  const thread = await owner(
    async (db) =>
      (await chat.getMainThread(db, ids.userA)) ?? chat.openNewThread(db, { title: "Main" })
  );
  const scope = {
    operation: "tasks.updateStatus" as const,
    taskId: task.id,
    taskTitle: task.title,
    status: "done" as const,
    dueAt: new Date(Date.now() + delayMs).toISOString(),
    timeZone: "UTC",
    destinationThreadId: thread.id
  };
  const stored = await persistence().recordReminderTurn(
    ids.userA,
    `Mark task ${task.title} done in 10 minutes`,
    { kind: "scope_proposal", scope },
    { threadId: thread.id }
  );
  expect(
    stored &&
      stored !== "stopped" &&
      (stored.origin.kind === "reminder" ? stored.origin.event : null)
  ).toBe("scope_proposed");
  const pending = await owner((db) =>
    pendingResponsibilityProposal(db, thread.id, BOUNDED_ACTION_PROPOSAL_KIND, boundedActionScope)
  );
  expect(pending).toBeDefined();
  return { task, thread, scope, proposal: pending! };
}
async function acceptedCount(id: string) {
  const result = await bootstrap.query(
    "SELECT count(*) AS count FROM app.chat_responsibility_proposals WHERE id = $1 AND state = 'accepted'",
    [id]
  );
  return Number(result.rows[0].count);
}
describe("real persistence binds inert agreement once", () => {
  it("stores a real paired question, survives reload, accepts once, exposes scope and queues no action", async () => {
    const before = await bootstrap.query(
      "SELECT (SELECT count(*) FROM app.chat_reminders WHERE owner_user_id = $1) AS reminders, (SELECT count(*) FROM pgboss.job WHERE data->>'actorUserId' = $1::text AND name IN ('chat.deliver-reminder', 'chat.scheduled-read')) AS jobs",
      [ids.userA]
    );
    const saved = await propose();
    const reopened = persistence();
    const plan = await reopened.prepareResponsibilityAgreement(ids.userA, "yes", saved.thread.id);
    expect(plan?.kind).toBe("scope_agreement");
    const result = await reopened.recordReminderTurn(ids.userA, "yes", plan!, {
      threadId: saved.thread.id
    });
    expect(result && result !== "stopped" && result.reply).toContain("not active");
    expect(await acceptedCount(saved.proposal.id)).toBe(1);
    const scopes = await owner(listApprovedActionScopes);
    expect(scopes.find((scope) => scope.id === saved.proposal.id)).toMatchObject({
      state: "not_active",
      scope: saved.scope
    });
    const jobs = await bootstrap.query(
      "SELECT count(*) AS count FROM pgboss.job WHERE data->>'resourceId' = $1",
      [saved.proposal.id]
    );
    expect(Number(jobs.rows[0].count)).toBe(0);
    const reminder = await bootstrap.query(
      "SELECT count(*) AS count FROM app.chat_reminders WHERE id = $1",
      [saved.proposal.id]
    );
    expect(Number(reminder.rows[0].count)).toBe(0);
    const after = await bootstrap.query(
      "SELECT (SELECT count(*) FROM app.chat_reminders WHERE owner_user_id = $1) AS reminders, (SELECT count(*) FROM pgboss.job WHERE data->>'actorUserId' = $1::text AND name IN ('chat.deliver-reminder', 'chat.scheduled-read')) AS jobs",
      [ids.userA]
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
    await reopened.recordReminderTurn(ids.userA, "yes", plan!, { threadId: saved.thread.id });
    expect(await acceptedCount(saved.proposal.id)).toBe(1);
    expect(await owner((db) => tasks.getById(db, saved.task.id))).toMatchObject({ status: "todo" });
    expect(
      await gateway().runBackgroundReadForActor(ids.userA, {
        operation: saved.scope.operation,
        itemId: saved.task.id,
        runId: saved.proposal.id
      })
    ).toMatchObject({ ok: false });
  });
  it.each(["no", "yes but delete it", "sure"])("does not save acceptance for %j", async (text) => {
    const saved = await propose();
    const plan = await persistence().prepareResponsibilityAgreement(
      ids.userA,
      text,
      saved.thread.id
    );
    await persistence().recordReminderTurn(ids.userA, text, plan!, { threadId: saved.thread.id });
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("revalidates raw text and attachments before persistence", async () => {
    const saved = await propose();
    const plan = { kind: "scope_agreement" as const, proposal: saved.proposal, agree: true };
    await expect(
      persistence().recordReminderTurn(ids.userA, "yes but delete", plan, {
        threadId: saved.thread.id
      })
    ).rejects.toThrow("typed agreement");
    await expect(
      persistence().recordReminderTurn(ids.userA, "yes", plan, {
        threadId: saved.thread.id,
        attachments: [
          { id: randomUUID(), fileName: "outside.txt", mimeType: "text/plain", sizeBytes: 1 }
        ]
      })
    ).rejects.toThrow("typed agreement");
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("refuses changed version and revoked capability", async () => {
    const saved = await propose();
    const plan = {
      kind: "scope_agreement" as const,
      proposal: { ...saved.proposal, version: 2 },
      agree: true
    };
    await persistence().recordReminderTurn(ids.userA, "yes", plan, { threadId: saved.thread.id });
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
    const newer = await propose();
    await persistence(false).recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: newer.proposal, agree: true },
      { threadId: newer.thread.id }
    );
    expect(await acceptedCount(newer.proposal.id)).toBe(0);
  });
  it("an interrupted ordinary owner turn invalidates a proposal before completion", async () => {
    const saved = await propose();
    const turnId = randomUUID();
    await persistence().beginLiveTurn(ids.userA, {
      turnId,
      threadId: saved.thread.id,
      userText: "Actually change the scope"
    });
    expect(
      await owner((db) =>
        pendingResponsibilityProposal(
          db,
          saved.thread.id,
          BOUNDED_ACTION_PROPOSAL_KIND,
          boundedActionScope
        )
      )
    ).toBeUndefined();
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: saved.thread.id }
    );
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
    await persistence().storeInterruptedLiveTurn(ids.userA, saved.thread.id, turnId);
  });
  it("foreign owner and admin do not read another owner's scope", async () => {
    const saved = await propose();
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: saved.thread.id }
    );
    expect(await owner(listApprovedActionScopes)).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: saved.proposal.id })])
    );
    for (const actorUserId of [ids.userB, ids.adminUser]) {
      const direct = await app.withDataContext({ actorUserId }, (db) =>
        db.db
          .selectFrom("app.chat_responsibility_proposals")
          .selectAll()
          .where("id", "=", saved.proposal.id)
          .execute()
      );
      expect(direct).toHaveLength(0);
      const rows = await app.withDataContext({ actorUserId }, listApprovedActionScopes);
      expect(rows.some((scope) => scope.id === saved.proposal.id)).toBe(false);
    }
    const pending = await app.withDataContext({ actorUserId: ids.userB }, (db) =>
      pendingResponsibilityProposal(
        db,
        saved.thread.id,
        BOUNDED_ACTION_PROPOSAL_KIND,
        boundedActionScope
      )
    );
    expect(pending).toBeUndefined();
  });
  it("cannot reuse an old same-thread yes message to consume a new proposal", async () => {
    const first = await propose();
    const accepted = await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: first.proposal, agree: true },
      { threadId: first.thread.id }
    );
    if (!accepted || accepted === "stopped") throw new Error("acceptance missing");
    const newer = await propose();
    expect(
      await owner((db) =>
        consumeResponsibilityProposal(
          db,
          newer.thread.id,
          newer.proposal,
          boundedActionScope,
          accepted.userMessageId
        )
      )
    ).toBe(false);
    expect(await acceptedCount(newer.proposal.id)).toBe(0);
  });
  it.each(["\tyes\n", " yes! "])("aligns typed and database whitespace for %j", async (text) => {
    const saved = await propose();
    await persistence().recordReminderTurn(
      ids.userA,
      text,
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: saved.thread.id }
    );
    expect(await acceptedCount(saved.proposal.id)).toBe(1);
  });
  it.each(["id", "fingerprint"] as const)("rejects a replaced proposal %s", async (field) => {
    const saved = await propose();
    const changed = { ...saved.proposal, [field]: field === "id" ? randomUUID() : "b".repeat(64) };
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: changed, agree: true },
      { threadId: saved.thread.id }
    );
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("simultaneous acceptance creates only one accepted record", async () => {
    const saved = await propose();
    const plan = { kind: "scope_agreement" as const, proposal: saved.proposal, agree: true };
    await Promise.all([
      persistence().recordReminderTurn(ids.userA, "yes", plan, { threadId: saved.thread.id }),
      persistence().recordReminderTurn(ids.userA, "yes", plan, { threadId: saved.thread.id })
    ]);
    expect(await acceptedCount(saved.proposal.id)).toBe(1);
  });
  it("cross-thread acceptance cannot consume the question", async () => {
    const saved = await propose();
    const side = await owner((db) => chat.openNewThread(db, { title: "Other context" }));
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: side.id }
    );
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("actual loss of access to the source task defeats acceptance", async () => {
    const saved = await propose();
    // Supported source removal in the disposable isolated fixture. Runtime reads must see no task.
    await bootstrap.query("DELETE FROM app.tasks WHERE id = $1", [saved.task.id]);
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: saved.thread.id }
    );
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("app runtime cannot edit immutable scope or proposal version", async () => {
    const saved = await propose();
    await expect(
      owner((db) =>
        db.db
          .updateTable("app.chat_responsibility_proposals")
          .set({ terms_json: { ...saved.scope, status: "archived" } })
          .where("id", "=", saved.proposal.id)
          .execute()
      )
    ).rejects.toThrow();
    await expect(
      owner((db) =>
        db.db
          .updateTable("app.chat_responsibility_proposals")
          .set({ proposal_version: 2 })
          .where("id", "=", saved.proposal.id)
          .execute()
      )
    ).rejects.toThrow();
    expect(
      await owner((db) =>
        pendingResponsibilityProposal(
          db,
          saved.thread.id,
          BOUNDED_ACTION_PROPOSAL_KIND,
          boundedActionScope
        )
      )
    ).toMatchObject({ version: 1, terms: saved.scope });
  });
  it("atomic consumption refuses expiry after a transaction wait", async () => {
    const saved = await propose(2000);
    await owner(async (db) => {
      const yes = await chat.recordGateCompletedTurn(
        db,
        saved.thread.id,
        "yes",
        "not active",
        { version: 1, kind: "reminder", event: "scope_saved", reminderId: null },
        { turnId: randomUUID() }
      );
      if (!yes) throw new Error("owner yes missing");
      await sql`SELECT pg_sleep(2.1)`.execute(db.db);
      expect(
        await consumeResponsibilityProposal(
          db,
          saved.thread.id,
          saved.proposal,
          boundedActionScope,
          yes.userMessage.id
        )
      ).toBe(false);
    });
    expect(await acceptedCount(saved.proposal.id)).toBe(0);
  });
  it("Settings shows accepted scope but all scheduled controls reject its ID", async () => {
    const saved = await propose();
    await persistence().recordReminderTurn(
      ids.userA,
      "yes",
      { kind: "scope_agreement", proposal: saved.proposal, agree: true },
      { threadId: saved.thread.id }
    );
    const server = Fastify();
    registerScheduledTaskRoutes(server, {
      dataContext: app,
      boss,
      resolveAccessContext: async () => ({ actorUserId: ids.userA })
    });
    try {
      const list = await server.inject({ url: "/api/chat/scheduled-tasks" });
      expect(list.statusCode).toBe(200);
      expect(list.json().approvedScopes).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: saved.proposal.id, state: "not_active" })
        ])
      );
      for (const action of ["pause", "resume", "delete"] as const) {
        const response = await server.inject({
          method: action === "delete" ? "DELETE" : "POST",
          url: `/api/chat/scheduled-tasks/${saved.proposal.id}${action === "delete" ? "" : `/${action}`}`
        });
        expect(response.statusCode).toBe(404);
      }
      expect(await acceptedCount(saved.proposal.id)).toBe(1);
    } finally {
      await server.close();
    }
  });
});
