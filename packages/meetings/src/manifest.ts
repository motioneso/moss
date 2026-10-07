import { meetingRecordTarget } from "./chat-targets.js";
import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";
import { collectMeetingsExportSection } from "./data-lifecycle.js";

export const meetingsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

/** Owner-private meetings with an explicitly approved native recorder. */
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
      "sql/0280_meeting_history.sql",
      "sql/0283_meeting_account_export.sql",
      "sql/0284_meeting_capture.sql",
      "sql/0288_meeting_recording_connections.sql",
      "sql/0292_meeting_minimal.sql"
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
      "app.meeting_export_requests",
      "app.meeting_capture_links",
      "app.meeting_capture_grants",
      "app.meeting_capture_receipts",
      "app.meeting_capture_connections",
      "app.meeting_capture_start_cancellations",
      "app.meeting_stop_summaries"
    ]
  },
  permissions: [
    {
      id: "meetings.read",
      label: "Read meetings",
      description:
        "Read the signed-in person's meetings, personal notes, and retained transcript evidence.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "meetings.write",
      label: "Manage meetings",
      description:
        "Create and delete meetings, save personal notes with version checks, manage capture defaults, and ingest transcript text.",
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
        "Create meetings, edit personal notes, and review transcripts. Explicit recording needs a connected Mac recorder with one-time recording approval and configured transcription.",
      permissionId: "meetings.read"
    }
  ],
  settings: [
    {
      id: "meetings.module-settings",
      label: "Meetings",
      description:
        "See your Mac link status, choose microphone plus system audio or microphone only, switch automatic summaries after Stop on or off, and unlink the Mac.",
      path: "/settings?section=modules&module=meetings",
      scope: "user",
      permissionId: "meetings.write",
      entry: "./settings"
    }
  ],
  jobs: [{ queueName: "meetings.stop-summary", metadataOnly: true }],
  routes: [
    {
      method: "PUT",
      path: "/api/meetings/records/:id/title",
      chat: { access: "write", title: "Rename your meeting", content: "user_authored" },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/output-availability",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/connection",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/commands",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/claim",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/capture/devices",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/capture/cancel-start",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/status",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/control",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/capture/audio",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/capture",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/capture/start",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/capture/control",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/history/search",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/history/:id",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/exports",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/exports",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/outputs",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/outputs/:version",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/outputs",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      permissionId: "meetings.write"
    },
    {
      method: "PUT",
      path: "/api/meetings/records/:id/outputs",
      chat: { access: "write", title: "Edit a meeting summary" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/actions/:candidateId/review",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      permissionId: "meetings.write"
    },
    {
      method: "POST",
      path: "/api/meetings/records/:id/transcript",
      chat: {
        access: "write",
        title: "Add or correct retained meeting transcript text",
        content: "user_authored"
      },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/transcript",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id/transcript/evidence",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/preferences",
      chat: { access: "read", content: "user_authored" },
      permissionId: "meetings.read"
    },
    {
      method: "PUT",
      path: "/api/meetings/preferences",
      chat: {
        access: "write",
        title: "Change your default meeting capture source",
        content: "user_authored"
      },
      permissionId: "meetings.write"
    },
    {
      method: "DELETE",
      path: "/api/meetings/records/:id",
      chat: {
        access: "destructive",
        title: "Delete meeting, retained records and linked Moss chats",
        content: "user_authored",
        target: meetingRecordTarget
      },
      permissionId: "meetings.write"
    },
    {
      method: "GET",
      path: "/api/meetings/records",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "GET",
      path: "/api/meetings/records/:id",
      chat: { access: "read" },
      permissionId: "meetings.read"
    },
    {
      method: "POST",
      path: "/api/meetings/records",
      chat: { access: "write", title: "Create a meeting draft", content: "user_authored" },
      permissionId: "meetings.write"
    },
    {
      method: "PUT",
      path: "/api/meetings/records/:id/notes",
      chat: { access: "write", title: "Save your meeting notes" },
      permissionId: "meetings.write"
    }
  ],
  features: [
    {
      id: "meetings.chat_app_actions",
      description:
        "App actions read retained meetings and your output availability, and save drafts, titles, notes, transcripts and summaries. Generation, export and capture stay in Meetings; deleting a meeting and linked chats asks first."
    },
    {
      id: "meetings.link_state",
      description:
        "When no Mac is linked, Meetings points to Trail Marker’s existing connect-in-browser flow. Download app has no destination yet. A linked Mac opens a ready workspace without source questions; linking, creating and opening never record."
    },
    {
      id: "meetings.automatic_summary",
      description:
        "Automatic summaries default on. Turn off Summarize automatically after Stop in Settings → Meetings. Only automatic summaries rename Untitled meeting. Rewrite summary remains available."
    },
    {
      id: "transcribe.meeting",
      description:
        "Capture duration uses native acknowledgement. Transcription delay is separate; transient clips retry within bounded memory. Activity records clip model, duration and outcome without audio or transcript text."
    },
    {
      id: "meetings.native_capture",
      description:
        "Link your Mac once. Start uses its default microphone and system audio unless Settings has an override. Only Start or Resume records. Pause and Stop remain available; a nav dot shows recording elsewhere. Mac only.",
      errors: [
        {
          code: "meeting_capture_source_unavailable",
          class: "prerequisite",
          remediationRef: "meetings.connect_recorder",
          description:
            "The Mac or exact audio source is missing or ambiguous. Check the linked Mac and macOS default microphone, restore an existing source, or adjust recording mode in Settings. Moss never chooses between multiple available Macs."
        },
        {
          code: "meeting_capture_processing_failed",
          class: "transient",
          description:
            "A transcription clip failed. Capture continues while transient failures retry within the memory limit; an unrecoverable clip leaves a visible gap."
        },
        {
          code: "meeting_capture_rate_limited",
          class: "transient",
          description:
            "Capture transport is temporarily rate limited. Moss honors Retry-After while keeping Pause and Stop available."
        },
        {
          code: "meeting_capture_unavailable",
          class: "prerequisite",
          remediationRef: "meetings.connect_recorder",
          description:
            "The recording connection is unavailable, expired or revoked. Check the companion connection in Settings and complete its one-time recording upgrade if requested."
        },
        {
          code: "meeting_capture_processing_unavailable",
          class: "prerequisite",
          remediationRef: "meetings.configure_transcription",
          description:
            "The configured transcription route is unavailable. An admin must check AI providers; no substitute provider is selected."
        },
        {
          code: "meeting_capture_interrupted",
          class: "transient",
          description:
            "Recording was interrupted by unlink, device expiry, permission revoke, session end, connection replacement or capture expiry. Check the Mac connection and create a new meeting after recording authority ends."
        },
        {
          code: "meeting_capture_conflict",
          class: "validation",
          description:
            "Capture state or selected sources changed. Refresh and review before trying again. After a completed recording, create New meeting so its transcript and clock remain separate."
        },
        {
          code: "meeting_capture_limit",
          class: "validation",
          description:
            "This recording reached a bounded session, source or receipt limit. Stop and review the meeting before starting another."
        },
        {
          code: "meeting_capture_busy",
          class: "transient",
          description:
            "The device is recording or finalizing another meeting, or a clip is still processing. Finalization lasts at most 60 seconds. The native recorder retains bounded transient audio and pauses when its buffer fills."
        }
      ],
      remediations: [
        {
          id: "meetings.connect_recorder",
          path: "/meetings",
          description:
            "Open Settings → Meetings to check the linked Mac and audio mode. Link or restore recording access from Profile settings if needed and check macOS audio permissions. Open New meeting and explicitly press Start."
        },
        {
          id: "meetings.configure_transcription",
          path: "/settings?section=aiproviders",
          description:
            "An admin configures the transcription endpoint and model in AI providers. The selected route must return clip timestamps; unsupported responses stop processing without provider fallback."
        }
      ]
    },
    {
      id: "meetings.account_export",
      description:
        "Your data in Settings exports your meeting records, retained notes/transcripts, summaries, action reviews and export receipts. Owner-only, including disabled-module data. Derived search indexes are excluded; no model request runs."
    },
    {
      id: "meetings.history",
      description:
        "The Meetings list searches titles, notes and transcripts. Rows grouped by week open the meeting directly and show the latest summary excerpt and acknowledged recording length when available.",
      errors: [
        {
          code: "meeting_history_access_denied",
          class: "permission",
          description:
            "History is unavailable to this signed-in account. Sign in again and check that Meetings is enabled. Other people's private meetings are never included."
        },
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
        "Citations scroll to an exact passage beside your notes. Continue editing there, or use Meetings to return to the list. Invalid links and unavailable revisions explain the problem; citations never substitute newer text."
    },
    {
      id: "meetings.private_exports",
      description:
        "Save each output version as a private vault file. Requires Meetings enabled and the required Notes module. Unchanged repeats do nothing; manual edits cause a conflict. Saved and search-index queued/delayed statuses are separate.",
      errors: [
        {
          code: "meeting_export_invalid_input",
          class: "validation",
          description: "Choose a retained summary version and use a valid export request key."
        },
        {
          code: "meeting_export_unavailable",
          class: "prerequisite",
          remediationRef: "meetings.enable_private_exports",
          description:
            "Private export needs Meetings enabled, the required Notes module and an available summary version. Check Meetings in Modules and refresh the summary; contact an instance admin if export remains unavailable."
        },
        {
          code: "meeting_export_content_conflict",
          class: "validation",
          description:
            "The summary content no longer matches this version's export receipt. Keep the existing copy and save a new summary version."
        },
        {
          code: "meeting_export_request_conflict",
          class: "validation",
          description:
            "This export request key was used for a different version. Use a new request key for the intended summary version."
        },
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
      ],
      remediations: [
        {
          id: "meetings.enable_private_exports",
          description:
            "Enable Meetings in Modules and reopen a retained summary version. Notes is required and cannot be switched off; contact an instance admin if private export remains unavailable.",
          path: "/settings?section=modules"
        }
      ]
    },
    {
      id: "meetings.grounded_outputs",
      description:
        "Generate evidence-checked summaries, decisions and actions with four templates. Compare versions and review exact sources. Generate requires a supported API-key route; CLI unavailable. Refresh summaries rechecks model configuration.",
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
            "Summaries need an API-key model with summarization and structured-output support; CLI is unsupported. Admins check Settings → AI providers; other owners contact an admin. Refresh summaries after updating configuration, then generate."
        },
        {
          code: "meeting_output_route_changed",
          class: "transient",
          description:
            "The summary model configuration changed during generation. Admins review Settings → AI providers; other owners contact an admin. Refresh summaries after updating configuration, then generate again."
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
          code: "meeting_output_queue_unavailable",
          class: "transient",
          description:
            "Recording stopped, but its summary could not be queued. Review the finalized transcript and use Rewrite summary for a new explicit attempt."
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
      remediations: [
        {
          id: "meetings.remove_chat_context",
          path: "/meetings",
          description:
            "Remove the About this meeting chip in the chat drawer to continue ordinary subscription chat, or choose an API-key chat model for meeting questions."
        }
      ],
      errors: [
        {
          code: "meeting_chat_unsupported",
          class: "prerequisite",
          remediationRef: "meetings.remove_chat_context",
          description:
            "Selected-meeting questions need an API-key chat model. Remove the About this meeting chip to continue ordinary chat with your subscription model."
        }
      ],
      description:
        "Chat attaches the open meeting’s notes and transcript; its chip announces the title. API-key only, no actions. Remove About this meeting for ordinary subscription chat. Admin pins and locked defaults apply."
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
        "Read live transcript timestamps and source labels beside notes, with inline missing-audio ranges. On phones they become tabs. Chat timestamp links scroll to exact evidence; older cited text remains identifiable."
    },
    {
      id: "meetings.capture_default",
      description:
        "New recordings use the sole available Mac’s default microphone and system audio. Settings can switch to microphone-only. Existing exact source choices are preserved; missing or ambiguous sources never broaden capture."
    },
    {
      id: "meetings.notes_recovery",
      description:
        "Notes autosave and remain in signed-in memory across navigation. Failed saves can retry the same request. Conflicts keep edits and show saved notes before an explicit Keep my version choice. Unsaved work warns before sign-out."
    },
    {
      id: "meetings.delete_draft",
      description:
        "Delete meeting in the overflow menu permanently removes its notes, transcript, chat and summaries after confirmation. Accepted Tasks and vault copies remain. Cancel keeps unsaved edits."
    },
    {
      id: "meetings.draft_records",
      description:
        "Untitled meeting has the same title in its page, list and chat chip. Rename inline; Notes and Summary sit beside the transcript. Overflow has search, rewrite, versions, export, copy and deletion. Add to Tasks requires owner review.",
      errors: [
        {
          code: "meeting_request_conflict",
          class: "validation",
          description:
            "A request key was already used with different input. Use a new key for a new change."
        },
        {
          code: "meeting_title_conflict",
          class: "transient",
          description:
            "The title changed elsewhere. Your draft is kept; review the current title before choosing to keep your version or load the saved title."
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
            "The meeting or notes exceed the allowed size or contain invalid fields. Correct the input and retry."
        },
        {
          code: "meeting_not_found",
          class: "validation",
          description: "This meeting is unavailable to the signed-in person."
        }
      ]
    }
  ],
  dataLifecycle: {
    exportSections: [
      { key: "meetings", displayName: "Meetings", collect: collectMeetingsExportSection }
    ],
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
        { table: "app.meeting_export_requests", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_capture_links", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_capture_grants", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_capture_receipts", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_capture_connections", countPredicate: "owner_user_id = $1::uuid" },
        {
          table: "app.meeting_capture_start_cancellations",
          countPredicate: "owner_user_id = $1::uuid"
        },
        { table: "app.meeting_stop_summaries", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  }
} satisfies MossModuleManifest;
