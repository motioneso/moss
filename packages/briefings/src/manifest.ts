import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  briefingRunPayloadSchema,
  createBriefingDefinitionRequestSchema,
  createBriefingDefinitionResponseSchema,
  getBriefingRunResponseSchema,
  listBriefingDefinitionsResponseSchema,
  listBriefingRunsResponseSchema,
  runBriefingDefinitionRequestSchema,
  runBriefingDefinitionResponseSchema,
  updateBriefingDefinitionRequestSchema,
  updateBriefingDefinitionResponseSchema
} from "@moss/shared";

export const BRIEFINGS_MODULE_ID = "briefings";
export const BRIEFINGS_RUN_QUEUE = "briefings-run";
export const briefingsModuleSqlMigrationDirectory = fileURLToPath(
  new URL("../sql", import.meta.url)
);

export const briefingsModuleManifest = {
  id: BRIEFINGS_MODULE_ID,
  name: "Briefings",
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
  notifications: { supported: true },
  database: {
    migrations: [
      "sql/0015_briefings_module.sql",
      "sql/0116_briefing_type.sql",
      "sql/0237_briefing_selected_tool_names_allow_empty.sql"
    ],
    migrationDirectories: ["packages/briefings/sql"],
    ownedTables: ["app.briefing_definitions", "app.briefing_runs"]
  },
  navigation: [
    {
      id: "briefings",
      label: "Briefings",
      description: "Review generated morning and evening briefings.",
      path: "/briefings",
      icon: "newspaper",
      order: 50,
      permissionId: "briefings.view"
    }
  ],
  permissions: [
    {
      id: "briefings.view",
      label: "View briefings",
      description: "Read briefing definitions and runs owned by or shared with the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "briefings.create",
      label: "Create briefings",
      description: "Create briefing definitions owned by the active actor.",
      scope: "user",
      actions: ["create"]
    },
    {
      id: "briefings.update",
      label: "Update briefings",
      description: "Update briefing definitions owned by the active actor.",
      scope: "user",
      actions: ["update"]
    },
    {
      id: "briefings.run",
      label: "Run briefings",
      description: "Queue metadata-only briefing runs over selected read-risk assistant tools.",
      scope: "user",
      actions: ["execute"]
    }
  ],
  // briefing_definitions is share-aware at the RLS layer: its SELECT policy uses
  // has_share('briefing_definition', id, 'view') and its UPDATE policy uses
  // has_share(..., 'manage') (sql/0026). Declare the resource here so the manifest
  // matches that reality and the briefings.view permission's "owned by or shared
  // with" wording is backed by a real shareable-resource entry (#150).
  shareableResources: [
    {
      resourceType: "briefing_definition",
      grantLevels: ["view", "manage"]
    }
  ],
  featureFlags: [
    {
      id: "briefings.module",
      label: "Briefings module",
      description: "Enables scheduled read-only briefing summaries.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/briefings/definitions",
      responseSchema: listBriefingDefinitionsResponseSchema,
      permissionId: "briefings.view"
    },
    {
      method: "POST",
      path: "/api/briefings/definitions",
      requestSchema: createBriefingDefinitionRequestSchema,
      responseSchema: createBriefingDefinitionResponseSchema,
      permissionId: "briefings.create"
    },
    {
      method: "PATCH",
      path: "/api/briefings/definitions/:id",
      requestSchema: updateBriefingDefinitionRequestSchema,
      responseSchema: updateBriefingDefinitionResponseSchema,
      permissionId: "briefings.update"
    },
    {
      method: "POST",
      path: "/api/briefings/definitions/:id/run",
      requestSchema: runBriefingDefinitionRequestSchema,
      responseSchema: runBriefingDefinitionResponseSchema,
      permissionId: "briefings.run"
    },
    {
      method: "GET",
      path: "/api/briefings/definitions/:id/runs",
      responseSchema: listBriefingRunsResponseSchema,
      permissionId: "briefings.view"
    },
    {
      method: "GET",
      path: "/api/briefings/definitions/:id/runs/:runId",
      responseSchema: getBriefingRunResponseSchema,
      permissionId: "briefings.view"
    }
  ],
  features: [
    {
      id: "briefings.refresh",
      description:
        "Queue a fresh briefing run for a definition and follow it to ready. A repeated " +
        "idempotency key reuses the run already queued instead of starting a second one.",
      errors: [
        {
          code: "briefing_run_in_flight",
          class: "transient",
          description:
            "A run with this idempotency key is already queued or running. Read the " +
            "promised run until it is ready instead of submitting again."
        }
      ],
      remediations: [
        {
          id: "briefings.refresh.wait",
          description: "Wait for the queued run, then read it again from the briefing history.",
          path: "/briefings"
        }
      ]
    },
    {
      id: "briefings.history",
      description:
        "List past briefing runs newest first, or read one run by id with its pending, " +
        "failed or ready state. Earlier reports stay dated and read-only.",
      errors: [
        {
          code: "briefing_run_not_available",
          class: "validation",
          description:
            "The named briefing run is missing or owned by someone else; both cases " +
            "look the same so runs cannot be probed."
        }
      ],
      remediations: [
        {
          id: "briefings.history.reread",
          description: "Pick the newest run in the briefing history and read it instead.",
          path: "/briefings"
        }
      ]
    },
    {
      id: "briefings.source_gaps",
      description:
        "A succeeded run that missed a source stays readable and lists each missing " +
        "source with its reason, so the gap is visible instead of silent.",
      remediations: [
        {
          id: "briefings.source_gaps.review",
          description: "Open the briefing to see which sources are missing and why.",
          path: "/briefings"
        }
      ]
    },
    {
      id: "briefings.plan_handoff",
      description:
        "A report records the plan id and revision it was written from, and a later " +
        "read says whether the saved plan has changed since. Acting on an old report " +
        "starts from the current plan, which rejects a stale revision.",
      remediations: [
        {
          id: "briefings.plan_handoff.refresh",
          description: "Read the current plan, then queue a fresh briefing run from it.",
          path: "/briefings"
        }
      ]
    }
  ],
  jobs: [
    {
      queueName: BRIEFINGS_RUN_QUEUE,
      payloadSchema: briefingRunPayloadSchema,
      metadataOnly: true,
      permissionId: "briefings.run"
    }
  ]
} satisfies MossModuleManifest;
