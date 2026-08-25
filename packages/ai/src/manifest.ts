import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  aiDiscoverModelsResponseSchema,
  createAiConfiguredModelRequestSchema,
  createAiConfiguredModelResponseSchema,
  createAiProviderConfigRequestSchema,
  createAiProviderConfigResponseSchema,
  deleteAiServiceBindingResponseSchema,
  discoverAiProviderModelsResponseSchema,
  getAiSummaryResponseSchema,
  getChatModelOverrideSettingsResponseSchema,
  getAiAdminUserPinResponseSchema,
  getVoiceEndpointResponseSchema,
  putVoiceEndpointRequestSchema,
  putVoiceEndpointResponseSchema,
  invokeAiAssistantToolRequestSchema,
  invokeAiAssistantToolResponseSchema,
  listAiServiceBindingsResponseSchema,
  listAiAssistantActionsResponseSchema,
  listAiAssistantToolsResponseSchema,
  listAiConfiguredModelsResponseSchema,
  listAiProviderConfigsResponseSchema,
  lookupAiCapabilityRouteResponseSchema,
  putAiServiceBindingRequestSchema,
  putAiServiceBindingResponseSchema,
  putAdminChatModelOverrideRequestSchema,
  putAiAdminUserPinRequestSchema,
  putChatModelOverrideRequestSchema,
  resolveAiAssistantActionRequestSchema,
  resolveAiAssistantActionResponseSchema,
  revokeAiProviderConfigResponseSchema,
  testAiProviderConfigResponseSchema,
  transcribeAudioResponseSchema,
  updateAiConfiguredModelRequestSchema,
  updateAiConfiguredModelResponseSchema,
  updateAiProviderConfigRequestSchema,
  updateAiProviderConfigResponseSchema,
  getAiActionPoliciesResponseSchema,
  patchAiActionPolicyRequestSchema,
  patchAiActionPolicyResponseSchema,
  listActionAuditLogRouteSchema,
  approveModuleBuildResponseSchema
} from "@moss/shared";

import { aiExplainRecentErrorsExecute } from "./error-tools.js";

export const AI_MODULE_ID = "ai";
export const aiModuleSqlMigrationDirectory = fileURLToPath(new URL("../sql", import.meta.url));

