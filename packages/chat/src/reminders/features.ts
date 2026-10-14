import { REMINDER_SETTINGS_FEATURE } from "./manifest.js";
import type { ModuleFeatureManifest } from "@moss/module-sdk";
import { quietHoursAllowanceFeature } from "./quiet-hours-feature.js";

export const reminderFeatures: readonly ModuleFeatureManifest[] = [
  {
    id: "chat.scheduled_owner_read",
    description:
      "In regular chat, check one owned task once or repeatedly. Repeats start with a quiet baseline and report only title/status changes. Configured JSON models prepare sourced reports. Controls, quiet retries and notification policy apply.",
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
          "If Tasks access is unavailable, refusal contains no source data. One-time checks post it immediately; repeating checks record every refusal and post guidance after three consecutive failed runs. Restore access or request a new check."
      },
      {
        code: "scheduled_report_failed",
        class: "transient",
        description:
          "Missing model setup, a model timeout, an invalid report or a changed source produces an honest failure without source prose. Check your configured JSON model and ask for a new check."
      },
      {
        code: "scheduled_read_failed",
        class: "transient",
        description:
          "Temporary source failures retry quietly twice. Recurring checks record every failed run and post guidance once after three consecutive failures, resetting after a valid success. One-time checks post failures immediately."
      }
    ],
    remediations: [
      {
        id: "chat.restore_scheduled_read_access",
        description:
          "Choose a task you own in Tasks and request a new status check in regular chat.",
        path: "/tasks"
      }
    ]
  },
  quietHoursAllowanceFeature,
  {
    id: "chat.reminder_destinations",
    description:
      "Tasks default to Main; append a comma or and before send it to one owned chat, or say in this chat. Results appear only there. Change destination separately. Private, module, foreign and ambiguous chats are refused.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "reminder_destination_combined_edit_refused",
        class: "validation",
        description:
          "A destination edit combined with other terms changes nothing. Send the destination in its own message, then edit text, time, repeat or stop time separately."
      },
      {
        code: "reminder_destination_unavailable",
        class: "validation",
        description:
          "A missing, ambiguous or unavailable destination saves nothing. A destination lost before or during a run leaves the task failed without posting to Main."
      }
    ],
    remediations: [
      {
        id: "chat.choose_reminder_destination",
        description:
          "Name one available conversation you own, say this chat in a regular conversation, or choose Main. If a task already failed, create a replacement with an available destination.",
        path: "/settings?section=scheduled"
      }
    ]
  },
  {
    id: "chat.reminder_edits",
    description:
      "Edit pending or paused text, time, repeat or stop time in regular chat; change destination separately. Task checks keep their source fixed. Settings shows saved terms. Old jobs cannot fire; ambiguity needs a choice. Paused stays paused.",
    featureFlagId: "chat.module",
    errors: [
      {
        code: "reminder_edit_unsupported",
        class: "validation",
        description:
          "Actions, recipients and attention changes are unsupported. Nothing changed. Ask for a text, time, repeat, stop-time or destination edit instead."
      },
      {
        code: "reminder_edit_unclear",
        class: "validation",
        description:
          "Moss could not resolve the reminder or new terms. Nothing changed. Name the reminder and give a future time. One-time deadlines follow it within 12 hours; repeating stops may be later."
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
          "Inspect the current reminder and ask in an owned regular chat using its exact words. If asked which one, type its number or name.",
        path: "/settings?section=scheduled"
      }
    ]
  },
  REMINDER_SETTINGS_FEATURE,
  {
    id: "chat.reminder_notifications",
    description:
      "Reminders arrive in the saved chat and alert enabled devices. Quiet hours hold alerts unless the owner allowed that task; mutes and device switches win. Retries never repeat chat. Dismissing stops alerts. Opening goes to Today.",
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
      "In regular chat, remind me in 10 minutes to stretch posts once to Main by default, noting if late. A reply in its destination frees the slot. Up to 20 schedules, 30 days ahead. No deadline on one-time relative reminders; no private chats.",
    featureFlagId: "chat.module"
  },
  {
    id: "chat.clock_reminders",
    description:
      "In regular chat, set a one-time reminder for today, tonight or tomorrow in your time zone. Moss confirms in your chosen clock format. Daily and weekly repeats keep a saved local time and zone.",
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
      "Regular chat saves daily, named-weekday or 60-86399-second reminders. Saved local times shift through gaps and use the earlier fold. One catch-up after downtime, then normal cadence. Edits invalidate old jobs; saved stops end repeats.",
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
      "Due results appear in their open destination, even during a reply, and remain separate after reload. Other conversations, private and module chats do not show them. Reopen the destination or reload if a result is missing.",
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
