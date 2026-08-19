import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  createCheckinRequestSchema,
  createCheckinResponseSchema,
  createMedicationLogRequestSchema,
  createMedicationLogResponseSchema,
  createMedicationRequestSchema,
  createTherapyNoteRouteSchema,
  deleteTherapyNoteRouteSchema,
  listCheckinsResponseSchema,
  listMedicationsResponseSchema,
  listTherapyNotesRouteSchema,
  medicationAdherenceSummaryRouteSchema,
  putWellnessAiConsentRequestSchema,
  medicationResponseSchema,
  medicationScheduleResponseSchema,
  updateCheckinRouteSchema,
  updateMedicationRequestSchema,
  wellnessAiConsentResponseSchema,
  wellnessExportRequestSchema,
  wellnessInsightsRouteSchema
} from "@moss/shared";

import { collectWellnessExportSection } from "./data-lifecycle.js";
import { wellnessFocusSignal } from "./focus-signal.js";
import { WELLNESS_EXPORT_QUEUE } from "./export-job.js";
import { wellnessMedicationAdherenceExecute, wellnessRecentCheckInsExecute } from "./tools.js";

export const WELLNESS_MODULE_ID = "wellness";
export const WELLNESS_MEDICATION_REMINDER_QUEUE = "wellness-medication-reminder";
export const wellnessModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const wellnessModuleManifest = {
  id: WELLNESS_MODULE_ID,
  name: "Wellness",
  version: "0.1.0",
  publisher: "Moss",
  lifecycle: "user-toggleable",
  compatibility: {
    jarv1s: ">=0.0.0"
  },
  availability: {
    defaultEnabled: true,
    required: false,
    supportsUserDisable: true
  },
  database: {
    // No consumer reads this list (migrationDirectories is the operative mechanism below);
    // left empty rather than hand-maintained to avoid drifting out of sync with sql/ again.
    migrations: [],
    migrationDirectories: ["packages/wellness/sql"],
    ownedTables: [
      "app.wellness_checkins",
      "app.medications",
      "app.medication_logs",
      "app.wellness_therapy_notes"
    ]
  },
  navigation: [
    {
      id: "wellness",
      label: "Wellness",
      description:
        "Log mood check-ins and medications, track medication-taking streaks and adherence, review history and trends, keep private therapy notes, and export the active actor's wellness data.",
      path: "/wellness",
      icon: "heart-pulse",
      order: 40,
      permissionId: "wellness.view"
    }
  ],
  settings: [
    {
      id: "wellness.ai-consent",
      label: "Wellness",
      description:
        "Allow or block your assistant from reading your mood check-ins and medication adherence counts, so it can reference them in briefings and answer questions about them.",
      path: "/settings/modules/wellness",
      scope: "user",
      order: 40,
      permissionId: "wellness.view",
      entry: "./settings"
    }
  ],
  permissions: [
    {
      id: "wellness.view",
      label: "View wellness",
      description: "Read the active actor's own wellness check-ins and medications.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "wellness.create",
      label: "Log wellness",
      description: "Create check-ins, medications, and dose logs owned by the active actor.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "wellness.update",
      label: "Update wellness",
      description: "Update the active actor's own check-ins, medications, and AI-consent setting.",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "wellness.delete",
      label: "Delete wellness",
      description: "Delete the active actor's own therapy notes.",
      scope: "user",
      actions: ["delete"]
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/wellness/ai-consent",
      responseSchema: wellnessAiConsentResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "PUT",
      path: "/api/wellness/ai-consent",
      requestSchema: putWellnessAiConsentRequestSchema,
      responseSchema: wellnessAiConsentResponseSchema,
      permissionId: "wellness.update"
    },
    {
      method: "POST",
      path: "/api/wellness/checkins",
      requestSchema: createCheckinRequestSchema,
      responseSchema: createCheckinResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "GET",
      path: "/api/wellness/checkins",
      responseSchema: listCheckinsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "PATCH",
      path: "/api/wellness/checkins/:id",
      requestSchema: updateCheckinRouteSchema.body,
      responseSchema: updateCheckinRouteSchema.response[200],
      permissionId: "wellness.update"
    },
    {
      method: "GET",
      path: "/api/wellness/medications",
      responseSchema: listMedicationsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications",
      requestSchema: createMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "PATCH",
      path: "/api/wellness/medications/:id",
      requestSchema: updateMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.update"
    },
    {
      method: "GET",
      path: "/api/wellness/medications/schedule",
      responseSchema: medicationScheduleResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications/:id/logs",
      requestSchema: createMedicationLogRequestSchema,
      responseSchema: createMedicationLogResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "GET",
      path: "/api/wellness/insights",
      responseSchema: wellnessInsightsRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "GET",
      path: "/api/wellness/therapy-notes",
      responseSchema: listTherapyNotesRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/therapy-notes",
      requestSchema: createTherapyNoteRouteSchema.body,
      responseSchema: createTherapyNoteRouteSchema.response[201],
      permissionId: "wellness.create"
    },
    {
      method: "DELETE",
      path: "/api/wellness/therapy-notes/:id",
      responseSchema: deleteTherapyNoteRouteSchema.response[200],
      permissionId: "wellness.delete"
    },
    {
      method: "GET",
      path: "/api/wellness/medications/logs",
      responseSchema: medicationAdherenceSummaryRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/export",
      requestSchema: wellnessExportRequestSchema,
      permissionId: "wellness.view"
    }
  ],
  jobs: [
    {
      // Designed seam; NO worker registered until the Phase-3 scheduler lands (deferred).
      queueName: WELLNESS_MEDICATION_REMINDER_QUEUE,
      metadataOnly: true,
      permissionId: "wellness.view"
    },
    {
      // Selective Wellness export (#484). Metadata-only payload; worker re-reads the
      // selected window + categories from the job row. Reuses the settings data-export
      // pipeline for status/download/expiry.
      queueName: WELLNESS_EXPORT_QUEUE,
      metadataOnly: true,
      permissionId: "wellness.view"
    }
  ],
  assistantTools: [
    {
      name: "wellness.recentCheckIns",
      description:
        "List the actor's recent feelings check-ins (most recent first): timestamp, core feeling, secondary feeling, intensity, and free-text note (may be null). Read-only.",
      permissionId: "wellness.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: wellnessRecentCheckInsExecute
    },
    {
      name: "wellness.medicationAdherence",
      description:
        "Summarize the actor's medication adherence over the last 7 days as counts (scheduled, taken, skipped, PRN) and an adherence rate. Returns counts only, never a medication list. Read-only.",
      permissionId: "wellness.view",
      risk: "read",
      inputSchema: { type: "object", properties: {} },
      execute: wellnessMedicationAdherenceExecute
    }
  ],
  focusSignal: wellnessFocusSignal,
  dataLifecycle: {
    // Full-account export (#801 Phase A): reproduces today's sections.wellness = { checkins,
    // therapy_notes } exactly (byte-compat golden test in tests/integration/data-export.test.ts).
    // medications / medication_logs feed the archive's separate structured_state section and
    // are read there in @moss/settings — not required here (only deletion.tables must cover
    // every ownedTables entry).
    exportSections: [
      {
        key: "wellness",
        displayName: "Wellness",
        collect: collectWellnessExportSection
      }
    ],
    deletion: {
      strategy: "cascade",
      tables: [
        { table: "app.wellness_checkins" },
        { table: "app.medications" },
        { table: "app.medication_logs" },
        { table: "app.wellness_therapy_notes" }
      ]
    }
  }
} satisfies MossModuleManifest;
