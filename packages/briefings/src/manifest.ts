import { briefingRerunPresentation } from "./approval-presentation.js";
import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  briefingRunPayloadSchema,
  createBriefingDefinitionRequestSchema,
  createBriefingDefinitionResponseSchema,
  getBriefingRunResponseSchema,
  nullableStringSchema,
  listBriefingDefinitionsResponseSchema,
  listBriefingRunsResponseSchema,
  runBriefingDefinitionRequestSchema,
  runBriefingDefinitionResponseSchema,
  updateBriefingDefinitionRequestSchema,
  updateBriefingDefinitionResponseSchema
} from "@moss/shared";

import { BRIEFINGS_MODULE_ID, BRIEFINGS_RUN_QUEUE } from "./identifiers.js";
import { briefingsGetRunStatusExecute, briefingsRerunExecute } from "./tools.js";

export { BRIEFINGS_MODULE_ID, BRIEFINGS_RUN_QUEUE };
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
  settings: [
    {
      id: "briefings.settings",
      label: "Briefings",
      description:
        "Set the morning and evening briefing times and choose the morning sources, including " +
        "news, sports, read tools, email and calendar signals, and a switch for each module you " +
        "have turned on that offers a briefing source.",
      path: "/settings?section=modules&module=briefings",
      scope: "user",
      permissionId: "briefings.update"
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
  assistantActionFamilies: [
    {
      id: "briefing_runs",
      label: "Re-run briefings",
      description:
        "Let your assistant queue a fresh run of one of your briefings when you ask in chat.",
      defaultTier: "ask_each_time",
      allowedTiers: ["ask_each_time", "trusted_auto", "always_confirm"]
    }
  ],
  assistantTools: [
    {
      name: "briefings.rerun",
      actionLabel: "Re-run a briefing",
      approvalPresentation: briefingRerunPresentation,
      description:
        "Re-run one of the user's own briefings now. Pick it by briefingType (morning, evening, " +
        "weekly_review) or by definitionId; give exactly one. Returns status queued, " +
        "already_running (a run for that briefing is still going, so no second run was started) " +
        "or no_briefing (the user has no such briefing). Keep runId and jobId, then call " +
        "briefings.getRunStatus to tell the user when the briefing is ready or has failed.",
      permissionId: "briefings.run",
      actionFamilyId: "briefing_runs",
      risk: "write",
      content: "user_authored",
      executionPolicy: "auto",
      // Re-running only writes a new dated report; earlier reports stay. Not destructive, so
      // installing the module grants normal use (Ben's ruling on Food, 2026-08-19).
      selfOperationGrant: "granted_at_install",
      requiresServices: ["briefingRunQueue"],
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          briefingType: {
            type: "string",
            enum: ["morning", "evening", "weekly_review"],
            description: "Which of the user's briefings to re-run"
          },
          definitionId: {
            type: "string",
            description: "A specific briefing definition id, instead of briefingType"
          }
        }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "definitionId", "briefingType", "runId", "jobId"],
        properties: {
          status: { type: "string", enum: ["queued", "already_running", "no_briefing"] },
          definitionId: nullableStringSchema,
          briefingType: nullableStringSchema,
          runId: {
            type: ["string", "null"],
            description: "Null only when the running job is a scheduled run not yet started"
          },
          jobId: nullableStringSchema
        }
      },
      execute: briefingsRerunExecute,
      summarize: (input) =>
        typeof input.briefingType === "string"
          ? `Re-run your ${input.briefingType.replace("_", " ")} briefing.`
          : "Re-run a briefing."
    },
    {
      name: "briefings.getRunStatus",
      description:
        "Check one briefing run of the user's, with the runId and jobId from briefings.rerun. " +
        "When runId is null (a scheduled run already going), pass jobId and definitionId. " +
        "state is pending (still being written), ready (summaryText holds the briefing), " +
        "failed, or not_found. Check again later while pending; never re-run to check.",
      permissionId: "briefings.view",
      risk: "read",
      content: "outside",
      externalContent: true,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        properties: {
          runId: { type: "string", description: "runId from briefings.rerun" },
          jobId: { type: "string", description: "jobId from briefings.rerun" },
          definitionId: {
            type: "string",
            description: "definitionId from briefings.rerun; needed when runId is null"
          }
        }
      },
      outputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["state", "runId", "definitionId", "briefingType", "createdAt", "summaryText"],
        properties: {
          state: { type: "string", enum: ["pending", "ready", "failed", "not_found"] },
          runId: nullableStringSchema,
          definitionId: nullableStringSchema,
          briefingType: nullableStringSchema,
          createdAt: nullableStringSchema,
          summaryText: nullableStringSchema
        }
      },
      execute: briefingsGetRunStatusExecute
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
      // Listing definitions schedules/unschedules the actor's jobs as a self-heal.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: listBriefingDefinitionsResponseSchema,
      permissionId: "briefings.view"
    },
    {
      method: "POST",
      path: "/api/briefings/definitions",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: createBriefingDefinitionRequestSchema,
      responseSchema: createBriefingDefinitionResponseSchema,
      permissionId: "briefings.create"
    },
    {
      method: "PATCH",
      path: "/api/briefings/definitions/:id",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: updateBriefingDefinitionRequestSchema,
      responseSchema: updateBriefingDefinitionResponseSchema,
      permissionId: "briefings.update"
    },
    {
      method: "POST",
      path: "/api/briefings/definitions/:id/run",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      requestSchema: runBriefingDefinitionRequestSchema,
      responseSchema: runBriefingDefinitionResponseSchema,
      permissionId: "briefings.run"
    },
    {
      method: "GET",
      path: "/api/briefings/definitions/:id/runs",
      // Both run reads upsert feedback/catch-up targets; neither is read-only.
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: listBriefingRunsResponseSchema,
      permissionId: "briefings.view"
    },
    {
      method: "GET",
      path: "/api/briefings/definitions/:id/runs/:runId",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: getBriefingRunResponseSchema,
      permissionId: "briefings.view"
    }
  ],
  features: [
    {
      // #2956: the Activity history line title for this module's structured calls.
      id: "structured.briefings",
      description: "Prepared a briefing"
    },
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
          path: "/today"
        }
      ]
    },
    {
      id: "briefings.chat_rerun",
      description:
        "Ask Moss in chat to re-run your morning, evening or weekly review briefing. Approval identifies your saved briefing. It queues one run and can report readiness or failure; asking again while it runs starts no second run.",
      errors: [
        {
          code: "briefing_run_in_flight",
          class: "transient",
          description:
            "A run of that briefing is already queued or being written, so no second run " +
            "was started. Check that run instead."
        },
        {
          code: "briefing_not_set_up",
          class: "prerequisite",
          description: "You have no briefing of that type to re-run.",
          remediationRef: "briefings.chat_rerun.set_up"
        }
      ],
      remediations: [
        {
          id: "briefings.chat_rerun.wait",
          description: "Ask Moss again in a minute whether the briefing is ready.",
          path: "/today"
        },
        {
          id: "briefings.chat_rerun.set_up",
          description: "Turn on the evening briefing or set briefing times in briefing settings.",
          path: "/settings?section=modules&module=briefings"
        }
      ]
    },
    {
      id: "briefings.history",
      description:
        "List past briefing runs newest first, or read one run by id with its pending, " +
        "failed or ready state. Earlier reports stay dated and read-only. A run written " +
        "without AI returns empty summary text, so its source list is never shown.",
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
          path: "/today"
        }
      ]
    },
    {
      id: "briefings.source_gaps",
      description:
        "A succeeded run that missed a source stays readable and lists each missing " +
        "source with its reason, so the gap is visible instead of silent. Mail that was " +
        "fetched but all judged not worth mentioning is recorded as filtered out, not empty.",
      remediations: [
        {
          id: "briefings.source_gaps.review",
          description: "Open the briefing to see which sources are missing and why.",
          path: "/today"
        }
      ]
    },
    {
      id: "briefings.morning_inputs",
      description:
        "Morning briefings read open tasks and tasks finished since the last one, never " +
        "archived tasks. Email covers mail still awaiting a closer look, pending commitment " +
        "suggestions and a short worth-knowing roundup."
    },
    {
      id: "briefings.evening_email",
      description:
        "Evening briefings read today's mail like the morning one: mail awaiting a closer " +
        "look, pending commitment suggestions and a short worth-knowing roundup. Mail all " +
        "left out is recorded as filtered out."
    },
    {
      id: "briefings.ai_writing",
      description:
        "Briefings are written by the summarization model chosen in the admin AI settings, " +
        "signed in by API key or subscription login. Without a working model no written " +
        "briefing appears and Today keeps its normal header.",
      remediations: [
        {
          id: "briefings.ai_writing.configure",
          description: "Add or fix a summarization model in the admin AI provider settings.",
          path: "/settings?section=aiproviders"
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
          path: "/today"
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
