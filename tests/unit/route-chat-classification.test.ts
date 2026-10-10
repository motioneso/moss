import {
  PRIVACY_MODULE_IDS,
  PRIVACY_EXPECTED_ROWS,
  PRIVACY_NAMED_BLOCKED
} from "../fixtures/route-chat-content-privacy.js";
import {
  SCHEDULING_MODULE_IDS,
  SCHEDULING_EXPECTED_ROWS,
  SCHEDULING_NAMED_BLOCKED
} from "../fixtures/route-chat-content-scheduling.js";
import {
  FEEDS_MODULE_IDS,
  FEEDS_EXPECTED_ROWS,
  FEEDS_NAMED_BLOCKED
} from "../fixtures/route-chat-content-feeds.js";
import {
  RECORDS_MODULE_IDS,
  RECORDS_EXPECTED_ROWS,
  RECORDS_NAMED_BLOCKED
} from "../fixtures/route-chat-content-records.js";
import { describe, expect, it } from "vitest";

import { getBuiltInModuleManifests } from "../../packages/module-registry/src/index.js";
import {
  assertRouteChatClassification,
  buildRouteCatalog
} from "../../packages/module-registry/src/route-catalog.js";

/**
 * #3065 slices 3–4: every built-in route declares how Moss may call it. The
 * table pins method, path, access, block category, content class and outbound for each route,
 * so a reclassification shows up as a reviewed diff here.
 */

const CLASSIFIED_MODULES: ReadonlySet<string> = new Set([
  ...PRIVACY_MODULE_IDS,
  ...SCHEDULING_MODULE_IDS,
  ...FEEDS_MODULE_IDS,
  ...RECORDS_MODULE_IDS,
  "settings",
  "ai",
  "chat",
  "connectors",
  "integrations",
  "notifications",
  "backtrack",
  "workflows",
  "proactive-monitoring",
  "usefulness-feedback"
]);

