import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";

import { scratchpadAppendExecute, scratchpadReadExecute } from "./tools.js";

export const SCRATCHPAD_MODULE_ID = "scratchpad";

export const scratchpadModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const scratchpadModuleManifest = {
  id: SCRATCHPAD_MODULE_ID,
  name: "Scratchpad",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "required",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: true
  },
  database: {
    migrations: ["sql/0216_scratchpads.sql"],
    migrationDirectories: ["packages/scratchpad/sql"],
    ownedTables: ["app.scratchpads"]
  },
  routes: [
    { method: "GET", path: "/api/scratchpad", permissionId: "scratchpad.read" },
    { method: "PUT", path: "/api/scratchpad", permissionId: "scratchpad.write" },
    { method: "POST", path: "/api/scratchpad/append", permissionId: "scratchpad.write" },
    { method: "PATCH", path: "/api/scratchpad/settings", permissionId: "scratchpad.write" }
  ],
  // #2236 slice 1: storage, the API, and the two assistant tools only. No screen yet - the
  // scratchpad UI is a later slice - so `navigation` and `settings` stay absent on purpose,
  // matching the notifications module's precedent for a module with no screen yet.
  features: [
    {
      id: "scratchpad.assistant_read_append",
      description:
        "The assistant can read the user's scratchpad and append a line to it. It can never replace or delete existing text.",
      errors: [
        {
          code: "scratchpad_too_large",
          class: "validation",
          description:
            "Shown as 'Scratchpad is full': the pad is at its 64,000 character limit, so nothing was added. Delete text you no longer need in the pad, then ask again."
        },
        {
          code: "scratchpad_empty_text",
          class: "validation",
          description:
            "The assistant was asked to add nothing, or only spaces, so nothing was added. Say what the line should read and ask again."
        },
        {
          code: "scratchpad_text_too_long",
          class: "validation",
          description:
            "One addition can be at most 2,000 characters and this one was longer, so nothing was added. Ask for it in shorter pieces, or shorten the text."
        }
      ]
    },
    {
      id: "scratchpad.save",
      description:
        "Saving the scratchpad keeps a version number with the text, so a save made against an out-of-date copy is refused instead of quietly overwriting the newer one.",
      errors: [
        {
          code: "scratchpad_conflict",
          class: "transient",
          description:
            "The pad changed somewhere else (another tab, device, or the assistant) since this copy was opened, so the save was refused. The refusal carries the current text; reload it, reapply the edit, and save again."
        }
      ]
    },
    {
      id: "scratchpad.settings",
      description:
        "Scratchpad settings: the keyboard shortcut that opens the pad, and whether the pad is copied into the user's notes folder.",
      remediations: [
        {
          id: "scratchpad.settings.connect_notes_folder",
          description:
            "Connect a notes folder under Data sources in Settings, then turn on copying the scratchpad to notes again.",
          path: "/settings?section=sources"
        }
      ],
      errors: [
        {
          code: "scratchpad_shortcut_invalid",
          class: "validation",
          description:
            "The shortcut was rejected and was not saved. It needs a real modifier key (control, command, alt) plus one key, Shift alone is not enough, and it cannot be a shortcut the app already uses such as control or command plus K."
        },
        {
          code: "scratchpad_notes_folder_missing",
          class: "prerequisite",
          remediationRef: "scratchpad.settings.connect_notes_folder",
          description:
            "Copying the scratchpad to notes was refused because no notes folder is connected yet, so the setting stayed off."
        }
      ]
    }
  ],
  assistantActionFamilies: [
    {
      id: "scratchpad_changes",
      label: "Scratchpad changes",
      description: "Append a line to the scratchpad.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "scratchpad.read",
      description: "Read the user's scratchpad text.",
      permissionId: "scratchpad.read",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: scratchpadReadExecute
    },
    {
      name: "scratchpad.append",
      description: "Append a line to the user's scratchpad. Never replaces existing text.",
      permissionId: "scratchpad.write",
      risk: "write",
      executionPolicy: "auto",
      actionFamilyId: "scratchpad_changes",
      selfOperationGrant: "granted_at_install",
      inputSchema: {
        type: "object",
        required: ["text"],
        properties: {
          text: { type: "string", minLength: 1, maxLength: 2000 }
        }
      },
      execute: scratchpadAppendExecute
    }
  ],
  dataLifecycle: {
    exportSections: [],
    deletion: {
      strategy: "cascade",
      tables: [{ table: "app.scratchpads", countPredicate: "user_id = $1::uuid" }]
    }
  }
} satisfies MossModuleManifest;
