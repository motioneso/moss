// #3309: every reminder reply is written by code, so the wording here is the whole contract.

import type { ChatReminderState } from "@moss/db";

import type { ReminderCancelResult, ReminderList } from "./cancel.js";
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
  const tryThis = 'Try "remind me in 10 minutes to stretch".';
  switch (reason) {
    case "out_of_range":
      return `I can set a reminder from 1 second up to 30 days ahead. ${tryThis}`;
    case "text_length":
      return `Keep the reminder to 500 characters or fewer. ${tryThis}`;
    case "clock_or_recurrence":
      return `I can only set a one-off reminder a set time from now, not at a clock time or on repeat. ${tryThis}`;
    case "ambiguous":
      return `That has more than one time in it, so I didn't set anything. ${tryThis}`;
    case "needs_relative_duration":
      return `Tell me how long from now, in seconds, minutes, hours or days. ${tryThis}`;
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
  "I can only list or cancel reminders in your Main chat, so nothing changed.";

const FINISHED_LABEL: Readonly<Record<Exclude<ChatReminderState, "queued">, string>> = {
  delivered: "sent",
  cancelled: "cancelled",
  failed: "couldn't be sent"
};

export function reminderListReply(list: ReminderList): string {
  if (list.open.length === 0 && list.finished.length === 0) {
    return "You don't have any reminders.";
  }
  const lines: string[] = [];
  lines.push(
    list.open.length === 0
      ? "Nothing is waiting."
      : `Waiting:\n${list.open.map((reminder) => `- ${reminder.text}, ${timeLeft(reminder.dueAt, list.now)}`).join("\n")}`
  );
  if (list.finished.length > 0) {
    lines.push(
      `Recent:\n${list.finished
        .map((reminder) => `- ${reminder.text} (${finishedLabel(reminder.state)})`)
        .join("\n")}`
    );
  }
  return lines.join("\n\n");
}

export function reminderCancelReply(result: ReminderCancelResult): string {
  switch (result.kind) {
    case "cancelled":
      return `Cancelled. I won't remind you: ${result.reminder.text}`;
    case "already_cancelled":
      return `That reminder was already cancelled: ${result.reminder.text}`;
    case "already_delivered":
      return `Too late to cancel, I already sent that reminder: ${result.reminder.text}`;
    case "already_failed":
      return `That reminder couldn't be sent, so there was nothing to cancel: ${result.reminder.text}`;
    case "ambiguous":
      return `More than one reminder matches, so I didn't cancel any. Which one?\n${bullets(result.matches)}`;
    case "needs_target":
      return `You have ${result.open.length} reminders waiting. Which one should I cancel?\n${bullets(result.open)}`;
    case "not_found":
      return "I couldn't find a reminder like that, so nothing changed.";
    case "none_waiting":
      return "You don't have any reminders waiting, so nothing changed.";
  }
}

function bullets(reminders: readonly OwnedReminder[]): string {
  return reminders.map((reminder) => `- ${reminder.text}`).join("\n");
}

function finishedLabel(state: ChatReminderState): string {
  return state === "queued" ? "waiting" : FINISHED_LABEL[state];
}

function timeLeft(dueAt: Date, now: Date): string {
  const seconds = Math.ceil((dueAt.getTime() - now.getTime()) / 1000);
  return seconds > 0 ? `in ${describeDelay(seconds)}` : "due now";
}
