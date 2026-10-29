import { recordingDeliveryRoutes } from "./recording-delivery-declarations.js";
import { meetingFeatures } from "./features.js";
import {
  recordingIdentityFeature,
  recordingIdentityRoutes,
  recordingTypeConfigurationFeature
} from "./recording-declarations.js";
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
      "sql/0295_meeting_capture_start_limits.sql",
      "sql/0325_meeting_recording_imports.sql",
      "sql/0326_meeting_import_summaries.sql",
      "sql/0328_meeting_voice_recordings.sql",
      "sql/0329_meeting_recording_uploads.sql",
      "sql/0335_meeting_recording_identity.sql"
    ],
    migrationDirectories: ["packages/meetings/sql"],
    ownedTables: [
      "app.meeting_recording_metadata",
      "app.meeting_recording_types",
      "app.meeting_manual_entries",
      "app.meeting_recording_imports",
      "app.meeting_recording_chunks",
      "app.meeting_recording_voice_enablements",
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
        "Add a pasted recording without a Mac; review summaries, types, personal/work labels and transcripts. Live recording needs a linked Mac and configured transcription.",
      permissionId: "meetings.read"
    }
  ],
  settings: [
    {
      id: "meetings.module-settings",
      label: "Meetings",
      description:
        "Choose recording audio, transcript language, best-effort vocabulary and automatic summaries; see Mac link status and unlink your Mac.",
      path: "/settings?section=modules&module=meetings",
      scope: "user",
      permissionId: "meetings.write",
      entry: "./settings"
    }
  ],
  jobs: [
    { queueName: "meetings.recording-notice", metadataOnly: true },
    { queueName: "meetings.stop-summary", metadataOnly: true },
    { queueName: "meetings.recording-import", metadataOnly: true }
  ],
  routes: [
    ...recordingIdentityRoutes,
    ...recordingDeliveryRoutes,
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
  features: [...meetingFeatures, recordingIdentityFeature, recordingTypeConfigurationFeature],
  dataLifecycle: {
    exportSections: [
      { key: "meetings", displayName: "Meetings", collect: collectMeetingsExportSection }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.meeting_recording_metadata", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_recording_types", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_manual_entries", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_recording_imports", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.meeting_recording_chunks", countPredicate: "owner_user_id = $1::uuid" },
        {
          table: "app.meeting_recording_voice_enablements",
          countPredicate: "owner_user_id = $1::uuid"
        },
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
