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
    migrations: ["sql/0214_scratchpads.sql"],
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
            "Shown as 'Scratchpad is full': the pad is already at its 64,000 character limit, so the new text was not appended."
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
