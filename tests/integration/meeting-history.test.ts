import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, Kysely, PostgresDialect, CompiledQuery } from "kysely";
import pg from "pg";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  MeetingHistoryRepository,
  MeetingRecordsRepository,
  MeetingTranscriptRepository,
  MeetingOutputsRepository
} from "@moss/meetings";
import { MeetingExportsRepository } from "../../packages/meetings/src/export-repository.js";
import type { IngestMeetingTranscriptInput } from "@moss/shared";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
let lastHistoryQuery: CompiledQuery | undefined;
const owner = { actorUserId: ids.userA };
const records = new MeetingRecordsRepository();
const transcripts = new MeetingTranscriptRepository();
const outputs = new MeetingOutputsRepository();
const exports = new MeetingExportsRepository();
const history = new MeetingHistoryRepository();
beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  app = new Kysely<MossDatabase>({
    dialect: new PostgresDialect({
      pool: new pg.Pool({ connectionString: connectionStrings.app, max: 4 })
    }),
    log: (event) => {
      if (
        event.level === "query" &&
        event.query.sql.trimStart().startsWith("WITH records AS MATERIALIZED")
      )
        lastHistoryQuery = event.query;
    }
  });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});
const create = (title: string) =>
  context.withDataContext(
    owner,
    async (db) => (await records.create(db, { requestKey: randomUUID(), title })).meeting
  );
const search = (input: Parameters<MeetingHistoryRepository["search"]>[1]) =>
  context.withDataContext(owner, (db) => history.search(db, input));
function batch(meetingId: string, text = "currentterm"): IngestMeetingTranscriptInput {
  return {
    meetingId,
    requestKey: randomUUID(),
    expectedVersion: 0,
    stopCutoffMs: null,
    sources: [
      { sourceId: "mic", epoch: 1, kind: "microphone", label: "Mic\ud800", startMs: 0, endMs: 1000 }
    ],
    events: [
      {
        cursor: 1,
        segment: {
          meetingId,
          segmentId: "\ud800",
          sourceId: "mic",
          epoch: 1,
          startMs: 10,
          endMs: 200,
          revision: 1,
          text,
          finality: "provisional",
          provenance: "transcription",
          speakerId: null
        }
      }
    ]
  };
}
const ingest = (input: IngestMeetingTranscriptInput) =>
  context.withDataContext(owner, (db) => transcripts.ingest(db, input));
