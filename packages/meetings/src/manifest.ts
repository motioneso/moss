import { fileURLToPath } from "node:url";
import type { MossModuleManifest } from "@moss/module-sdk";

export const meetingsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

/** Draft records only. No navigation or recording capability is advertised by this slice. */
export const meetingsModuleManifest = {
  id: "meetings",
  name: "Meetings",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "optional",
  compatibility: { jarv1s: ">=0.0.0" },
  availability: { defaultEnabled: true, required: false, supportsUserDisable: true },
  database: {
    migrations: ["sql/0260_meeting_records.sql"],
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
      label: "Write meeting drafts",
      description: "Create a meeting draft or save personal notes with version checks.",
      scope: "user",
      actions: ["create", "update"]
    }
  ],
  routes: [
    { method: "GET", path: "/api/meetings/records", permissionId: "meetings.read" },
    { method: "GET", path: "/api/meetings/records/:id", permissionId: "meetings.read" },
    { method: "POST", path: "/api/meetings/records", permissionId: "meetings.write" },
    { method: "PUT", path: "/api/meetings/records/:id/notes", permissionId: "meetings.write" }
  ],
  features: [
    {
      id: "meetings.draft_records",
      description:
        "Development foundation: the meeting-draft API stores titles and personal notes with version checks. It does not record audio, transcribe, summarize, or expose a Meetings screen.",
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
