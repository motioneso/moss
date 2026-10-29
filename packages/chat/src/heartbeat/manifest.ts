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

export const HEARTBEAT_MESSAGE_FEATURE: ModuleFeatureManifest = {
  id: "chat.heartbeat_messages",
  description:
    "Moss posts a check-in in Main when a check finds items needing attention, with a short intro and a note per item. Nothing is posted when nothing changed. Up to six model checks per local day.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "heartbeat_check_failed",
      class: "transient",
      description:
        "A check could not produce a usable message. Nothing was posted and the next check tries again."
    },
    {
      code: "heartbeat_allowance_reached",
      class: "validation",
      description: "The daily limit of model checks was reached. Checks resume the next local day."
    }
  ],
  remediations: [
    {
      id: "chat.review_heartbeat_status",
      description: "Open Alerts to see the last check, unavailable sources and the next check.",
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
