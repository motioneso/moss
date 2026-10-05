import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, type MossDatabase } from "@moss/db";
import {
  MeetingRecordsRepository,
  MeetingTranscriptRepository,
  MeetingTranscriptInputError,
  MeetingTranscriptRequestConflictError
} from "@moss/meetings";
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
const records = new MeetingRecordsRepository();
const transcripts = new MeetingTranscriptRepository();
const owner = ids.userA;
const selection = { maxSegments: 500, maxCharacters: 100000 };
beforeAll(async () => {
  // This suite is run only through the supported isolated verify-gate workflow.
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});
async function fixture() {
  const { meeting } = await context.withDataContext({ actorUserId: owner }, (db) =>
    records.create(db, { requestKey: randomUUID(), title: "Synthetic transcript fixture" })
  );
  const input: IngestMeetingTranscriptInput = {
    meetingId: meeting.id,
    requestKey: randomUUID(),
    expectedVersion: 0,
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
    stopCutoffMs: null,
    events: [
      {
        cursor: 1,
        segment: {
          meetingId: meeting.id,
          segmentId: "segment-one",
          sourceId: "mic",
          epoch: 1,
          startMs: 0,
          endMs: 900,
          revision: 1,
          text: "Original synthetic evidence",
          finality: "final",
          provenance: "transcription",
          speakerId: null
        }
      }
    ]
  };
  return input;
}
const ingest = (input: IngestMeetingTranscriptInput) =>
  context.withDataContext({ actorUserId: owner }, (db) => transcripts.ingest(db, input));

class TranscriptIsolationProbeError extends Error {}
function assertTranscriptInvisible(rows: readonly unknown[]) {
  if (rows.length)
    throw new TranscriptIsolationProbeError("Transcript owner-isolation assertion failed");
}

