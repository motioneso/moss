import { fileURLToPath } from "node:url";

import type { MossModuleManifest, ToolRequiresConfirmation } from "@moss/module-sdk";
import { notesMonitorProvider } from "./monitor-provider.js";
import { collectManagedNotesExportSection } from "./managed-source-export.js";
import {
  notesCreateInputSchema,
  notesDeleteInputSchema,
  notesEditInputSchema,
  notesWriteResultSchema,
  postNotesSyncRouteSchema,
  notesSearchInputSchema,
  notesSearchResponseSchema
} from "@moss/shared";

import { notesSearchExecute } from "./tools.js";
import { notesCreateExecute, notesDeleteExecute, notesEditExecute } from "./write-tools.js";
import {
  notesCreatePresentation,
  notesDeletePresentation,
  notesEditPresentation
} from "./approval-presentation.js";

export const NOTES_MODULE_ID = "notes";
export const NOTES_SYNC_QUEUE = "notes.sync";

const configureFolderRemediation = {
  id: "notes.configure_folder",
  description: "Choose a notes folder under Connections in Settings.",
  path: "/settings?section=sources"
};

export const notesModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const notesModuleManifest = {
  id: NOTES_MODULE_ID,
  chatRefreshTokens: ["settings.notesLastSync", "settings.notesSource"],
  name: "Notes",
  version: "0.0.0",
  publisher: "Moss",
  // #996/#860: Notes moves to required (same rationale as commitments/people/goals).
  // supportsUserDisable stays true — harmless: active-modules-resolver.ts's
  // `required === true` short-circuit runs BEFORE this field is ever read, so it has
  // no effect once required flips; leaving it avoids an unrelated schema-shape edit.
  lifecycle: "required",
  compatibility: { jarv1s: ">=0.0.0" },
  availability: {
    defaultEnabled: true,
    required: true,
    supportsUserDisable: true
  },
  database: {
    migrations: [
      "sql/0336_notes_managed_source_lifecycle.sql",
      "sql/0337_notes_recording_contributions.sql"
    ],
    migrationDirectories: [notesModuleSqlMigrationDirectory],
    ownedTables: [
      "app.notes_managed_actors",
      "app.notes_managed_sources",
      "app.notes_destination_bindings",
      "app.notes_recording_contributions",
      "app.notes_contribution_proposals",
      "app.notes_contribution_operations"
    ]
  },
  permissions: [
    {
      id: "notes.sync",
      label: "Sync notes",
      description: "Trigger a notes folder sync job.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "notes.search",
      label: "Search notes",
      description: "Semantically search the user's ingested notes.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "notes.create",
      label: "Create notes",
      description: "Create Markdown notes in the linked notes source.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "notes.edit",
      label: "Edit notes",
      description: "Edit Markdown notes in the linked notes source.",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "notes.delete",
      label: "Delete notes",
      description: "Delete Markdown notes in the linked notes source immediately and permanently.",
      scope: "user",
      actions: ["delete"]
    }
  ],
  assistantActionFamilies: [
    {
      id: "note_changes",
      label: "Note changes",
      description: "Create and update notes. Deleting a note always asks for approval.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/notes/sync",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: postNotesSyncRouteSchema.response[202],
      permissionId: "notes.sync"
    }
  ],
  assistantTools: [
    {
      name: "notes.search",
      description:
        "Search the user's own ingested notes (Obsidian vault) by meaning. Returns matching note excerpts with file path and line range for citation.",
      permissionId: "notes.search",
      risk: "read",
      content: "outside",
      inputSchema: notesSearchInputSchema,
      outputSchema: notesSearchResponseSchema,
      externalContent: true,
      execute: notesSearchExecute
    },
    {
      name: "notes.create",
      approvalPresentation: notesCreatePresentation,
      approvalContent: "user_authored",
      actionLabel: "Create note",
      description: "Create a Markdown note in the linked notes source.",
      permissionId: "notes.create",
      actionFamilyId: "note_changes",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      safeErrors: true,
      requiresServices: ["notesSync"],
      inputSchema: notesCreateInputSchema,
      outputSchema: notesWriteResultSchema,
      execute: notesCreateExecute,
      // overwrite:true replaces an existing note's entire content — that's a destructive act
      // wearing a "create" label. Disclose it in the summary and force confirmation even if
      // note_changes has been promoted to trusted_auto (never silently auto-run a data-loss call).
      requiresConfirmation: ((_scopedDb, input, _ctx) =>
        input.overwrite === true) as ToolRequiresConfirmation,
      summarize: (input) =>
        input.overwrite === true
          ? `Overwrite note ${String(input.path)} (replaces existing content).`
          : `Create note ${String(input.path)}.`
    },
    {
      name: "notes.edit",
      approvalPresentation: notesEditPresentation,
      approvalContent: "user_authored",
      actionLabel: "Edit note",
      description: "Edit a Markdown note in the linked notes source.",
      permissionId: "notes.edit",
      actionFamilyId: "note_changes",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      safeErrors: true,
      requiresServices: ["notesSync"],
      inputSchema: notesEditInputSchema,
      outputSchema: notesWriteResultSchema,
      execute: notesEditExecute,
      summarize: (input) => `Edit note ${String(input.path)}.`
    },
    {
      name: "notes.delete",
      approvalPresentation: notesDeletePresentation,
      approvalContent: "user_authored",
      actionLabel: "Delete note",
      description:
        "Delete a Markdown note from the linked notes source immediately and permanently. There is " +
        "no trash or restore — the file is unlinked on disk.",
      permissionId: "notes.delete",
      actionFamilyId: "note_changes",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      safeErrors: true,
      requiresServices: ["notesSync"],
      inputSchema: notesDeleteInputSchema,
      outputSchema: notesWriteResultSchema,
      execute: notesDeleteExecute,
      // Permanent deletion must ask even when note changes or Auto-approve are trusted.
      requiresConfirmation: () => true,
      summarize: (input) => `Delete note ${String(input.path)}.`
    }
  ],
  features: [
    {
      id: "notes.recording_source_export",
      description:
        "Your account export includes saved recording-source status, note destination labels and contribution review, change and undo receipts. Recording filing controls are not yet available."
    },
    {
      id: "notes.vault_sync",
      description:
        "Sync Markdown notes from the folder in Settings, Connections while keeping files on disk. " +
        "A sync request also prepares search for chat recall; slow or unavailable recall is skipped.",
      errors: [
        {
          code: "notes.folder_missing",
          class: "prerequisite",
          remediationRef: "notes.configure_folder",
          description: "No notes folder is selected in Connections."
        }
      ],
      remediations: [configureFolderRemediation]
    },
    {
      id: "notes.semantic_search",
      description:
        "Search your notes by meaning, not just exact words, using embeddings, so closely related " +
        "wording still matches."
    },
    {
      id: "notes.approval_prerequisites",
      description:
        "Before approval, an unlinked or unavailable notes folder returns its safe configuration reason to Moss, without exposing filesystem paths. Link or fix the folder in Settings, then Connections.",
      errors: [
        {
          code: "notes.approval_folder_unavailable",
          class: "prerequisite",
          remediationRef: "notes.configure_folder",
          description:
            "A linked notes folder is missing, unavailable, or outside the allowed notes roots."
        }
      ],
      remediations: [configureFolderRemediation]
    },
    {
      id: "notes.approval_folder_path",
      description:
        "Note approval cards and cited note sources in goal and memory cards show the exact relative folder path under Folder. Absolute server paths stay private."
    },
    {
      id: "notes.assistant_authoring",
      description:
        "Create, edit or delete Markdown notes in your linked folder. Overwrite is disclosed. Deletion always asks, including trusted changes and Auto-approve, with red Approve and a warning that there is no trash or undo."
    },
    {
      id: "notes.coordinated_writes",
      description:
        "Concurrent Moss edits read the latest note before saving. An external edit detected during a save returns a conflict; review the current note before retrying.",
      errors: [
        {
          code: "notes.write_conflict",
          class: "transient",
          description: "The note changed while Moss was preparing to save it."
        }
      ],
      remediations: [
        {
          id: "notes.review_current_note",
          description:
            "Review the current note in your linked folder, then ask Moss to retry the intended change.",
          path: "/settings?section=sources"
        }
      ]
    }
  ],
  dataLifecycle: {
    exportSections: [
      { key: "notes", displayName: "Notes", collect: collectManagedNotesExportSection }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.notes_contribution_operations", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.notes_contribution_proposals", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.notes_recording_contributions", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.notes_destination_bindings", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.notes_managed_sources", countPredicate: "owner_user_id = $1::uuid" },
        { table: "app.notes_managed_actors", countPredicate: "owner_user_id = $1::uuid" }
      ]
    }
  },
  proactiveMonitor: notesMonitorProvider
} satisfies MossModuleManifest;
