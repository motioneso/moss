import Fastify from "fastify";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "kysely";
import { createPgBossClient } from "@moss/jobs";
import { MeetingDeletionService, registerMeetingRecordRoutes } from "@moss/meetings";
import {
  createManagedDeletionPreparation,
  createMeetingDeletionPort,
  getBuiltInModuleManifests
} from "@moss/module-registry";
import { RecordingContributionService } from "@moss/notes";
import { MemoryForgetService } from "@moss/memory";
import { RecordingContributionRepository } from "../../packages/notes/src/contribution-repository.js";
import { VaultContextRunner } from "@moss/vault";
import { PreferencesRepository } from "@moss/structured-state";
import { NOTES_SOURCE_PREFERENCE_KEY, registerSettingsRoutes } from "@moss/settings";
import { DELETE_MY_ACCOUNT_PHRASE } from "@moss/shared";
import { createDatabase, DataContextRunner } from "@moss/db";
import { deleteUserData, ManagedDeletionError } from "../../scripts/delete-user-data.js";
import { useRecordingMemoryFixture } from "./recording-memory-test-support.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const fixture = useRecordingMemoryFixture();
let boss: ReturnType<typeof createPgBossClient>;
let workspace: string;
let linked: string;
let privateVault: VaultContextRunner;
beforeEach(async () => {
  await resetFoundationDatabase();
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  workspace = await mkdtemp(join(tmpdir(), "recording-cleanup-"));
  linked = join(workspace, "linked");
  await mkdir(linked);
  privateVault = new VaultContextRunner(join(workspace, "private"));
  vi.stubEnv("MOSS_VAULT_ROOT", join(workspace, "private"));
  vi.stubEnv("JARVIS_VAULT_ROOT", join(workspace, "private"));
  vi.stubEnv("MOSS_NOTES_ROOTS", linked);
  vi.stubEnv("JARVIS_NOTES_ROOTS", linked);
});
afterEach(async () => {
  vi.restoreAllMocks();
  await boss?.stop({ graceful: false });
  vi.unstubAllEnvs();
  await rm(workspace, { force: true, recursive: true });
});

async function setup(role: "app" | "worker" = "app") {
  const state = await fixture.setup(role);
  const notes = new RecordingContributionService({
    runner: state.runner,
    lifecycle: state.lifecycle,
    privateVault,
    authority: {
      async readCurrent(db, source) {
        const metadata = await fixture.metadata.get(db, source.sourceId);
        if (!metadata?.side || !metadata.outputVersion) throw new Error("Missing synthetic source");
        return { sourceVersion: metadata.outputVersion, side: metadata.side };
      }
    },
    index: { async invalidateScoped() {}, async enqueueScoped() {} }
  });
  const appRunner = new DataContextRunner(fixture.appDb);
  const appDeletion = new MeetingDeletionService({
    dataContext: appRunner,
    cleanup: createMeetingDeletionPort({ dataContext: appRunner, privateVault, boss }),
    async beforeRemove() {}
  });
  // Workers can clean managed contributions, but only the app role may DELETE meeting rows.
  const workerCleanup = createMeetingDeletionPort({
    dataContext: state.runner,
    privateVault,
    boss
  });
  const deletion =
    role === "app"
      ? appDeletion
      : {
          async remove(access: typeof state.owner, id: string) {
            expect(await workerCleanup.withCleanSource(access, id, async () => {})).toBe(
              "complete"
            );
            await appDeletion.remove(access, id);
          }
        };
  async function note(
    source: Awaited<ReturnType<typeof state.create>>,
    text = "Synthetic source text",
    path?: string
  ) {
    const candidate = path
      ? (await notes.inventory(state.owner)).candidates.find((row) => row.displayPath === path)!
      : null;
    const review = await notes.prepare(state.owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text,
      destination: candidate
        ? { kind: "candidate", candidateId: candidate.id, candidateRevision: candidate.revision }
        : { kind: "fallback" }
    });
    return (await notes.apply(state.owner, { proposalId: review.id, acceptBinding: true })).receipt;
  }
  async function fact(
    source: Awaited<ReturnType<typeof state.create>>,
    text = "Synthetic durable memory"
  ) {
    const review = await state.service.prepare(state.owner, {
      kind: "apply",
      requestId: randomUUID(),
      source,
      text
    });
    const receipt = (await state.service.apply(state.owner, { proposalId: review.id })).receipt;
    const episodeId = await state.runner.withDataContext(state.owner, async (db) => {
      const result = await sql<{
        episode_id: string;
      }>`select episode_id from app.memory_recording_receipts where receipt_id = ${receipt.id}`.execute(
        db.db
      );
      return result.rows[0]!.episode_id;
    });
    return { ...receipt, episodeId };
  }
  return { ...state, notes, deletion, note, fact };
}

