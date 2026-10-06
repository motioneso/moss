import { MEETING_RECORDING_NOTICE } from "@moss/shared";
import { MeetingRecordingNoticeRepository } from "../../packages/meetings/src/recording-notice.js";
import { randomUUID } from "node:crypto";
import type { DataContextDb } from "@moss/db";
import {
  MeetingOutputsRepository,
  MeetingRecordsRepository,
  MeetingTranscriptRepository
} from "@moss/meetings";
import type { IngestMeetingTranscriptInput, MeetingOutputContent } from "@moss/shared";
import { TasksRepository } from "@moss/tasks";
import { sql } from "kysely";
import { MeetingExportsRepository } from "../../packages/meetings/src/export-repository.js";

/** Independent export contract: original columns only, never the history search projection. */
export const meetingExportTables = [
  {
    key: "records",
    table: "meeting_records",
    columns: [
      "id",
      "owner_user_id",
      "request_key",
      "title",
      "personal_notes",
      "notes_revision",
      "created_at",
      "updated_at"
    ],
    derived: ["history_search_terms"]
  },
  {
    key: "note_writes",
    table: "meeting_note_writes",
    columns: [
      "meeting_id",
      "owner_user_id",
      "request_key",
      "expected_revision",
      "personal_notes",
      "saved_at"
    ],
    derived: []
  },
  {
    key: "transcript_batches",
    table: "meeting_transcript_batches",
    columns: [
      "meeting_id",
      "owner_user_id",
      "request_key",
      "version",
      "input_json",
      "transcript_revision",
      "cursor",
      "stop_cutoff_ms",
      "created_at"
    ],
    derived: ["history_sources_json", "history_omitted_sources"]
  },
  {
    key: "output_requests",
    table: "meeting_output_requests",
    columns: [
      "meeting_id",
      "owner_user_id",
      "request_key",
      "input_json",
      "expires_at",
      "result_json"
    ],
    derived: ["history_kind", "history_result_status", "history_result_code"]
  },
  {
    key: "output_artifacts",
    table: "meeting_output_artifacts",
    columns: [
      "id",
      "meeting_id",
      "owner_user_id",
      "version",
      "artifact_json",
      "inactive",
      "created_at"
    ],
    derived: [
      "history_origin",
      "history_notes_revision",
      "history_transcript_revision",
      "history_stale"
    ]
  },
  {
    key: "action_candidates",
    table: "meeting_action_candidates",
    columns: [
      "id",
      "meeting_id",
      "owner_user_id",
      "identity_key",
      "artifact_version",
      "proposal_json",
      "possible_match_ids",
      "review_state",
      "accepted_task_id"
    ],
    derived: []
  },
  {
    key: "export_receipts",
    table: "meeting_export_receipts",
    columns: ["meeting_id", "owner_user_id", "artifact_version", "content_hash", "receipt_json"],
    derived: ["history_write_status", "history_index_status", "history_updated_at"]
  },
  {
    key: "export_requests",
    table: "meeting_export_requests",
    columns: ["meeting_id", "owner_user_id", "request_key", "artifact_version", "result_json"],
    derived: []
  },
  {
    key: "capture_connections",
    table: "meeting_capture_connections",
    columns: [
      "device_id",
      "owner_user_id",
      "device_name",
      "inventory_json",
      "last_seen_at",
      "expires_at"
    ],
    derived: ["connection_id", "verifier_hash", "capability_revision", "revision"]
  },
  {
    key: "capture_start_cancellations",
    table: "meeting_capture_start_cancellations",
    columns: ["meeting_id", "owner_user_id", "request_key", "created_at"],
    derived: ["device_id", "connection_id"]
  },
  {
    key: "recording_notices",
    table: "meeting_recording_notices",
    columns: ["owner_user_id", "policy_version", "acknowledged_at"],
    derived: []
  },
  {
    key: "capture_grants",
    table: "meeting_capture_grants",
    columns: [
      "id",
      "meeting_id",
      "owner_user_id",
      "device_name",
      "status",
      "state_json",
      "notice_policy_version",
      "created_at",
      "expires_at"
    ],
    derived: [
      "credential_hash",
      "verifier_hash",
      "session_id",
      "device_id",
      "connection_id",
      "capability_revision",
      "claim_expires_at",
      "start_request_key",
      "start_fingerprint"
    ]
  }
] as const;

export type MeetingExportGroup = (typeof meetingExportTables)[number]["key"];
export type StoredMeetingExport = Record<MeetingExportGroup, Record<string, unknown>[]>;

