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
    migrations: ["sql/0260_meeting_records.sql", "sql/0261_meeting_draft_delete.sql"],
    migrationDirectories: ["packages/meetings/sql"],
    ownedTables: ["app.meeting_records", "app.meeting_note_writes"]
  },
  permissions: [
    {
      id: "meetings.read",
      label: "Read meeting drafts",
      description: "Read the signed-in person's meeting drafts and personal notes.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "meetings.write",
      label: "Manage meeting drafts",
      description:
        "Create and delete drafts, save personal notes with version checks, and manage capture defaults.",
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
        "Permanently delete a draft and its personal notes after a confirmation dialog. Cancellation preserves unsaved edits; deletion cannot be undone."
    },
    {
      id: "meetings.draft_records",
      description:
        "Create titled drafts, browse history, and save personal notes with version checks and retry-safe requests at /meetings. Native recording, transcripts, summaries, Tasks, vault export, and meeting chat are unavailable.",
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
        { table: "app.meeting_note_writes", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  }
} satisfies MossModuleManifest;
