import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, type PgBoss } from "@moss/jobs";
import { VaultContextRunner, readVaultFile, listVaultFilesRecursive } from "@moss/vault";
import {
  RecordingImportService,
  RecordingImportRepository,
  RecordingImportConflictError,
  MeetingRecordsRepository,
  meetingsModuleManifest,
  createRecordingImportScheduler,
  RECORDING_IMPORT_QUEUE,
  recordingBundlePath,
  collectMeetingsExportSection,
  type RecordingImportDependencies
} from "@moss/meetings";
import { recordingBundle, recordingFile } from "../fixtures/recording-bundle.js";
import { deleteUserData } from "../../scripts/delete-user-data.js";
import { createRecordingImportRuntime } from "../../packages/module-registry/src/recording-import-runtime.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

let app: Kysely<MossDatabase>,
  context: DataContextRunner,
  boss: PgBoss,
  root: string,
  vault: VaultContextRunner;
const actor = { actorUserId: ids.userA },
  imports = new RecordingImportRepository(),
  records = new MeetingRecordsRepository();
const priorRoot = process.env.MOSS_VAULT_ROOT;
beforeAll(async () => {
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
  context = new DataContextRunner(app);
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
  root = await mkdtemp(join(tmpdir(), "moss-recording-imports-"));
  vault = new VaultContextRunner(root);
  process.env.MOSS_VAULT_ROOT = root;
});
afterAll(async () => {
  await boss?.stop({ graceful: false });
  await app?.destroy();
  if (root) await rm(root, { recursive: true, force: true });
  if (priorRoot === undefined) delete process.env.MOSS_VAULT_ROOT;
  else process.env.MOSS_VAULT_ROOT = priorRoot;
});
function setup(overrides: Partial<RecordingImportDependencies> = {}) {
  const deps: RecordingImportDependencies = {
    dataContext: context,
    vault,
    assertAvailable: async () => {},
    schedule: createRecordingImportScheduler(boss),
    availability: async () => ({ ready: true, modelRoute: "test-route" }),
    transcribe: vi.fn<RecordingImportDependencies["transcribe"]>(async (_actor, input) =>
      input.dispatch(
        async () => ({
          segments: [{ startMs: 0, endMs: 120, text: "Synthetic retained recording" }]
        }),
        async (db) => {
          expect(
            (
              await sql<{
                actor: string;
              }>`SELECT app.current_actor_user_id()::text AS actor`.execute(db.db)
            ).rows[0]!.actor
          ).toBe(ids.userA);
        }
      )
    ),
    describeFailure: () => ({ retryable: false, unavailable: false }),
    ...overrides
  };
  return {
    deps,
    service: new RecordingImportService(deps),
    input: { ...recordingBundle(), sourceDeviceId: randomUUID() }
  };
}
const payload = (id: string, kind: "transcribe" | "abandoned" | "purge" = "transcribe") => ({
  actorUserId: ids.userA,
  resourceId: id,
  kind
});
describe("completed recording imports through real owner DB/vault paths", () => {
  it("blocks actual dispatch when the accepted recording owner is deactivated", async () => {
    const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
    let sent = false;
    const runtime = createRecordingImportRuntime({
      dataContext: context,
      boss,
      resolveActiveModules: async () => [meetingsModuleManifest]
    });
    const service = new RecordingImportService({
      ...runtime,
      vault,
      availability: async () => ({ ready: true, modelRoute: "test-route" }),
      transcribe: async (_actor, request) => {
        await sql`UPDATE app.users SET status='deactivated' WHERE id=${ids.userA}::uuid`.execute(
          bootstrap
        );
        return request.dispatch(async () => {
          sent = true;
          return { segments: [] };
        });
      }
    });
    try {
      const accepted = await service.accept(actor, {
        ...recordingBundle(),
        sourceDeviceId: randomUUID()
      });
      await service.process(actor, payload(accepted.id));
      expect(sent).toBe(false);
      const row = await context.withDataContext(actor, (db) => imports.get(db, accepted.id));
      expect(row).toMatchObject({ state: "failed", code: "import_unavailable" });
    } finally {
      await sql`UPDATE app.users SET status='active' WHERE id=${ids.userA}::uuid`.execute(
        bootstrap
      );
      await bootstrap.destroy();
    }
  });
  it("revalidates selected configuration at actual dispatch", async () => {
    let sent = false;
    const { service, input } = setup({
      transcribe: async (_actor, request) =>
        request.dispatch(
          async () => {
            sent = true;
            return { segments: [{ startMs: 0, endMs: 120, text: "Synthetic" }] };
          },
          async () => {
            throw new Error("Synthetic route configuration changed");
          }
        )
    });
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    expect(sent).toBe(false);
    expect(await service.status(actor, accepted.id)).toMatchObject({ state: "failed" });
  });
  it("rechecks module availability immediately before sending", async () => {
    let available = true,
      sent = false;
    const { service, input } = setup({
      assertAvailable: async () => {
        if (!available) throw new Error("Synthetic module disabled");
      },
      transcribe: async (_actor, request) => {
        available = false;
        return request.dispatch(async () => {
          sent = true;
          return { segments: [] };
        });
      }
    });
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    expect(sent).toBe(false);
    const row = await context.withDataContext(actor, (db) => imports.get(db, accepted.id));
    expect(row?.state).toBe("failed");
  });
  it("rolls all transcript batches back if a later batch is invalid", async () => {
    const { service, input } = setup({
      transcribe: async () => ({
        segments: Array.from({ length: 101 }, (_, i) => ({
          startMs: i,
          endMs: i + 1,
          text: i === 100 ? "Invalid\0text" : "Synthetic"
        }))
      })
    });
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    expect(await service.status(actor, accepted.id)).toMatchObject({ state: "failed" });
    const rows = await context.withDataContext(actor, (db) =>
      sql`SELECT version FROM app.meeting_transcript_batches WHERE meeting_id=${accepted.meetingId}::uuid`.execute(
        db.db
      )
    );
    expect(rows.rows).toHaveLength(0);
  });
  it("accepts concurrent replay once, preserves bytes and rejects changed evidence", async () => {
    const { service, input } = setup();
    const results = await Promise.all([service.accept(actor, input), service.accept(actor, input)]);
    expect(results.filter((r) => r.created)).toHaveLength(1);
    expect(results[0]!.id).toBe(results[1]!.id);
    expect(results[0]!.meetingId).toBe(results[1]!.meetingId);
    const raw = await vault.withVaultContext(actor, (ctx) =>
      readVaultFile(ctx, recordingBundlePath(results[0]!.id))
    );
    expect(JSON.parse(raw).sidecar).toEqual(input.sidecar);
    const bytes = Buffer.from(input.wav.base64, "base64");
    bytes[44] = 1;
    await expect(
      service.accept(actor, { ...input, wav: recordingFile(input.wav.name, bytes) })
    ).rejects.toBeInstanceOf(RecordingImportConflictError);
    expect(
      await vault.withVaultContext(actor, (ctx) =>
        readVaultFile(ctx, recordingBundlePath(results[0]!.id))
      )
    ).toBe(raw);
  });
  it.each([ids.userB, ids.adminUser])("RLS hides owner evidence from %s", async (id) => {
    const { service, input } = setup();
    const accepted = await service.accept(actor, input);
    expect(await service.status({ actorUserId: id }, accepted.id)).toBeNull();
    await context.withDataContext({ actorUserId: id }, async (db) => {
      expect(await imports.get(db, accepted.id)).toBeNull();
      expect(
        (
          await sql`UPDATE app.meeting_recording_imports SET state='failed' WHERE id=${accepted.id}::uuid RETURNING id`.execute(
            db.db
          )
        ).rows
      ).toHaveLength(0);
    });
    const other = await service.accept({ actorUserId: id }, input);
    expect(other.id).not.toBe(accepted.id);
  });
  it("atomically commits transcript provenance and completion, then ignores duplicate delivery", async () => {
    const { service, input, deps } = setup();
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    await service.process(actor, payload(accepted.id));
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(await service.status(actor, accepted.id)).toMatchObject({
      state: "complete",
      code: null
    });
    const rows = await context.withDataContext(actor, (db) =>
      sql<{
        input_json: string;
      }>`SELECT input_json FROM app.meeting_transcript_batches WHERE meeting_id=${accepted.meetingId}::uuid`.execute(
        db.db
      )
    );
    expect(rows.rows).toHaveLength(1);
    expect(JSON.parse(rows.rows[0]!.input_json).sources[0].kind).toBe("recording");
  });
  it("commits more than one transcript batch atomically", async () => {
    const { service, input } = setup({
      transcribe: async () => ({
        segments: Array.from({ length: 101 }, (_, i) => ({
          startMs: i,
          endMs: i + 1,
          text: `Segment ${i}`
        }))
      })
    });
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    expect(await service.status(actor, accepted.id)).toMatchObject({ state: "complete" });
    const rows = await context.withDataContext(actor, (db) =>
      sql`SELECT version FROM app.meeting_transcript_batches WHERE meeting_id=${accepted.meetingId}::uuid`.execute(
        db.db
      )
    );
    expect(rows.rows).toHaveLength(2);
  });
  it("retains voice-request classification without executing tasks", async () => {
    const { service } = setup();
    const accepted = await service.accept(actor, {
      ...recordingBundle(true),
      sourceDeviceId: randomUUID()
    });
    await service.process(actor, payload(accepted.id));
    expect(await service.status(actor, accepted.id)).toMatchObject({
      mode: "voice-request",
      state: "complete"
    });
    const tasks = await context.withDataContext(actor, (db) =>
      sql`SELECT * FROM app.meeting_action_candidates WHERE meeting_id=${accepted.meetingId}::uuid`.execute(
        db.db
      )
    );
    expect(tasks.rows).toHaveLength(0);
  });
  it("does not dispatch without configuration and never resets failed work on replay", async () => {
    const { service, input, deps } = setup({
      availability: async () => ({ ready: false, modelRoute: null })
    });
    const accepted = await service.accept(actor, input);
    await service.process(actor, payload(accepted.id));
    expect(deps.transcribe).not.toHaveBeenCalled();
    expect(await service.accept(actor, input)).toMatchObject({
      id: accepted.id,
      state: "failed",
      code: "transcription_unavailable",
      retryable: false
    });
  });
  it("bounds retries and recovers an interrupted final attempt", async () => {
    const { service, input } = setup({
      transcribe: async () => {
        throw new Error("synthetic provider failure");
      },
      describeFailure: () => ({ retryable: true, unavailable: false })
    });
    const accepted = await service.accept(actor, input);
    await expect(service.process(actor, payload(accepted.id))).rejects.toThrow("retry pending");
    await expect(service.process(actor, payload(accepted.id))).rejects.toThrow("retry pending");
    await service.process(actor, payload(accepted.id));
    expect(await service.status(actor, accepted.id)).toMatchObject({
      state: "failed",
      retryable: false
    });
    const next = await service.accept(actor, { ...input, sourceDeviceId: randomUUID() });
    await context.withDataContext(actor, async (db) => {
      for (let i = 0; i < 3; i++) await imports.claim(db, next.id, randomUUID());
    });
    await service.process(actor, payload(next.id));
    expect(await service.status(actor, next.id)).toMatchObject({ state: "failed" });
  });
  it("rolls back acceptance when durable cleanup cannot be scheduled", async () => {
    const { service, input } = setup({
      schedule: async () => {
        throw new Error("synthetic enqueue failure");
      }
    });
    await expect(service.accept(actor, input)).rejects.toThrow("enqueue failure");
    const row = await context.withDataContext(actor, (db) =>
      imports.lockIdentity(db, input.sourceDeviceId, input.recordingId)
    );
    expect(row).toBeNull();
  });
  it("cleans interrupted publication, including a bundle left before ready commit", async () => {
    const normal = setup();
    let calls = 0;
    const { service, input } = setup({
      schedule: async (db, data, delay) => {
        if (++calls === 2) throw new Error("synthetic dispatch enqueue failure");
        await normal.deps.schedule(db, data, delay);
      }
    });
    await expect(service.accept(actor, input)).rejects.toThrow("enqueue failure");
    const row = await context.withDataContext(actor, (db) =>
      imports.lockIdentity(db, input.sourceDeviceId, input.recordingId)
    );
    expect(row?.ready).toBe(false);
    await normal.service.process(actor, payload(row!.id, "abandoned"));
    expect(await normal.service.status(actor, row!.id)).toMatchObject({
      state: "failed",
      code: "import_interrupted"
    });
    expect(
      (await vault.withVaultContext(actor, (ctx) => listVaultFilesRecursive(ctx))).filter((path) =>
        path.includes(row!.id)
      )
    ).toEqual([]);
  });
  it("exports original bundles and removes evidence after meeting deletion", async () => {
    const { service, input } = setup();
    const accepted = await service.accept(actor, input);
    const exported = await context.withDataContext(actor, (db) =>
      collectMeetingsExportSection(db, { actorUserId: ids.userA, requestId: randomUUID() })
    );
    const evidence = exported.recording_imports.find((row) => row.id === accepted.id);
    expect(JSON.parse(String(evidence!.bundleJson)).packets).toEqual(input.packets);
    await context.withDataContext(actor, async (db) => {
      await service.beforeRemove(db, actor, accepted.meetingId);
      await records.remove(db, accepted.meetingId);
    });
    await service.process(actor, payload(accepted.id, "purge"));
    expect(await service.status(actor, accepted.id)).toBeNull();
    expect(
      (await vault.withVaultContext(actor, (ctx) => listVaultFilesRecursive(ctx))).filter((path) =>
        path.includes(accepted.id)
      )
    ).toEqual([]);
  });
  it("schedules only metadata and rolls job rows back with their transaction", async () => {
    const resourceId = randomUUID(),
      schedule = createRecordingImportScheduler(boss);
    await expect(
      context.withDataContext(actor, async (db) => {
        await schedule(db, payload(resourceId));
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
    try {
      const rows = await sql<{
        data: Record<string, unknown>;
      }>`SELECT data FROM pgboss.job WHERE name=${RECORDING_IMPORT_QUEUE}`.execute(bootstrap);
      expect(rows.rows.some((row) => row.data.resourceId === resourceId)).toBe(false);
      for (const row of rows.rows)
        expect(Object.keys(row.data).sort()).toEqual(["actorUserId", "kind", "resourceId"]);
    } finally {
      await bootstrap.destroy();
    }
  });
  it("account deletion removes retained bundles and cascades import rows", async () => {
    const { service, input } = setup();
    const owner = { actorUserId: ids.userB };
    const accepted = await service.accept(owner, input);
    const removed = await deleteUserData({
      userId: ids.userB,
      confirmUserId: ids.userB,
      dryRun: false,
      bootstrapConnectionString: connectionStrings.bootstrap
    });
    expect(removed).toMatchObject({ deleted: true, vaultDeleted: true });
    expect(await service.status(owner, accepted.id)).toBeNull();
    expect(await vault.withVaultContext(owner, (ctx) => listVaultFilesRecursive(ctx))).toEqual([]);
  });
});