export function camelCase(column: string): string {
  return column.replace(/_([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

export function normalizeStoredRow(row: Record<string, unknown>): Record<string, unknown> {
  // The selected original columns contain only scalar values, dates, and a JSONB string array.
  // TEXT JSON must remain text, including whitespace, escaped NUL, and lone surrogates.
  return Object.fromEntries(
    Object.entries(row).map(([column, value]) => [
      camelCase(column),
      value instanceof Date ? value.toISOString() : value
    ])
  );
}

export function sortExportRows(rows: readonly Record<string, unknown>[]) {
  const key = (row: Record<string, unknown>) =>
    JSON.stringify([row.id, row.meetingId, row.version, row.artifactVersion, row.requestKey]);
  return [...rows].sort((left, right) => key(left).localeCompare(key(right)));
}

export async function readStoredMeetingExport(db: DataContextDb): Promise<StoredMeetingExport> {
  const entries = [];
  for (const { key, table, columns } of meetingExportTables) {
    const { rows } = await sql<Record<string, unknown>>`
      SELECT ${sql.join(columns.map((column) => sql.ref(column)))}
      FROM ${sql.table(`app.${table}`)}
    `.execute(db.db);
    entries.push([key, rows.map(normalizeStoredRow)]);
  }
  return Object.fromEntries(entries) as StoredMeetingExport;
}

export function buildMeetingAccountExportInput(meetingId: string, marker: string) {
  const personalNotes = `${marker}: I will prepare the report tomorrow.`;
  const firstBatch: IngestMeetingTranscriptInput = {
    meetingId,
    requestKey: randomUUID(),
    expectedVersion: 0,
    stopCutoffMs: null,
    sources: [
      {
        sourceId: "mic",
        epoch: 1,
        kind: "microphone",
        label: "Owner mic\ud800",
        startMs: 0,
        endMs: 4000
      }
    ],
    events: [
      {
        cursor: 1,
        segment: {
          meetingId,
          segmentId: "segment\ud800",
          sourceId: "mic",
          epoch: 1,
          startMs: 100,
          endMs: 900,
          revision: 1,
          text: `${marker} original provisional wording`,
          finality: "provisional",
          provenance: "transcription",
          speakerId: "speaker-one"
        }
      }
    ]
  };
  const content: MeetingOutputContent = {
    overview: `${marker} overview with preserved escapes \0\ud800`,
    decisions: [],
    openQuestions: [],
    warnings: [],
    actions: [
      {
        text: `${marker} prepare report`,
        ownerPhrase: "I will",
        duePhrase: "tomorrow",
        evidence: [
          {
            kind: "personal-note",
            meetingId,
            notesRevision: 1,
            startCharacter: 0,
            endCharacter: personalNotes.length
          }
        ]
      }
    ]
  };
  return { personalNotes, firstBatch, content };
}

/** Repository writes plus one unfinished-request fixture; generated content never invokes AI. */
export async function seedMeetingAccountExport(
  db: DataContextDb,
  marker: string,
  staleVersionCount = 1
) {
  const records = new MeetingRecordsRepository();
  const transcripts = new MeetingTranscriptRepository();
  const outputs = new MeetingOutputsRepository();
  const exports = new MeetingExportsRepository();
  const tasks = new TasksRepository();
  const { meeting } = await records.create(db, {
    requestKey: randomUUID(),
    title: `${marker} planning meeting`
  });
  const { personalNotes, firstBatch, content } = buildMeetingAccountExportInput(meeting.id, marker);
  await records.putNotes(db, {
    meetingId: meeting.id,
    requestKey: randomUUID(),
    expectedRevision: 0,
    personalNotes
  });
  await transcripts.ingest(db, firstBatch);
  const firstInputs = await outputs.inputs(db, meeting.id);
  const generated = await outputs.save(db, {
    meetingId: meeting.id,
    inputs: firstInputs,
    content,
    templateId: "general",
    templateVersion: 1,
    modelRoute: "synthetic-stored-fixture",
    origin: "generated",
    stale: false
  });
  const generateKey = randomUUID();
  await outputs.reserve(
    db,
    meeting.id,
    generateKey,
    JSON.stringify(
      {
        kind: "generate",
        requestKey: generateKey,
        expectedOutputVersion: 0,
        expectedTranscriptRevision: 1,
        expectedNotesRevision: 1,
        templateId: "general",
        templateVersion: 1
      },
      null,
      2
    )
  );
  await outputs.finish(db, meeting.id, generateKey, { status: "saved", artifact: generated });
  const [firstCandidate] = await outputs.candidates(db, meeting.id);
  if (!firstCandidate) throw new Error("Fixture did not create a candidate");
  const accepted = await outputs.review(
    db,
    meeting.id,
    firstCandidate.id,
    {
      requestKey: randomUUID(),
      decision: "accept",
      title: `${marker} reviewed Task`,
      dueAt: null
    },
    (transaction, input) => tasks.create(transaction, input)
  );
  const manual = await outputs.edit(db, meeting.id, {
    requestKey: randomUUID(),
    expectedOutputVersion: 1,
    content: {
      ...content,
      overview: `${marker} manually edited overview \0\ud800`,
      actions: [{ ...content.actions[0]!, text: `${marker} manually clarified report` }]
    }
  });
  const manualCandidate = (await outputs.candidates(db, meeting.id)).find(
    (candidate) => candidate.artifactVersion === manual.version
  );
  if (!manualCandidate) throw new Error("Fixture did not create a manual candidate");
  await outputs.review(
    db,
    meeting.id,
    manualCandidate.id,
    {
      requestKey: randomUUID(),
      decision: "dismiss"
    },
    (transaction, input) => tasks.create(transaction, input)
  );
  await records.putNotes(db, {
    meetingId: meeting.id,
    requestKey: randomUUID(),
    expectedRevision: 1,
    personalNotes: `${personalNotes} Owner correction.`
  });
  await transcripts.ingest(db, {
    ...firstBatch,
    requestKey: randomUUID(),
    expectedVersion: 1,
    stopCutoffMs: 4000,
    events: [
      {
        cursor: 2,
        segment: {
          ...firstBatch.events[0]!.segment,
          revision: 2,
          text: `${marker} corrected final wording`,
          finality: "final",
          provenance: "correction"
        }
      }
    ]
  });
  // More than the interactive output-history cap for one owner proves the export is unpaged.
  for (let index = 0; index < staleVersionCount; index++) {
    await outputs.save(db, {
      ...generated,
      content: { ...content, overview: `${marker} stale generation ${index}` },
      stale: true
    });
  }
  const currentInputs = await outputs.inputs(db, meeting.id);
  const current = await outputs.save(db, {
    ...generated,
    inputs: currentInputs,
    content: {
      ...content,
      overview: `${marker} current generated overview`,
      actions: [
        {
          ...content.actions[0]!,
          text: `${marker} current report proposal`,
          evidence: [
            {
              kind: "personal-note",
              meetingId: meeting.id,
              notesRevision: 2,
              startCharacter: 0,
              endCharacter: currentInputs.personalNotes.length
            }
          ]
        }
      ]
    }
  });
  // An expired but unfinished request is retained as stored; collection must not reconcile it.
  await db.db
    .insertInto("app.meeting_output_requests")
    .values({
      meeting_id: meeting.id,
      request_key: randomUUID(),
      input_json: JSON.stringify({ kind: "generate", marker, retained: "\0\ud800" }, null, 2),
      expires_at: new Date("2026-01-01T00:00:00.000Z"),
      result_json: null,
      history_kind: "generate"
    })
    .execute();
  const failedKey = randomUUID();
  await outputs.reserve(db, meeting.id, failedKey, JSON.stringify({ kind: "generate", marker }));
  await outputs.finish(db, meeting.id, failedKey, {
    status: "failed",
    code: "meeting_output_interrupted",
    requestKey: failedKey
  });
  for (const artifact of [generated, manual, current]) {
    await exports.intend(
      db,
      meeting.id,
      artifact.version,
      `${marker} stored export v${artifact.version}`
    );
    const requestKey = randomUUID();
    await exports.reserve(db, meeting.id, requestKey, artifact.version);
    const receipt = await exports.receipt(db, meeting.id, artifact.version);
    if (!receipt) throw new Error("Fixture did not create a vault receipt");
    if (artifact === current) continue;
    await exports.finish(db, requestKey, {
      ...receipt,
      writeStatus: artifact === generated ? "saved" : "failed",
      indexStatus: artifact === generated ? "queued" : "not-requested",
      noteReference: artifact === generated ? `notes/generated/${meeting.id}/v1.md` : null,
      indexJobId: artifact === generated ? randomUUID() : null,
      errorCode: artifact === generated ? null : "meeting_vault_write_failed",
      updatedAt: "2026-10-04T12:00:00.123Z"
    });
  }
  await new MeetingRecordingNoticeRepository().acknowledge(
    db,
    MEETING_RECORDING_NOTICE.policyVersion
  );
  await sql`INSERT INTO app.meeting_capture_connections (device_id,connection_id,device_name,verifier_hash,capability_revision,inventory_json,last_seen_at,expires_at) VALUES (${randomUUID()}::uuid,${randomUUID()}::uuid,${marker + " connection"},${"0".repeat(64)},1,'{}',now(),now()+interval '1 hour')`.execute(
    db.db
  );
  await sql`INSERT INTO app.meeting_capture_start_cancellations (meeting_id,request_key,device_id,connection_id) VALUES (${meeting.id}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid)`.execute(
    db.db
  );
  await sql`INSERT INTO app.meeting_capture_grants
    (meeting_id,device_id,device_name,verifier_hash,status,state_json,expires_at)
    VALUES (${meeting.id}::uuid,${randomUUID()}::uuid,${marker + " synthetic Mac"},${"0".repeat(64)},'revoked',
      ${JSON.stringify({ gaps: [{ id: randomUUID(), sourceId: "microphone", epoch: 1, startMs: 0, endMs: 1000, reason: "interrupted" }] })},
      ${new Date("2026-01-01T00:00:00Z")})`.execute(db.db);
  return {
    marker,
    meetingId: meeting.id,
    acceptedTaskId: accepted.acceptedTaskId,
    artifactCount: staleVersionCount + 3,
    expected: await readStoredMeetingExport(db)
  };
}
