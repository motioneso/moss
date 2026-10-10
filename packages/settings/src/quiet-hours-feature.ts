import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const quietHoursFeature: ModuleFeatureManifest = {
  id: "settings.quietHours",
  description:
    "One quiet-hours schedule for notifications, focus and alert cards, saved in Settings > Alerts & quiet hours or chat; undo reverts a chat edit. Nothing saved means off, 22:00-07:00. A differing older alert schedule holds until picked.",
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
      code: "stale_choice",
      class: "transient",
      description:
        "The saved schedules changed after they were loaded, so the choice between them was not saved. Both schedules stay in force."
    },
    {
      code: "choice_failed",
      class: "transient",
      description:
        "The choice between differing saved schedules could not save. Both schedules stay in force and the choice can be tried again."
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
      path: "/settings?section=alerts"
    },
    {
      id: "settings.reload_quiet_hours",
      description: "Alerts & quiet hours now shows the latest schedule. Make the change again.",
      path: "/settings?section=alerts"
    },
    {
      id: "settings.choose_quiet_hours",
      description:
        "Alerts & quiet hours shows the differing saved schedules. Choose one again, or use Try again.",
      path: "/settings?section=alerts"
    },
    {
      id: "settings.retry_quiet_hours_chat",
      description: "Ask Moss again in chat to retry the change against the latest schedule.",
      path: "/today"
    }
  ]
};
