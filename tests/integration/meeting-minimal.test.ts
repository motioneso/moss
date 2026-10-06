import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import { createPgBossClient, scopedJobDatabase, sendJob, type PgBoss } from "@moss/jobs";
import { MEETING_RECORDING_NOTICE, type MeetingOutputContent } from "@moss/shared";
import { MeetingRecordsRepository } from "../../packages/meetings/src/repository.js";
import { MeetingTranscriptRepository } from "../../packages/meetings/src/transcript-repository.js";
import { MeetingRecordingNoticeRepository } from "../../packages/meetings/src/recording-notice.js";
import { MeetingPreferencesRepository } from "../../packages/meetings/src/preferences.js";
import {
  MeetingOutputService,
  type MeetingOutputGenerator
} from "../../packages/meetings/src/output-service.js";
import { MeetingOutputError } from "../../packages/meetings/src/output-repository.js";
import { MeetingStopSummaryRepository } from "../../packages/meetings/src/stop-summary-repository.js";
import {
  createMeetingStopSummaryScheduler,
  MEETING_STOP_SUMMARY_QUEUE
} from "../../packages/meetings/src/stop-summary-jobs.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
let app: Kysely<MossDatabase>,
  worker: Kysely<MossDatabase>,
  bootstrap: Kysely<MossDatabase>,
  context: DataContextRunner,
  workerContext: DataContextRunner,
  boss: PgBoss;