const EXPECTED: readonly string[] = [
  ...PRIVACY_EXPECTED_ROWS,
  ...SCHEDULING_EXPECTED_ROWS,
  ...FEEDS_EXPECTED_ROWS,
  ...RECORDS_EXPECTED_ROWS,
  "settings GET /api/bootstrap/status read",
  "settings GET /api/me read user_authored",
  "settings PATCH /api/me/profile blocked prompt_shaping",
  "settings GET /api/me/locale read user_authored",
  "settings PUT /api/me/locale write user_authored",
  "settings GET /api/me/quiet-hours read user_authored",
  "settings PUT /api/me/quiet-hours write user_authored",
  "settings GET /api/me/notification-preferences read user_authored",
  "settings PUT /api/me/notification-preferences/:moduleId write user_authored",
  "settings GET /api/me/notification-digest-preference read user_authored",
  "settings PUT /api/me/notification-digest-preference blocked external_effect",
  "settings GET /api/me/notification-sensitivity read user_authored",
  "settings PUT /api/me/notification-sensitivity blocked external_effect",
  "settings GET /api/me/weather-location read user_authored",
  "settings PUT /api/me/weather-location write user_authored",
  "settings GET /api/me/weather-location/search read outbound",
  "settings GET /api/me/weather-location/reverse read outbound",
  "settings GET /api/me/weather-unit read user_authored",
  "settings PUT /api/me/weather-unit write user_authored",
  "settings GET /api/me/themes read user_authored",
  "settings PUT /api/me/themes/active write user_authored",
  "settings PUT /api/me/themes/mode write user_authored",
  "settings PUT /api/me/themes/:id write user_authored",
  "settings DELETE /api/me/themes/:id destructive user_authored",
  "settings GET /api/me/notes-source read user_authored",
  "settings GET /api/me/notes-source/directories read",
  "settings PUT /api/me/notes-source blocked prompt_shaping",
  "settings GET /api/me/notes-last-sync read",
  "settings GET /api/me/sessions read",
  "settings DELETE /api/me/sessions/others blocked identity_auth_registration",
  "settings DELETE /api/me/sessions/:id blocked identity_auth_registration",
  "settings DELETE /api/me/account blocked identity_auth_registration",
  "settings GET /api/me/persona blocked prompt_shaping",
  "settings GET /api/me/install-manifest read",
  "settings PUT /api/me/persona blocked prompt_shaping",
  "settings POST /api/me/persona/preview blocked prompt_shaping",
  "settings GET /api/me/source-behaviors read user_authored",
  "settings PUT /api/me/source-behaviors/:id blocked prompt_shaping",
  "settings GET /api/me/priority-model read user_authored",
  "settings PATCH /api/me/priority-model blocked prompt_shaping",
  "settings GET /api/me/proactive-monitoring-settings read user_authored",
  "settings PATCH /api/me/proactive-monitoring-settings blocked external_effect",
  "settings GET /api/admin/auth/providers blocked self_authority",
  "settings GET /api/admin/users blocked self_authority",
  "settings GET /api/admin/yolo blocked self_authority",
  "settings PUT /api/admin/yolo/instance blocked self_authority",
  "settings PUT /api/admin/yolo/users/:id blocked self_authority",
  "settings POST /api/admin/yolo/allow-all blocked self_authority",
  "settings GET /api/admin/settings blocked self_authority",
  "settings PATCH /api/admin/settings/:key blocked self_authority",
  "settings GET /api/admin/runtime-config/:key blocked self_authority",
  "settings PUT /api/admin/runtime-config/:key blocked self_authority",
  "settings GET /api/admin/audit-events blocked self_authority",
  "settings GET /api/admin/modules blocked self_authority",
  "settings PATCH /api/admin/modules/:id blocked self_authority",
  "settings GET /api/admin/external-modules blocked self_authority",
  "settings POST /api/admin/external-modules/:id blocked self_authority",
  "settings GET /api/me/modules read",
  "settings PATCH /api/me/modules/:id blocked self_authority",
  "settings GET /api/me/yolo blocked self_authority",
  "settings PUT /api/me/yolo blocked self_authority",
  "settings GET /api/settings/me/data-export blocked data_scope_consent",
  "settings POST /api/me/export blocked external_effect",
  "settings GET /api/me/export/status/:jobId read",
  "settings GET /api/me/export/download/:jobId blocked data_scope_consent",
  "settings POST /api/onboarding/provider-check blocked identity_auth_registration",
  "settings POST /api/onboarding/provider-install blocked secrets",
  "settings POST /api/onboarding/provider-login/begin blocked secrets",
  "settings POST /api/onboarding/provider-login/poll blocked secrets",
  "settings POST /api/onboarding/provider-login/submit-token blocked secrets",
  "settings POST /api/onboarding/provider-login/cancel blocked secrets",
  "settings GET /api/me/chat-archive read user_authored",
  "settings PUT /api/me/chat-archive write user_authored",
  "connectors GET /api/connectors/providers read",
  "connectors GET /api/connectors/accounts read",
  "connectors POST /api/connectors/accounts blocked secrets",
  "connectors PATCH /api/connectors/accounts/:id blocked secrets",
  "connectors POST /api/connectors/accounts/:id/revoke blocked external_effect",
  "connectors GET /api/connectors/accounts/:id/feature-grants blocked self_authority",
  "connectors PUT /api/connectors/accounts/:id/feature-grants blocked self_authority",
  "connectors GET /api/admin/connectors/accounts blocked self_authority",
  "connectors POST /api/connectors/google/authorize blocked secrets",
  "connectors POST /api/connectors/google/complete blocked secrets",
  "connectors POST /api/connectors/google/sync blocked external_effect",
  "connectors POST /api/connectors/email-refresh blocked external_effect",
  "connectors GET /api/connectors/email-refresh/:refreshId read",
  "connectors POST /api/connectors/imap/connect blocked secrets",
  "connectors POST /api/connectors/imap/test-connection blocked secrets",
  "integrations GET /api/integrations read",
  "integrations POST /api/integrations blocked secrets",
  "integrations GET /api/integrations/:id blocked self_authority",
  "integrations PATCH /api/integrations/:id blocked secrets",
  "integrations POST /api/integrations/:id/refresh blocked external_effect",
  "integrations DELETE /api/integrations/:id blocked external_effect",
  "integrations PUT /api/integrations/:id/classifier/kept-out blocked self_authority",
  "integrations POST /api/integrations/:id/classifier/prepare blocked self_authority",
  "integrations POST /api/integrations/:id/classifier/sort blocked self_authority",
  "integrations PUT /api/integrations/:id/classifier/send-without-asking blocked self_authority",
  "notifications GET /api/notifications read",
  "notifications PATCH /api/notifications/:id/read write",
  "notifications PATCH /api/notifications/read-all write user_authored",
  "notifications GET /api/notifications/push/config blocked secrets",
  "notifications POST /api/notifications/push/subscriptions blocked secrets",
  "notifications DELETE /api/notifications/push/subscriptions/:id destructive user_authored",
  "ai GET /api/ai/summary read",
  "ai GET /api/ai/providers blocked assistant_brain",
  "ai POST /api/ai/providers blocked secrets",
  "ai PATCH /api/ai/providers/:id blocked secrets",
  "ai POST /api/ai/providers/:id/revoke blocked assistant_brain",
  "ai POST /api/ai/providers/:id/cli-check blocked external_effect",
  "ai POST /api/ai/providers/:id/test blocked external_effect",
  "ai POST /api/ai/providers/:id/discover-models blocked external_effect",
  "ai GET /api/ai/providers/:id/models/discover blocked external_effect",
  "ai POST /api/ai/providers/:id/models/refresh blocked external_effect",
  "ai GET /api/ai/models blocked external_effect",
  "ai POST /api/ai/models blocked assistant_brain",
  "ai PATCH /api/ai/models/:id blocked assistant_brain",
  "ai DELETE /api/ai/models/:id blocked assistant_brain",
  "ai GET /api/ai/capability-route/:capability read",
  "ai GET /api/ai/service-bindings blocked self_authority",
  "ai PUT /api/ai/services/:service/binding blocked self_authority",
  "ai DELETE /api/ai/services/:service/binding blocked self_authority",
  "ai PUT /api/ai/providers/:id/default blocked self_authority",
  "ai POST /api/ai/transcriptions blocked external_effect",
  "ai GET /api/ai/voice-endpoint blocked secrets",
  "ai PUT /api/ai/voice-endpoint blocked secrets",
  "ai GET /api/ai/terminal/status read",
  "ai POST /api/ai/terminal/password blocked secrets",
  "ai POST /api/ai/terminal/ticket blocked secrets",
  "ai GET /api/ai/terminal blocked secrets",
  "ai GET /api/ai/chat-model-override blocked self_authority",
  "ai PUT /api/ai/chat-model-override blocked self_authority",
  "ai GET /api/ai/chat-model-favorites read user_authored",
  "ai PUT /api/ai/chat-model-favorites write user_authored",
  "ai PUT /api/admin/ai/chat-model-override blocked self_authority",
  "ai GET /api/admin/users/:userId/ai-pin blocked self_authority",
  "ai PUT /api/admin/users/:userId/ai-pin blocked self_authority",
  "ai GET /api/ai/assistant-tools read",
  "ai POST /api/ai/assistant-tools/:name/invoke blocked self_authority",
  "ai GET /api/ai/assistant-actions read",
  "ai POST /api/ai/assistant-actions/:id/resolve blocked self_authority",
  "ai GET /api/ai/action-policy blocked self_authority",
  "ai PATCH /api/ai/action-policy/:moduleId/:actionFamilyId blocked self_authority",
  "ai GET /api/ai/action-audit read",
  "ai GET /api/ai/activity-lines blocked data_scope_consent",
  "ai POST /api/ai/module-builds/:buildId/approve blocked self_authority",
  "ai POST /api/ai/module-builds/:buildId/cancel blocked external_effect",
  "ai GET /api/ai/module-builds/mine read",
  "chat GET /api/chat/threads blocked data_scope_consent",
  "chat GET /api/chat/threads/:id/messages blocked data_scope_consent",
  "chat GET /api/chat/meeting-context read",
  "chat POST /api/chat/turn blocked prompt_shaping",
  "chat POST /api/chat/attachments blocked prompt_shaping",
  "chat POST /api/chat/evening-interview blocked prompt_shaping",
  "chat POST /api/chat/seed blocked prompt_shaping",
  "chat POST /api/chat/turn/cancel blocked prompt_shaping",
  "chat GET /api/chat/stream blocked prompt_shaping",
  "chat POST /api/chat/clear blocked prompt_shaping",
  "chat POST /api/chat/private/end blocked prompt_shaping",
  "chat GET /api/chat/privacy read user_authored",
  "chat POST /api/chat/switch blocked prompt_shaping",
  "chat PUT /api/chat/page-context blocked prompt_shaping",
  "chat POST /api/chat/threads/:id/resume blocked prompt_shaping",
  "chat GET /api/chat/settings read user_authored",
  "chat PUT /api/chat/settings blocked assistant_brain",
  "chat GET /api/chat/memory/settings read user_authored",
  "chat PATCH /api/chat/memory/settings blocked prompt_shaping",
  "chat GET /api/chat/memory/facts blocked data_scope_consent",
  "chat GET /api/chat/memory/corrections blocked data_scope_consent",
  "chat DELETE /api/chat/memory/facts/:id blocked data_scope_consent",
  "chat DELETE /api/chat/classifier/shadow-records destructive user_authored",
  "chat GET /api/chat/classifier/shadow-report read user_authored",
  "chat PATCH /api/chat/memory/facts/:id blocked prompt_shaping",
  "chat POST /api/chat/memory/facts/:id/confirm blocked prompt_shaping",
  "chat POST /api/chat/memory/facts/:id/reject blocked prompt_shaping",
  "chat POST /api/chat/action-requests/:id/resolve blocked self_authority",
  "chat GET /api/chat/messages/:messageId/provenance blocked data_scope_consent",
  "chat GET /api/chat/messages/:messageId/provenance/:supportId/dereference read",
  "chat POST /api/mcp blocked self_authority",
  "chat POST /internal/permission blocked self_authority",
  "chat POST /internal/vault-read-report blocked self_authority",
  "chat GET /api/chat/skills blocked prompt_shaping",
  "chat GET /api/chat/skills/:id blocked prompt_shaping",
  "chat POST /api/chat/skills blocked prompt_shaping",
  "chat PATCH /api/chat/skills/:id blocked prompt_shaping",
  "chat PATCH /api/chat/skills/:id/enabled blocked prompt_shaping",
  "chat DELETE /api/chat/skills/:id blocked prompt_shaping",
  "chat POST /api/chat/skills/import blocked prompt_shaping",
  "usefulness-feedback POST /api/me/usefulness-feedback/signals write",
  "usefulness-feedback POST /api/me/usefulness-feedback blocked external_effect",
  "usefulness-feedback GET /api/me/usefulness-feedback read",
  "usefulness-feedback PATCH /api/me/usefulness-feedback/:id blocked external_effect",
  "usefulness-feedback POST /api/me/usefulness-feedback/:id/undo blocked external_effect",
  "proactive-monitoring GET /api/me/proactive-cards read",
  "proactive-monitoring POST /api/me/proactive-cards/refresh blocked external_effect",
  "workflows GET /api/workflows/runs read",
  "workflows GET /api/workflows/runs/:id read",
  "workflows POST /api/workflows/runs/:id/cancel blocked external_effect",
  "workflows POST /api/workflows/approvals/:id/resolve blocked self_authority",
  "backtrack GET /api/backtrack/status read user_authored",
  "backtrack PUT /api/backtrack/preferences blocked data_scope_consent",
  "backtrack DELETE /api/backtrack/segments destructive user_authored"
];

