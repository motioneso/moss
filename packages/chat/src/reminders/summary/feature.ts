import type { ModuleFeatureManifest } from "@moss/module-sdk";

export const reminderSummaryFeature: ModuleFeatureManifest = {
  id: "chat.reminder_visual_summary",
  description:
    "Chat shows up to twelve saved reminders with real state, due time, repeat and destination. Read-only: never creates, changes, cancels or delivers. Saved cards never refetch.",
  errors: [
    {
      code: "reminder_summary_unavailable",
      class: "transient",
      description:
        "If the reminder summary or its visual is unavailable, chat keeps a readable text answer. Ask again or read the reminder list in chat."
    }
  ],
  remediations: [
    {
      id: "chat.reminder_summary_retry",
      description:
        "Ask for the reminder summary again. Change your saved timezone in Profile when local days look wrong.",
      path: "/today"
    }
  ],
  featureFlagId: "chat.module"
};
