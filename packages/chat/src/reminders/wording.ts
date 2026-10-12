// #3309: every reminder reply is written by code, so the wording here is the whole contract.

import type { ChatReminderState } from "@moss/db";
import { localDayKey } from "@moss/module-sdk";

import type { ReminderCancelResult, ReminderList } from "./cancel.js";
import { deadlinePhrase, whenPhrase, type ReminderLocale } from "./clock-wording.js";
import { localWallClock } from "./local-clock.js";
import type { ReminderUnsupportedReason } from "./recognizer.js";
import type { OwnedReminder } from "./repository.js";

export const REMINDER_OPEN_LIMIT = 20;

/**
 * A delivery that runs this long after its due time says so. It stays above one worker poll
 * (DATA_CONTEXT_WORKER_POLLING_INTERVAL_SECONDS) plus the first retry delay.
 */
export const REMINDER_LATE_AFTER_MS = 60_000;

export function reminderSavedReply(delaySeconds: number, text: string): string {
  return `Okay. I'll remind you in ${describeDelay(delaySeconds)}: ${text}`;
}

export function reminderRefusedReply(reason: ReminderUnsupportedReason): string {
  const tryThis = 'Try "remind me in 10 minutes to stretch" or "remind me at 3pm to call Sam".';
  switch (reason) {
    case "out_of_range":
      return `I can set a reminder from 1 second up to 30 days ahead. ${tryThis}`;
    case "text_length":
      return `Keep the reminder to 500 characters or fewer. ${tryThis}`;
    case "recurrence":
      return `I can only set a one-off reminder, not one that repeats, so I didn't set anything. ${tryThis}`;
    case "unsupported_day":
      return 'I can set a clock-time reminder for today or tomorrow only, said like "tomorrow at 9am", so I didn\'t set anything.';
    case "needs_am_pm":
      return "Say am or pm, or use a 24-hour time like 15:00, so I set the right time. I didn't set anything yet.";
    case "deadline_needs_clock":
      return 'A deadline works only with a clock-time reminder, so I didn\'t set anything. Try "remind me at 3pm to call Sam, but not after 4pm".';
    case "ambiguous":
      return `I couldn't tell exactly when you meant, so I didn't set anything. ${tryThis}`;
    case "needs_time":
      return `Tell me how long from now, or a clock time today or tomorrow. ${tryThis}`;
  }
}

export const REMINDER_CAPACITY_REPLY = `You already have ${REMINDER_OPEN_LIMIT} reminders, which is the most I can hold, so I didn't set this one.`;

export const REMINDER_MAIN_ONLY_REPLY =
  "I can only set reminders in your Main chat, so I didn't set this one.";

export function reminderDeliveredMessage(text: string, late: boolean): string {
  return late
    ? `Reminder (this is late, I couldn't send it on time): ${text}`
    : `Reminder: ${text}`;
}

export function describeDelay(totalSeconds: number): string {
  const units: readonly (readonly [number, string])[] = [
    [86_400, "day"],
    [3600, "hour"],
    [60, "minute"],
    [1, "second"]
  ];
  const parts: string[] = [];
  let rest = totalSeconds;
  for (const [size, name] of units) {
    const count = Math.floor(rest / size);
    if (count > 0) parts.push(`${count} ${name}${count === 1 ? "" : "s"}`);
    rest -= count * size;
  }
  return parts.length > 1 ? `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}` : parts[0]!;
}

export const REMINDER_MANAGE_MAIN_ONLY_REPLY =
  "I can only manage chat reminders in your Main chat, so nothing changed.";

const FINISHED_LABEL: Readonly<Record<Exclude<ChatReminderState, "queued">, string>> = {
  paused: "paused",
  delivered: "sent",
  cancelled: "cancelled",
  failed: "couldn't be sent",
  expired: "skipped, past its deadline"
};

export function reminderListReply(list: ReminderList, locale: ReminderLocale): string {
  if (list.open.length === 0 && list.finished.length === 0) {
    return "You haven't set any reminders in chat.";
  }
  const lines: string[] = [];
  lines.push(
    list.open.length === 0
      ? "No chat reminders are waiting."
      : `Chat reminders waiting:\n${list.open.map((reminder) => `- ${reminder.text}, ${waitingLabel(reminder, list.now, locale)}`).join("\n")}`
  );
  if (list.finished.length > 0) {
    lines.push(
      `Recent chat reminders:\n${list.finished
        .map((reminder) => `- ${reminder.text} (${finishedLabel(reminder)})`)
        .join("\n")}`
    );
  }
  return lines.join("\n\n");
}

export function reminderCancelReply(result: ReminderCancelResult): string {
  switch (result.kind) {
    case "cancelled":
      return result.alike === 0
        ? `Cancelled. I won't remind you: ${result.reminder.text}`
        : `Cancelled the soonest one: ${result.reminder.text}\n${result.alike} more with the same words ${result.alike === 1 ? "is" : "are"} still waiting.`;
    case "already_cancelled":
      return `That reminder was already cancelled: ${result.reminder.text}`;
    case "already_delivered":
      return `Too late to cancel, I already sent that reminder: ${result.reminder.text}`;
    case "already_failed":
      return `That reminder couldn't be sent, so there was nothing to cancel: ${result.reminder.text}`;
    case "already_expired":
      return `That reminder passed its deadline and was skipped, so there was nothing to cancel: ${result.reminder.text}`;
    case "ambiguous":
      return `More than one reminder matches, so I didn't cancel any. Which one?\n${bullets(result.matches)}`;
    case "needs_target":
      return `You have ${result.open.length} chat reminders waiting. Which one should I cancel?\n${bullets(result.open)}`;
    case "not_found":
      return "I couldn't find a chat reminder like that, so nothing changed. I can only cancel reminders you set here in chat.";
    case "none_waiting":
      return "You don't have any chat reminders waiting, so nothing changed.";
  }
}

function bullets(reminders: readonly OwnedReminder[]): string {
  return reminders.map((reminder) => `- ${reminder.text}`).join("\n");
}

function finishedLabel(reminder: OwnedReminder): string {
  if (reminder.state === "queued") return "waiting";
  if (reminder.state === "delivered" && reminder.late) return "sent late";
  return FINISHED_LABEL[reminder.state];
}

/** A clock-time reminder shows its local time and deadline; a relative one shows time left. */
function waitingLabel(reminder: OwnedReminder, now: Date, locale: ReminderLocale): string {
  if (reminder.state === "paused") return "paused until you resume it";
  if (reminder.timing !== "local_clock") return timeLeft(reminder.dueAt, now);
  const today = localDayKey(now, locale.timeZone);
  const localDue = localWallClock(reminder.dueAt, locale.timeZone);
  const when = whenPhrase(localDue, today, locale.clockFormat);
  if (reminder.deadlineAt === null) return when;

  // The worker writes the expired state when it next runs; until then the list already says so.
  if (reminder.deadlineAt.getTime() <= now.getTime())
    return `${when}, past its deadline, so it won't be sent`;
  const localDeadline = localWallClock(reminder.deadlineAt, locale.timeZone);
  return `${when}, skipped if not sent by ${deadlinePhrase(localDeadline, localDue, today, locale.clockFormat)}`;
}

function timeLeft(dueAt: Date, now: Date): string {
  const seconds = Math.ceil((dueAt.getTime() - now.getTime()) / 1000);
  return seconds > 0 ? `in ${describeDelay(seconds)}` : "due now";
}