/**
 * Surfaces Moss must never reach, each with the category it is blocked under: the July
 * families, plus account exports (they bypass Wellness consent) and GETs with side effects.
 */
const NAMED_BLOCKED: readonly (readonly [string, string, string])[] = [
  ...PRIVACY_NAMED_BLOCKED,
  ...SCHEDULING_NAMED_BLOCKED,
  ...FEEDS_NAMED_BLOCKED,
  ...RECORDS_NAMED_BLOCKED,
  ["PATCH", "/api/ai/action-policy/:moduleId/:actionFamilyId", "self_authority"],
  ["GET", "/api/me/persona", "prompt_shaping"],
  ["PUT", "/api/me/persona", "prompt_shaping"],
  ["POST", "/api/me/persona/preview", "prompt_shaping"],
  ["POST", "/api/chat/skills", "prompt_shaping"],
  ["PATCH", "/api/chat/skills/:id", "prompt_shaping"],
  ["PATCH", "/api/chat/skills/:id/enabled", "prompt_shaping"],
  ["DELETE", "/api/chat/skills/:id", "prompt_shaping"],
  ["POST", "/api/chat/skills/import", "prompt_shaping"],
  ["PUT", "/api/ai/chat-model-override", "self_authority"],
  ["PATCH", "/api/me/modules/:id", "self_authority"],
  ["PATCH", "/api/chat/memory/settings", "prompt_shaping"],
  ["PUT", "/api/chat/page-context", "prompt_shaping"],
  ["PUT", "/api/me/source-behaviors/:id", "prompt_shaping"],
  ["PATCH", "/api/me/priority-model", "prompt_shaping"],
  ["PUT", "/api/me/notes-source", "prompt_shaping"],
  ["PUT", "/api/ai/voice-endpoint", "secrets"],
  ["POST", "/api/ai/terminal/password", "secrets"],
  ["POST", "/api/ai/terminal/ticket", "secrets"],
  ["GET", "/api/settings/me/data-export", "data_scope_consent"],
  ["GET", "/api/me/export/download/:jobId", "data_scope_consent"],
  ["GET", "/api/ai/models", "external_effect"],
  ["GET", "/api/integrations/:id", "self_authority"],
  ["GET", "/api/notifications/push/config", "secrets"]
];

