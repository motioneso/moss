import { REMINDER_SETTINGS_FEATURE } from "./manifest.js";
import type { ModuleFeatureManifest } from "@moss/module-sdk";
import { quietHoursAllowanceFeature } from "./quiet-hours-feature.js";

export const reminderFeatures: readonly ModuleFeatureManifest[] = [
  quietHoursAllowanceFeature,
  REMINDER_SETTINGS_FEATURE,
  {
    id: "chat.reminder_notifications",
    description:
      "Due reminders stay in Main and alert enabled devices. Quiet hours hold alerts; mutes and device switches win. Retries never repeat chat. Dismissing stops alerts. Opening goes to Today.",
    featureFlagId: "chat.module",
    remediations: [
      {
        id: "chat.enable_reminder_notifications",
        description:
          "Check Chat's notification mute, delivery sensitivity and this device's push setting in Notifications settings.",
        path: "/settings?section=modules&module=notifications"
      }
    ]
  },
  {
    id: "chat.notification_preferences",
    description:
      "Chat appears in the per-module notification switches and counts toward email digest availability.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.relative_reminders",
    description:
      "In Main chat, 'remind me in 10 minutes to stretch' saves a reminder Moss posts once in Main, " +
      "noting if late; its next reply knows it and frees the slot. Up to 20 at once, 30 days ahead. " +
      "No deadline, repeats or private chats.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.clock_reminders",
    description:
      "In Main chat, 'remind me tomorrow at 9am to call Sam' saves a reminder for that time in your " +
      "time zone, today, tonight or tomorrow only. Moss confirms it in your 12- or 24-hour clock and names the time zone. " +
      "Repeats are not available.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "reminder_needs_am_pm",
        class: "validation",
        description:
          "A bare hour like 'at 3' could be morning or afternoon, so Moss saves nothing. Say 3pm, 3am or 15:00."
      },
      {
        code: "reminder_time_unclear",
        class: "validation",
        description:
          "A request Moss cannot pin to one time, like 'tonight at 7am', 'at midnight', 'at 3ish' or 'at 3pm or 4pm', is refused and nothing is saved."
      },
      {
        code: "reminder_day_unsupported",
        class: "validation",
        description:
          "Weekdays, dates and repeats are refused and nothing is saved. Say today, tonight or tomorrow, or a time from now."
      },
      {
        code: "reminder_time_passed",
        class: "validation",
        description:
          "A time pinned to today that has already passed is refused. Say tomorrow. With no day word, a passed time means tomorrow."
      },
      {
        code: "reminder_time_changes_with_clocks",
        class: "validation",
        description:
          "On a daylight saving day, a time the clocks skip or show twice is refused and nothing is saved. Pick a time outside that hour."
      },
      {
        code: "reminder_time_zone_wrong",
        class: "prerequisite",
        remediationRef: "chat.set_reminder_time_zone",
        description:
          "Clock times use the time zone in your profile. The confirmation names that zone. If it is not where you are, change the time zone in your profile."
      }
    ],
    remediations: [
      {
        id: "chat.set_reminder_time_zone",
        description:
          "Set your time zone in Settings, Account & preferences, then cancel the reminder and set it again.",
        path: "/settings?section=profile"
      }
    ]
  },
  {
    id: "chat.reminder_deadline",
    description:
      "A clock reminder can carry a deadline: 'remind me at 3pm to call Sam, not after 4pm'. If Moss " +
      "was offline at the due time, it posts once on return, marked late, but never after the deadline.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "reminder_deadline_invalid",
        class: "validation",
        description:
          "A deadline must come after the reminder time and within 12 hours of it, and only clock-time reminders take one. Nothing is saved."
      },
      {
        code: "reminder_skipped_after_deadline",
        class: "transient",
        description:
          "Moss could not send a reminder before its deadline, usually because it was offline, so it was skipped and never posts. The list shows it as skipped."
      }
    ]
  },
  {
    id: "chat.reminder_live_arrival",
    description:
      "A due chat reminder appears at once in the open Main chat, even while Moss is replying; both " +
      "stay separate after a reload. Side, private and module chats never show it. If it does not " +
      "appear, reopen Main or reload.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.reminder_settings",
    description:
      "Inspect chat reminders in Settings, Scheduled tasks: details, dated run history and collapsed Past tasks. View message reads the saved result; Open chat opens its thread. Read only; set or cancel reminders in Main chat.",
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
  },
  {
    id: "chat.reminder_list",
    description:
      "In Main chat, 'list my reminders' shows waiting chat reminders with time left or their clock " +
      "time and deadline, then up to 10 recent ones: sent, sent late, cancelled, skipped past its " +
      "deadline, or couldn't be sent. Not task reminders.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.reminder_cancel",
    description:
      "In Main chat, 'cancel the reminder to stretch' stops a waiting chat reminder so it never arrives. " +
      "If already sent, Moss says so and frees its place under the limit of 20. " +
      "If different reminders match, Moss names them and cancels none.",
    featureFlagId: "chat.module"
  }
];
