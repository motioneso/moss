import { fileURLToPath } from "node:url";

import type { MossModuleManifest, ToolRequiresConfirmation } from "@moss/module-sdk";
import { notesMonitorProvider } from "./monitor-provider.js";
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

export const NOTES_MODULE_ID = "notes";
export const NOTES_SYNC_QUEUE = "notes.sync";

export const notesModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const notesModuleManifest = {
  id: NOTES_MODULE_ID,
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
    migrations: [],
    migrationDirectories: [notesModuleSqlMigrationDirectory],
    ownedTables: []
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
      description: "Create and update notes.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  routes: [
    {
      method: "POST",
      path: "/api/notes/sync",
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
      inputSchema: notesSearchInputSchema,
      outputSchema: notesSearchResponseSchema,
      externalContent: true,
      execute: notesSearchExecute
    },
    {
      name: "notes.create",
      description: "Create a Markdown note in the linked notes source.",
      permissionId: "notes.create",
      actionFamilyId: "note_changes",
      risk: "write",
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
      description: "Edit a Markdown note in the linked notes source.",
      permissionId: "notes.edit",
      actionFamilyId: "note_changes",
      risk: "write",
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
      description:
        "Delete a Markdown note from the linked notes source immediately and permanently. There is " +
        "no trash or restore — the file is unlinked on disk.",
      permissionId: "notes.delete",
      actionFamilyId: "note_changes",
      risk: "write",
      executionPolicy: "auto",
      selfOperationGrant: "granted_at_install",
      safeErrors: true,
      requiresServices: ["notesSync"],
      inputSchema: notesDeleteInputSchema,
      outputSchema: notesWriteResultSchema,
      execute: notesDeleteExecute,
      summarize: (input) => `Delete note ${String(input.path)}.`
    }
  ],
  proactiveMonitor: notesMonitorProvider
} satisfies MossModuleManifest;
