import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  briefingRunPayloadSchema,
  createBriefingDefinitionRequestSchema,
  createBriefingDefinitionResponseSchema,
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