const owner = { actorUserId: ids.userA };
const records = new MeetingRecordsRepository();
const summaries = new MeetingStopSummaryRepository();
beforeAll(async () => {
  // Canonical isolated run-gate only. No database commands may be run directly.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  worker = createDatabase({ connectionString: connectionStrings.worker, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
  workerContext = new DataContextRunner(worker);
  boss = createPgBossClient(connectionStrings.app);
  await boss.start();
});
afterAll(async () => {
  await boss?.stop({ graceful: true });
  await Promise.all([app?.destroy(), worker?.destroy(), bootstrap?.destroy()]);
});
async function fixture(
  options: { enabled?: boolean; transcript?: boolean; finalized?: boolean } = {}
) {
  const enabled = options.enabled ?? true,
    finalized = options.finalized ?? true;
  const creation = { requestKey: randomUUID(), title: "Untitled meeting" };
  const result = await context.withDataContext(owner, async (db) => {
    await new MeetingPreferencesRepository().update(db, {
      summarizeOnStop: enabled,
      summaryTemplateId: "general"
    });
    const { meeting } = await records.create(db, creation);
    const grantId = randomUUID(),
      deadline = new Date(Date.now() + 60000).toISOString();
    const state = {
      desired: "stopped",
      stopCutoffMs: 1000,
      finalized,
      finalizationDeadline: deadline,
      gaps: [],
      gapLimitReached: false
    };
    await sql`INSERT INTO app.meeting_capture_grants (id,meeting_id,device_id,device_name,verifier_hash,status,state_json,expires_at)
      VALUES (${grantId}::uuid,${meeting.id}::uuid,${randomUUID()}::uuid,'Synthetic recorder',${"0".repeat(64)},${finalized ? "complete" : "finalizing"},${JSON.stringify(state)},now()+interval '1 hour')`.execute(
      db.db
    );
    if (options.transcript !== false)
      await new MeetingTranscriptRepository().ingest(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedVersion: 0,
        stopCutoffMs: 1000,
        sources: [
          {
            sourceId: "mic",
            epoch: 1,
            kind: "microphone",
            label: "Microphone",
            startMs: 0,
            endMs: 1000
          }
        ],
        events: [
          {
            cursor: 1,
            segment: {
              meetingId: meeting.id,
              segmentId: "one",
              sourceId: "mic",
              epoch: 1,
              startMs: 0,
              endMs: 900,
              revision: 1,
              text: "Publish the project notes",
              finality: "final",
              provenance: "transcription",
              speakerId: null
            }
          }
        ]
      });
    return { meeting, grantId, deadline, state };
  });
  const schedule = createMeetingStopSummaryScheduler(boss);
  const stop = (stoppedNow = true, finalized = result.state.finalized) =>
    context.withDataContext(owner, async (db) => {
      await records.get(db, result.meeting.id, { forUpdate: true });
      await schedule(db, owner, {
        meetingId: result.meeting.id,
        grantId: result.grantId,
        deadline: result.deadline,
        finalized,
        stoppedNow
      });
      return (await summaries.row(db, result.meeting.id))!;
    });
  return { ...result, creation, stop, schedule };
}
function generator() {
  return vi.fn<MeetingOutputGenerator>(async (_actor, { inputs }) => {
    const content: MeetingOutputContent = {
      overview: "Project notes and next steps.",
      decisions: [],
      openQuestions: [],
      warnings: [],
      actions: [
        {
          text: "Publish project notes",
          ownerPhrase: null,
          duePhrase: null,
          evidence: [
            {
              kind: "transcript",
              meetingId: inputs.meetingId,
              segmentId: "one",
              segmentRevision: 1,
              startCharacter: 0,
              endCharacter: 25
            }
          ]
        }
      ]
    };
    return { content, modelRoute: "synthetic-configured-summarization" };
  });
}
describe("minimal meeting lifecycle (real isolated storage, synthetic provider)", () => {
  it("stores durable default-on preferences and requires current notice before setup completes", async () => {
    const actor = { actorUserId: ids.userD };
    const preferences = new MeetingPreferencesRepository();
    expect(await context.withDataContext(actor, (db) => preferences.get(db))).toMatchObject({
      summarizeOnStop: true,
      summaryTemplateId: "general",
      setupCompletedAt: null
    });
    const selection = {
      defaultCaptureMode: "microphone-only" as const,
      rememberedSource: {
        deviceId: randomUUID(),
        microphoneId: "exact-microphone",
        mode: "microphone-only" as const
      },
      completeSetup: true as const
    };
    await expect(
      context.withDataContext(actor, (db) => preferences.update(db, selection))
    ).rejects.toMatchObject({ code: "meeting_capture_notice_required" });
    await context.withDataContext(actor, (db) =>
      new MeetingRecordingNoticeRepository().acknowledge(db, MEETING_RECORDING_NOTICE.policyVersion)
    );
    const saved = await context.withDataContext(actor, (db) => preferences.update(db, selection));
    expect(saved.setupCompletedAt).not.toBeNull();
    expect(await context.withDataContext(actor, (db) => preferences.get(db))).toEqual(saved);
    expect(
      (await context.withDataContext({ actorUserId: ids.userB }, (db) => preferences.get(db)))
        .rememberedSource
    ).toBeNull();
  });
  it("uses compare-and-swap titles without changing creation replay or notes", async () => {
    const f = await fixture();
    const outcomes = await Promise.all(
      ["First title", "Second title"].map((title) =>
        context.withDataContext(owner, (db) =>
          records.putTitle(db, { meetingId: f.meeting.id, expectedTitle: f.meeting.title, title })
        )
      )
    );
    expect(outcomes.map((item) => item.status).sort()).toEqual(["conflict", "saved"]);
    expect(
      (await context.withDataContext(owner, (db) => records.create(db, f.creation))).meeting.title
    ).toBe("Untitled meeting");
    expect(
      (await context.withDataContext(owner, (db) => records.get(db, f.meeting.id)))?.title
    ).not.toBe("Untitled meeting");
  });
  it("queues Stop atomically, waits for finalization, then dispatches once through real worker-role receipts", async () => {
    const f = await fixture({ finalized: false });
    const row = await f.stop();
    await f.stop();
    const jobs = () =>
      sql<{
        data: unknown;
      }>`SELECT data FROM pgboss.job WHERE name=${MEETING_STOP_SUMMARY_QUEUE} AND data->>'resourceId'=${f.meeting.id}`.execute(
        bootstrap
      );
    expect((await jobs()).rows).toHaveLength(1);
    expect((await jobs()).rows[0]?.data).toEqual({
      actorUserId: owner.actorUserId,
      resourceId: f.meeting.id,
      idempotencyKey: row.request_key
    });
    const generate = generator(),
      service = new MeetingOutputService(workerContext, generate);
    await expect(service.generateOnStop(owner, f.meeting.id, row.request_key)).rejects.toThrow(
      "finalization is still pending"
    );
    expect(generate).not.toHaveBeenCalled();
    await context.withDataContext(owner, (db) =>
      sql`UPDATE app.meeting_capture_grants SET status='complete',state_json=${JSON.stringify({ ...f.state, finalized: true })} WHERE id=${f.grantId}::uuid`.execute(
        db.db
      )
    );
    await f.stop(false, true);
    await f.stop(false, true);
    expect((await jobs()).rows).toHaveLength(2);
    const results = await Promise.all([
      service.generateOnStop(owner, f.meeting.id, row.request_key),
      service.generateOnStop(owner, f.meeting.id, row.request_key)
    ]);
    expect(results.some((result) => result?.status === "saved")).toBe(true);
    expect(await service.generateOnStop(owner, f.meeting.id, row.request_key)).toMatchObject({
      status: "saved",
      replayed: true
    });
    expect(generate).toHaveBeenCalledOnce();
    expect(
      await context.withDataContext(owner, (db) => summaries.status(db, f.meeting.id))
    ).toMatchObject({ status: "saved" });
    expect(
      (await context.withDataContext(owner, (db) => records.get(db, f.meeting.id)))?.title
    ).toBe("Project notes and next steps.");
  });
  it.each([{ enabled: false }, { transcript: false }])(
    "skips setting-off or notes-only Stop without provider work (%s)",
    async (options) => {
      const f = await fixture(options);
      const row = await f.stop();
      const generate = generator();
      expect(
        await new MeetingOutputService(workerContext, generate).generateOnStop(
          owner,
          f.meeting.id,
          row.request_key
        )
      ).toBeNull();
      expect(generate).not.toHaveBeenCalled();
      expect(
        await context.withDataContext(owner, (db) => summaries.status(db, f.meeting.id))
      ).toMatchObject({ status: "skipped" });
    }
  );
  it.each([false, true])(
    "preserves delayed admission after partial early enqueue failure (retry early: %s)",
    async (retryEarly) => {
      const f = await fixture({ finalized: false });
      const row = await f.stop();
      const jobs = () =>
        sql<{
          data: { actorUserId: string; resourceId: string; idempotencyKey: string };
        }>`SELECT data FROM pgboss.job WHERE name=${MEETING_STOP_SUMMARY_QUEUE} AND data->>'resourceId'=${f.meeting.id}`.execute(
          bootstrap
        );
      const [delayed] = (await jobs()).rows;
      expect(delayed).toBeDefined();
      await context.withDataContext(owner, async (db) => {
        await records.get(db, f.meeting.id, { forUpdate: true });
        await sql`UPDATE app.meeting_capture_grants SET status='complete',state_json=${JSON.stringify({ ...f.state, finalized: true })} WHERE id=${f.grantId}::uuid`.execute(
          db.db
        );
        await summaries.schedule(
          db,
          owner,
          {
            meetingId: f.meeting.id,
            grantId: f.grantId,
            deadline: f.deadline,
            finalized: true,
            stoppedNow: false
          },
          async (transaction, payload, at) => {
            await sendJob(boss, MEETING_STOP_SUMMARY_QUEUE, payload, {
              db: scopedJobDatabase(transaction),
              startAfter: at,
              singletonKey: `${payload.idempotencyKey}:finalized`
            });
            // A SQL error after partial enqueue must roll back only that early job.
            await sql`SELECT * FROM app.synthetic_unavailable_summary_queue`.execute(
              transaction.db
            );
          }
        );
      });
      expect((await jobs()).rows).toEqual([delayed]);
      expect(
        await context.withDataContext(owner, (db) => summaries.row(db, f.meeting.id))
      ).toMatchObject({
        status: "waiting",
        code: null,
        early_enqueued: false,
        request_key: row.request_key
      });
      expect(
        await context.withDataContext(owner, (db) => summaries.status(db, f.meeting.id))
      ).toMatchObject({ status: "waiting" });
      if (retryEarly) {
        await f.stop(false, true);
        await f.stop(false, true);
        expect((await jobs()).rows).toHaveLength(2);
        expect(
          await context.withDataContext(owner, (db) => summaries.row(db, f.meeting.id))
        ).toMatchObject({ early_enqueued: true });
      }
      const generate = generator();
      const service = new MeetingOutputService(workerContext, generate);
      const payload = delayed!.data;
      expect(
        await service.generateOnStop(
          { actorUserId: payload.actorUserId },
          payload.resourceId,
          payload.idempotencyKey
        )
      ).toMatchObject({ status: "saved" });
      expect(await service.generateOnStop(owner, f.meeting.id, row.request_key)).toMatchObject({
        status: "saved",
        replayed: true
      });
      expect(generate).toHaveBeenCalledOnce();
      expect(
        await context.withDataContext(owner, (db) => summaries.status(db, f.meeting.id))
      ).toMatchObject({ status: "saved" });
    }
  );
  it("treats a deleted meeting's retained queued summary as done without provider work", async () => {
    const f = await fixture({ finalized: false });
    const row = await f.stop();
    await context.withDataContext(owner, (db) =>
      db.db.deleteFrom("app.meeting_records").where("id", "=", f.meeting.id).execute()
    );
    expect(
      await context.withDataContext(owner, (db) => summaries.row(db, f.meeting.id))
    ).toBeNull();
    expect(
      (
        await sql`SELECT id FROM pgboss.job WHERE name=${MEETING_STOP_SUMMARY_QUEUE} AND data->>'resourceId'=${f.meeting.id}`.execute(
          bootstrap
        )
      ).rows
    ).toHaveLength(1);
    const generate = generator();
    const service = new MeetingOutputService(workerContext, generate);
    await expect(service.generateOnStop(owner, f.meeting.id, row.request_key)).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
  });
  it("persists unavailable-model failure and never retries provider dispatch", async () => {
    const f = await fixture();
    const row = await f.stop();
    const generate = generator();
    generate.mockRejectedValue(new MeetingOutputError("meeting_output_route_unavailable"));
    const service = new MeetingOutputService(workerContext, generate);
    expect(await service.generateOnStop(owner, f.meeting.id, row.request_key)).toMatchObject({
      status: "failed",
      code: "meeting_output_route_unavailable"
    });
    await service.generateOnStop(owner, f.meeting.id, row.request_key);
    expect(generate).toHaveBeenCalledOnce();
  });
  it("rolls back automatic intent and transactional queue insertion together", async () => {
    const f = await fixture();
    await expect(
      context.withDataContext(owner, async (db) => {
        await records.get(db, f.meeting.id, { forUpdate: true });
        await f.schedule(db, owner, {
          meetingId: f.meeting.id,
          grantId: f.grantId,
          deadline: f.deadline,
          finalized: false,
          stoppedNow: true
        });
        throw new Error("Synthetic enclosing rollback");
      })
    ).rejects.toThrow("Synthetic enclosing rollback");
    expect(
      await context.withDataContext(owner, (db) => summaries.row(db, f.meeting.id))
    ).toBeNull();
    expect(
      (
        await sql`SELECT id FROM pgboss.job WHERE name=${MEETING_STOP_SUMMARY_QUEUE} AND data->>'resourceId'=${f.meeting.id}`.execute(
          bootstrap
        )
      ).rows
    ).toEqual([]);
  });
  it("keeps owner isolation and denies worker capture/credential/candidate-review mutations", async () => {
    const f = await fixture();
    const row = await f.stop();
    const generate = generator();
    const service = new MeetingOutputService(workerContext, generate);
    for (const actorUserId of [ids.userB, ids.adminUser])
      await expect(
        service.generateOnStop({ actorUserId }, f.meeting.id, row.request_key)
      ).resolves.toBeNull();
    expect(generate).not.toHaveBeenCalled();
    for (const query of [
      sql`SELECT credential_hash FROM app.meeting_capture_grants WHERE id=${f.grantId}::uuid`,
      sql`UPDATE app.meeting_capture_grants SET status='active' WHERE id=${f.grantId}::uuid`,
      sql`UPDATE app.meeting_action_candidates SET review_state='accepted' WHERE meeting_id=${f.meeting.id}::uuid`,
      sql`INSERT INTO app.meeting_action_candidates (meeting_id,identity_key,artifact_version,proposal_json,accepted_task_id) VALUES (${f.meeting.id}::uuid,'forged',1,'{}',NULL)`
    ])
      await expect(
        workerContext.withDataContext(owner, (db) => query.execute(db.db))
      ).rejects.toMatchObject({ code: "42501" });
    const foreign = await context.withDataContext({ actorUserId: ids.userB }, (db) =>
      records.create(db, { requestKey: randomUUID(), title: "Other owner's meeting" })
    );
    await expect(
      context.withDataContext({ actorUserId: ids.userB }, (db) =>
        sql`INSERT INTO app.meeting_stop_summaries (meeting_id,grant_id,request_key,template_id,status,due_at) VALUES (${foreign.meeting.id}::uuid,${f.grantId}::uuid,${randomUUID()}::uuid,'general','waiting',now())`.execute(
          db.db
        )
      )
    ).rejects.toMatchObject({ code: "23503" });
  });
});
