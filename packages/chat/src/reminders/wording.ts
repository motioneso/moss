// #3309: every reminder reply is written by code, so the wording here is the whole contract.

import type { ReminderUnsupportedReason } from "./recognizer.js";

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
