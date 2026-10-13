import { REMINDER_SETTINGS_FEATURE } from "./manifest.js";
import type { ModuleFeatureManifest } from "@moss/module-sdk";
import { quietHoursAllowanceFeature } from "./quiet-hours-feature.js";

export const reminderFeatures: readonly ModuleFeatureManifest[] = [
  {
    id: "chat.scheduled_owner_read",
    description:
      "In Main, ask Moss to check one owned task later. Your model selects the task and time; Moss saves and posts a sourced result. Plain reminders and questions keep their usual paths. Reminder controls, limits and notification policy apply.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "scheduled_read_text_edit_refused",
        class: "validation",
        description:
          "A saved task check keeps its source fixed. Time edits use the source-read queue; text edits change nothing. Delete the check and request a new one to choose a different task."
      },
      {
        code: "scheduled_read_unresolved",
        class: "validation",
        description:
          "An unresolved task stays in ordinary chat instead of saving a check. Name one task you own and a supported future time."
      },
      {
        code: "scheduled_read_unavailable",
        class: "transient",
        description:
          "If the model or Tasks module is unavailable, Moss says it could not set the check and saves nothing. Check the configured JSON model and enabled Tasks module, then try again."
      },
      {
        code: "scheduled_read_access_refused",
        class: "prerequisite",
        remediationRef: "chat.restore_scheduled_read_access",
        description:
          "If the source capability or owned task is no longer accessible at run time, Moss posts a refusal without source data. Choose an accessible task and request a new check."
      },
      {
        code: "scheduled_read_failed",
        class: "transient",
        description:
          "A temporary source failure retries quietly twice, then posts that the check failed. Request a new check when the source is available."
      }
    ],
    remediations: [
      {
        id: "chat.restore_scheduled_read_access",
        description: "Choose a task you own in Tasks and request a new status check in Main.",
        path: "/tasks"
      }
    ]
  },
  quietHoursAllowanceFeature,
  {
    id: "chat.reminder_edits",
    description:
      "Edit pending or paused reminder text, time, repeat or stop time in Main chat; Settings shows the saved record without an editor. Old jobs cannot fire. Ambiguous targets need a typed choice. Paused reminders stay paused.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "reminder_edit_unsupported",
        class: "validation",
        description:
          "Actions, recipients, destinations and attention changes are unsupported. Nothing changed. Ask for a text, time, repeat or stop-time edit instead."
      },
      {
        code: "reminder_edit_unclear",
        class: "validation",
        description:
          "Moss could not resolve the reminder or new terms. Nothing changed. Name the reminder and give a future time; deadlines must follow it within 12 hours."
      },
      {
        code: "reminder_edit_stale",
        class: "validation",
        description:
          "The reminder changed or finished before the edit. Nothing changed. Inspect the current record and ask again."
      },
      {
        code: "reminder_edit_failed",
        class: "transient",
        description: "The model or save failed. Nothing changed. Check AI settings or retry."
      }
    ],
    remediations: [
      {
        id: "chat.retry_reminder_edit",
        description:
          "Inspect the current reminder and ask in Main chat using its exact words. If asked which one, type its number or name.",
        path: "/settings?section=scheduled"
      }
    ]
  },
  REMINDER_SETTINGS_FEATURE,
  {
    id: "chat.reminder_notifications",
    description:
      "Due reminders stay in Main and alert enabled devices. Quiet hours hold alerts unless the owner allowed that task; mutes and device switches win. Retries never repeat chat. Dismissing stops alerts. Opening goes to Today.",
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
      "In Main, 'remind me in 10 minutes to stretch' posts once, noting if late; Moss's next reply knows it. Up to 20 active schedules, 30 days ahead. One-time relative reminders have no deadline. Private chats cannot create reminders.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.clock_reminders",
    description:
      "In Main, 'remind me tomorrow at 9am to call Sam' saves a one-time reminder for today, tonight or tomorrow in your time zone. Moss confirms in your 12- or 24-hour clock. Daily and weekly repeats keep a saved local time and zone.",
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
          "One-time weekdays and dates are refused. Say today, tonight or tomorrow, or explicitly ask for every named weekday at a clock time."
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
          "Set your time zone in Settings, Account & preferences, then ask in Main chat to move the reminder to the right time.",
        path: "/settings?section=profile"
      }
    ]
  },
  {
    id: "chat.repeating_reminders",
    description:
      "Main saves daily, named-weekday or 60-86399-second reminders. Saved local times shift through gaps and use the earlier fold. One catch-up after downtime, then normal cadence. Edits invalidate old jobs; saved stops end repeats.",
    featureFlagId: "chat.module"
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
