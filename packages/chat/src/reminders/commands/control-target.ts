import { matchTarget } from "../cancel.js";
import { lockReminderControl } from "../controls.js";
import type { ReminderCommandContext, ReminderTurnDecision } from "./types.js";

export async function controlTarget(
  context: ReminderCommandContext,
  target: string | null,
  pendingOnly: boolean
) {
  const owned = await context.deps.reminders.listOwned(context.scopedDb);
  const candidates = pendingOnly
    ? owned.filter((row) => row.state === "queued" || row.state === "paused")
    : owned;
  const matches = target === null ? candidates : matchTarget(candidates, target);
  if (matches.length !== 1) return undefined;
  return lockReminderControl(context.scopedDb, matches[0]!.id);
}

export function controlRefused(
  reply = "Name one reminder so I can change the right one. Nothing changed."
): ReminderTurnDecision {
  return { reply, origin: { version: 1, kind: "reminder", event: "refused", reminderId: null } };
}
