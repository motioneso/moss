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
      "sql/0273_meeting_records.sql",
      "sql/0274_meeting_draft_delete.sql",
      "sql/0275_meeting_transcript_batches.sql",
      "sql/0278_meeting_outputs.sql",
      "sql/0279_meeting_exports.sql",
      "sql/0280_meeting_history.sql"
    ],
    migrationDirectories: ["packages/meetings/sql"],
    ownedTables: [
      "app.meeting_records",
      "app.meeting_note_writes",
      "app.meeting_transcript_batches",
      "app.meeting_history_segments",
      "app.meeting_output_requests",
      "app.meeting_output_artifacts",
      "app.meeting_action_candidates",
      "app.meeting_export_receipts",
      "app.meeting_export_requests"
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
    { method: "POST", path: "/api/meetings/history/search", permissionId: "meetings.read" },
    { method: "GET", path: "/api/meetings/history/:id", permissionId: "meetings.read" },
    { method: "GET", path: "/api/meetings/records/:id/exports", permissionId: "meetings.read" },
    { method: "POST", path: "/api/meetings/records/:id/exports", permissionId: "meetings.write" },
    { method: "GET", path: "/api/meetings/records/:id/outputs", permissionId: "meetings.read" },
    {
      method: "GET",
      path: "/api/meetings/records/:id/outputs/:version",
      permissionId: "meetings.read"
    },
    { method: "POST", path: "/api/meetings/records/:id/outputs", permissionId: "meetings.write" },
    { method: "PUT", path: "/api/meetings/records/:id/outputs", permissionId: "meetings.write" },
    {
      method: "POST",
      path: "/api/meetings/records/:id/actions/:candidateId/review",
      permissionId: "meetings.write"
    },
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
      id: "meetings.history",
      description:
        "Search current titles, notes and transcripts across your history; filter review and export receipts. Select metadata, open Review or Ask Moss. Capture is unavailable; receipt states do not verify current Tasks or vault files.",
      errors: [
        {
          code: "meeting_history_rate_limited",
          class: "transient",
          description: "Too many history requests. Wait for the retry interval, then try again."
        },
        {
          code: "meeting_history_invalid_input",
          class: "validation",
          description:
            "Use a shorter search with at most 16 distinct words, a supported filter, and a valid page cursor."
        },
        {
          code: "meeting_history_unavailable",
          class: "transient",
          description:
            "History could not finish within its query budget or is temporarily unavailable. Retry or narrow the search."
        }
      ]
    },
    {
      id: "meetings.unsaved_changes",
      description:
        "Unsaved notes and summary edits stay in this signed-in session. Sign-out asks before discarding them; cancel keeps the edits. Browser close or reload also warns about unsaved edits."
    },
    {
      id: "meetings.referenced_evidence",
      description:
        "Open an exact cited passage beside the current transcript. Close evidence returns to review. Invalid links and unavailable revisions show an explanation; they never redirect a citation to newer text."
    },
    {
      id: "meetings.private_exports",
      description:
        "Explicitly save an immutable output version into the Moss private vault. Each version has its own file. Unchanged repeats are a no-op; manual edits cause a conflict. Saved and search-index queued/delayed statuses are separate.",
      errors: [
        {
          code: "meeting_vault_write_failed",
          class: "transient",
          description:
            "The private vault write failed. Retry the same request after checking vault availability."
        },
        {
          code: "meeting_vault_conflict",
          class: "validation",
          description:
            "The destination file differs from this output. Preserve manual edits and export another version instead."
        },
        {
          code: "meeting_index_delayed",
          class: "transient",
          description:
            "The file was saved but search indexing could not be queued. Retry to reconcile the saved file and queue only the missing stage."
        }
      ]
    },
    {
      id: "meetings.grounded_outputs",
      description:
        "Generate summaries and evidence-checked decisions/actions with four templates. Compare recent versions and load exact candidate sources; edits create new versions. Requires an API-key summarization route; CLI unavailable.",
      errors: [
        {
          code: "meeting_output_unavailable",
          class: "validation",
          description:
            "This output version is unavailable to the owner. Refresh the meeting and review another retained version."
        },
        {
          code: "meeting_output_route_unavailable",
          class: "validation",
          description:
            "Summaries need an API-key model with summarization and structured-output support; CLI is unsupported. Admins review Settings → AI providers; other owners contact an instance admin. Generate again after configuration is updated."
        },
        {
          code: "meeting_output_route_changed",
          class: "transient",
          description:
            "The summary model configuration changed during generation. Admins can review Settings → AI providers; other owners should contact an instance admin. Generate again after configuration is updated."
        },
        {
          code: "meeting_output_input_too_large",
          class: "validation",
          description:
            "The selected transcript and notes exceed the safe prompt budget. No provider request was sent; use a shorter retained input."
        },
        {
          code: "meeting_output_module_unavailable",
          class: "validation",
          description:
            "Meetings is unavailable for this owner. Check module settings before retrying."
        },
        {
          code: "meeting_action_tasks_unavailable",
          class: "validation",
          description:
            "Tasks is unavailable for this owner. Enable Tasks in module settings before accepting this candidate."
        },
        {
          code: "meeting_output_interrupted",
          class: "transient",
          description:
            "Generation was interrupted or its reservation expired. Start a new explicit request; replaying the old key will not run it again."
        },
        {
          code: "meeting_output_generation_failed",
          class: "transient",
          description:
            "Generation failed or its result was invalid. Review provider settings, then explicitly start a new request; no fallback provider is used."
        },
        {
          code: "meeting_output_busy",
          class: "transient",
          description:
            "Another summary is already being generated for this meeting. Refresh to check its result before starting another request."
        },
        {
          code: "meeting_output_version_conflict",
          class: "transient",
          description:
            "The transcript, notes or output changed. Reload current revisions before generating or editing."
        },
        {
          code: "meeting_output_request_conflict",
          class: "validation",
          description:
            "This request key identifies another mutation. Use a new key for different input."
        },
        {
          code: "meeting_output_invalid_input",
          class: "validation",
          description:
            "Correct the output shape, exact evidence anchors, template version or reviewed Task fields."
        },
        {
          code: "meeting_output_evidence_unavailable",
          class: "validation",
          description:
            "Retained evidence is unavailable. Add notes or retained transcript before generation."
        },
        {
          code: "meeting_output_limit",
          class: "validation",
          description:
            "The meeting output storage limit was reached. Existing output remains available."
        },
        {
          code: "meeting_action_match_review_required",
          class: "validation",
          description:
            "This proposal may overlap an existing candidate. Review previous decisions and explicitly confirm a distinct Task before acceptance."
        },
        {
          code: "meeting_action_review_conflict",
          class: "validation",
          description:
            "The candidate already has a different review decision. Existing accepted Tasks and dismissals are preserved."
        },
        {
          code: "meeting_action_unavailable",
          class: "validation",
          description: "This candidate is unavailable to the signed-in owner."
        }
      ]
    },
    {
      id: "meetings.reviewed_tasks",
      description:
        "Explicit owner-reviewed acceptance creates a personal Task. Retries preserve its edits; regeneration preserves decisions and flags uncertain matches. No remote assignments. Accepted Tasks survive meeting deletion."
    },
    {
      id: "meetings.questions",
      description:
        "Ask Moss uses current meeting evidence and exact citations in shared chat. API-key requests have a two-minute deadline; no actions or model fallback. Inaccessible meetings explain how to close and choose another. CLI unsupported."
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
        "Permanently delete a draft, personal notes, retained transcript revisions and meeting chat, generated outputs and candidates after confirmation; accepted Tasks remain. Cancellation preserves unsaved edits; deletion cannot be undone."
    },
    {
      id: "meetings.draft_records",
      description:
        "Review Summary and actions, Transcript and My notes at /meetings. Search current titles, notes and transcripts in History. Accept reviewed Tasks and save private copies. Native recording remains unavailable.",
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
        { table: "app.meeting_transcript_batches", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_history_segments", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_output_requests", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_output_artifacts", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_action_candidates", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_export_receipts", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_export_requests", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  }
} satisfies MossModuleManifest;
