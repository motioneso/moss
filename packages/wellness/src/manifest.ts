import { checkinPresentation, therapyNoteRemovalPresentation } from "./approval-presentation.js";
import { fileURLToPath } from "node:url";

import { assertDataContextDb } from "@moss/db";
import { PreferencesRepository } from "@moss/structured-state";

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

import {
  resolveEffectiveWellnessConsent,
  WELLNESS_AI_CONSENT_PREFERENCE_KEY
} from "./ai-consent.js";
import { therapyNoteTarget } from "./chat-targets.js";
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
        "Allow assistant access to mood check-ins and medication adherence for briefings and questions. Unknown choices stay unavailable; read failures offer Retry separately from save errors. Failed refreshes retain the confirmed choice.",
      path: "/settings?section=modules&module=wellness",
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
  chatDefaults: { consent: WELLNESS_AI_CONSENT_PREFERENCE_KEY },
  aiConsent: {
    key: WELLNESS_AI_CONSENT_PREFERENCE_KEY,
    async isGranted(scopedDb) {
      assertDataContextDb(scopedDb);
      // The normal route guard still requires an active module; active users default to consent.
      return resolveEffectiveWellnessConsent(
        scopedDb,
        new PreferencesRepository(),
        undefined,
        true
      );
    }
  },
  routes: [
    {
      method: "GET",
      path: "/api/wellness/ai-consent",
      chat: { access: "read", content: "user_authored" },
      responseSchema: wellnessAiConsentResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "PUT",
      path: "/api/wellness/ai-consent",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      requestSchema: putWellnessAiConsentRequestSchema,
      responseSchema: wellnessAiConsentResponseSchema,
      permissionId: "wellness.update"
    },
    {
      method: "POST",
      path: "/api/wellness/checkins",
      chat: {
        access: "write",
        title: "Log mood check-in",
        presentation: checkinPresentation(false),
        content: "outside"
      },
      requestSchema: createCheckinRequestSchema,
      responseSchema: createCheckinResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "GET",
      path: "/api/wellness/checkins",
      chat: { access: "read", content: "outside" },
      responseSchema: listCheckinsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "PATCH",
      path: "/api/wellness/checkins/:id",
      chat: {
        access: "write",
        title: "Update mood check-in",
        presentation: checkinPresentation(true),
        content: "outside"
      },
      requestSchema: updateCheckinRouteSchema.body,
      responseSchema: updateCheckinRouteSchema.response[200],
      permissionId: "wellness.update"
    },
    {
      method: "GET",
      path: "/api/wellness/medications",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listMedicationsResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      requestSchema: createMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "PATCH",
      path: "/api/wellness/medications/:id",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      requestSchema: updateMedicationRequestSchema,
      responseSchema: medicationResponseSchema,
      permissionId: "wellness.update"
    },
    {
      method: "GET",
      path: "/api/wellness/medications/schedule",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: medicationScheduleResponseSchema,
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/medications/:id/logs",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      requestSchema: createMedicationLogRequestSchema,
      responseSchema: createMedicationLogResponseSchema,
      permissionId: "wellness.create"
    },
    {
      method: "GET",
      path: "/api/wellness/insights",
      chat: { access: "read", content: "user_authored" },
      responseSchema: wellnessInsightsRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "GET",
      path: "/api/wellness/therapy-notes",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listTherapyNotesRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/therapy-notes",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      requestSchema: createTherapyNoteRouteSchema.body,
      responseSchema: createTherapyNoteRouteSchema.response[201],
      permissionId: "wellness.create"
    },
    {
      method: "DELETE",
      path: "/api/wellness/therapy-notes/:id",
      chat: {
        access: "destructive",
        title: "Delete therapy note",
        content: "user_authored",
        target: therapyNoteTarget,
        presentation: therapyNoteRemovalPresentation
      },
      responseSchema: deleteTherapyNoteRouteSchema.response[200],
      permissionId: "wellness.delete"
    },
    {
      method: "GET",
      path: "/api/wellness/medications/logs",
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: medicationAdherenceSummaryRouteSchema.response[200],
      permissionId: "wellness.view"
    },
    {
      method: "POST",
      path: "/api/wellness/export",
      chat: { access: "blocked", blockedBecause: "external_effect" },
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
      content: "outside",
      inputSchema: { type: "object", properties: {} },
      execute: wellnessRecentCheckInsExecute
    },
    {
      name: "wellness.medicationAdherence",
      description:
        "Summarize the actor's medication adherence over the last 7 days as counts (scheduled, taken, skipped, PRN) and an adherence rate. Returns counts only, never a medication list. Read-only.",
      permissionId: "wellness.view",
      risk: "read",
      content: "user_authored",
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
  },
  features: [
    {
      id: "wellness.chat_app_actions",
      description:
        "App actions require effective Wellness AI consent for check-ins and derived insights. Therapy-note deletion asks with a timestamp-only preview. Raw medication details and therapy-note text remain unavailable."
    },
    {
      id: "wellness.mood_checkins",
      description:
        "Log emotion, energy and a note; review history and insights. Failed reads offer Retry and retain known data. The mood average covers the previous 14 calendar days. Trends offer keyboard day selection and daily values alongside the chart."
    },
    {
      id: "wellness.medication_tracking",
      description:
        "Keep a medication list with schedules and as-needed doses. The day view asks about scheduled " +
        "doses, and 30-day adherence shows up in Wellness insights and in briefings when allowed."
    },
    {
      id: "wellness.therapy_notes",
      description:
        "Keep private therapy notes the assistant cannot read; include them in your export. Failed exports and failed status checks offer Retry without discarding the export selection."
    }
  ]
} satisfies MossModuleManifest;
