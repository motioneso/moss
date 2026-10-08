import { meetingRecordTarget } from "./chat-targets.js";
import {
  createMeetingPresentation,
  deleteMeetingPresentation,
  meetingNotesPresentation,
  meetingPreferencesPresentation,
  meetingSummaryPresentation,
  meetingTitlePresentation,
  meetingTranscriptPresentation
} from "./action-presentations.js";
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
      "sql/0292_meeting_minimal.sql",
      "sql/0295_meeting_capture_start_limits.sql"
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
      "app.meeting_stop_summaries",
      "app.meeting_capture_start_limits"
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
        "Create meetings, edit personal notes, and review transcripts. Explicit recording needs a connected Mac recorder authorized by initial linking and configured transcription.",
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
      chat: {
        access: "write",
        title: "Rename your meeting",
        content: "user_authored",
        presentation: meetingTitlePresentation
      },
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
      chat: {
        access: "write",
        title: "Edit a meeting summary",
        presentation: meetingSummaryPresentation
      },
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
        content: "user_authored",
        presentation: meetingTranscriptPresentation
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
        title:
          "Change meeting capture mode, recording source, automatic summaries or summary style",
        content: "user_authored",
        presentation: meetingPreferencesPresentation
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
        target: meetingRecordTarget,
        presentation: deleteMeetingPresentation
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
      chat: {
        access: "write",
        title: "Create a meeting draft",
        content: "user_authored",
        presentation: createMeetingPresentation
      },
      permissionId: "meetings.write"
    },
    {
      method: "PUT",
      path: "/api/meetings/records/:id/notes",
      chat: {
        access: "write",
        title: "Save your meeting notes",
        presentation: meetingNotesPresentation
      },
      permissionId: "meetings.write"
    }
  ],
  features: [
    {
      id: "meetings.chat_app_actions",
      description:
        "App actions read meetings/output availability; save drafts, titles, notes, transcripts, summaries and preferences. Cards show targets, content and evidence. Generate/export/record in Meetings. Deleting meetings and linked chats asks first."
    },
    {
      id: "meetings.link_state",
      description:
        "When no Mac is linked, Meetings points to Trail Marker’s existing connect-in-browser flow. Download app has no destination yet. A linked Mac opens a ready workspace without source questions; linking, creating and opening never record."
    },
    {
      id: "meetings.mac_link_controls",
      description:
        "Settings → Meetings shows link status, audio source, automatic summary and confirmed Unlink for the exact Mac. Pending and failed changes are explicit. Recording-capability revocation stays enforced; Unlink keeps retained meetings.",
      remediations: [
        {
          id: "meetings.restore_mac_link",
          path: "/settings?section=modules&module=meetings",
          description:
            "For missing or revoked recording access, unlink this Mac in Settings → Meetings and relink through Trail Marker. If Unlink is unconfirmed, use local Stop, check the connection and retry. Linking never starts capture."
        }
      ]
    },
    {
      id: "meetings.automatic_summary",
      description:
        "Automatic summaries default on and use your default model without fallback, including supported Claude. Turn off Summarize automatically after Stop in Settings → Meetings. Only these rename Untitled meeting; Rewrite summary stays available."
    },
    {
      id: "transcribe.meeting",
      description:
        "Capture time uses native acknowledgement. Silent/near-silent clips skip transcription and clear settled delays. Transient clips retry in bounded memory. Activity records model, duration and outcome without audio or transcript text."
    },
    {
      id: "meetings.native_startup_recovery",
      description:
        "A brief microphone timing hiccup at Start can recover without Resume. Missing startup sources are checked once; uncertain audio is dropped and marked as a gap. Real source changes still pause. The Mac log records audio gaps."
    },
    {
      id: "meetings.native_source_recovery",
      description:
        "Recovering audio… retries the same sources up to 8 times per recording. macOS may show its own permission dialog. Pause and Stop cancel recovery. Repeated interruptions need Resume; missed audio is marked as a gap.",
      remediations: [
        {
          id: "meetings.resume_interrupted_audio",
          path: "/meetings",
          description:
            "A visible warning restores a hidden recording pill if recovery cannot finish. Check the original sources and macOS permissions before Resume, or choose Stop. Missed audio is marked as a gap."
        }
      ]
    },
    {
      id: "meetings.speaker_echo_control",
      description:
        "Mic + computer audio echo control checked on built-in Mac speakers. Headsets/Bluetooth, Zoom sharing the mic, and fallback on Macs rejecting setup are unchecked. Unsupported setup uses the same mic after cleanup; route changes need Resume."
    },
    {
      id: "meetings.native_capture",
      description:
        "Link once and grant OS audio permissions. Start uses its default microphone and system audio unless Settings overrides it. Start or Resume begins recording; same-source recovery is automatic. A nav dot shows recording elsewhere. Mac only.",
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
            "Transient transcription failures retry while capture continues. Terminal failed clips retain one gap, shown at 250ms or longer. Provider end rounding up to 100ms is clamped to the clip; other invalid intervals are rejected."
        },
        {
          code: "meeting_capture_rate_limited",
          class: "transient",
          description:
            "Start is limited per account to 10 requests per minute and 60 per hour, alongside transport limits. Moss honors Retry-After while keeping Pause and Stop available."
        },
        {
          code: "meeting_capture_unavailable",
          class: "prerequisite",
          remediationRef: "meetings.connect_recorder",
          description:
            "The recording connection is unavailable, expired or revoked. Check the Mac in Settings → Meetings. For missing or revoked recording access, unlink the Mac and reconnect through Trail Marker."
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
          path: "/settings?section=modules&module=meetings",
          description:
            "Check the Mac and audio in Settings → Meetings. For missing or revoked recording access, unlink and relink through Trail Marker. Check macOS audio permissions, then press Start in New meeting."
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
      id: "meetings.mac_recording_status",
      description:
        "White 222 × 32 pill: three live audio bars, light/dark-readable source menu, Pause/Resume, Stop and Hide X. Silence/stale audio flattens bars. Resume keeps sources. Stop clears the pill and red menu item."
    },
    {
      id: "meetings.mac_recording_pill_visibility",
      description:
        "X hides the pill while recording continues. The red Meeting menu keeps Pause/Stop and Show recording pill. A persistent audio interruption shows it again with a warning. Showing a paused pill never resumes it. Each new Start shows the pill."
    },
    {
      id: "meetings.mac_audio_sources",
      description:
        "Select a mic or None and toggle computer audio for this recording. System-only skips mic permission. Both-off is rejected; select audio. Paused edits stay paused. Changes await confirmation and keep Settings defaults."
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
      id: "meetings.summary.validation",
      description: "Checked a meeting summary",
      errors: []
    },
    {
      id: "meetings.grounded_outputs",
      description:
        "Generate evidence-checked summaries with your default model, without fallback. Claude availability depends on this server setup. Compare versions and exact sources; refresh to check availability without generating a summary.",
      errors: [
        {
          code: "meeting_output_unavailable",
          class: "validation",
          description:
            "This output version is unavailable to the owner. Refresh the meeting and review another retained version."
        },
        {
          code: "meeting_output_subscription_unsupported",
          class: "validation",
          description:
            "Codex and other unconstrained subscription profiles do not support summaries yet. No replacement model is used. API-key and supported Claude profiles remain available."
        },
        {
          code: "meeting_output_subscription_isolation_unavailable",
          class: "validation",
          description:
            "Claude summaries aren’t available on this server setup. No other model was used."
        },
        {
          code: "meeting_output_claude_subscription_unsupported",
          class: "validation",
          description:
            "Summaries on this Claude subscription are not supported by the installed constrained runner yet. No other model is used. Ask an admin to check the installed CLI version."
        },
        {
          code: "meeting_output_route_unavailable",
          class: "validation",
          description:
            "Your default model is unavailable or cannot produce structured summaries. No replacement is used. Check Settings → AI providers or ask an admin, then refresh summaries and try again."
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
          code: "meeting_output_timed_out",
          class: "transient",
          description: "The summary took too long and was stopped. Try again when you’re ready."
        },
        ...(
          [
            "json_parse",
            "schema_validation",
            "oversized_output",
            "schema_invalid",
            "length_exceeded",
            "source_binding_missing",
            "source_binding_invalid",
            "source_identity_mismatch",
            "source_revision_mismatch",
            "utf16_range_invalid",
            "owner_phrase_unsupported",
            "due_phrase_unsupported",
            "inputs_invalid"
          ] as const
        ).map((reason) => ({
          code: `meeting_output_rejected_${reason}`,
          class: "transient" as const,
          description:
            "The summary couldn’t be checked against your meeting notes or transcript. Try generating it again."
        })),
        {
          code: "meeting_output_provider_failed",
          class: "transient",
          description:
            "Your model couldn’t complete the summary. Check its connection in Settings → AI providers, or ask an admin, then try again. No other model was used."
        },
        {
          code: "meeting_output_generation_failed",
          class: "transient",
          description:
            "The summary could not be generated. Try again when you’re ready. No other model was used."
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
        "Transcript timestamps and sources sit beside notes or in phone tabs. Gaps under 250ms and exact duplicates hide; same-second gaps say under a second. Diagnostics stay intact. Chat links scroll to cited evidence, including older text."
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
        { table: "app.meeting_stop_summaries", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_capture_start_limits", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  }
} satisfies MossModuleManifest;
