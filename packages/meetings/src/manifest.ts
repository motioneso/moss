import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";

export const meetingsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

/** Draft records and personal notes. Native recording is not available yet. */
export const meetingsModuleManifest = {
  id: "meetings",
  name: "Meetings",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
  database: {
    migrations: [
      "sql/0260_meeting_records.sql",
      "sql/0261_meeting_draft_delete.sql",
      "sql/0262_meeting_transcript_batches.sql"
    ],
    migrationDirectories: ["packages/meetings/sql"],
    ownedTables: [
      "app.meeting_records",
      "app.meeting_note_writes",
      "app.meeting_transcript_batches"
    ]
  },
  permissions: [
    {
      id: "meetings.read",
      label: "Read meeting drafts",
      description:
        "Read the signed-in person's meeting drafts, personal notes, and retained transcript evidence.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "meetings.write",
      label: "Manage meeting drafts",
      description:
        "Create and delete drafts, save personal notes with version checks, manage capture defaults, and ingest transcript text.",
      scope: "user",
      actions: ["create", "update", "delete"]
    }
  ],
  navigation: [
    {
      id: "meetings",
      label: "Meetings",
      path: "/meetings",
      icon: "mic",
      order: 36,
      description:
        "Create meeting drafts, find their history, and edit personal notes. Recording is unavailable.",
      permissionId: "meetings.read"
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/meetings/records/:id/transcript",
      permissionId: "meetings.write"
    },
    { method: "GET", path: "/api/meetings/records/:id/transcript", permissionId: "meetings.read" },
    {
      method: "GET",
      path: "/api/meetings/records/:id/transcript/evidence",
      permissionId: "meetings.read"
    },
    { method: "GET", path: "/api/meetings/preferences", permissionId: "meetings.read" },
    { method: "PUT", path: "/api/meetings/preferences", permissionId: "meetings.write" },
    { method: "DELETE", path: "/api/meetings/records/:id", permissionId: "meetings.write" },
    { method: "GET", path: "/api/meetings/records", permissionId: "meetings.read" },
    { method: "GET", path: "/api/meetings/records/:id", permissionId: "meetings.read" },
    { method: "POST", path: "/api/meetings/records", permissionId: "meetings.write" },
    { method: "PUT", path: "/api/meetings/records/:id/notes", permissionId: "meetings.write" }
  ],
  features: [
    {
      id: "meetings.questions",
      description:
        "Ask Moss opens shared chat with this meeting selected. Independent questions use current transcript evidence, visible coverage and exact-revision timestamps. Requires an API-key model; no actions, exports or subscription-model support."
    },
    {
      id: "meetings.transcript_storage",
      description:
        "Owner-only text ingestion retains immutable transcript revisions, retry receipts, source epochs and a fixed stop cutoff. Bounded API snapshots and evidence resolve exact revisions. No audio or provider processing.",
      errors: [
        {
          code: "meeting_transcript_invalid_input",
          class: "validation",
          description:
            "Invalid transcript revisions, source bounds, or cutoff. Correct the input before retrying."
        },
        {
          code: "meeting_transcript_limit",
          class: "validation",
          description:
            "A batch or retained ledger reached its published limit. No batch was accepted or silently truncated; preserve the source text outside this ingestion request and surface the missing interval."
        },
        {
          code: "meeting_transcript_request_conflict",
          class: "validation",
          description:
            "This request key already identifies different transcript input. Use a new key for a new operation."
        },
        {
          code: "meeting_transcript_version_conflict",
          class: "transient",
          description:
            "Another transcript batch was saved first. Reload the current version and reconcile before retrying."
        },
        {
          code: "meeting_transcript_unavailable",
          class: "validation",
          description:
            "The requested transcript or exact evidence revision is unavailable to this person."
        }
      ]
    },
    {
      id: "meetings.transcript_review",
      description:
        "Read retained transcripts with source labels, timestamps, revision and provisional status, and omitted counts. Refresh manually or inspect previous/latest revisions. Recording remains unavailable."
    },
    {
      id: "meetings.capture_default",
      description:
        "Explicitly save or clear a personal capture-mode default in meeting Setup. Choosing another mode does not change the saved default. Native recording remains unavailable."
    },
    {
      id: "meetings.notes_recovery",
      description:
        "Unsaved notes survive signed-in app navigation in memory. Save before closing or signing out. On a version conflict, compare current saved notes before explicitly rebasing your edits."
    },
    {
      id: "meetings.delete_draft",
      description:
        "Permanently delete a draft, personal notes, retained transcript revisions and meeting chat after confirmation. Cancellation preserves unsaved edits; deletion cannot be undone."
    },
    {
      id: "meetings.draft_records",
      description:
        "Create titled drafts, browse history, and save personal notes with version checks and retry-safe requests at /meetings. Native recording, summaries, Tasks and vault export remain unavailable.",
      errors: [
        {
          code: "meeting_request_conflict",
          class: "validation",
          description:
            "A request key was already used with different input. Use a new key for a new change."
        },
        {
          code: "meeting_notes_conflict",
          class: "transient",
          description:
            "Personal notes changed since this version was loaded. Reload and review the current notes before saving."
        },
        {
          code: "meeting_invalid_input",
          class: "validation",
          description:
            "The meeting draft or notes exceed the allowed size or contain invalid fields. Correct the input and retry."
        },
        {
          code: "meeting_not_found",
          class: "validation",
          description: "This meeting draft is unavailable to the signed-in person."
        }
      ]
    }
  ],
  dataLifecycle: {
    exportSections: [],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.meeting_records", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_note_writes", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_transcript_batches", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  }
} satisfies MossModuleManifest;