export const aiModuleManifest = {
  id: AI_MODULE_ID,
  name: "AI",
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
    migrations: [
      "sql/0013_ai_module.sql",
      "sql/0016_ai_assistant_actions.sql",
      "sql/0033_ai_auth_method.sql",
      "sql/0037_ai_worker_read_grants.sql",
      "sql/0048_ai_model_tier.sql",
      "sql/0091_chat_model_override.sql",
      "sql/0098_ai_cancel_stale_assistant_actions.sql",
      "sql/0127_jarvis_action_audit_log.sql",
      "sql/0145_jarvis_error_log.sql",
      // #870/H1 — instance-default provider flag + global single-default index.
      "sql/0147_ai_provider_instance_default.sql",
      // #870 Fable HIGH-1 — grant jarvis_worker_runtime INSERT on jarvis_error_log so the H3
      // worker needs-config observability log actually records (0145 granted app-runtime only).
      "sql/0148_jarvis_error_log_worker_insert.sql",
      // #874 — `purpose` discriminator ('assistant'|'voice') + one-voice partial unique index so the
      // Voice(STT) endpoint reuses the AI provider/model tables without bleeding into chat routing.
      "sql/0150_ai_provider_purpose.sql"
    ],
    migrationDirectories: ["packages/ai/sql"],
    ownedTables: [
      "app.ai_provider_configs",
      "app.ai_configured_models",
      "app.ai_assistant_action_requests",
      "app.moss_action_audit_log",
      "app.moss_error_log"
    ]
  },
  settings: [
    {
      id: "ai.user-settings",
      label: "AI Providers",
      description: "Configure the personal assistant's model, routing, and response behavior.",
      path: "/settings/ai",
      scope: "user",
      order: 40,
      permissionId: "ai.manage"
    }
  ],
  permissions: [
    {
      id: "ai.view",
      label: "View AI configuration",
      description: "View safe AI provider and model configuration metadata for the active actor.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "ai.manage",
      label: "Manage AI configuration",
      description: "Create, update, deactivate, and revoke AI provider and model configuration.",
      scope: "user",
      actions: ["create", "update", "manage"]
    },
    {
      id: "ai.route",
      label: "Route AI capability",
      description: "Resolve an active configured model for a declared AI capability.",
      scope: "user",
      actions: ["view"]
    },
    {
      id: "ai.assistant-actions",
      label: "Confirm assistant actions",
      description:
        "View and resolve pending risky assistant action requests. Confirming a request with a " +
        "live confirmation waiter unblocks the paused tool call, which then executes.",
      scope: "user",
      actions: ["view", "update"]
    }
  ],
  featureFlags: [
    {
      id: "ai.module",
      label: "AI module",
      description: "Enables BYO AI provider metadata and capability-routing configuration.",
      scope: "system",
      defaultEnabled: true
    }
  ],
  routes: [
    {
      method: "GET",
      path: "/api/ai/summary",
      responseSchema: getAiSummaryResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "GET",
      path: "/api/ai/providers",
      responseSchema: listAiProviderConfigsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/providers",
      requestSchema: createAiProviderConfigRequestSchema,
      responseSchema: createAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PATCH",
      path: "/api/ai/providers/:id",
      requestSchema: updateAiProviderConfigRequestSchema,
      responseSchema: updateAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/revoke",
      responseSchema: revokeAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/test",
      responseSchema: testAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/discover-models",
      responseSchema: discoverAiProviderModelsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/providers/:id/models/discover",
      responseSchema: aiDiscoverModelsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/models",
      responseSchema: listAiConfiguredModelsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/models",
      requestSchema: createAiConfiguredModelRequestSchema,
      responseSchema: createAiConfiguredModelResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PATCH",
      path: "/api/ai/models/:id",
      requestSchema: updateAiConfiguredModelRequestSchema,
      responseSchema: updateAiConfiguredModelResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/capability-route/:capability",
      responseSchema: lookupAiCapabilityRouteResponseSchema,
      permissionId: "ai.route"
    },
    {
      // #870 Slice 1: unified per-service binding map, replaces per-capability routes. #874 HIGH-2:
      // Chat is the only bindable service (Voice moved to its own dedicated endpoint).
      method: "GET",
      path: "/api/ai/service-bindings",
      responseSchema: listAiServiceBindingsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PUT",
      path: "/api/ai/services/:service/binding",
      requestSchema: putAiServiceBindingRequestSchema,
      responseSchema: putAiServiceBindingResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "DELETE",
      path: "/api/ai/services/:service/binding",
      responseSchema: deleteAiServiceBindingResponseSchema,
      permissionId: "ai.manage"
    },
    {
      // #870/H1: promote a provider to the single instance-default.
      method: "PUT",
      path: "/api/ai/providers/:id/default",
      responseSchema: createAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/transcriptions",
      responseSchema: transcribeAudioResponseSchema,
      permissionId: "ai.route"
    },
    {
      // #874: dedicated Voice (STT) admin endpoint — both are admin-gated in-handler
      // (assertInstanceAdmin). GET never returns the API key (write-only); PUT is an upsert of the
      // single `purpose='voice'` provider row and runs NO auto-discovery (CRIT-1).
      method: "GET",
      path: "/api/ai/voice-endpoint",
      responseSchema: getVoiceEndpointResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PUT",
      path: "/api/ai/voice-endpoint",
      requestSchema: putVoiceEndpointRequestSchema,
      responseSchema: putVoiceEndpointResponseSchema,
      permissionId: "ai.manage"
    },
    // #1059 — owner-gated terminal control plane (password/status/ticket + WS relay). All 4
    // routes are admin-only diagnostic surfaces (same tier as voice-endpoint above), so
    // "ai.manage" for all of them. No shared request/response schemas exist for these yet — the
    // route bodies are small ad-hoc shapes validated inline in terminal-routes.ts, matching the
    // brief/corrections' scope (a shared-package schema wasn't specified for this task).
    {
      method: "GET",
      path: "/api/ai/terminal/status",
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/terminal/password",
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/terminal/ticket",
      permissionId: "ai.manage"
    },
    {
      // WS upgrade — registered as a Fastify GET route by @fastify/websocket ({ websocket: true }),
      // so it must be declared here as method "GET" for assertRouteCoverage to recognize it.
      method: "GET",
      path: "/api/ai/terminal",
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/chat-model-override",
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PUT",
      path: "/api/ai/chat-model-override",
      requestSchema: putChatModelOverrideRequestSchema,
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.route"
    },
    {
      method: "PUT",
      path: "/api/admin/ai/chat-model-override",
      requestSchema: putAdminChatModelOverrideRequestSchema,
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/admin/users/:userId/ai-pin",
      responseSchema: getAiAdminUserPinResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/users/:userId/ai-pin",
      requestSchema: putAiAdminUserPinRequestSchema,
      responseSchema: getAiAdminUserPinResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/assistant-tools",
      responseSchema: listAiAssistantToolsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/assistant-tools/:name/invoke",
      requestSchema: invokeAiAssistantToolRequestSchema,
      responseSchema: invokeAiAssistantToolResponseSchema,
      permissionId: "ai.route"
    },
    {
      method: "GET",
      path: "/api/ai/assistant-actions",
      responseSchema: listAiAssistantActionsResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      method: "POST",
      path: "/api/ai/assistant-actions/:id/resolve",
      requestSchema: resolveAiAssistantActionRequestSchema,
      responseSchema: resolveAiAssistantActionResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      method: "GET",
      path: "/api/ai/action-policy",
      responseSchema: getAiActionPoliciesResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PATCH",
      path: "/api/ai/action-policy/:moduleId/:actionFamilyId",
      requestSchema: patchAiActionPolicyRequestSchema,
      responseSchema: patchAiActionPolicyResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/action-audit",
      responseSchema: listActionAuditLogRouteSchema.response[200],
      permissionId: "ai.assistant-actions"
    },
    {
      // #1888 — the "Build it" button on the plan card the workshop.buildModule tool returns.
      // The plan itself is written by a tool call inside a chat turn; this is the separate,
      // explicit human confirmation that releases the build to the worker queue. Ownership is
      // re-checked server-side against the build row, so approving another user's build is
      // indistinguishable from approving one that does not exist.
      method: "POST",
      path: "/api/ai/module-builds/:buildId/approve",
      responseSchema: approveModuleBuildResponseSchema,
      permissionId: "ai.assistant-actions"
    }
  ],
  assistantTools: [
    {
      name: "ai.explainRecentErrors",
      description: "List recent structured error events visible to the active actor.",
      permissionId: "ai.view",
      risk: "read",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" }
        }
      },
      execute: aiExplainRecentErrorsExecute
    }
  ]
} satisfies MossModuleManifest;