describe("meeting history owner projection and indexed search", () => {
  it("searches beyond the first page, matches terms across documents and follows current corrections", async () => {
    const meeting = await create("crossdocumenttitle");
    await context.withDataContext(owner, (db) =>
      records.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 0,
        personalNotes: "crossdocumentnotes"
      })
    );
    const first = batch(meeting.id, "crossdocumentfirst");
    const input: IngestMeetingTranscriptInput = {
      ...first,
      events: [
        first.events[0]!,
        {
          cursor: 2,
          segment: {
            ...first.events[0]!.segment,
            segmentId: "\ud801",
            startMs: 300,
            endMs: 700,
            text: "crossdocumentother",
            finality: "final"
          }
        }
      ]
    };
    await ingest(input);
    for (let i = 0; i < 32; i++) await create(`Recent synthetic draft ${i}`);
    expect((await search({ limit: 30 })).meetings.map((item) => item.id)).not.toContain(meeting.id);
    const match = await search({
      query: "crossdocumenttitle crossdocumentnotes crossdocumentfirst crossdocumentother"
    });
    expect(match.meetings.map((item) => item.id)).toEqual([meeting.id]);
    expect(match.meetings[0]?.transcript).toMatchObject({
      segmentCount: 2,
      finalSegmentCount: 1,
      provisionalSegmentCount: 1,
      span: { startMs: 10, endMs: 700 }
    });
    const correction = {
      ...input,
      requestKey: randomUUID(),
      expectedVersion: 1,
      events: [
        {
          cursor: 3,
          segment: {
            ...input.events[0]!.segment,
            revision: 2,
            text: "replacementword",
            finality: "final" as const
          }
        }
      ]
    };
    await ingest(correction);
    await ingest(input); // An exact old retry must not restore old projection text.
    expect((await search({ query: "crossdocumentfirst" })).meetings).toEqual([]);
    expect(
      (await search({ query: "replacementword crossdocumentother" })).meetings.map(
        (item) => item.id
      )
    ).toEqual([meeting.id]);
    expect((await search({ query: "replacement" })).meetings).toEqual([]);
    expect((await search({ query: "!!!" })).meetings).toEqual([]);
    await expect(
      search({ query: Array.from({ length: 17 }, (_, index) => `term${index}`).join(" ") })
    ).rejects.toThrow("Invalid meeting history query");
    await context.withDataContext(owner, (db) =>
      records.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 1,
        personalNotes: "newnoteword"
      })
    );
    expect((await search({ query: "crossdocumentnotes" })).meetings).toEqual([]);
    expect(
      (await search({ query: "newnoteword replacementword" })).meetings.map((item) => item.id)
    ).toEqual([meeting.id]);
  });
  it("paginates equal-millisecond timestamps by UUID without skips or repeats", async () => {
    const meetingIds: string[] = [];
    for (let index = 0; index < 4; index++)
      meetingIds.push((await create("sameinstantpagination")).id);
    await bootstrap
      .updateTable("app.meeting_records")
      .set({ created_at: new Date("2026-10-04T00:00:00.123Z") })
      .where("id", "in", meetingIds)
      .execute();
    const seen: string[] = [];
    let before: { id: string; createdAt: string } | undefined;
    do {
      const page = await search({ query: "sameinstantpagination", limit: 1, before });
      seen.push(...page.meetings.map((item) => item.id));
      before = page.nextCursor ?? undefined;
    } while (before);
    expect(seen).toEqual([...meetingIds].sort().reverse());
  });
  it("rolls back transcript and projection together, preserves safe-integer offsets, and cascades deletion", async () => {
    const meeting = await create("rollbackprojection");
    const input = batch(meeting.id, "rollbackprivateword");
    await expect(
      context.withDataContext(owner, async (db) => {
        await transcripts.ingest(db, input);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect((await search({ query: "rollbackprivateword" })).meetings).toEqual([]);
    await ingest(input);
    await context.withDataContext(owner, async (db) => {
      const rows = await db.db
        .selectFrom("app.meeting_history_segments")
        .select(["segment_key", "revision"])
        .where("meeting_id", "=", meeting.id)
        .execute();
      expect(rows).toEqual([{ segment_key: JSON.stringify("\ud800"), revision: 1 }]);
      await records.remove(db, meeting.id);
      expect(await history.get(db, meeting.id)).toBeNull();
      expect(
        await db.db
          .selectFrom("app.meeting_history_segments")
          .select("meeting_id")
          .where("meeting_id", "=", meeting.id)
          .execute()
      ).toEqual([]);
    });
  });
  it("indexes a maximum-length accepted segment without an aggregate vector or large response", async () => {
    const meeting = await create("maxprojection");
    const words = Array.from({ length: 11000 }, (_, index) => `lex${index.toString(36)}`).join(" ");
    const text = `maximumsearchtoken ${words} `.padEnd(100000, " ");
    expect(text.length).toBe(100000);
    const maximum = batch(meeting.id, text);
    await ingest({
      ...maximum,
      events: [
        {
          ...maximum.events[0]!,
          segment: { ...maximum.events[0]!.segment, segmentId: "\ud800".repeat(256) }
        }
      ]
    });
    const result = await search({ query: "maximumsearchtoken lex8hj", filter: "needs-review" });
    expect(result.meetings.map((item) => item.id)).toEqual([meeting.id]);
    expect(JSON.stringify(result).length).toBeLessThan(3000);
    expect(JSON.stringify(result)).not.toContain(words);
    // Explain the exact production search/filter statement after executing it normally.
    // Do not force a GIN choice on a small fixture; inspect the natural runtime/RLS plan.
    const productionQuery = lastHistoryQuery!;
    await context.withDataContext(owner, async (db) => {
      await sql`SET LOCAL statement_timeout = '3s'`.execute(db.db);
      const explained = await db.db.executeQuery<{
        "QUERY PLAN": { "Execution Time": number; Plan: Record<string, unknown> }[];
      }>(
        CompiledQuery.raw(`EXPLAIN (ANALYZE, FORMAT JSON) ${productionQuery.sql}`, [
          ...productionQuery.parameters
        ])
      );
      const plan = explained.rows[0]!["QUERY PLAN"][0]!;
      expect(plan["Execution Time"]).toBeLessThan(3000);
      expect(JSON.stringify(plan.Plan)).toContain("meeting_history_segments");
      console.info(
        `[meeting-history] natural runtime-RLS search plan: ${plan["Execution Time"]} ms; default planner settings; maximum accepted segment fixture`
      );
    });
  });
  it.each([ids.userB, ids.adminUser])(
    "hides search/detail/direct projection from non-owner %s",
    async (actorUserId) => {
      const meeting = await create(`privatehistory-${actorUserId}`);
      await ingest(batch(meeting.id, "isolateduniqueword"));
      await context.withDataContext({ actorUserId }, async (db) => {
        expect((await history.search(db, { query: "isolateduniqueword" })).meetings).toEqual([]);
        expect(await history.get(db, meeting.id)).toBeNull();
        expect(
          await db.db
            .selectFrom("app.meeting_history_segments")
            .selectAll()
            .where("meeting_id", "=", meeting.id)
            .execute()
        ).toEqual([]);
      });
    }
  );
  it("observes owner-isolation assertion failing when projection RLS is removed, then restores it", async () => {
    const meeting = await create("projectionnegativecontrol");
    await ingest(batch(meeting.id));
    class IsolationProbe extends Error {}
    const assertInvisible = (rows: unknown[]) => {
      if (rows.length) throw new IsolationProbe("Owner projection isolation failed");
    };
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.meeting_history_segments DISABLE ROW LEVEL SECURITY`.execute(
          transaction
        );
        await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
        await sql`SELECT set_config('app.actor_user_id', ${ids.userB}, true)`.execute(transaction);
        const rows = await transaction
          .selectFrom("app.meeting_history_segments")
          .select("meeting_id")
          .where("meeting_id", "=", meeting.id)
          .execute();
        expect(rows).toEqual([{ meeting_id: meeting.id }]);
        assertInvisible(rows);
        throw new Error("Protection removal did not defeat assertion");
      })
    ).rejects.toBeInstanceOf(IsolationProbe);
    const flags = await sql<{
      enabled: boolean;
      forced: boolean;
    }>`SELECT relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid='app.meeting_history_segments'::regclass`.execute(
      bootstrap
    );
    expect(flags.rows).toEqual([{ enabled: true, forced: true }]);
    await context.withDataContext({ actorUserId: ids.userB }, async (db) =>
      assertInvisible(
        await db.db
          .selectFrom("app.meeting_history_segments")
          .select("meeting_id")
          .where("meeting_id", "=", meeting.id)
          .execute()
      )
    );
  });
  it("derives independent generation, stale-summary, candidate and latest/older export facts", async () => {
    const meeting = await create("receiptmetadatacase");
    await context.withDataContext(owner, async (db) => {
      await records.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 0,
        personalNotes: "Review action"
      });
      const inputs = await outputs.inputs(db, meeting.id);
      const artifact = await outputs.save(db, {
        meetingId: meeting.id,
        inputs,
        content: {
          overview: "Valid output\0\ud800",
          decisions: [],
          openQuestions: [],
          warnings: [],
          actions: [
            {
              text: "Review action",
              ownerPhrase: null,
              duePhrase: null,
              evidence: [
                {
                  kind: "personal-note",
                  meetingId: meeting.id,
                  notesRevision: 1,
                  startCharacter: 0,
                  endCharacter: 13
                }
              ]
            }
          ]
        },
        templateId: "general",
        templateVersion: 1,
        modelRoute: "synthetic",
        origin: "manual",
        stale: false
      });
      const requestKey = randomUUID();
      await outputs.reserve(
        db,
        meeting.id,
        requestKey,
        JSON.stringify({ kind: "generate", private: "\0\ud800" })
      );
      expect((await history.get(db, meeting.id))?.summary.generation?.status).toBe("pending");
      await outputs.finish(db, meeting.id, requestKey, {
        status: "failed",
        code: "meeting_output_interrupted"
      });
      await exports.intend(db, meeting.id, artifact.version, "synthetic exported content");
      const receipt = (await exports.receipt(db, meeting.id, artifact.version))!;
      await exports.finish(db, randomUUID(), {
        ...receipt,
        writeStatus: "saved",
        indexStatus: "delayed",
        updatedAt: "2026-10-04T00:00:00.000Z"
      });
      const newer = await outputs.save(db, {
        meetingId: meeting.id,
        inputs,
        content: artifact.content,
        templateId: "general",
        templateVersion: 1,
        modelRoute: "synthetic",
        origin: "manual",
        stale: false
      });
      await exports.intend(db, meeting.id, newer.version, "second synthetic export");
      const failed = (await exports.receipt(db, meeting.id, newer.version))!;
      await exports.finish(db, randomUUID(), {
        ...failed,
        writeStatus: "failed",
        indexStatus: "not-requested",
        updatedAt: "2026-10-04T00:00:01.000Z"
      });
      await records.putNotes(db, {
        meetingId: meeting.id,
        requestKey: randomUUID(),
        expectedRevision: 1,
        personalNotes: "Changed notes"
      });
      const item = (await history.get(db, meeting.id))!;
      expect(item.summary).toMatchObject({
        status: "stale",
        version: 2,
        generation: { status: "interrupted" }
      });
      expect(item.actions).toEqual({ pending: 1, accepted: 0, dismissed: 0 });
      expect(item.vault).toMatchObject({
        savedVersionCount: 1,
        latest: { artifactVersion: 2, writeStatus: "failed", indexStatus: "not-requested" }
      });
      expect(item.capture.status).toBe("unavailable");
    });
    expect(
      (await search({ query: "receiptmetadatacase", filter: "needs-review" })).meetings
    ).toHaveLength(1);
    expect(
      (await search({ query: "receiptmetadatacase", filter: "exported" })).meetings
    ).toHaveLength(1);
    expect(
      (await search({ query: "receiptmetadatacase", filter: "notes-only" })).meetings
    ).toHaveLength(1);
  });
});
