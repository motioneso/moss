import type { MossModuleManifest } from "@moss/module-sdk";

export const REMINDER_CONTROL_FEATURE = {
  id: "chat.reminder_controls",
  description:
    "Pause/resume pending reminders in Settings or Main chat. Resume keeps timing and fires once. Delete keeps messages; Settings confirms, while chat delete/remove needs typed yes. Cancel stays immediate; controls are not runs.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "reminder_control_target",
      class: "validation",
      description:
        "An ambiguous target is refused. Name one reminder so Moss can change the right record."
    },
    {
      code: "reminder_control_changed",
      class: "validation",
      description:
        "A reminder changed or finished before the control. Refresh details or ask to delete it again; a stale yes does not delete it."
    }
  ],
  remediations: [
    {
      id: "chat.review_reminder",
      description:
        "Review the reminder's current state in Settings, then retry or name one reminder in Main chat.",
      path: "/settings?section=scheduled"
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];

export const REMINDER_CONTROL_ROUTES = [
  {
    method: "POST",
    path: "/api/chat/scheduled-tasks/:id/pause",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  },
  {
    method: "POST",
    path: "/api/chat/scheduled-tasks/:id/resume",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  },
  {
    method: "DELETE",
    path: "/api/chat/scheduled-tasks/:id",
    chat: { access: "blocked", blockedBecause: "self_authority" },
    permissionId: "chat.message"
  }
] satisfies NonNullable<MossModuleManifest["routes"]>;

export const REMINDER_SETTINGS_FEATURE = {
  id: "chat.reminder_settings",
  description:
    "Settings, Scheduled tasks shows reminder details, dated history and Past tasks. View message opens the saved result; Open chat opens its thread. Pause, resume or delete here or in Main chat. Set reminders in Main chat.",
  featureFlagId: "chat.module",
  errors: [
    {
      code: "scheduled_tasks_load_failed",
      class: "transient",
      description: "Could not load scheduled tasks. Choose Try again in Settings or reload."
    }
  ],
  remediations: [
    {
      id: "chat.retry_scheduled_tasks",
      description: "Choose Try again in Settings, Scheduled tasks, or reload the page.",
      path: "/settings?section=scheduled"
    }
  ]
} satisfies NonNullable<MossModuleManifest["features"]>[number];