function classifiedManifests() {
  return getBuiltInModuleManifests().filter((manifest) => CLASSIFIED_MODULES.has(manifest.id));
}

function allToolNames(): ReadonlySet<string> {
  return new Set(
    getBuiltInModuleManifests().flatMap((m) => (m.assistantTools ?? []).map((tool) => tool.name))
  );
}

function concrete(path: string): string {
  return path.replace(/:[A-Za-z]+/g, "x1");
}

describe("all built-in route classification", () => {
  it("covers every module with routes", () => {
    expect(
      new Set(
        getBuiltInModuleManifests()
          .filter((m) => m.routes?.length)
          .map((m) => m.id)
      )
    ).toEqual(CLASSIFIED_MODULES);
  });

  it("passes the boot classification check", () => {
    expect(() =>
      assertRouteChatClassification(classifiedManifests(), { toolNames: allToolNames() })
    ).not.toThrow();
  });

  it("puts every route in the catalog as recorded", () => {
    const manifests = classifiedManifests();
    const total = manifests.reduce((sum, m) => sum + (m.routes?.length ?? 0), 0);
    const catalog = buildRouteCatalog(manifests, []);
    expect(catalog.routes).toHaveLength(total);

    const rows = catalog.routes.map((route) => {
      const { access, blockedBecause, content, outbound } = route.policy;
      return [
        route.moduleId,
        route.method,
        route.path,
        access,
        blockedBecause,
        content === "user_authored" ? content : undefined,
        outbound ? "outbound" : undefined
      ]
        .filter((part) => part !== undefined)
        .join(" ");
    });
    expect([...rows].sort()).toEqual([...EXPECTED].sort());
  });

  it.each(NAMED_BLOCKED)("%s %s is blocked as %s", (method, path, category) => {
    const catalog = buildRouteCatalog(classifiedManifests(), []);
    const hit = catalog.resolve(method, concrete(path));
    expect(hit?.route.path).toBe(path);
    expect(hit?.route.policy.access).toBe("blocked");
    expect(hit?.route.policy.blockedBecause).toBe(category);
  });

  it("gives every destructive route with a path parameter a target", () => {
    const catalog = buildRouteCatalog(classifiedManifests(), []);
    const missing = catalog.routes.filter(
      (route) =>
        route.policy.access === "destructive" &&
        route.path.includes("/:") &&
        typeof route.policy.target !== "function"
    );
    expect(missing).toEqual([]);
  });
});
