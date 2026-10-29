import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const HEARTBEAT_FEATURE: ModuleFeatureManifest = {
  id: "chat.heartbeat_settings",
  description:
    "Settings > Alerts > Moss check-ins switches periodic check-ins on or off, sets frequency (30 or 60 minutes) and picks sources (Calendar, Tasks, Memory, Sports, News). Status, muted topics and scheduled jobs sit beside it.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "heartbeat_settings_conflict",
      class: "validation",
      description:
        "Check-in settings changed in another tab or device before this save. Nothing was overwritten; use the current settings or save your edit again."
    },
    {
      code: "heartbeat_settings_load_failed",
      class: "transient",
      description: "Could not load check-in settings. Try again; saved settings are unchanged."
    }
  ],
  remediations: [
    {
      id: "chat.review_heartbeat_settings",
      description: "Open Alerts to review check-in frequency, sources and muted topics, then save.",
      path: "/settings?section=alerts"
    }
  ]
};

export const HEARTBEAT_ROUTES = [
  {
    method: "GET",
    path: "/api/me/heartbeat/settings",
    chat: { access: "read" },
    permissionId: "chat.view"
  },
  {
    method: "PUT",
    path: "/api/me/heartbeat/settings",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  },
  {
    method: "GET",
    path: "/api/me/heartbeat/status",
    chat: { access: "read" },
    permissionId: "chat.view"
  },
  {
    method: "GET",
    path: "/api/me/heartbeat/mutes",
    chat: { access: "blocked", blockedBecause: "data_scope_consent" },
    permissionId: "chat.view"
  },
  {
    method: "DELETE",
    path: "/api/me/heartbeat/mutes/:id",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  }
] as const;
