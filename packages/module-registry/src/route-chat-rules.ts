import type { SelfOperationExclusionCategory } from "@moss/module-sdk";

export interface ChatBlockedPathRule {
  /** Tested against the manifest route pattern, e.g. `/api/me/modules/:id`. */
  readonly pattern: RegExp;
  readonly category: SelfOperationExclusionCategory;
  /** True: GET on the path stays classifiable. */
  readonly writesOnly?: boolean;
  /** `SELF_OPERATION_EXCLUSIONS` prefixes this rule covers, for the July walk. */
  readonly julyPrefixes?: readonly string[];
}

export interface JulyExcludedRoute {
  readonly method: string;
  readonly path: string;
  readonly category: SelfOperationExclusionCategory;
  readonly julyPrefixes: readonly string[];
}

export interface JulyPrefixWithoutRoutes {
  /** A `toolNamePrefixes` entry in `SELF_OPERATION_EXCLUSIONS`. */
  readonly prefix: string;
  readonly reason: string;
}

export interface DestructiveWordPostAllowed {
  readonly path: string;
  readonly reason: string;
}

/**
 * Paths Moss may never call, whatever the manifest says. First match wins. The July families
 * (decision 2.22) match by pattern so a new route in a family is caught without a table row.
 */
export const CHAT_BLOCKED_PATH_RULES: readonly ChatBlockedPathRule[] = [
  {
    pattern: /^\/api\/people\/notes-settings$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.notesSourceSelection."]
  },
  {
    pattern: /^\/api\/admin(\/|$)/,
    category: "self_authority",
    julyPrefixes: [
      "settings.module.install.",
      "settings.module.remove.",
      "settings.module.purge.",
      "ai.adminPin."
    ]
  },
  { pattern: /^\/api\/auth(\/|$)/, category: "identity_auth_registration" },
  {
    pattern: /^\/api\/onboarding\/provider-(login|install)(\/|$)/,
    category: "secrets",
    julyPrefixes: ["settings.onboarding.login.", "settings.onboarding.install."]
  },
  { pattern: /^\/api\/onboarding(\/|$)/, category: "identity_auth_registration" },
  { pattern: /^\/api\/companion(\/|$)/, category: "identity_auth_registration" },
  { pattern: /^\/api\/mcp(\/|$)/, category: "self_authority" },
  { pattern: /^\/internal(\/|$)/, category: "self_authority" },
  { pattern: /^\/api\/ai\/assistant-tools\/[^/]+\/invoke$/, category: "self_authority" },
  {
    pattern: /^\/api\/(ai\/assistant-actions|chat\/action-requests)\/[^/]+\/resolve$/,
    category: "self_authority"
  },
  { pattern: /^\/api\/workflows\/approvals\/[^/]+\/resolve$/, category: "self_authority" },

  {
    pattern: /^\/api\/(settings\/me\/data-export|me\/export\/download\/[^/]+)$/,
    category: "data_scope_consent"
  },
  {
    pattern: /^\/api\/ai\/action-policy(\/|$)/,
    category: "self_authority",
    julyPrefixes: ["settings.actionPolicy.tier."]
  },
  {
    pattern: /^\/api\/ai\/chat-model-override$/,
    category: "self_authority",
    julyPrefixes: ["ai.chatModelOverride."]
  },
  {
    pattern: /^\/api\/ai\/(service-bindings|services\/[^/]+\/binding)$/,
    category: "self_authority",
    julyPrefixes: ["ai.serviceBinding."]
  },
  { pattern: /^\/api\/me\/yolo$/, category: "self_authority", julyPrefixes: ["settings.yolo."] },
  {
    pattern: /^\/api\/connectors\/accounts\/[^/]+\/feature-grants$/,
    category: "self_authority",
    julyPrefixes: ["settings.connector.featureGrant."]
  },
  {
    pattern: /^\/api\/ai\/providers\/[^/]+\/default$/,
    category: "self_authority",
    julyPrefixes: ["ai.defaultProvider."]
  },
  {
    pattern: /^\/api\/ai\/providers(\/[^/]+)?$/,
    category: "secrets",
    writesOnly: true,
    julyPrefixes: ["settings.provider.create.", "settings.provider.update."]
  },
  {
    pattern:
      /^\/api\/ai\/providers\/[^/]+\/(test|cli-check|discover-models|models\/discover|models\/refresh)$/,
    category: "external_effect",
    julyPrefixes: ["settings.providerTest.", "settings.providerDiscovery."]
  },
  {
    pattern: /^\/api\/ai\/providers(\/|$)/,
    category: "assistant_brain",
    julyPrefixes: ["ai.providerRevoke.", "ai.modelDisable."]
  },
  {
    pattern: /^\/api\/me\/persona(\/|$)/,
    category: "prompt_shaping",
    julyPrefixes: ["settings.persona.", "settings.assistantName."]
  },
  {
    pattern: /^\/api\/chat\/skills(\/|$)/,
    category: "prompt_shaping",
    julyPrefixes: ["settings.chatSkill.mutate.", "settings.chatSkill.import."]
  },
  {
    pattern: /^\/api\/me\/modules\/[^/]+$/,
    category: "self_authority",
    writesOnly: true,
    julyPrefixes: ["settings.module.enable."]
  },
  {
    pattern: /^\/api\/tasks\/agency-auto-execute$/,
    category: "self_authority",
    julyPrefixes: ["settings.taskAgency.autoExecution."]
  },
  {
    pattern: /^\/api\/chat\/memory\/settings$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.memorySettings."]
  },
  {
    pattern: /^\/api\/chat\/page-context$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.pageContext.write."]
  },
  {
    pattern: /^\/api\/me\/source-behaviors(\/|$)/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.sourceBehavior."]
  },
  {
    pattern: /^\/api\/me\/priority-model$/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.priorityRanking."]
  },
  {
    pattern: /^\/api\/me\/notes-source(\/|$)/,
    category: "prompt_shaping",
    writesOnly: true,
    julyPrefixes: ["settings.notesSourceSelection."]
  },
  {
    pattern: /^\/api\/ai\/voice-endpoint$/,
    category: "secrets",
    julyPrefixes: ["settings.voiceEndpoint."]
  },
  {
    pattern: /^\/api\/ai\/terminal\/(password|ticket)$/,
    category: "secrets",
    julyPrefixes: ["settings.terminal.password.", "settings.terminal.ticket."]
  },
  {
    pattern: /^\/api\/news\/(credentials|sources\/credentialed|sources\/[^/]+\/credential)$/,
    category: "secrets",
    julyPrefixes: ["settings.credential."]
  },
  {
    pattern: /^\/api\/wellness\/ai-consent$/,
    category: "data_scope_consent",
    writesOnly: true,
    julyPrefixes: ["settings.wellnessAiConsent."]
  }
];

