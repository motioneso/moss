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
    "Moss posts a check-in in Main when a check finds items worth attention, with a short intro and a note. During quiet hours it says the alert waits until they end. Nothing is posted when nothing changed. Up to six model checks per local day.",
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
    method: "POST",
    path: "/api/me/heartbeat/mutes",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  },
  {
    method: "DELETE",
    path: "/api/me/heartbeat/mutes/:id",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  }
] as const;

export const HEARTBEAT_STOP_FEATURE: ModuleFeatureManifest = {
  id: "chat.heartbeat_stop",
  description:
    "Tell Moss in chat to stop mentioning a check-in item or topic. It shows a Muted label with Undo. If several items match, Moss offers up to three choices and saves nothing until one is picked. Muted topics are listed in Settings > Alerts.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "heartbeat_mute_not_found",
      class: "validation",
      description:
        "No recent check-in item matched what was named. Name the topic in your own words, or point at an item in a check-in message."
    }
  ],
  remediations: [
    {
      id: "chat.review_heartbeat_mutes",
      description: "Open Alerts to see muted topics and remove one.",
      path: "/settings?section=alerts"
    }
  ]
};

export const HEARTBEAT_RATING_FEATURE: ModuleFeatureManifest = {
  id: "chat.heartbeat_rating",
  description:
    "Every check-in message in Main has a thumbs up and a thumbs down under it. A second click on the same thumb undoes the rating. Ratings are saved as feedback on that message only; nothing asks why.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "heartbeat_rating_save_failed",
      class: "transient",
      description: "The rating could not be saved. Try the thumb again; nothing was changed."
    }
  ],
  remediations: []
};
