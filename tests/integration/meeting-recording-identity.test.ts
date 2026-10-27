import Fastify from "fastify";
import { sql } from "kysely";
import { registerRecordingRoutes } from "../../packages/meetings/src/recording-routes.js";
import { DEFAULT_RECORDING_TYPES } from "../../packages/meetings/src/recording-types.js";
import { randomUUID } from "node:crypto";
import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { createDatabase, DataContextRunner } from "@moss/db";
import {
  MeetingOutputService,
  MeetingOutputsRepository,
  MeetingRecordsRepository,
  MeetingHistoryRepository,
  ManualEntryService,
  RecordingMetadataRepository
} from "@moss/meetings";
import type { RecordingInterpretation, ManualTranscriptInput } from "@moss/shared";
import { connectionStrings, ids, resetFoundationDatabase } from "./test-database.js";

const app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
const context = new DataContextRunner(app);
const bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
const worker = createDatabase({ connectionString: connectionStrings.worker });
const workerContext = new DataContextRunner(worker);
const owner = { actorUserId: ids.userA };
const records = new MeetingRecordsRepository();
const metadata = new RecordingMetadataRepository();
const interpretation: RecordingInterpretation = {
  title: "Wind and grass ideas",
  typeId: "brain-dump",
  side: "personal",
  confidence: 0.95,
  reason: "The speaker describes a personal hobby game.",
  ideaGroups: [{ title: "Wind", ideas: ["Animate grass in the wind."] }]
};
const content = {
  overview: "Ideas for wind and grass in a personal game.",
  decisions: [],
  actions: [],
  openQuestions: [],
  warnings: [],
  recording: interpretation
};
beforeAll(async () => {
  await resetFoundationDatabase();
});
afterAll(async () => {
  await Promise.all([app.destroy(), bootstrap.destroy(), worker.destroy()]);
});
async function manual(overrides: Partial<ManualTranscriptInput> = {}) {
  const jobs: { resourceId: string; idempotencyKey: string }[] = [];
  const service = new ManualEntryService(async (_db, payload) => {
    jobs.push(payload);
  });
  const input = {
    requestKey: randomUUID(),
    transcript: "Thinking aloud about my personal hobby game. Grass should move in the wind.",
    ...overrides
  };
  const result = await context.withDataContext(owner, (db) => service.create(db, owner, input));
  return { service, input, result, jobs };
}
describe("recording identity and pasted transcript admission (#3777)", () => {
  it("replays atomically without duplicate evidence or generation intent, and rejects changed input", async () => {
    const f = await manual();
    expect(
      await context.withDataContext(owner, (db) => f.service.create(db, owner, f.input))
    ).toEqual({ ...f.result, replayed: true });
    expect(f.jobs).toHaveLength(1);
    await expect(
      context.withDataContext(owner, (db) =>
        f.service.create(db, owner, { ...f.input, transcript: "Different input" })
      )
    ).rejects.toMatchObject({ code: "recording_request_conflict" });
    await context.withDataContext(owner, async (db) => {
      const input = await new MeetingOutputsRepository().inputs(db, f.result.meetingId);
      expect(input.transcript?.segments).toHaveLength(1);
      expect(input.transcript?.segments[0]).toMatchObject({
        text: f.input.transcript,
        finality: "final",
        provenance: "correction"
      });
      expect(input.recording?.metadata).toMatchObject({
        source: "manual-transcript",
        typeId: null,
        side: null,
        recordedAt: null
      });
    });
  });
  it("rolls back record and evidence when queue admission fails", async () => {
    const input = { requestKey: randomUUID(), transcript: "Some thoughts" };
    const service = new ManualEntryService(async () => {
      throw new Error("Queue unavailable");
    });
    await expect(
      context.withDataContext(owner, (db) => service.create(db, owner, input))
    ).rejects.toThrow("Queue unavailable");
    await context.withDataContext(owner, async (db) => {
      const row = await db.db
        .selectFrom("app.meeting_records")
        .select("id")
        .where("request_key", "=", input.requestKey)
        .executeTakeFirst();
      expect(row).toBeUndefined();
    });
  });
  it.each([ids.userB, ids.adminUser])(
    "hides identity, text and type-filter matches from another actor %s",
    async (actorUserId) => {
      const f = await manual();
      await context.withDataContext({ actorUserId }, async (db) => {
        expect(await metadata.get(db, f.result.meetingId)).toBeNull();
        expect(await records.get(db, f.result.meetingId)).toBeNull();
        expect(
          (
            await new MeetingHistoryRepository().search(db, {
              query: "grass",
              typeId: "brain-dump"
            })
          ).meetings
        ).toEqual([]);
        await expect(metadata.putType(db, f.result.meetingId, 0, "idea")).rejects.toMatchObject({
          code: "meeting_not_found"
        });
      });
    }
  );
  it("classifies, names and groups ideas in the single admitted generation, and preserves explicit choices", async () => {
    for (const chosenTitle of [undefined, "My chosen title", "Untitled meeting"]) {
      const explicit = chosenTitle !== undefined;
      const f = await manual(explicit ? { title: chosenTitle, typeId: "idea" } : {});
      let dispatches = 0;
      const service = new MeetingOutputService(context, async () => {
        dispatches++;
        return { content, modelRoute: "synthetic-integration" };
      });
      const job = f.jobs[0]!;
      const result = await service.generateAutomatic(owner, job.resourceId, job.idempotencyKey);
      expect(result).toMatchObject({
        status: "saved",
        artifact: { stale: false, content: { recording: interpretation } }
      });
      expect(
        await service.generateAutomatic(owner, job.resourceId, job.idempotencyKey)
      ).toMatchObject({ status: "saved", replayed: true });
      expect(dispatches).toBe(1);
      await context.withDataContext(owner, async (db) => {
        expect((await records.get(db, job.resourceId))?.title).toBe(
          explicit ? chosenTitle : interpretation.title
        );
        expect(await metadata.get(db, job.resourceId)).toMatchObject({
          typeId: explicit ? "idea" : "brain-dump",
          side: "personal",
          outputVersion: 1
        });
        const page = await new MeetingHistoryRepository().search(db, {
          query: "grass",
          typeId: explicit ? "idea" : "brain-dump",
          limit: 1
        });
        expect(page.meetings.some((item) => item.id === job.resourceId)).toBe(true);
      });
    }
  });
  it("retains a stale artifact without overwriting a concurrent user type or same-text title selection", async () => {
    const f = await manual();
    const job = f.jobs[0]!;
    const service = new MeetingOutputService(context, async () => {
      await context.withDataContext(owner, async (db) => {
        await metadata.putType(db, job.resourceId, 0, "conversation");
        await records.putTitle(db, {
          meetingId: job.resourceId,
          expectedTitle: "Untitled meeting",
          title: "Untitled meeting"
        });
      });
      return { content, modelRoute: "synthetic-integration" };
    });
    expect(
      await service.generateAutomatic(owner, job.resourceId, job.idempotencyKey)
    ).toMatchObject({ status: "saved", artifact: { stale: true } });
    await context.withDataContext(owner, async (db) => {
      expect((await records.get(db, job.resourceId))?.title).toBe("Untitled meeting");
      expect(await metadata.get(db, job.resourceId)).toMatchObject({
        typeId: "conversation",
        typeSource: "user",
        titleSource: "user",
        side: null
      });
    });
  });

  it("serves the strict manual API and replays one admission after concurrent retries", async () => {
    const server = Fastify();
    let actorUserId: string = ids.userA;
    let enqueued = 0;
    registerRecordingRoutes(server, {
      dataContext: context,
      resolveAccessContext: async () => ({ actorUserId }),
      manualSummaryEnqueue: async () => {
        enqueued++;
      }
    });
    const payload = { requestKey: randomUUID(), transcript: "A personal idea about grass." };
    try {
      const responses = await Promise.all(
        [0, 1].map(() =>
          server.inject({
            method: "POST",
            url: "/api/meetings/manual-transcripts",
            payload
          })
        )
      );
      expect(responses.map((r) => r.statusCode).sort()).toEqual([200, 201]);
      expect(enqueued).toBe(1);
      const id = responses[0]!.json().meetingId;
      const invalid = await server.inject({
        method: "POST",
        url: "/api/meetings/manual-transcripts",
        payload: { ...payload, side: "work" }
      });
      expect(invalid.statusCode).toBe(400);
      const get = await server.inject(`/api/meetings/records/${id}/recording`);
      expect(get.statusCode).toBe(200);
      expect(get.headers["cache-control"]).toBe("no-store");
      actorUserId = ids.adminUser;
      expect((await server.inject(`/api/meetings/records/${id}/recording`)).statusCode).toBe(404);
      actorUserId = ids.userA;
      await context.withDataContext(owner, (db) => records.remove(db, id));
      expect((await server.inject(`/api/meetings/records/${id}/recording`)).statusCode).toBe(404);
    } finally {
      await server.close();
    }
  });
  it("applies combined type/text filtering before cursor pagination", async () => {
    const marker = `filter${randomUUID().replaceAll("-", "")}`;
    const expected: string[] = [];
    for (const typeId of ["brain-dump", "idea", "brain-dump", "conversation", "brain-dump"]) {
      const f = await manual({ typeId, transcript: `${marker} personal grass ideas` });
      if (typeId === "brain-dump") expected.push(f.result.meetingId);
    }
    const actual: string[] = [];
    await context.withDataContext(owner, async (db) => {
      let before: import("@moss/shared").MeetingRecordCursor | undefined;
      for (let i = 0; i < 4; i++) {
        const page = await new MeetingHistoryRepository().search(db, {
          query: marker,
          typeId: "brain-dump",
          limit: 1,
          before
        });
        actual.push(...page.meetings.map((m) => m.id));
        if (!page.nextCursor) break;
        before = page.nextCursor;
      }
    });
    expect(actual.sort()).toEqual(expected.sort());
  });
  it("uses the worker role for admitted classification without losing owner choices", async () => {
    const f = await manual({ title: "Untitled meeting", typeId: "idea" });
    const service = new MeetingOutputService(workerContext, async () => ({
      content,
      modelRoute: "worker-integration"
    }));
    expect(
      await service.generateAutomatic(owner, f.jobs[0]!.resourceId, f.jobs[0]!.idempotencyKey)
    ).toMatchObject({ status: "saved", artifact: { stale: false } });
    await context.withDataContext(owner, async (db) => {
      expect((await records.get(db, f.result.meetingId))?.title).toBe("Untitled meeting");
      expect(await metadata.get(db, f.result.meetingId)).toMatchObject({
        typeId: "idea",
        side: "personal"
      });
    });
  });
  it("observes each owner-isolation assertion fail with its RLS policy removed, then restores it", async () => {
    const f = await manual();
    await context.withDataContext(owner, (db) =>
      sql`INSERT INTO app.meeting_recording_types(revision,types_json) VALUES(1,${JSON.stringify(DEFAULT_RECORDING_TYPES)})`.execute(
        db.db
      )
    );
    for (const table of [
      "meeting_recording_metadata",
      "meeting_manual_entries",
      "meeting_recording_types"
    ] as const) {
      const policy =
        table === "meeting_manual_entries"
          ? "meeting_manual_entries_owner"
          : table === "meeting_recording_types"
            ? "meeting_recording_types_owner"
            : "meeting_recording_metadata_owner";
      const assertHidden = () =>
        context.withDataContext({ actorUserId: ids.adminUser }, async (db) => {
          const rows =
            await sql`SELECT * FROM ${sql.id("app", table)} WHERE owner_user_id=${ids.userA}::uuid`.execute(
              db.db
            );
          expect(rows.rows).toEqual([]);
        });
      await assertHidden();
      try {
        await sql`ALTER POLICY ${sql.id(policy)} ON ${sql.id("app", table)} USING(true) WITH CHECK(true)`.execute(
          bootstrap
        );
        await expect(assertHidden()).rejects.toThrow();
        process.stdout.write(
          `RECORDING_OWNER_NEGATIVE_CONTROL table=${table} hiddenAssertion=failedAsExpected\n`
        );
      } finally {
        await sql`ALTER POLICY ${sql.id(policy)} ON ${sql.id("app", table)} USING(owner_user_id=app.current_actor_user_id()) WITH CHECK(owner_user_id=app.current_actor_user_id())`.execute(
          bootstrap
        );
      }
      await assertHidden();
    }
    await context.withDataContext(owner, (db) => records.remove(db, f.result.meetingId));
  });
});
