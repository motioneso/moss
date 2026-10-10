import { modelFavoritesPresentation } from "./approval-presentation.js";
import { fileURLToPath } from "node:url";

import type { MossModuleManifest } from "@moss/module-sdk";
import {
  aiDiscoverModelsResponseSchema,
  createAiConfiguredModelRequestSchema,
  createAiConfiguredModelResponseSchema,
  createAiProviderConfigRequestSchema,
  createAiProviderConfigResponseSchema,
  deleteAiServiceBindingResponseSchema,
  deleteAiConfiguredModelResponseSchema,
  discoverAiProviderModelsResponseSchema,
  getAiSummaryResponseSchema,
  getChatModelOverrideSettingsResponseSchema,
  chatModelFavoritesSchema,
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
  refreshAiProviderModelsResponseSchema,
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
  postAiActionFreedomRequestSchema,
  postAiActionFreedomResponseSchema,
  listActionAuditLogRouteSchema,
  listActivityLinesRouteSchema,
  approveModuleBuildResponseSchema,
  listMyModuleBuildsResponseSchema
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
      "sql/0150_ai_provider_purpose.sql",
      // #2208 — `origin` ('discovered'|'manual') so discovery prunes only its own rows and never a
      // model an admin added by hand.
      "sql/0212_ai_configured_models_origin.sql",
      "sql/0214_ai_configured_models_released_at.sql",
      // System One (TypeSafe) — a provider kind whose API answers fixed named questions, not chat.
      "sql/0241_ai_provider_kind_system_one.sql",
      // #2716 — persist an ACP identity for CLI providers while retaining unsupported legacy rows.
      "sql/0246_ai_provider_acp_agent_id.sql",
      // #2682 — the nightly worker-run purge job had no EXECUTE grant on the purge function.
      "sql/0245_moss_action_audit_purge_worker_grant.sql",
      // Plan 3.6a (#2889) — one flat, admin-readable, append-only row per model call.
      "sql/0254_moss_model_activity_log.sql",
      // #2956 — owner lines, owner-only detail with 30-day expiry, purge function.
      "sql/0258_activity_owner_lines.sql",
      // #2956 — turn link on the action audit log for the per-turn step join.
      "sql/0259_audit_log_turn_id.sql",
      // #3065: a server-resolved read can require confirmation without becoming a write.
      "sql/0289_ai_read_action_approval.sql",
      "sql/0296_ai_action_origin_and_timeout.sql",
      "sql/0298_ai_action_outcome_delivery.sql"
    ],
    migrationDirectories: ["packages/ai/sql"],
    ownedTables: [
      "app.ai_provider_configs",
      "app.ai_configured_models",
      "app.ai_assistant_action_requests",
      "app.moss_action_audit_log",
      "app.moss_error_log",
      "app.moss_model_activity_log",
      "app.moss_activity_detail"
    ]
  },
  settings: [
    {
      id: "ai.user-settings",
      label: "AI Providers",
      description:
        "Change the AI model for chat: choose which model answers, change model routing and response behavior.",
      path: "/settings?section=assistant",
      scope: "user",
      order: 40,
      permissionId: "ai.manage"
    }
  ],
  // #2208: Moss's app map for the Providers card's model controls (Settings > AI providers).
  features: [
    {
      id: "ai.clip_transcription_timestamps",
      description:
        "Transcription can return clip-relative segment timestamps when requested. This is file transcription, not streaming or speaker separation. Invalid or unsupported timestamps fail without changing providers.",
      remediations: [
        {
          id: "ai.clip_transcription.configure",
          description:
            "Check the transcription endpoint, selected model and its timestamp support in AI providers. Admin model restrictions still apply.",
          path: "/settings?section=aiproviders"
        }
      ],
      errors: [
        {
          code: "ai.clip_transcription.unavailable",
          class: "prerequisite",
          remediationRef: "ai.clip_transcription.configure",
          description:
            "No transcription-capable model, provider or usable credential is configured (HTTP 422)."
        },
        {
          code: "ai.clip_transcription.provider_failed",
          class: "transient",
          description:
            "The provider failed, or returned an invalid or unsupported timestamp response (HTTP 502). No transcript from that response is returned."
        },
        {
          code: "ai.clip_transcription.timeout",
          class: "transient",
          description:
            "The transcription request timed out (HTTP 504); Moss aborts its fetch. This does not establish whether the provider has stopped processing already-received audio."
        }
      ]
    },
    {
      // #2956: the Activity history line title for the module-build planning call.
      id: "structured.moss.workshop-build-plan",
      description: "Planned a module build"
    },
    {
      id: "ai.refresh_provider_models",
      description:
        "Refresh models: ask a provider for its current model list and store it. Vanished discovered " +
        "rows are removed; hand-added rows and the default entry stay. A failed refresh changes " +
        "nothing. Any admin sees models of an admin-owned provider.",
      remediations: [
        {
          id: "ai.refresh_provider_models.log_in",
          description: "Log in to the provider with its Log in button, then refresh again.",
          path: "/settings?section=aiproviders"
        },
        {
          id: "ai.refresh_provider_models.re_enter_key",
          description:
            "Edit the provider card, enter the API key again exactly as the provider issued it, " +
            "then refresh again.",
          path: "/settings?section=aiproviders"
        },
        {
          id: "ai.refresh_provider_models.add_by_hand",
          description: "Use Add model on the provider card to type in the model you need.",
          path: "/settings?section=aiproviders"
        }
      ],
      errors: [
        {
          code: "ai.refresh_provider_models.not_logged_in",
          class: "prerequisite",
          remediationRef: "ai.refresh_provider_models.log_in",
          description:
            "Shown as 'Not logged in': the provider has no stored sign-in to ask with, or the " +
            "provider refused the one it has (that sign-in then counts as expired)."
        },
        {
          code: "ai.refresh_provider_models.unsupported",
          class: "prerequisite",
          remediationRef: "ai.refresh_provider_models.add_by_hand",
          description:
            "Shown as 'This provider cannot list its models yet': no live list exists for this " +
            "provider kind (Google/Gemini today)."
        },
        {
          code: "ai.refresh_provider_models.unavailable",
          class: "transient",
          description:
            "Shown as 'The sign-in helper is not running': the service that holds provider " +
            "logins is not connected; start it or contact an administrator."
        },
        {
          code: "ai.refresh_provider_models.rejected_key",
          class: "prerequisite",
          remediationRef: "ai.refresh_provider_models.re_enter_key",
          description:
            "Shown as 'The provider rejected the API key': the provider answered 401 or 403; " +
            "enter the key again."
        },
        {
          code: "ai.refresh_provider_models.error",
          class: "transient",
          description:
            "Shown as 'Could not reach the provider': the vendor did not answer; retry later."
        }
      ]
    },
    {
      id: "ai.add_model_by_hand",
      description:
        "Add model: type a model id, display name, tier, and capabilities under a provider. The " +
        "row shows a * after its id (the list footer reads '* Manually added') and is never " +
        "removed by Refresh models or a re-login."
    },
    {
      id: "ai.remove_model",
      description:
        "Remove model: the trash button on a model row deletes it after a confirmation; the " +
        "minus button only disables it. The provider's default entry cannot be removed. The " +
        "Models section of each provider card collapses from its header.",
      errors: [
        {
          code: "ai.remove_model.sentinel",
          class: "validation",
          description:
            "Shown as 'The provider's default entry cannot be removed; disable it instead'."
        }
      ]
    },
    {
      id: "ai.classifier_gate_setting",
      description:
        "Classifier gate: the Chat gate choice (Off, Shadow, On) in the Classifier row on Settings > " +
        "AI providers, an instance-wide setting. On needs a shadow review of the current " +
        "classifier; changing the classifier drops On back to Shadow.",
      remediations: [
        {
          id: "ai.classifier_gate_setting.not_released",
          description:
            "Run the Classifier gate on Shadow and record a shadow review for the current " +
            "classifier; the gate cannot be turned On before then.",
          path: "/settings?section=aiproviders"
        }
      ],
      errors: [
        {
          code: "ai.classifier_gate_setting.not_released",
          class: "prerequisite",
          remediationRef: "ai.classifier_gate_setting.not_released",
          description:
            "Setting the classifier gate to On was refused because no shadow review is recorded " +
            "for the current classifier."
        }
      ]
    },
    {
      id: "ai.sorting_model",
      description:
        "Classifier: a row under Services on Settings > AI providers. An admin picks a small, " +
        "fast model for sorting, or Use main model. News and Sports ask it yes/no questions per " +
        "story and preference, falling back to the main model.",
      remediations: [
        {
          id: "ai.sorting_model.use_main_model",
          description:
            "Moss tries your main model instead when it can. To stop trying the classifier, choose Use main model.",
          path: "/settings?section=aiproviders"
        }
      ],
      errors: [
        {
          code: "ai.sorting_model.not_answering",
          class: "transient",
          description:
            "sorting model not answering: the chosen classifier failed or gave an unusable " +
            "answer. It is logged, not shown; the main model answers instead."
        }
      ]
    },
    {
      id: "ai.model_activity_log",
      description:
        "Admin-only log of every model call: chat turns, structured output including classifier " +
        "choices, transcription, embeddings, background tasks, module builds, probes and checks. " +
        "Rows hold time, kind, action, outcome, model and result."
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
      chat: { access: "read" },
      responseSchema: getAiSummaryResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "GET",
      path: "/api/ai/providers",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      responseSchema: listAiProviderConfigsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/providers",
      chat: { access: "blocked", blockedBecause: "secrets" },
      requestSchema: createAiProviderConfigRequestSchema,
      responseSchema: createAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PATCH",
      path: "/api/ai/providers/:id",
      chat: { access: "blocked", blockedBecause: "secrets" },
      requestSchema: updateAiProviderConfigRequestSchema,
      responseSchema: updateAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/revoke",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      responseSchema: revokeAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/cli-check",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: revokeAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/test",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: testAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/providers/:id/discover-models",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: discoverAiProviderModelsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/providers/:id/models/discover",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: aiDiscoverModelsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      // #2208: admin "Refresh models" — re-discover one provider's list and persist it.
      method: "POST",
      path: "/api/ai/providers/:id/models/refresh",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: refreshAiProviderModelsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/models",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: listAiConfiguredModelsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/models",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      requestSchema: createAiConfiguredModelRequestSchema,
      responseSchema: createAiConfiguredModelResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PATCH",
      path: "/api/ai/models/:id",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      requestSchema: updateAiConfiguredModelRequestSchema,
      responseSchema: updateAiConfiguredModelResponseSchema,
      permissionId: "ai.manage"
    },
    {
      // #2208 follow-up: Remove on a model row; the `default` sentinel is refused.
      method: "DELETE",
      path: "/api/ai/models/:id",
      chat: { access: "blocked", blockedBecause: "assistant_brain" },
      responseSchema: deleteAiConfiguredModelResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/capability-route/:capability",
      chat: { access: "read" },
      responseSchema: lookupAiCapabilityRouteResponseSchema,
      permissionId: "ai.route"
    },
    {
      // #870 Slice 1: unified per-service binding map, replaces per-capability routes. #874 HIGH-2:
      // Chat is the only bindable service (Voice moved to its own dedicated endpoint).
      method: "GET",
      path: "/api/ai/service-bindings",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: listAiServiceBindingsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PUT",
      path: "/api/ai/services/:service/binding",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: putAiServiceBindingRequestSchema,
      responseSchema: putAiServiceBindingResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "DELETE",
      path: "/api/ai/services/:service/binding",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: deleteAiServiceBindingResponseSchema,
      permissionId: "ai.manage"
    },
    {
      // #870/H1: promote a provider to the single instance-default.
      method: "PUT",
      path: "/api/ai/providers/:id/default",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: createAiProviderConfigResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/transcriptions",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: transcribeAudioResponseSchema,
      permissionId: "ai.route"
    },
    {
      // #874: dedicated Voice (STT) admin endpoint — both are admin-gated in-handler
      // (assertInstanceAdmin). GET never returns the API key (write-only); PUT is an upsert of the
      // single `purpose='voice'` provider row and runs NO auto-discovery (CRIT-1).
      method: "GET",
      path: "/api/ai/voice-endpoint",
      chat: { access: "blocked", blockedBecause: "secrets" },
      responseSchema: getVoiceEndpointResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PUT",
      path: "/api/ai/voice-endpoint",
      chat: { access: "blocked", blockedBecause: "secrets" },
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
      chat: { access: "read" },
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/terminal/password",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/terminal/ticket",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "ai.manage"
    },
    {
      // WS upgrade — registered as a Fastify GET route by @fastify/websocket ({ websocket: true }),
      // so it must be declared here as method "GET" for assertRouteCoverage to recognize it.
      method: "GET",
      path: "/api/ai/terminal",
      chat: { access: "blocked", blockedBecause: "secrets" },
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/chat-model-override",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PUT",
      path: "/api/ai/chat-model-override",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: putChatModelOverrideRequestSchema,
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.route"
    },
    {
      method: "GET",
      path: "/api/ai/chat-model-favorites",
      chat: { access: "read", content: "user_authored" },
      responseSchema: chatModelFavoritesSchema,
      permissionId: "ai.view"
    },
    {
      method: "PUT",
      path: "/api/ai/chat-model-favorites",
      chat: {
        access: "write",
        title: "Change your favourite chat models",
        presentation: modelFavoritesPresentation,
        content: "user_authored"
      },
      requestSchema: chatModelFavoritesSchema,
      responseSchema: chatModelFavoritesSchema,
      permissionId: "ai.route"
    },
    {
      method: "PUT",
      path: "/api/admin/ai/chat-model-override",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: putAdminChatModelOverrideRequestSchema,
      responseSchema: getChatModelOverrideSettingsResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/admin/users/:userId/ai-pin",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: getAiAdminUserPinResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "PUT",
      path: "/api/admin/users/:userId/ai-pin",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: putAiAdminUserPinRequestSchema,
      responseSchema: getAiAdminUserPinResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/assistant-tools",
      chat: { access: "read" },
      responseSchema: listAiAssistantToolsResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "POST",
      path: "/api/ai/assistant-tools/:name/invoke",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: invokeAiAssistantToolRequestSchema,
      responseSchema: invokeAiAssistantToolResponseSchema,
      permissionId: "ai.route"
    },
    {
      method: "GET",
      path: "/api/ai/assistant-actions",
      chat: { access: "read" },
      responseSchema: listAiAssistantActionsResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      method: "POST",
      path: "/api/ai/assistant-actions/:id/resolve",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: resolveAiAssistantActionRequestSchema,
      responseSchema: resolveAiAssistantActionResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      method: "GET",
      path: "/api/ai/action-policy",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: getAiActionPoliciesResponseSchema,
      permissionId: "ai.view"
    },
    {
      method: "PATCH",
      path: "/api/ai/action-policy/:moduleId/:actionFamilyId",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: patchAiActionPolicyRequestSchema,
      responseSchema: patchAiActionPolicyResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "POST",
      path: "/api/ai/action-policy/:moduleId/freedom",
      chat: { access: "blocked", blockedBecause: "self_authority" },
      requestSchema: postAiActionFreedomRequestSchema,
      responseSchema: postAiActionFreedomResponseSchema,
      permissionId: "ai.manage"
    },
    {
      method: "GET",
      path: "/api/ai/action-audit",
      chat: { access: "read" },
      responseSchema: listActionAuditLogRouteSchema.response[200],
      permissionId: "ai.assistant-actions"
    },
    {
      // #2956: the viewer's own activity lines the Activity page reads.
      // Owner-scoped like the audit log above, so it carries the same permission.
      // Slice D retired the old admin-only model-activity endpoint with its page;
      // admins read the same rows through this route instead.
      method: "GET",
      path: "/api/ai/activity-lines",
      // Turn details retain the user's full message, including prior consent-gated words.
      chat: { access: "blocked", blockedBecause: "data_scope_consent" },
      responseSchema: listActivityLinesRouteSchema.response[200],
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
      chat: { access: "blocked", blockedBecause: "self_authority" },
      responseSchema: approveModuleBuildResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      // The Workshop Stop/Discard actions re-check ownership and cancellable status server-side.
      method: "POST",
      path: "/api/ai/module-builds/:buildId/cancel",
      chat: { access: "blocked", blockedBecause: "external_effect" },
      responseSchema: approveModuleBuildResponseSchema,
      permissionId: "ai.assistant-actions"
    },
    {
      // #1945 — the Workshop page's own list of the caller's builds. The repository query
      // scopes to owner_user_id, so this is never a cross-user listing.
      method: "GET",
      path: "/api/ai/module-builds/mine",
      chat: { access: "read" },
      responseSchema: listMyModuleBuildsResponseSchema,
      permissionId: "ai.assistant-actions"
    }
  ],
  assistantTools: [
    {
      name: "ai.explainRecentErrors",
      description: "List recent structured error events visible to the active actor.",
      permissionId: "ai.view",
      risk: "read",
      content: "outside",
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
