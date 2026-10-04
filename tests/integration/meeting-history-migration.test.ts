import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";
import { createDatabase, DataContextRunner, runSqlMigrations, type MossDatabase } from "@moss/db";
import {
  MeetingHistoryRepository,
  MeetingRecordsRepository,
  encodeMeetingTranscriptBatch,
  meetingsModuleSqlMigrationDirectory
} from "@moss/meetings";
import type { IngestMeetingTranscriptInput, MeetingOutputArtifact } from "@moss/shared";
import {
  assertIsolatedTestDatabase,
  connectionStrings,
  ids,
  resetFoundationDatabase
} from "./test-database.js";
let app: Kysely<MossDatabase>;
let bootstrap: Kysely<MossDatabase>;
let context: DataContextRunner;
const owner = { actorUserId: ids.userA };
beforeAll(async () => {
  assertIsolatedTestDatabase(connectionStrings.bootstrap);
  await resetFoundationDatabase();
  app = createDatabase({ connectionString: connectionStrings.app, maxConnections: 4 });
  bootstrap = createDatabase({ connectionString: connectionStrings.bootstrap });
  context = new DataContextRunner(app);
});
afterAll(async () => {
  await Promise.all([app?.destroy(), bootstrap?.destroy()]);
});
describe("0267 current-history upgrade", () => {
  it("backfills pre-projection Unicode data without altering authoritative bytes and skips completed replay", async () => {
    // Rewind only the new feature in this already guarded disposable server, as existing
    // migration-upgrade suites do. No checked-in or previously applied SQL file is edited.
    await sql`DROP TABLE app.meeting_history_segments;
      ALTER TABLE app.meeting_records DROP COLUMN history_search_terms;
      ALTER TABLE app.meeting_transcript_batches DROP COLUMN history_sources_json,DROP COLUMN history_omitted_sources;
      ALTER TABLE app.meeting_output_requests DROP COLUMN history_kind,DROP COLUMN history_result_status,DROP COLUMN history_result_code;
      ALTER TABLE app.meeting_output_artifacts DROP COLUMN history_origin,DROP COLUMN history_notes_revision,DROP COLUMN history_transcript_revision,DROP COLUMN history_stale;
      ALTER TABLE app.meeting_export_receipts DROP COLUMN history_write_status,DROP COLUMN history_index_status,DROP COLUMN history_updated_at;
      DELETE FROM app.schema_migrations WHERE version='0267'`.execute(bootstrap);
    const records = new MeetingRecordsRepository();
    const { meeting, encoded, artifactJson, resultJson } = await context.withDataContext(
      owner,
      async (db) => {
        const { meeting } = await records.create(db, {
          requestKey: randomUUID(),
          title: "legacyprojectiontitle"
        });
        await records.putNotes(db, {
          meetingId: meeting.id,
          requestKey: randomUUID(),
          expectedRevision: 0,
          personalNotes: "legacynotes"
        });
        const input: IngestMeetingTranscriptInput = {
          meetingId: meeting.id,
          requestKey: randomUUID(),
          expectedVersion: 0,
          stopCutoffMs: null,
          sources: [
            {
              sourceId: "mic",
              epoch: 1,
              kind: "microphone",
              label: "Mic\ud800",
              startMs: 0,
              endMs: 1000
            }
          ],
          events: [
            {
              cursor: 1,
              segment: {
                meetingId: meeting.id,
                segmentId: "\ud800",
                sourceId: "mic",
                epoch: 1,
                startMs: 0,
                endMs: 100,
                revision: 1,
                text: "legacyobsoleteword",
                finality: "provisional",
                provenance: "transcription",
                speakerId: null
              }
            },
            {
              cursor: 2,
              segment: {
                meetingId: meeting.id,
                segmentId: "\ud801",
                sourceId: "mic",
                epoch: 1,
                startMs: 100,
                endMs: 200,
                revision: 1,
                text: "legacyotherword\ud800",
                finality: "final",
                provenance: "transcription",
                speakerId: null
              }
            },
            {
              cursor: 3,
              segment: {
                meetingId: meeting.id,
                segmentId: "\ud800",
                sourceId: "mic",
                epoch: 1,
                startMs: 0,
                endMs: 100,
                revision: 2,
                text: "legacycurrentword😀",
                finality: "final",
                provenance: "correction",
                speakerId: null
              }
            }
          ]
        };
        const encoded = encodeMeetingTranscriptBatch(input);
        await db.db
          .insertInto("app.meeting_transcript_batches")
          .values({
            meeting_id: meeting.id,
            request_key: input.requestKey,
            version: 1,
            input_json: encoded,
            transcript_revision: 3,
            cursor: 3,
            stop_cutoff_ms: null
          })
          .execute();
        const artifact: MeetingOutputArtifact = {
          id: randomUUID(),
          meetingId: meeting.id,
          version: 1,
          inputs: {
            meetingId: meeting.id,
            personalNotes: "legacynotes",
            notesRevision: 1,
            transcript: null
          },
          templateId: "general",
          templateVersion: 1,
          modelRoute: "synthetic",
          origin: "manual",
          stale: false,
          createdAt: "2026-10-04T00:00:00.000Z",
          content: {
            overview: "accepted\0\ud800",
            decisions: [],
            openQuestions: [],
            actions: [],
            warnings: []
          }
        };
        const artifactJson = JSON.stringify(artifact);
        await db.db
          .insertInto("app.meeting_output_artifacts")
          .values({
            id: artifact.id,
            meeting_id: meeting.id,
            version: 1,
            artifact_json: artifactJson,
            inactive: false
          })
          .execute();
        const resultJson = JSON.stringify({ status: "saved", artifact, replayed: false });
        await db.db
          .insertInto("app.meeting_output_requests")
          .values({
            meeting_id: meeting.id,
            request_key: randomUUID(),
            input_json: '{"kind":"generate"}',
            result_json: resultJson
          })
          .execute();
        return { meeting, encoded, artifactJson, resultJson };
      }
    );
    const migrated = await runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: meetingsModuleSqlMigrationDirectory
    });
    expect(migrated.applied.map((item) => item.version)).toEqual(["0267"]);
    const history = new MeetingHistoryRepository();
    await context.withDataContext(owner, async (db) => {
      expect(
        (
          await history.search(db, {
            query: "legacyprojectiontitle legacynotes legacycurrentword legacyotherword"
          })
        ).meetings.map((item) => item.id)
      ).toEqual([meeting.id]);
      expect((await history.search(db, { query: "legacyobsoleteword" })).meetings).toEqual([]);
      expect((await history.get(db, meeting.id))?.transcript).toMatchObject({
        segmentCount: 2,
        finalSegmentCount: 2,
        provisionalSegmentCount: 0,
        sources: [{ kind: "microphone", label: "Mic\ud800" }]
      });
      expect(
        (
          await db.db
            .selectFrom("app.meeting_transcript_batches")
            .select("input_json")
            .where("meeting_id", "=", meeting.id)
            .executeTakeFirst()
        )?.input_json
      ).toBe(encoded);
      expect(
        (
          await db.db
            .selectFrom("app.meeting_output_artifacts")
            .select("artifact_json")
            .where("meeting_id", "=", meeting.id)
            .executeTakeFirst()
        )?.artifact_json
      ).toBe(artifactJson);
      expect(
        (
          await db.db
            .selectFrom("app.meeting_output_requests")
            .select("result_json")
            .where("meeting_id", "=", meeting.id)
            .executeTakeFirst()
        )?.result_json
      ).toBe(resultJson);
    });
    const flags = await sql<{
      name: string;
      enabled: boolean;
      forced: boolean;
    }>`SELECT relname AS name,relrowsecurity AS enabled,relforcerowsecurity AS forced FROM pg_class WHERE oid IN ('app.meeting_records'::regclass,'app.meeting_transcript_batches'::regclass,'app.meeting_history_segments'::regclass,'app.meeting_output_requests'::regclass,'app.meeting_output_artifacts'::regclass,'app.meeting_export_receipts'::regclass)`.execute(
      bootstrap
    );
    expect(flags.rows).toHaveLength(6);
    expect(flags.rows.every((row) => row.enabled && row.forced)).toBe(true);
    const replay = await runSqlMigrations({
      connectionString: connectionStrings.migration,
      migrationsDirectory: meetingsModuleSqlMigrationDirectory
    });
    expect(replay.applied).toEqual([]);
    expect(replay.skipped.some((item) => item.version === "0267")).toBe(true);
  });
});