/** Routes doing what an excluded tool family does that no path rule covers. Slices 3 and 4. */
export const JULY_EXCLUDED_ROUTES: readonly JulyExcludedRoute[] = [
  {
    method: "GET",
    path: "/api/ai/activity-lines",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/chat/memory/facts",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/chat/memory/corrections",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/chat/messages/:messageId/provenance",
    category: "data_scope_consent",
    julyPrefixes: []
  },

  {
    method: "GET",
    path: "/api/memory/graph/recall",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/memory/graph/core",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/memory/dashboard",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/memory/graph/facts/:id/confirm",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/memory/graph/facts/:id/correct",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/memory/graph/facts/:id/status",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/memory/graph/facts/:id/mark-stale",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  { method: "GET", path: "/api/chat/threads", category: "data_scope_consent", julyPrefixes: [] },
  {
    method: "GET",
    path: "/api/chat/threads/:id/messages",
    category: "data_scope_consent",
    julyPrefixes: []
  },

  {
    method: "GET",
    path: "/api/me/proactive-monitoring-settings",
    category: "external_effect",
    julyPrefixes: ["settings.proactive."]
  },
  {
    method: "PATCH",
    path: "/api/tasks/:id",
    category: "external_effect",
    julyPrefixes: []
  },
  // Slice 4: audited hidden effects, withheld content and approval-target promises.
  {
    method: "GET",
    path: "/api/wellness/medications",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/wellness/medications",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "PATCH",
    path: "/api/wellness/medications/:id",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/wellness/medications/schedule",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/wellness/medications/:id/logs",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/wellness/medications/logs",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/wellness/therapy-notes",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/wellness/therapy-notes",
    category: "data_scope_consent",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/wellness/export",
    category: "external_effect",
    julyPrefixes: ["settings.export."]
  },
  { method: "POST", path: "/api/people", category: "external_effect", julyPrefixes: [] },
  { method: "PATCH", path: "/api/people/:id", category: "external_effect", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/people/:id/archive",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/people/index/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.moduleQueueRun."]
  },
  {
    method: "POST",
    path: "/api/people/notes/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.notesSourceScheduling."]
  },
  { method: "POST", path: "/api/people/:id/merge", category: "module_promise", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/people/:id/split-identity",
    category: "module_promise",
    julyPrefixes: []
  },
  { method: "PUT", path: "/api/scratchpad", category: "module_promise", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/notes/sync",
    category: "external_effect",
    julyPrefixes: ["settings.notesSourceScheduling."]
  },
  {
    method: "GET",
    path: "/api/tasks",
    category: "external_effect",
    julyPrefixes: ["settings.scheduledWork."]
  },
  {
    method: "POST",
    path: "/api/tasks",
    category: "external_effect",
    julyPrefixes: ["settings.scheduledWork."]
  },
  {
    method: "POST",
    path: "/api/tasks/search/interpret",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/tasks/:id/deferred-status",
    category: "external_effect",
    julyPrefixes: ["settings.scheduledWork."]
  },
  {
    method: "GET",
    path: "/api/tasks/lists",
    category: "external_effect",
    julyPrefixes: ["settings.scheduledWork."]
  },
  { method: "GET", path: "/api/tasks/focus", category: "external_effect", julyPrefixes: [] },
  { method: "GET", path: "/api/tasks/at-risk", category: "external_effect", julyPrefixes: [] },
  { method: "GET", path: "/api/tasks/overdue", category: "external_effect", julyPrefixes: [] },
  { method: "GET", path: "/api/tasks/preferences", category: "external_effect", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/calendar/day-plans/:id/preview",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/calendar/day-plans/:id/apply",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/calendar/day-plans/:id/operations/:operationId/retry",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/calendar/day-plans/:id/operations/:operationId/recover",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/calendar/day-plans/:id/operations/:operationId/confirm",
    category: "self_authority",
    julyPrefixes: []
  },
  {
    method: "PATCH",
    path: "/api/calendar/briefing-settings",
    category: "self_authority",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/commitments/extract",
    category: "external_effect",
    julyPrefixes: []
  },
  { method: "PATCH", path: "/api/goals/:id", category: "external_effect", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/goals/:id/evidence",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/briefings/definitions",
    category: "external_effect",
    julyPrefixes: ["settings.scheduledWork.", "settings.cancelledWork."]
  },
  {
    method: "POST",
    path: "/api/briefings/definitions",
    category: "external_effect",
    julyPrefixes: [
      "settings.briefing.mutate.",
      "settings.scheduledWork.",
      "settings.cancelledWork."
    ]
  },
  {
    method: "PATCH",
    path: "/api/briefings/definitions/:id",
    category: "external_effect",
    julyPrefixes: [
      "settings.briefing.mutate.",
      "settings.scheduledWork.",
      "settings.cancelledWork."
    ]
  },
  {
    method: "POST",
    path: "/api/briefings/definitions/:id/run",
    category: "external_effect",
    julyPrefixes: ["settings.briefing.run."]
  },
  {
    method: "GET",
    path: "/api/briefings/definitions/:id/runs",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/briefings/definitions/:id/runs/:runId",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "GET",
    path: "/api/news/overview",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "GET",
    path: "/api/news/personalization",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/prefs",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "DELETE",
    path: "/api/news/prefs/:id",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/source-exclusions",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "DELETE",
    path: "/api/news/source-exclusions/:id",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/sources/preview",
    category: "external_effect",
    julyPrefixes: ["settings.newsPreview."]
  },
  {
    method: "POST",
    path: "/api/news/sources",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "DELETE",
    path: "/api/news/sources/:id",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/topics",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "PATCH",
    path: "/api/news/topics/:id",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "DELETE",
    path: "/api/news/topics/:id",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "POST",
    path: "/api/news/revalidation",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "GET",
    path: "/api/sports/overview",
    category: "external_effect",
    julyPrefixes: ["settings.newsRefresh."]
  },
  {
    method: "GET",
    path: "/api/sports/headlines/:headlineId/photo",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/sports/sources/preview",
    category: "external_effect",
    julyPrefixes: ["settings.newsPreview."]
  },
  { method: "POST", path: "/api/sports/sources", category: "external_effect", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/sports/sources/:id/assignments/preview",
    category: "external_effect",
    julyPrefixes: ["settings.newsPreview."]
  },
  {
    method: "PATCH",
    path: "/api/sports/sources/:id/assignments",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/sports/sources/:id/retry",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/sports/sources/:id/rebuild/preview",
    category: "external_effect",
    julyPrefixes: ["settings.newsPreview."]
  },
  {
    method: "PATCH",
    path: "/api/sports/sources/:id/rebuild",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/meetings/records/:id/exports",
    category: "external_effect",
    julyPrefixes: ["settings.export."]
  },
  {
    method: "POST",
    path: "/api/meetings/records/:id/outputs",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/meetings/records/:id/actions/:candidateId/review",
    category: "self_authority",
    julyPrefixes: []
  },
  { method: "POST", path: "/api/workshop/projects", category: "module_promise", julyPrefixes: [] },
  {
    method: "POST",
    path: "/api/workshop/projects/:projectId/messages",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "PATCH",
    path: "/api/email/briefing-settings",
    category: "self_authority",
    julyPrefixes: []
  },
  {
    method: "PUT",
    path: "/api/email/task-creation-mode",
    category: "self_authority",
    julyPrefixes: []
  },
  // The original UI actions can remove calendar follow-through, dismiss cards, create memory
  // candidates or enqueue feed refreshes. The separate /signals route records only safe pairs.
  {
    method: "POST",
    path: "/api/me/usefulness-feedback",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "PATCH",
    path: "/api/me/usefulness-feedback/:id",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/me/usefulness-feedback/:id/undo",
    category: "external_effect",
    julyPrefixes: []
  },
  {
    method: "POST",
    path: "/api/connectors/google/authorize",
    category: "secrets",
    julyPrefixes: ["settings.connector.authorize."]
  },
  {
    method: "POST",
    path: "/api/connectors/google/complete",
    category: "secrets",
    julyPrefixes: ["settings.connector.complete."]
  },
  {
    method: "POST",
    path: "/api/connectors/imap/connect",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/connectors/imap/test-connection",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/connectors/accounts",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "PATCH",
    path: "/api/connectors/accounts/:id",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "POST",
    path: "/api/integrations",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "PATCH",
    path: "/api/integrations/:id",
    category: "secrets",
    julyPrefixes: ["settings.connector.connect."]
  },
  {
    method: "DELETE",
    path: "/api/me/account",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.account.lifecycle."]
  },
  {
    method: "DELETE",
    path: "/api/me/sessions/others",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.session.revoke."]
  },
  {
    method: "DELETE",
    path: "/api/me/sessions/:id",
    category: "identity_auth_registration",
    julyPrefixes: ["settings.session.revoke."]
  },
  {
    method: "PUT",
    path: "/api/integrations/:id/classifier/send-without-asking",
    category: "self_authority",
    julyPrefixes: ["settings.permissions."]
  },
  {
    method: "POST",
    path: "/api/ai/module-builds/:buildId/approve",
    category: "self_authority",
    julyPrefixes: ["settings.module.install."]
  },
  {
    method: "POST",
    path: "/api/ai/models",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "PATCH",
    path: "/api/ai/models/:id",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "DELETE",
    path: "/api/ai/models/:id",
    category: "assistant_brain",
    julyPrefixes: ["ai.modelDisable."]
  },
  {
    method: "POST",
    path: "/api/connectors/google/sync",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/connectors/email-refresh",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/integrations/:id/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.connectorSync."]
  },
  {
    method: "POST",
    path: "/api/connectors/accounts/:id/revoke",
    category: "external_effect",
    julyPrefixes: ["settings.connectorRevoke."]
  },
  {
    method: "DELETE",
    path: "/api/integrations/:id",
    category: "external_effect",
    julyPrefixes: ["settings.connectorRevoke."]
  },
  {
    method: "PUT",
    path: "/api/me/notification-digest-preference",
    category: "external_effect",
    julyPrefixes: ["settings.digest."]
  },
  {
    method: "PATCH",
    path: "/api/me/proactive-monitoring-settings",
    category: "external_effect",
    julyPrefixes: ["settings.proactive."]
  },
  {
    method: "POST",
    path: "/api/me/proactive-cards/refresh",
    category: "external_effect",
    julyPrefixes: ["settings.proactive."]
  },
  {
    method: "POST",
    path: "/api/me/export",
    category: "external_effect",
    julyPrefixes: ["settings.export."]
  },
  {
    method: "POST",
    path: "/api/ai/transcriptions",
    category: "external_effect",
    julyPrefixes: ["settings.transcription."]
  },
  {
    method: "POST",
    path: "/api/workflows/runs/:id/cancel",
    category: "external_effect",
    julyPrefixes: ["settings.cancelledWork."]
  },
  {
    method: "POST",
    path: "/api/ai/module-builds/:buildId/cancel",
    category: "external_effect",
    julyPrefixes: ["settings.cancelledWork."]
  }
];

