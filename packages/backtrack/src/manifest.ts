import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";

import { collectBacktrackSegmentsExportSection } from "./data-lifecycle.js";

export const BACKTRACK_MODULE_ID = "backtrack";

/** The index job: embed a batch of just-ingested segments (plan §4.5). */
export const BACKTRACK_INDEX_QUEUE = "backtrack.index";
/** The hourly retention/upkeep sweep (plan §4.6). */
export const BACKTRACK_UPKEEP_QUEUE = "backtrack.upkeep";

export const backtrackModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const backtrackModuleManifest: MossModuleManifest = {
  id: BACKTRACK_MODULE_ID,
  name: "Backtrack",
  publisher: "Moss",
  version: "0.1.0",
  // Decision 12 (plan §3): the module can't be disabled, the same way calendar can't
  // (packages/calendar/src/manifest.ts). Status, pause and delete must always be reachable —
  // disabling the module would 404 delete while ingest (a platform route) kept accepting uploads,
  // which is worse than a module that can't be disabled. Recording is controlled only by the
  // instance switch (§4.3), the person's pause, and the Mac's own consent and switches.
  lifecycle: "required",
  availability: {
    defaultEnabled: true,
    required: true,
    supportsUserDisable: false,
    supportsWorkspaceDisable: false
  },
  compatibility: { jarv1s: ">=0.0.0" },
  database: {
    migrations: ["sql/0282_backtrack_segments.sql"],
    migrationDirectories: ["packages/backtrack/sql"],
    ownedTables: ["app.backtrack_segments", "app.backtrack_preferences", "app.backtrack_deletions"]
  },
  features: [
    {
      id: "backtrack.day_memory",
      description:
        "Trail Marker can read your screen through the day and keep it as searchable day memory " +
        "in Moss, kept 37 days, plus up to one hourly run. An admin must turn storage on first.",
      errors: [
        {
          code: "backtrack_unavailable",
          class: "transient",
          description:
            "Backtrack storage is not turned on for this Moss yet; Settings > Modules > " +
            "Backtrack says so, and an admin turns it on (the backtrack.storage instance switch)."
        },
        {
          code: "backtrack_paused",
          class: "validation",
          description:
            "Recording is paused from Moss, so nothing new is stored; turn Recording back on in " +
            "Settings > Modules > Backtrack."
        },
        {
          code: "backtrack_clock",
          class: "validation",
          description:
            "A Mac's clock is more than an hour off, so its upload is refused and kept on the " +
            "Mac; correct the Mac's date and time."
        }
      ]
    },
    {
      id: "backtrack.delete_history",
      description:
        "Settings > Modules > Backtrack deletes stored history for the last hour, today, a chosen " +
        "day or everything. It is permanent and works with no Mac linked, even if storage is off.",
      errors: []
    }
  ],
  settings: [
    {
      id: "backtrack.module-settings",
      label: "Backtrack",
      description:
        "Pause or resume Backtrack for all your Macs, see days and size kept (37 days, plus up " +
        "to one hourly run), and delete history. Shows an empty state with no Mac and no " +
        "history, and a note when an admin has not turned storage on.",
      path: "/settings?section=modules&module=backtrack",
      scope: "user",
      permissionId: "backtrack.manage",
      entry: "./settings"
    }
  ],
  permissions: [
    {
      id: "backtrack.manage",
      label: "Manage Backtrack",
      description:
        "View and manage the active actor's own Backtrack day-memory status, pause state, and " +
        "stored history (status, pause and delete).",
      scope: "user",
      actions: ["view", "update", "delete"]
    }
  ],
  routes: [
    { method: "GET", path: "/api/backtrack/status", permissionId: "backtrack.manage" },
    { method: "PUT", path: "/api/backtrack/preferences", permissionId: "backtrack.manage" },
    { method: "DELETE", path: "/api/backtrack/segments", permissionId: "backtrack.manage" }
  ],
  jobs: [
    { queueName: BACKTRACK_INDEX_QUEUE, metadataOnly: true },
    { queueName: BACKTRACK_UPKEEP_QUEUE, metadataOnly: true }
  ],
  dataLifecycle: {
    exportSections: [
      {
        key: "backtrackSegments",
        displayName: "Backtrack day memory",
        collect: collectBacktrackSegmentsExportSection
      }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.backtrack_segments" },
        { table: "app.backtrack_preferences" },
        { table: "app.backtrack_deletions" }
      ]
    }
  }
};
