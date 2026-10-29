import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createDatabase, DataContextRunner, type DataContextDb } from "@moss/db";
import {
  RecordingTypesRepository,
  DEFAULT_RECORDING_TYPES,
  ManualEntryService,
  MeetingOutputService,
  MeetingOutputsRepository,
  RecordingMetadataRepository,
  collectMeetingsExportSection
} from "@moss/meetings";
import { registerRecordingRoutes } from "../../packages/meetings/src/recording-routes.js";
import { recordingInterpretation } from "../fixtures/meeting-recording.js";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";
const app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 6 });
const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
const context = new DataContextRunner(app);
const types = new RecordingTypesRepository();
const owner = { actorUserId: ids.userA };
const defaults = () => DEFAULT_RECORDING_TYPES.map((type) => ({ ...type }));
const input = () => ({
  expectedRevision: 0,
  types: defaults().map((type) => ({
    ...type,
    name: type.id === "brain-dump" ? "Thinking aloud" : type.name
  }))
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
beforeAll(async () => {
  await resetFoundationDatabase();
});
beforeEach(async () => {
  await sql`DELETE FROM app.meeting_recording_types`.execute(bootstrap);
});
afterAll(async () => {
  await Promise.all([app.destroy(), bootstrap.destroy()]);
});
async function manual(typeId?: string) {
  const service = new ManualEntryService(async () => {});
  return context.withDataContext(owner, (db) =>
    service.create(db, owner, {
      requestKey: randomUUID(),
      transcript: "Project progress and blockers to review",
      ...(typeId ? { typeId } : {})
    })
  );
}
const content = {
  overview: "Project progress",
  decisions: [],
  actions: [],
  openQuestions: [],
  warnings: [],
  recording: recordingInterpretation()
};
async function generate(meetingId: string, service: MeetingOutputService, version = 0) {
  const inputs = await context.withDataContext(owner, (db) =>
    new MeetingOutputsRepository().inputs(db, meetingId)
  );
  return service.generate(owner, meetingId, {
    requestKey: randomUUID(),
    expectedOutputVersion: version,
    expectedTranscriptRevision: inputs.transcript!.transcriptRevision,
    expectedNotesRevision: inputs.notesRevision,
    templateId: "general",
    templateVersion: 1
  });
}
async function waitingWriter() {
  const result = await sql<{
    waiting: boolean;
  }>`SELECT EXISTS(SELECT 1 FROM pg_locks l JOIN pg_stat_activity a ON a.pid=l.pid WHERE a.application_name='recording-config-writer' AND l.locktype='advisory' AND NOT l.granted) AS waiting`.execute(
    bootstrap
  );
  return result.rows[0]?.waiting;
}
async function writer() {
  return context.withDataContext(owner, async (db) => {
    await sql`SELECT set_config('application_name','recording-config-writer',true)`.execute(db.db);
    return types.put(db, input());
  });
}
describe("owner recording-type configuration (#3777 Phase 2a)", () => {
  it("allows exactly one simultaneous first write and preserves no-op revisions", async () => {
    const result = await Promise.allSettled([
      context.withDataContext(owner, (db) => types.put(db, input())),
      context.withDataContext(owner, (db) => types.put(db, input()))
    ]);
    expect(result.filter((entry) => entry.status === "fulfilled")).toHaveLength(1);
    const rejected = result.find((entry) => entry.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : null).toMatchObject({
      code: "recording_type_configuration_conflict",
      statusCode: 409
    });
    const current = await context.withDataContext(owner, (db) => types.get(db));
    expect(current.revision).toBe(1);
    expect(
      await context.withDataContext(owner, (db) =>
        types.put(db, { expectedRevision: 1, types: current.types })
      )
    ).toEqual(current);
  });
  it("serves real PUT/GET and rejects unknown fields before schema stripping and stale writes", async () => {
    const server = Fastify();
    registerRecordingRoutes(server, {
      dataContext: context,
      resolveAccessContext: async () => owner
    });
    try {
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/meetings/recording-types",
            payload: { ...input(), unknown: true }
          })
        ).statusCode
      ).toBe(400);
      expect(
        (
          await server.inject({
            method: "PUT",
            url: "/api/meetings/recording-types",
            payload: { ...input(), types: input().types.map((type) => ({ ...type, hidden: true })) }
          })
        ).statusCode
      ).toBe(400);
      const saved = await server.inject({
        method: "PUT",
        url: "/api/meetings/recording-types",
        payload: input()
      });
      expect(saved.statusCode).toBe(200);
      expect(saved.json().revision).toBe(1);
      const read = await server.inject({ method: "GET", url: "/api/meetings/recording-types" });
      expect(read.json()).toEqual(saved.json());
      const stale = await server.inject({
        method: "PUT",
        url: "/api/meetings/recording-types",
        payload: input()
      });
      expect(stale.statusCode).toBe(409);
      expect(stale.json()).toMatchObject({ code: "recording_type_configuration_conflict" });
    } finally {
      await server.close();
    }
  });
  it.each([ids.userB, ids.adminUser])(
    "keeps another actor's configuration separate (%s)",
    async (actorUserId) => {
      await context.withDataContext(owner, (db) => types.put(db, input()));
      await context.withDataContext({ actorUserId }, async (db) => {
        expect((await types.get(db)).revision).toBe(0);
        await types.put(db, {
          expectedRevision: 0,
          types: defaults().map((type) => ({
            ...type,
            name: type.id === "other" ? "Another owner's type" : type.name
          }))
        });
      });
      const current = await context.withDataContext(owner, (db) => types.get(db));
      expect(current.types.find((type) => type.id === "brain-dump")?.name).toBe("Thinking aloud");
      expect(current.types.find((type) => type.id === "other")?.name).toBe("Other");
    }
  );
  it("holds a shared configuration read through the transaction so writers cannot slip past validation", async () => {
    const entered = deferred<void>(),
      release = deferred<void>();
    const reading = context.withDataContext(owner, async (db) => {
      await types.get(db);
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const writing = writer();
    try {
      await expect.poll(waitingWriter).toBe(true);
    } finally {
      release.resolve();
    }
    await reading;
    expect((await writing).revision).toBe(1);
  });
  it("marks an in-flight summary stale when configuration changes before completion", async () => {
    const meeting = await manual();
    const entered = deferred<void>(),
      release = deferred<void>();
    const service = new MeetingOutputService(context, async () => {
      entered.resolve();
      await release.promise;
      return { content, modelRoute: "synthetic-integration" };
    });
    const generating = generate(meeting.meetingId, service);
    await entered.promise;
    try {
      await context.withDataContext(owner, (db) => types.put(db, input()));
    } finally {
      release.resolve();
    }
    expect(await generating).toMatchObject({ status: "saved", artifact: { stale: true } });
    expect(
      await context.withDataContext(owner, (db) =>
        new RecordingMetadataRepository().get(db, meeting.meetingId)
      )
    ).toMatchObject({ typeId: null, revision: 0 });
  });
  it("blocks a competing config writer until the already validating summary commits", async () => {
    const meeting = await manual();
    const entered = deferred<void>(),
      release = deferred<void>();
    class PausingOutputs extends MeetingOutputsRepository {
      reads = 0;
      override async inputs(db: DataContextDb, id: string, initialize = false) {
        const inputs = await super.inputs(db, id, initialize);
        this.reads++;
        if (this.reads === 2) {
          entered.resolve();
          await release.promise;
        }
        return inputs;
      }
    }
    const repository = new PausingOutputs();
    const service = new MeetingOutputService(
      context,
      async () => ({ content, modelRoute: "synthetic-integration" }),
      repository
    );
    const generating = generate(meeting.meetingId, service);
    await entered.promise;
    const writing = writer();
    try {
      await expect.poll(waitingWriter).toBe(true);
    } finally {
      release.resolve();
    }
    expect(await generating).toMatchObject({ status: "saved", artifact: { stale: false } });
    expect((await writing).revision).toBe(1);
  });
  it("selects the interpreted style on first classification and on automatic reclassification", async () => {
    const configured = defaults().map((type) => ({
      ...type,
      templateId:
        type.id === "work-meeting"
          ? ("project-review" as const)
          : type.id === "idea"
            ? ("interview" as const)
            : type.templateId
    }));
    await context.withDataContext(owner, (db) =>
      types.put(db, { expectedRevision: 0, types: configured })
    );
    const meeting = await manual();
    const service = new MeetingOutputService(context, async () => ({
      content,
      modelRoute: "synthetic-integration"
    }));
    expect(await generate(meeting.meetingId, service)).toMatchObject({
      status: "saved",
      artifact: { templateId: "project-review", stale: false }
    });
    const reclassify = new MeetingOutputService(context, async () => ({
      content: { ...content, recording: { ...content.recording, typeId: "idea" } },
      modelRoute: "synthetic-integration"
    }));
    expect(await generate(meeting.meetingId, reclassify, 1)).toMatchObject({
      status: "saved",
      artifact: { templateId: "interview", stale: false }
    });
  });
  it("retains an explicit retired type on regeneration, but rejects automatic retired classification", async () => {
    const selected = await manual("work-meeting");
    await context.withDataContext(owner, (db) =>
      types.put(db, {
        expectedRevision: 0,
        types: defaults().map((type) => ({
          ...type,
          retired: type.id === "work-meeting",
          templateId: type.id === "work-meeting" ? "project-review" : type.templateId
        }))
      })
    );
    const service = new MeetingOutputService(context, async () => ({
      content,
      modelRoute: "synthetic-integration"
    }));
    expect(await generate(selected.meetingId, service)).toMatchObject({
      status: "saved",
      artifact: { templateId: "project-review", stale: false }
    });
    expect(
      await context.withDataContext(owner, (db) =>
        new RecordingMetadataRepository().get(db, selected.meetingId)
      )
    ).toMatchObject({ typeId: "work-meeting", typeSource: "user" });
    const automatic = await manual();
    expect(await generate(automatic.meetingId, service)).toMatchObject({
      status: "failed",
      code: "meeting_output_rejected_schema_invalid"
    });
  });
  it("exports retained configuration and deletes it with the account", async () => {
    const saved = await context.withDataContext(owner, (db) => types.put(db, input()));
    const exported = await context.withDataContext(owner, (db) =>
      collectMeetingsExportSection(db, { ...owner, requestId: randomUUID() })
    );
    expect(exported.recording_types).toEqual([
      { ownerUserId: ids.userA, revision: 1, typesJson: JSON.stringify(saved.types) }
    ]);
    const rollback = new Error("Rollback account-deletion assertion");
    await expect(
      bootstrap.transaction().execute(async (db) => {
        await sql`DELETE FROM app.users WHERE id=${ids.userA}::uuid`.execute(db);
        expect(
          (
            await sql`SELECT 1 FROM app.meeting_recording_types WHERE owner_user_id=${ids.userA}::uuid`.execute(
              db
            )
          ).rows
        ).toEqual([]);
        throw rollback;
      })
    ).rejects.toBe(rollback);
  });
  it("observes owner isolation fail with its policy removed, then restores it", async () => {
    await context.withDataContext(owner, (db) => types.put(db, input()));
    const assertHidden = () =>
      context.withDataContext({ actorUserId: ids.adminUser }, async (db) => {
        expect(
          (
            await sql`SELECT owner_user_id FROM app.meeting_recording_types WHERE owner_user_id=${ids.userA}::uuid`.execute(
              db.db
            )
          ).rows
        ).toEqual([]);
      });
    await assertHidden();
    try {
      await sql`ALTER POLICY meeting_recording_types_owner ON app.meeting_recording_types USING(true) WITH CHECK(true)`.execute(
        bootstrap
      );
      await expect(assertHidden()).rejects.toThrow();
      process.stdout.write(
        "RECORDING_TYPE_OWNER_NEGATIVE_CONTROL hiddenAssertion=failedAsExpected\n"
      );
    } finally {
      await sql`ALTER POLICY meeting_recording_types_owner ON app.meeting_recording_types USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id())`.execute(
        bootstrap
      );
    }
    await assertHidden();
  });
});