/** July prefixes with no route to block, each with its reason. Slices 3 and 4. */
export const JULY_PREFIXES_WITHOUT_ROUTES: readonly JulyPrefixWithoutRoutes[] = [
  {
    prefix: "settings.thirdPartySend.",
    reason:
      "No email-send HTTP route exists. PATCH /api/email/briefing-settings controls auto-send and is independently blocked as self_authority."
  },
  {
    prefix: "settings.secretRegistry.",
    reason:
      "Its only route, PATCH /api/admin/settings/:key, is blocked by the admin path rule as self_authority."
  },
  { prefix: "settings.webSearchKey.", reason: "Platform route; never in the catalog." },
  {
    prefix: "settings.admin.promote.",
    reason: "Platform admin user routes; never in the catalog."
  },
  {
    prefix: "settings.registration.flag.",
    reason: "Platform admin registration route; never in the catalog."
  },
  {
    prefix: "settings.onboarding.state.",
    reason: "Onboarding status, complete and skip are platform routes; never in the catalog."
  },
  {
    prefix: "settings.hostInstall.",
    reason: "Platform host install and restart routes; never in the catalog."
  },
  { prefix: "ai.multiplexer.", reason: "Platform chat-multiplexer route; never in the catalog." },
  { prefix: "settings.promptDataWidening.", reason: "No prompt data widening flag exists yet." },
  {
    prefix: "ai.embedProvider.",
    reason: "An admin setting, blocked by the admin path rule as self_authority."
  },
  {
    prefix: "ai.chatModelOverride.",
    reason:
      "Listed under both self_authority and assistant_brain; its routes are blocked as self_authority by the chat-model-override path rule, which a named-route test pins."
  }
];

/** POST paths naming a destructive word that are not destructive, each with its reason. */
export const DESTRUCTIVE_WORD_POST_ALLOWLIST: readonly DestructiveWordPostAllowed[] = [];

export interface RouteChatRuleTables {
  readonly pathRules?: readonly ChatBlockedPathRule[];
  readonly julyExcludedRoutes: readonly JulyExcludedRoute[];
  readonly julyPrefixesWithoutRoutes: readonly JulyPrefixWithoutRoutes[];
  readonly destructiveWordPostAllowlist: readonly DestructiveWordPostAllowed[];
}

export const DEFAULT_TABLES: RouteChatRuleTables = {
  pathRules: CHAT_BLOCKED_PATH_RULES,
  julyExcludedRoutes: JULY_EXCLUDED_ROUTES,
  julyPrefixesWithoutRoutes: JULY_PREFIXES_WITHOUT_ROUTES,
  destructiveWordPostAllowlist: DESTRUCTIVE_WORD_POST_ALLOWLIST
};
