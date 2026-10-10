import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const quietHoursFeature: ModuleFeatureManifest = {
  id: "settings.quietHours",
  description:
    "Save the quiet-hours schedule from Account & preferences or chat, and undo the last chat change. Overnight windows are allowed; a schedule with no time zone follows the profile time zone, then UTC.",
  errors: [
    {
      code: "invalid_schedule",
      class: "validation",
      description:
        "A newly supplied start or end time is outside 00:00-23:59, start and end are the same, or the time zone is unknown. Nothing is saved."
    },
    {
      code: "stale_save",
      class: "transient",
      description:
        "The schedule changed somewhere else after it was loaded, or kept changing while chat saved it. Nothing is saved."
    },
    {
      code: "undo_cancelled",
      class: "transient",
      description:
        "Undo found the schedule changed after the chat edit, so it left the newer schedule in place."
    }
  ],
  remediations: [
    {
      id: "settings.correct_quiet_hours",
      description:
        "Choose different start and end times in HH:MM and a known time zone, then save again.",
      path: "/settings?section=profile"
    },
    {
      id: "settings.reload_quiet_hours",
      description: "Account & preferences now shows the latest schedule. Make the change again.",
      path: "/settings?section=profile"
    },
    {
      id: "settings.retry_quiet_hours_chat",
      description: "Ask Moss again in chat to retry the change against the latest schedule.",
      path: "/today"
    }
  ]
};
