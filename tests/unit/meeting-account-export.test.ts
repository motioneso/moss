import { readFile } from "node:fs/promises";
import {
  DummyDriver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type CompiledQuery,
  type DatabaseConnection,
  type Transaction
} from "kysely";
import { describe, expect, it } from "vitest";

import { dataContextBrand, type DataContextDb, type MossDatabase } from "@moss/db";
import { collectMeetingsExportSection } from "../../packages/meetings/src/data-lifecycle.js";
import { meetingsModuleManifest } from "../../packages/meetings/src/manifest.js";
import { validateMeetingOutput } from "../../packages/meetings/src/output-validation.js";
import {
  applyMeetingTranscriptBatch,
  encodeMeetingTranscriptBatch
} from "../../packages/meetings/src/transcript-batch.js";
import { buildMeetingAccountExportInput } from "../integration/meeting-account-export-fixtures.js";

const ctx = {
  actorUserId: "00000000-0000-4000-8000-000000000001",
  requestId: "meeting-account-export-unit"
};
const collections = [
  "records",
  "note_writes",
  "transcript_batches",
  "output_requests",
  "output_artifacts",
  "action_candidates",
  "export_receipts",
  "export_requests",
  "capture_connections",
  "capture_start_cancellations",
  "stop_summaries",
  "recording_notices",
  "capture_grants"
] as const;

function harness(rows: Record<string, readonly Record<string, unknown>[]> = {}) {
  const queries: CompiledQuery[] = [];
  const connection = {
    async executeQuery(query: CompiledQuery) {
      queries.push(query);
      const table = query.sql.match(/FROM app\.(\w+)/)?.[1];
      return { rows: table ? (rows[table] ?? []) : [] };
    },
    streamQuery() {
      throw new Error("Streaming is not part of Meetings account export");
    }
  } as unknown as DatabaseConnection;
  class ExportDriver extends DummyDriver {
    override async acquireConnection(): Promise<DatabaseConnection> {
      return connection;
    }
  }
  const db = new Kysely<MossDatabase>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => new ExportDriver(),
      createIntrospector: (value) => new PostgresIntrospector(value),
      createQueryCompiler: () => new PostgresQueryCompiler()
    }
  });
  const scopedDb: DataContextDb = {
    db: db as unknown as Transaction<MossDatabase>,
    [dataContextBrand]: true
  };
  return { db, queries, scopedDb };
}