describe("persisted meeting transcript ledger", () => {
  it("replays uppercase UUID request and meeting identities canonically", async () => {
    const base = await fixture();
    const input = {
      ...base,
      meetingId: base.meetingId.toUpperCase(),
      requestKey: base.requestKey.toUpperCase(),
      events: base.events.map((event) => ({
        ...event,
        segment: { ...event.segment, meetingId: base.meetingId.toUpperCase() }
      }))
    };
    const first = await ingest(input);
    expect(first).toMatchObject({ status: "saved", replayed: false });
    expect(await ingest(input)).toEqual({ ...first, replayed: true });
    expect(await ingest(base)).toEqual({ ...first, replayed: true });
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      expect((await transcripts.snapshot(db, input.meetingId, selection))?.meetingId).toBe(
        base.meetingId
      );
      expect(
        await transcripts.evidence(db, {
          meetingId: input.meetingId,
          segmentId: "segment-one",
          segmentRevision: 1,
          startCharacter: 0,
          endCharacter: 8
        })
      ).not.toBeNull();
    });
  });

  it("serializes concurrent exact retries and preserves original receipts after later writes", async () => {
    const input = await fixture();
    const results = await Promise.all([ingest(input), ingest(input)]);
    expect(results.filter((result) => result.status === "saved" && result.replayed)).toHaveLength(
      1
    );
    const original = results.find((result) => result.status === "saved" && !result.replayed)!;
    const next = {
      ...input,
      requestKey: randomUUID(),
      expectedVersion: 1,
      events: [
        {
          cursor: 2,
          segment: {
            ...input.events[0]!.segment,
            revision: 2,
            provenance: "correction" as const,
            text: "Corrected synthetic evidence"
          }
        }
      ]
    };
    expect(await ingest(next)).toMatchObject({
      status: "saved",
      receipt: { version: 2, transcriptRevision: 2 }
    });
    expect(await ingest(input)).toEqual({ ...original, replayed: true });
    await expect(ingest({ ...input, stopCutoffMs: 1000 })).rejects.toBeInstanceOf(
      MeetingTranscriptRequestConflictError
    );
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      expect((await transcripts.snapshot(db, input.meetingId, selection))?.segments[0]?.text).toBe(
        "Corrected synthetic evidence"
      );
      expect(
        (await transcripts.snapshot(db, input.meetingId, { ...selection, transcriptRevision: 1 }))
          ?.segments[0]?.text
      ).toBe("Original synthetic evidence");
      expect(
        await transcripts.evidence(db, {
          meetingId: input.meetingId,
          segmentId: "segment-one",
          segmentRevision: 1,
          startCharacter: 0,
          endCharacter: 8
        })
      ).toMatchObject({ excerpt: "Original", segment: { revision: 1 } });
    });
  });
  it("allows only one concurrent new version and rolls back input and receipts together", async () => {
    const input = await fixture();
    const results = await Promise.all([
      ingest(input),
      ingest({ ...input, requestKey: randomUUID() })
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["conflict", "saved"]);
    const next = {
      ...input,
      requestKey: randomUUID(),
      expectedVersion: 1,
      events: [],
      stopCutoffMs: 1000
    };
    await expect(
      context.withDataContext({ actorUserId: owner }, async (db) => {
        await transcripts.ingest(db, next);
        throw new Error("rollback");
      })
    ).rejects.toThrow("rollback");
    expect(await ingest(next)).toMatchObject({
      status: "saved",
      replayed: false,
      receipt: { version: 2 }
    });
  });
  it.each([ids.userB, ids.adminUser])(
    "blocks reads and writes for non-owner %s including direct-table access",
    async (actorUserId) => {
      const input = await fixture();
      await ingest(input);
      await context.withDataContext({ actorUserId }, async (db) => {
        expect(await transcripts.snapshot(db, input.meetingId, selection)).toBeNull();
        expect(
          await transcripts.evidence(db, {
            meetingId: input.meetingId,
            segmentId: "segment-one",
            segmentRevision: 1,
            startCharacter: 0,
            endCharacter: 8
          })
        ).toBeNull();
        expect(
          await transcripts.ingest(db, { ...input, requestKey: randomUUID(), expectedVersion: 1 })
        ).toEqual({ status: "not-found" });
        // This assertion must fail if the new table's owner policy is widened or disabled.
        expect(
          await db.db
            .selectFrom("app.meeting_transcript_batches")
            .selectAll()
            .where("meeting_id", "=", input.meetingId)
            .execute()
        ).toEqual([]);
      });
      await expect(
        context.withDataContext({ actorUserId }, (db) =>
          db.db
            .insertInto("app.meeting_transcript_batches")
            .values({
              meeting_id: input.meetingId,
              owner_user_id: owner,
              request_key: randomUUID(),
              version: 2,
              input_json: "{}",
              transcript_revision: 0,
              cursor: 0,
              stop_cutoff_ms: null
            })
            .execute()
        )
      ).rejects.toMatchObject({ code: "42501" });
      await expect(
        context.withDataContext({ actorUserId }, (db) =>
          db.db
            .insertInto("app.meeting_transcript_batches")
            .values({
              meeting_id: input.meetingId,
              owner_user_id: actorUserId,
              request_key: randomUUID(),
              version: 2,
              input_json: "{}",
              transcript_revision: 0,
              cursor: 0,
              stop_cutoff_ms: null
            })
            .execute()
        )
      ).rejects.toMatchObject({ code: "23503" });
    }
  );
  it("bounds source epochs, immutable stop cutoff, and snapshot coverage", async () => {
    const input = await fixture();
    await ingest(input);
    const next = {
      ...input,
      requestKey: randomUUID(),
      expectedVersion: 1,
      stopCutoffMs: 1000,
      events: []
    };
    await ingest(next);
    for (const stopCutoffMs of [null, 999, 2000])
      await expect(
        ingest({ ...next, requestKey: randomUUID(), expectedVersion: 2, stopCutoffMs })
      ).rejects.toBeInstanceOf(MeetingTranscriptInputError);
    await expect(
      ingest({
        ...next,
        requestKey: randomUUID(),
        expectedVersion: 2,
        sources: [{ ...input.sources[0]!, endMs: 1001 }]
      })
    ).rejects.toBeInstanceOf(MeetingTranscriptInputError);
    await context.withDataContext({ actorUserId: owner }, async (db) => {
      const snapshot = await transcripts.snapshotWithSources(db, input.meetingId, {
        ...selection,
        cutoffMs: 5000
      });
      expect(snapshot?.snapshot).toMatchObject({
        cutoffMs: 1000,
        throughMs: 900,
        transcriptRevision: 1
      });
      expect(snapshot?.sources).toEqual(input.sources);
      expect(
        (await transcripts.snapshot(db, input.meetingId, { ...selection, cutoffMs: 800 }))?.segments
      ).toEqual([]);
      expect(
        (await transcripts.snapshot(db, input.meetingId, { ...selection, maxCharacters: 1 }))
          ?.omittedSegments
      ).toBe(1);
    });
  });
  it("forbids runtime mutation/deletion of revisions and cascades owner deletion", async () => {
    const input = await fixture();
    await ingest(input);
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        db.db
          .updateTable("app.meeting_transcript_batches")
          .set({ input_json: "{}" })
          .where("meeting_id", "=", input.meetingId)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        db.db
          .deleteFrom("app.meeting_transcript_batches")
          .where("meeting_id", "=", input.meetingId)
          .execute()
      )
    ).rejects.toMatchObject({ code: "42501" });
    await context.withDataContext({ actorUserId: owner }, (db) =>
      records.remove(db, input.meetingId)
    );
    expect(
      await bootstrap
        .selectFrom("app.meeting_transcript_batches")
        .selectAll()
        .where("meeting_id", "=", input.meetingId)
        .execute()
    ).toEqual([]);
  });
  it("observes the owner assertion fail with RLS removed and restores it by rollback", async () => {
    assertIsolatedTestDatabase(connectionStrings.bootstrap);
    const expectedDatabase = new URL(connectionStrings.bootstrap).pathname.slice(1);
    if (!/^(jarvis_gate_|jarvis_test_)/.test(expectedDatabase))
      throw new Error("Mutation probe requires a disposable gate/test database");
    const database = await sql<{ name: string }>`SELECT current_database() AS name`.execute(
      bootstrap
    );
    expect(database.rows[0]?.name).toBe(expectedDatabase);
    const input = await fixture();
    await ingest(input);
    const protectedCheck = () =>
      context.withDataContext({ actorUserId: ids.userB }, async (db) => {
        const rows = await db.db
          .selectFrom("app.meeting_transcript_batches")
          .select("meeting_id")
          .where("meeting_id", "=", input.meetingId)
          .execute();
        assertTranscriptInvisible(rows);
      });
    await protectedCheck();
    // ALTER is transactional and holds its table lock until this deliberate error rolls back.
    // No policy removal can commit, including on unexpected SQL/assertion failures.
    await expect(
      bootstrap.transaction().execute(async (transaction) => {
        await sql`ALTER TABLE app.meeting_transcript_batches DISABLE ROW LEVEL SECURITY`.execute(
          transaction
        );
        await sql`SET LOCAL ROLE jarvis_app_runtime`.execute(transaction);
        await sql`SELECT set_config('app.actor_user_id', ${ids.userB}, true)`.execute(transaction);
        const principal = await sql<{
          role: string;
          actor: string;
        }>`SELECT current_user AS role, current_setting('app.actor_user_id') AS actor`.execute(
          transaction
        );
        expect(principal.rows).toEqual([{ role: "jarvis_app_runtime", actor: ids.userB }]);
        const rows = await transaction
          .selectFrom("app.meeting_transcript_batches")
          .select("meeting_id")
          .where("meeting_id", "=", input.meetingId)
          .execute();
        expect(rows).toEqual([{ meeting_id: input.meetingId }]);
        assertTranscriptInvisible(rows);
        throw new Error("Mutation did not defeat owner-isolation assertion");
      })
    ).rejects.toBeInstanceOf(TranscriptIsolationProbeError);
    const restored = await sql<{
      enabled: boolean;
      forced: boolean;
    }>`SELECT relrowsecurity AS enabled, relforcerowsecurity AS forced FROM pg_class WHERE oid = 'app.meeting_transcript_batches'::regclass`.execute(
      bootstrap
    );
    expect(restored.rows).toEqual([{ enabled: true, forced: true }]);
    await protectedCheck();
  });

  it("declares forced RLS and finite storage bounds", async () => {
    const flags = await sql<{
      relrowsecurity: boolean;
      relforcerowsecurity: boolean;
    }>`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'app.meeting_transcript_batches'::regclass`.execute(
      bootstrap
    );
    expect(flags.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
    const input = await fixture();
    await expect(
      context.withDataContext({ actorUserId: owner }, (db) =>
        db.db
          .insertInto("app.meeting_transcript_batches")
          .values({
            meeting_id: input.meetingId,
            request_key: randomUUID(),
            version: 4097,
            input_json: "{}",
            transcript_revision: 0,
            cursor: 0,
            stop_cutoff_ms: null
          })
          .execute()
      )
    ).rejects.toMatchObject({ code: "23514" });
  });
});