async function retained() {
  // Sessions are auth-private; inspect fixture retention using the test bootstrap connection.
  const db = createDatabase({ connectionString: connectionStrings.bootstrap });
  try {
    const rows = await sql<{ users: number; sessions: number }>`select
      (select count(*)::int from app.users where id = ${ids.userA}::uuid) as users,
      (select count(*)::int from app.auth_sessions where user_id = ${ids.userA}::uuid) as sessions`.execute(
      db
    );
    return rows.rows[0];
  } finally {
    await db.destroy();
  }
}

describe("recording managed deletion", () => {
  it.each(["app", "worker"] as const)(
    "removes exact linked blocks and unsupported fact derivatives through %s",
    async (role) => {
      const state = await setup(role);
      const source = await state.create();
      await writeFile(join(linked, "topic.md"), "Unrelated opening\n");
      await state.runner.withDataContext(state.owner, (db) =>
        new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
      );
      const receipt = await state.note(source, "Source note text", "topic.md");
      const memory = await state.fact(source);
      const before = await readFile(join(linked, "topic.md"), "utf8");
      await writeFile(join(linked, "topic.md"), before + "Unrelated later edit\n");
      await state.deletion.remove(state.owner, source.sourceId);
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(
        "Unrelated opening\nUnrelated later edit\n"
      );
      await state.deletion.remove(state.owner, source.sourceId);
      await state.runner.withDataContext(state.owner, async (db) => {
        expect(await fixture.records.get(db, source.sourceId)).toBeNull();
        const data = await sql<{
          facts: number;
          documents: number;
          receipts: number;
          state: string;
        }>`select
        (select count(*)::int from app.memory_facts where id = ${memory.fact!.id}::uuid) as facts,
        (select count(*)::int from app.memory_search_documents where target_id in (${memory.fact!.id}::uuid, ${memory.episodeId}::uuid)) as documents,
        (select count(*)::int from app.notes_recording_contributions where receipt_id = ${receipt.id}) as receipts,
        (select state from app.memory_recording_fact_versions where fact_id = ${memory.fact!.id}::uuid) as state`.execute(
          db.db
        );
        expect(data.rows[0]).toEqual({ facts: 0, documents: 0, receipts: 0, state: "forgotten" });
      });
    }
  );

  it("retains changed blocks, source and sessions, then resumes exact removal after owner repair", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "User text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    await state.note(source, "Original contribution", "topic.md");
    const original = await readFile(join(linked, "topic.md"), "utf8");
    const changed = original.replace("Original contribution", "Owner changed this block");
    await writeFile(join(linked, "topic.md"), changed);
    await expect(state.deletion.remove(state.owner, source.sourceId)).rejects.toMatchObject({
      code: "meeting_cleanup_conflict"
    });
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(changed);
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
    await expect(state.fact(source)).rejects.toThrow();
    // Repair the exact source block; keep a new unrelated edit while retrying the explicit delete.
    await writeFile(join(linked, "topic.md"), original + "Later user text\n");
    await state.deletion.remove(state.owner, source.sourceId);
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe("User text\nLater user text\n");
  });

  it("does not fence or remove another owner's source", async () => {
    const state = await setup();
    const source = await state.create();
    await state.fact(source);
    await state.deletion.remove({ actorUserId: ids.userB }, source.sourceId);
    expect(
      await state.runner.withDataContext(state.owner, (db) =>
        fixture.records.get(db, source.sourceId)
      )
    ).not.toBeNull();
    expect((await state.service.inspect(state.owner, source))!.state).toBe("applied");
  });

  it("fails closed without account cleanup injection and retains session state", async () => {
    const state = await setup();
    await state.fact(await state.create());
    await expect(
      deleteUserData({
        userId: ids.userA,
        confirmUserId: ids.userA,
        dryRun: false,
        bootstrapConnectionString: connectionStrings.bootstrap
      })
    ).rejects.toBeInstanceOf(ManagedDeletionError);
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
  });

  it("returns stable cleanup conflicts through record DELETE and removes only after an explicit repaired retry", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "Owner text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    await state.note(source, "Reviewed source note", "topic.md");
    const original = await readFile(join(linked, "topic.md"), "utf8");
    const changed = original.replace("Reviewed source note", "Owner's changed private text");
    await writeFile(join(linked, "topic.md"), changed);
    const server = Fastify();
    registerMeetingRecordRoutes(server, {
      resolveAccessContext: async () => state.owner,
      dataContext: state.runner,
      deletion: state.deletion
    });
    try {
      const conflict = await server.inject({
        method: "DELETE",
        url: `/api/meetings/records/${source.sourceId}`
      });
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "meeting_cleanup_conflict" });
      expect(conflict.body).not.toContain("Owner's changed private text");
      expect(conflict.body).not.toContain(linked);
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(changed);
      await writeFile(join(linked, "topic.md"), original + "Later user text\n");
      const removed = await server.inject({
        method: "DELETE",
        url: `/api/meetings/records/${source.sourceId}`
      });
      expect(removed.statusCode).toBe(204);
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(
        "Owner text\nLater user text\n"
      );
      expect(
        (await server.inject({ method: "DELETE", url: `/api/meetings/records/${source.sourceId}` }))
          .statusCode
      ).toBe(204);
      expect(await retained()).toEqual({ users: 1, sessions: 1 });
    } finally {
      await server.close();
    }
  });

  it("keeps bounded account progress and requires a new explicitly confirmed deletion request", async () => {
    const state = await setup();
    for (let recording = 0; recording < 2; recording++) {
      const source = await state.create();
      for (let item = 0; item < (recording ? 1 : 20); item++) {
        await state.note({ ...source, itemKey: `item-${item}` });
      }
    }
    const prepareManagedDeletion = createManagedDeletionPreparation({
      dataContext: state.runner,
      privateVault
    });
    const options = {
      userId: ids.userA,
      confirmUserId: ids.userA,
      dryRun: false,
      bootstrapConnectionString: connectionStrings.bootstrap,
      prepareManagedDeletion
    };
    await expect(deleteUserData(options)).rejects.toMatchObject({
      code: "managed_cleanup_pending"
    });
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
    await expect(deleteUserData({ ...options, confirmUserId: undefined })).rejects.toThrow(
      "Confirmation"
    );
    const result = await deleteUserData(options);
    expect(result.deleted).toBe(true);
  });
  it.each(["app", "worker"] as const)(
    "retains another source's corrected fact and removes the deleted admission dependency under %s",
    async (role) => {
      const state = await setup(role);
      const first = await state.create();
      const second = await state.create();
      const original = [await state.fact(first), await state.fact(second)];
      const factIds = original.map((receipt) => receipt.fact!.id);
      await state.runner.withDataContext(state.owner, (db) =>
        state.graph.withFactMutation(db, ids.userA, factIds, async () => {
          const group = randomUUID();
          await sql`insert into app.memory_conflict_groups(id,owner_user_id) values (${group}::uuid,${ids.userA}::uuid)`.execute(
            db.db
          );
          await sql`update app.memory_facts set conflict_group_id = ${group}::uuid,status = 'conflicting'
        where owner_user_id = ${ids.userA}::uuid and id = any(${factIds}::uuid[])`.execute(db.db);
        })
      );
      const corrected = await state.runner.withDataContext(state.owner, (db) =>
        state.graph.correctFact(db, ids.userA, {
          targetFactId: factIds[0]!,
          replacementText: "Owner correction survives removal of just one source"
        })
      );
      expect(corrected!.sources).toHaveLength(2);
      await state.deletion.remove(state.owner, first.sourceId);
      const surviving = (await state.service.inspect(state.owner, second))!;
      expect(surviving.fact!.id).toBe(corrected!.id);
      expect(surviving.fact!.text).toBe("Owner correction survives removal of just one source");
      expect(surviving.state).toBe("applied");
      // A dead source receipt must not fence ordinary owner mutations of the surviving fact.
      expect(
        await state.runner.withDataContext(state.owner, (db) =>
          state.graph.pinFact(db, ids.userA, corrected!.id, true)
        )
      ).toBe(true);
      await state.runner.withDataContext(state.owner, async (db) => {
        expect(
          (
            await sql`select receipt_id from app.memory_recording_receipts where source_id = ${first.sourceId}::uuid`.execute(
              db.db
            )
          ).rows
        ).toEqual([]);
        const sources = await sql<{
          count: number;
        }>`select count(*)::int as count from app.memory_fact_sources where fact_id = ${corrected!.id}::uuid`.execute(
          db.db
        );
        expect(sources.rows[0]!.count).toBe(1);
      });
    }
  );

  it("removes forgotten episodes while preserving durable retirement and refusing a paused proposal", async () => {
    const state = await setup();
    const source = await state.create();
    const receipt = await state.fact(source);
    const paused = await state.service.prepare(state.owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: receipt.id,
      expectedRevision: receipt.revision,
      expectedFactRevision: receipt.fact!.revision,
      text: "Paused old publication"
    });
    await state.runner.withDataContext(state.owner, async (db) => {
      const forget = new MemoryForgetService(state.graph);
      const target = await forget.target(db, ids.userA, receipt.fact!.id);
      expect(await forget.forgetApproved(db, ids.userA, receipt.fact!.id, target!.version)).toBe(
        true
      );
    });
    await state.deletion.remove(state.owner, source.sourceId);
    await expect(state.service.apply(state.owner, { proposalId: paused.id })).rejects.toThrow();
    await state.runner.withDataContext(state.owner, async (db) => {
      expect(
        (
          await sql`select id from app.memory_episodes where id = ${receipt.episodeId}::uuid`.execute(
            db.db
          )
        ).rows
      ).toEqual([]);
      expect(
        (
          await sql<{
            state: string;
          }>`select state from app.memory_recording_fact_versions where fact_id = ${receipt.fact!.id}::uuid`.execute(
            db.db
          )
        ).rows
      ).toEqual([{ state: "forgotten" }]);
      expect(
        (
          await sql`select id from app.memory_search_documents where target_id in (${receipt.fact!.id}::uuid,${receipt.episodeId}::uuid)`.execute(
            db.db
          )
        ).rows
      ).toEqual([]);
    });
  });

  it("recovers a committed filesystem removal after receipt persistence failed", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "Owner text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    await state.note(source, "Contribution before interrupted cleanup", "topic.md");
    const failReceipt = vi
      .spyOn(RecordingContributionRepository.prototype, "updateReceipt")
      .mockRejectedValueOnce(new Error("Synthetic receipt persistence failure"));
    try {
      await expect(state.deletion.remove(state.owner, source.sourceId)).rejects.toThrow(
        "Synthetic receipt persistence failure"
      );
    } finally {
      failReceipt.mockRestore();
    }
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe("Owner text\n");
    await writeFile(join(linked, "topic.md"), "Owner text\nNew unrelated edit\n");
    await state.deletion.remove(state.owner, source.sourceId);
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(
      "Owner text\nNew unrelated edit\n"
    );
    expect(
      await state.runner.withDataContext(state.owner, (db) =>
        fixture.records.get(db, source.sourceId)
      )
    ).toBeNull();
  });

  it("lets account cleanup supersede an already fenced source without permitting its old cleanup capability", async () => {
    const state = await setup();
    const source = await state.create();
    await state.note(source);
    await state.fact(source);
    const old = await state.lifecycle.fenceSource(state.owner, {
      ownerUserId: ids.userA,
      sourceModuleId: "meetings",
      sourceId: source.sourceId
    });
    const prepare = createManagedDeletionPreparation({ dataContext: state.runner, privateVault });
    const completed = await prepare({ userId: ids.userA, requestId: randomUUID() });
    expect(completed.status).toBe("complete");
    await expect(state.lifecycle.withCleanup(state.owner, old, async () => {})).rejects.toThrow();
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
    const result = await deleteUserData({
      userId: ids.userA,
      confirmUserId: ids.userA,
      dryRun: false,
      bootstrapConnectionString: connectionStrings.bootstrap,
      prepareManagedDeletion: prepare
    });
    expect(result.deleted).toBe(true);
  });

  it.each(["self", "admin", "reject"] as const)(
    "keeps stable private cleanup outcomes and sessions through the %s entrypoint",
    async (entry) => {
      const state = await setup();
      const source = await state.create();
      await state.fact(source, "Private synthetic memory never returned to an administrator");
      await writeFile(join(linked, "topic.md"), "Owner note\n");
      await state.runner.withDataContext(state.owner, (db) =>
        new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
      );
      await state.note(source, "Private synthetic contribution", "topic.md");
      if (entry === "reject") {
        const db = createDatabase({ connectionString: connectionStrings.bootstrap });
        try {
          await sql`update app.users set status = 'pending' where id = ${ids.userA}::uuid`.execute(
            db
          );
        } finally {
          await db.destroy();
        }
      }
      const before = await readFile(join(linked, "topic.md"), "utf8");
      const verifySelfPassword = vi.fn(
        async (input: { password: string }) => input.password === "fresh-confirmation"
      );
      const realPrepare = createManagedDeletionPreparation({
        dataContext: state.runner,
        privateVault
      });
      async function call(
        prepareManagedDeletion?: typeof realPrepare,
        password = "fresh-confirmation"
      ) {
        const server = Fastify();
        registerSettingsRoutes(server, {
          rootDb: fixture.appDb,
          listModuleManifests: getBuiltInModuleManifests,
          dataContext: state.runner,
          resolveAccessContext: async () => ({
            actorUserId: entry === "self" ? ids.userA : ids.adminUser,
            requestId: randomUUID()
          }),
          bootstrapConnectionString: connectionStrings.bootstrap,
          moduleDeletionTables: [],
          hasPasswordCredential: async () => true,
          verifySelfPassword,
          prepareManagedDeletion
        });
        try {
          return await server.inject(
            entry === "self"
              ? {
                  method: "DELETE",
                  url: "/api/me/account",
                  payload: {
                    confirmEmail: "user-a@example.test",
                    confirmPhrase: DELETE_MY_ACCOUNT_PHRASE,
                    password
                  }
                }
              : {
                  method: entry === "reject" ? "POST" : "DELETE",
                  url: `/api/admin/users/${ids.userA}${entry === "reject" ? "/reject" : ""}`
                }
          );
        } finally {
          await server.close();
        }
      }
      const missing = await call();
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({ code: "managed_cleanup_pending" });
      expect(await retained()).toEqual({ users: 1, sessions: 1 });
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(before);
      const conflict = await call(async () => ({ status: "conflict" }));
      expect(conflict.statusCode).toBe(409);
      expect(conflict.json()).toMatchObject({ code: "managed_cleanup_conflict" });
      expect(conflict.body).not.toContain("Private synthetic");
      expect(conflict.body).not.toContain(linked);
      if (entry === "self") {
        const refused = await call(realPrepare, "wrong-new-confirmation");
        expect(refused.statusCode).toBe(400);
        expect(await retained()).toEqual({ users: 1, sessions: 1 });
      }
      const deleted = await call(realPrepare);
      expect(deleted.statusCode).toBe(200);
      expect(deleted.json()).toEqual(
        entry === "reject" ? { rejectedUserId: ids.userA } : { deletedUserId: ids.userA }
      );
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe("Owner note\n");
      expect(await retained()).toEqual({ users: 0, sessions: 0 });
      if (entry === "self") expect(verifySelfPassword).toHaveBeenCalledTimes(4);
    }
  );

  it("cleans both exact legs of an interrupted move and never replays its cancelled publication", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "before.md"), "Old destination user text\n");
    await writeFile(join(linked, "after.md"), "New destination user text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    const first = await state.note(source, "Initial contribution", "before.md");
    const candidate = (await state.notes.inventory(state.owner)).candidates.find(
      (row) => row.displayPath === "after.md"
    )!;
    const proposal = await state.notes.prepare(state.owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: first.id,
      expectedRevision: first.revision,
      text: "Moved contribution",
      destination: {
        kind: "candidate",
        candidateId: candidate.id,
        candidateRevision: candidate.revision
      }
    });
    const realSave = RecordingContributionRepository.prototype.saveOperation;
    let saved = 0;
    const interrupted = vi
      .spyOn(RecordingContributionRepository.prototype, "saveOperation")
      .mockImplementation(async function (this: RecordingContributionRepository, db, operation) {
        if (++saved === 2) throw new Error("Synthetic second-leg interruption");
        return realSave.call(this, db, operation);
      });
    await expect(
      state.notes.change(state.owner, { proposalId: proposal.id, acceptBinding: true })
    ).rejects.toThrow("Synthetic second-leg interruption");
    interrupted.mockRestore();
    const operation = await state.runner.withDataContext(state.owner, (db) =>
      new RecordingContributionRepository().operation(db, proposal.id)
    );
    expect(operation!.state).toBe("pending");
    expect(operation!.legs.map((leg) => leg.done)).toEqual([true, false]);
    expect(await readFile(join(linked, "before.md"), "utf8")).toBe("Old destination user text\n");
    // Model a crash after the new file was published but before its DB leg committed.
    const newBlock = operation!.legs[1]!.operation.after!.bytes;
    await writeFile(
      join(linked, "after.md"),
      "New destination user text\n" + newBlock + "Later user text\n"
    );
    const prepare = createManagedDeletionPreparation({ dataContext: state.runner, privateVault });
    expect((await prepare({ userId: ids.userA, requestId: randomUUID() })).status).toBe("complete");
    expect(await readFile(join(linked, "before.md"), "utf8")).toBe("Old destination user text\n");
    expect(await readFile(join(linked, "after.md"), "utf8")).toBe(
      "New destination user text\nLater user text\n"
    );
    const cancelled = await state.runner.withDataContext(state.owner, (db) =>
      new RecordingContributionRepository().operation(db, proposal.id)
    );
    expect(cancelled!.state).toBe("cancelled");
    await expect(
      state.notes.change(state.owner, { proposalId: proposal.id, acceptBinding: true })
    ).rejects.toThrow();
    expect(await readFile(join(linked, "after.md"), "utf8")).toBe(
      "New destination user text\nLater user text\n"
    );
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
  });

  it("keeps duplicate markers conflicted without removing either copy", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "Owner text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    const receipt = await state.note(source, "Duplicated contribution", "topic.md");
    const stored = await state.runner.withDataContext(state.owner, (db) =>
      new RecordingContributionRepository().receipt(db, receipt.id)
    );
    const duplicated = (await readFile(join(linked, "topic.md"), "utf8")) + stored!.block.bytes;
    await writeFile(join(linked, "topic.md"), duplicated);
    await expect(state.deletion.remove(state.owner, source.sourceId)).rejects.toMatchObject({
      code: "meeting_cleanup_conflict"
    });
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(duplicated);
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
  });

  it("refuses historical completed-operation bytes and retains the edited source", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "Owner text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    const first = await state.note(source, "Earlier reviewed contribution", "topic.md");
    const historical = await readFile(join(linked, "topic.md"), "utf8");
    const candidate = (await state.notes.inventory(state.owner)).candidates.find(
      (row) => row.displayPath === "topic.md"
    )!;
    const proposal = await state.notes.prepare(state.owner, {
      kind: "change",
      requestId: randomUUID(),
      receiptId: first.id,
      expectedRevision: first.revision,
      text: "Current reviewed contribution",
      destination: {
        kind: "candidate",
        candidateId: candidate.id,
        candidateRevision: candidate.revision
      }
    });
    await state.notes.change(state.owner, { proposalId: proposal.id, acceptBinding: true });
    // Reverting a previously completed leg is a user edit, not an interrupted pending leg.
    await writeFile(join(linked, "topic.md"), historical);
    await expect(state.deletion.remove(state.owner, source.sourceId)).rejects.toMatchObject({
      code: "meeting_cleanup_conflict"
    });
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(historical);
    expect(
      await state.runner.withDataContext(state.owner, (db) =>
        fixture.records.get(db, source.sourceId)
      )
    ).not.toBeNull();
  });

  it("keeps an unavailable linked root pending without deleting account or session", async () => {
    const state = await setup();
    const source = await state.create();
    await writeFile(join(linked, "topic.md"), "Owner text\n");
    await state.runner.withDataContext(state.owner, (db) =>
      new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
    );
    await state.note(source, "Must survive unavailable root", "topic.md");
    const before = await readFile(join(linked, "topic.md"), "utf8");
    vi.stubEnv("MOSS_NOTES_ROOTS", join(workspace, "different-root"));
    vi.stubEnv("JARVIS_NOTES_ROOTS", join(workspace, "different-root"));
    const prepareManagedDeletion = createManagedDeletionPreparation({
      dataContext: state.runner,
      privateVault
    });
    await expect(
      deleteUserData({
        userId: ids.userA,
        confirmUserId: ids.userA,
        dryRun: false,
        bootstrapConnectionString: connectionStrings.bootstrap,
        prepareManagedDeletion
      })
    ).rejects.toMatchObject({ code: "managed_cleanup_pending" });
    expect(await retained()).toEqual({ users: 1, sessions: 1 });
    expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(before);
  });

  it("serializes a missing-dependency zero-row probe against the first managed publisher", async () => {
    const state = await setup();
    const source = await state.create();
    const blocker = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    const inspection = createDatabase({
      connectionString: connectionStrings.bootstrap,
      maxConnections: 1
    });
    await sql`select pg_advisory_lock(hashtext('recording-delete-first-publisher-test'))`.execute(
      blocker
    );
    await sql`create function app.pause_recording_delete_audit() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(hashtext('recording-delete-first-publisher-test')); return new; end $$`.execute(
      inspection
    );
    await sql`create trigger pause_recording_delete_audit before insert on app.admin_audit_events
      for each row execute function app.pause_recording_delete_audit()`.execute(inspection);
    const deleting = deleteUserData({
      userId: ids.userA,
      confirmUserId: ids.userA,
      dryRun: false,
      bootstrapConnectionString: connectionStrings.bootstrap
    });
    let publishing: Promise<{ error?: unknown; published?: true }> | undefined;
    let finished = false;
    try {
      await expect
        .poll(
          async () =>
            (
              await sql<{ waiting: boolean }>`select exists(
        select 1 from pg_stat_activity where datname=current_database() and wait_event_type='Lock'
          and query like '%INSERT INTO app.admin_audit_events%') as waiting`.execute(inspection)
            ).rows[0]!.waiting,
          { timeout: 5000, interval: 50 }
        )
        .toBe(true);
      publishing = state.note(source).then(
        () => {
          finished = true;
          return { published: true };
        },
        (error) => {
          finished = true;
          return { error };
        }
      );
      await expect
        .poll(
          async () =>
            finished
              ? "completed-before-cascade"
              : (
                    await sql<{ waiting: boolean }>`select exists(select 1 from pg_stat_activity
          where datname=current_database() and wait_event_type='Lock'
            and query like '%pg_advisory_xact_lock_shared%') as waiting`.execute(inspection)
                  ).rows[0]!.waiting
                ? "waiting"
                : "starting",
          { timeout: 5000, interval: 50 }
        )
        .toBe("waiting");
    } finally {
      await sql`select pg_advisory_unlock(hashtext('recording-delete-first-publisher-test'))`.execute(
        blocker
      );
      await blocker.destroy();
      await inspection.destroy();
    }
    expect((await deleting).deleted).toBe(true);
    expect(await publishing).toHaveProperty("error");
    expect(await retained()).toEqual({ users: 0, sessions: 0 });
  });

  it.each(["changed", "unreadable"] as const)(
    "runs the real maintenance CLI with a %s note and an explicit confirmed retry",
    async (condition) => {
      const state = await setup();
      const source = await state.create();
      await writeFile(join(linked, "topic.md"), "Owner text\n");
      await state.runner.withDataContext(state.owner, (db) =>
        new PreferencesRepository().upsert(db, NOTES_SOURCE_PREFERENCE_KEY, linked)
      );
      await state.note(source, "Private CLI contribution", "topic.md");
      const original = await readFile(join(linked, "topic.md"), "utf8");
      if (condition === "changed")
        await writeFile(
          join(linked, "topic.md"),
          original.replace("Private CLI contribution", "Owner-edited secret")
        );
      else await chmod(join(linked, "topic.md"), 0);
      const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
      let ownerEmail: string;
      try {
        await sql`update app.users set is_bootstrap_owner = (id = ${ids.adminUser}::uuid)`.execute(
          bootstrap
        );
        ownerEmail = (
          await sql<{
            email: string;
          }>`select email from app.users where id = ${ids.adminUser}::uuid`.execute(bootstrap)
        ).rows[0]!.email;
      } finally {
        await bootstrap.destroy();
      }
      async function runCli() {
        return new Promise<{ code: number | null; stdout: string; stderr: string }>(
          (resolve, reject) => {
            const child = spawn(
              process.execPath,
              [
                "--import",
                "tsx",
                "scripts/delete-user-data-cli.ts",
                "--user-id",
                ids.userA,
                "--execute",
                "--confirm-user-id",
                ids.userA,
                "--confirm-owner-email",
                ownerEmail
              ],
              { env: process.env, stdio: ["ignore", "pipe", "pipe"] }
            );
            let stdout = "";
            let stderr = "";
            child.stdout.setEncoding("utf8").on("data", (chunk) => {
              stdout += chunk;
            });
            child.stderr.setEncoding("utf8").on("data", (chunk) => {
              stderr += chunk;
            });
            child.on("error", reject);
            child.on("close", (code) => resolve({ code, stdout, stderr }));
          }
        );
      }
      const conflicted = await runCli();
      expect(conflicted.code).toBe(1);
      expect(JSON.parse(conflicted.stderr.trim())).toEqual({
        deleted: false,
        code: condition === "changed" ? "managed_cleanup_conflict" : "managed_cleanup_pending"
      });
      expect(conflicted.stdout).not.toContain('"deleted": true');
      expect(conflicted.stderr).not.toContain("Owner-edited secret");
      expect(conflicted.stderr).not.toContain(linked);
      expect(await retained()).toEqual({ users: 1, sessions: 1 });
      await chmod(join(linked, "topic.md"), 0o600);
      await writeFile(join(linked, "topic.md"), original + "Later unrelated text\n");
      const deleted = await runCli();
      expect(deleted.code).toBe(0);
      expect(deleted.stdout).toContain('"deleted": true');
      expect(await readFile(join(linked, "topic.md"), "utf8")).toBe(
        "Owner text\nLater unrelated text\n"
      );
      expect(await retained()).toEqual({ users: 0, sessions: 0 });
    },
    60_000
  );
});