describe("Meetings account-export collector", () => {
  it("uses a valid populated integration fixture with exact cited owner and due phrases", () => {
    const meetingId = "00000000-0000-4000-8000-000000000002";
    const { content, personalNotes } = buildMeetingAccountExportInput(meetingId, "UNIT-FIXTURE");
    const inputs = { meetingId, notesRevision: 1, personalNotes, transcript: null };
    expect(validateMeetingOutput(content, inputs)).toEqual(content);
    expect(content.overview).toContain("\0\ud800");
    expect(() =>
      validateMeetingOutput(content, { ...inputs, personalNotes: "unrelated text" })
    ).toThrow("Invalid meeting output");
  });

  it("accepts the fixture transcript and preserves provenance and non-scalar text", () => {
    const meetingId = "00000000-0000-4000-8000-000000000002";
    const { firstBatch } = buildMeetingAccountExportInput(meetingId, "UNIT-FIXTURE");
    const encoded = encodeMeetingTranscriptBatch(firstBatch);
    expect(JSON.parse(encoded)).toEqual(firstBatch);
    const ledger = applyMeetingTranscriptBatch(null, ctx.actorUserId, null, firstBatch);
    expect(ledger.transcriptRevision).toBe(1);
    expect(ledger.sources[0]?.label).toBe("Owner mic\ud800");
  });

  it("rejects unscoped access before querying", async () => {
    for (const unscoped of [undefined, null, {}, { db: {} }]) {
      await expect(collectMeetingsExportSection(unscoped, ctx)).rejects.toThrow(
        "Repository access requires withDataContext"
      );
    }
  });

  it("declares the module-owned collector in the account-export manifest", () => {
    expect(meetingsModuleManifest.dataLifecycle.exportSections).toContainEqual({
      key: "meetings",
      displayName: "Meetings",
      collect: collectMeetingsExportSection
    });
    expect(meetingsModuleManifest.database.migrations).toContain(
      "sql/0283_meeting_account_export.sql"
    );
  });

  it("reads exactly thirteen source tables with explicit columns, actor predicates and stable order", async () => {
    const { db, queries, scopedDb } = harness();
    try {
      const section = await collectMeetingsExportSection(scopedDb, ctx);
      expect(section).toEqual(Object.fromEntries(collections.map((key) => [key, []])));
      expect(queries).toHaveLength(collections.length);
      for (const [index, query] of queries.entries()) {
        expect(query.sql).toContain(`FROM app.meeting_${collections[index]}`);
        expect(query.sql).toMatch(/WHERE owner_user_id = \$1::uuid/);
        expect(query.parameters).toEqual([ctx.actorUserId]);
        expect(query.sql).toMatch(/ORDER BY/);
        expect(query.sql).not.toMatch(/\*|history_|search_terms|JOIN|LIMIT|OFFSET|\bDELETE\b/i);
      }
      expect(queries[0]?.sql).toMatch(/ORDER BY created_at, id/);
      expect(queries[1]?.sql).toMatch(/ORDER BY meeting_id, expected_revision, request_key/);
      expect(queries[2]?.sql).toMatch(/ORDER BY meeting_id, version/);
      expect(queries[4]?.sql).toMatch(/ORDER BY meeting_id, version/);
      // An account export includes inactive, older and manual artifacts with no status filter.
      expect(queries[8]?.sql).not.toMatch(/credential_hash|verifier_hash|session_id/);
      expect(queries[4]?.sql).toMatch(/WHERE owner_user_id = \$1::uuid\s+ORDER BY/);
    } finally {
      await db.destroy();
    }
  });

  it("allowlists recording export metadata without connection proofs or authorization material", async () => {
    const expected = {
      meeting_capture_connections: [
        "device_id",
        "owner_user_id",
        "device_name",
        "inventory_json",
        "last_seen_at",
        "expires_at"
      ],
      meeting_capture_start_cancellations: [
        "meeting_id",
        "owner_user_id",
        "request_key",
        "created_at"
      ],
      meeting_capture_grants: [
        "id",
        "meeting_id",
        "owner_user_id",
        "device_name",
        "status",
        "state_json",
        "notice_policy_version",
        "created_at",
        "expires_at"
      ]
    };
    const { db, queries, scopedDb } = harness();
    try {
      await collectMeetingsExportSection(scopedDb, ctx);
      for (const [table, columns] of Object.entries(expected)) {
        const query = queries.find((query) => query.sql.includes(`FROM app.${table}`))!;
        expect(query).toBeDefined();
        const selected = query.sql.match(/SELECT\s+([\s\S]*?)\s+FROM/)?.[1];
        expect(selected?.split(",").map((part) => part.trim().split(/\s|::/)[0])).toEqual(columns);
        expect(query.sql).not.toMatch(
          /credential_hash|verifier_hash|proof_hash|session_id|connection_id|capability_revision|start_request_key|start_fingerprint|\btoken\b/i
        );
      }
    } finally {
      await db.destroy();
    }
  });

  it("keeps retained JSON text exact and normalizes dates, nulls and nested JSON values", async () => {
    const timestamp = new Date("2026-10-01T10:00:00.123Z");
    // TEXT JSON preserves unpaired surrogates, whitespace, and evidence from old revisions.
    const inputJson = '{ "events": [{"text":"older \\ud800 evidence"}], "sources": [] }';
    const artifactJson = '{ "origin": "manual", "stale": true, "summary": "old version" }';
    const { db, queries, scopedDb } = harness({
      meeting_records: [{ id: "record", personalNotes: "latest notes", createdAt: timestamp }],
      meeting_note_writes: [
        { personalNotes: "old notes", expectedRevision: 0, savedAt: timestamp }
      ],
      meeting_transcript_batches: [{ inputJson, stopCutoffMs: null, cursor: 2 }],
      meeting_output_requests: [{ inputJson, expiresAt: timestamp, resultJson: null }],
      meeting_output_artifacts: [{ version: 1, inactive: true, artifactJson }],
      meeting_action_candidates: [
        {
          reviewState: "accepted",
          acceptedTaskId: "task-ref",
          proposalJson: "{}",
          possibleMatchIds: ["candidate-ref"],
          nested: { values: [null, true, 1, "text", { timestamp }] }
        }
      ],
      meeting_export_receipts: [{ receiptJson: '{"writeStatus":"saved"}' }],
      meeting_export_requests: [{ resultJson: null }]
    });
    try {
      const result = await collectMeetingsExportSection(scopedDb, ctx);
      expect(result.records[0]?.createdAt).toBe(timestamp.toISOString());
      expect(result.note_writes[0]?.savedAt).toBe(timestamp.toISOString());
      expect(result.transcript_batches).toEqual([{ inputJson, stopCutoffMs: null, cursor: 2 }]);
      expect(result.output_requests).toEqual([
        { inputJson, expiresAt: timestamp.toISOString(), resultJson: null }
      ]);
      expect(result.output_artifacts).toEqual([{ version: 1, inactive: true, artifactJson }]);
      expect(result.action_candidates).toEqual([
        {
          reviewState: "accepted",
          acceptedTaskId: "task-ref",
          proposalJson: "{}",
          possibleMatchIds: ["candidate-ref"],
          nested: { values: [null, true, 1, "text", { timestamp: timestamp.toISOString() }] }
        }
      ]);
      expect(result.export_receipts).toEqual([{ receiptJson: '{"writeStatus":"saved"}' }]);
      expect(result.export_requests).toEqual([{ resultJson: null }]);
      expect(queries).toHaveLength(13);
      expect(JSON.parse(JSON.stringify(result))).toEqual(result);
    } finally {
      await db.destroy();
    }
  });

  it("keeps migration column grants in step with the collector's SELECT lists", async () => {
    const originalMigration = await readFile(
      new URL("../../packages/meetings/sql/0283_meeting_account_export.sql", import.meta.url),
      "utf8"
    );
    const captureMigration = await readFile(
      new URL("../../packages/meetings/sql/0284_meeting_capture.sql", import.meta.url),
      "utf8"
    );
    const connectionMigration = await readFile(
      new URL(
        "../../packages/meetings/sql/0288_meeting_recording_connections.sql",
        import.meta.url
      ),
      "utf8"
    );
    const noticeMigration = await readFile(
      new URL("../../packages/meetings/sql/0290_meeting_recording_notice.sql", import.meta.url),
      "utf8"
    );
    const minimalMigration = await readFile(
      new URL("../../packages/meetings/sql/0292_meeting_minimal.sql", import.meta.url),
      "utf8"
    );
    const minimalSelectGrants = [
      ...minimalMigration.matchAll(
        /GRANT SELECT \([^)]+\)\s+ON app\.[a-z_]+ TO jarvis_worker_runtime;/g
      )
    ]
      .map((match) => match[0])
      .join("\n");
    const migration =
      minimalSelectGrants +
      originalMigration +
      (captureMigration.match(/-- Capture account export[\s\S]*$/)?.[0] ?? "") +
      (connectionMigration.match(/-- Capture connection account export[\s\S]*$/)?.[0] ?? "") +
      (noticeMigration.match(/-- Ordinary acknowledgement metadata[\s\S]*$/)?.[0] ?? "");
    const { db, queries, scopedDb } = harness();
    try {
      await collectMeetingsExportSection(scopedDb, ctx);
      for (const query of queries) {
        const table = query.sql.match(/FROM app\.(\w+)/)?.[1];
        const selected = query.sql.match(/SELECT\s+([\s\S]*?)\s+FROM/)?.[1];
        expect(selected).toBeDefined();
        const columns = selected!.split(",").map((part) => part.trim().split(/\s|::/)[0]);
        const grants = [
          ...migration.matchAll(
            new RegExp(
              `GRANT SELECT \\(([^)]+)\\)\\s+ON app\\.${table} TO jarvis_worker_runtime;`,
              "g"
            )
          )
        ];
        expect(grants.length).toBeGreaterThan(0);
        expect(
          grants
            .flatMap((grant) => grant[1]!.split(",").map((part) => part.trim()))
            .filter(
              (column) =>
                !["history_kind", "history_result_status", "history_result_code"].includes(column)
            )
            .sort()
        ).toEqual([...columns].sort());
      }
      expect(migration).not.toMatch(/GRANT\s+(?:INSERT|UPDATE|DELETE|ALL)|BYPASSRLS|\bFOR ALL\b/i);
    } finally {
      await db.destroy();
    }
  });
});
