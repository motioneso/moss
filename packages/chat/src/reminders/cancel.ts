// #3310: lists the owner's reminders and cancels one. The target is chosen from the owner's own
// rows, then re-read under the row lock that delivery also takes, so the answer always reflects
// whichever of cancel and delivery committed first.

import type { DataContextDb } from "@moss/db";

import type { OwnedReminder, ReminderRepository } from "./repository.js";

export const REMINDER_LIST_FINISHED_LIMIT = 10;

export interface ReminderList {
  readonly now: Date;

  /** Waiting reminders, soonest first. */
  readonly open: readonly OwnedReminder[];

  /** Delivered, cancelled or failed reminders, newest first. */
  readonly finished: readonly OwnedReminder[];
}

export type ReminderCancelResult =
  | {
      readonly kind: "cancelled";
      readonly reminder: OwnedReminder;

      /** Other waiting reminders with the same words, left in place. */
      readonly alike: number;
    }
  | { readonly kind: "already_cancelled"; readonly reminder: OwnedReminder }
  | { readonly kind: "already_delivered"; readonly reminder: OwnedReminder }
  | { readonly kind: "already_failed"; readonly reminder: OwnedReminder }
  | { readonly kind: "ambiguous"; readonly matches: readonly OwnedReminder[] }
  | { readonly kind: "needs_target"; readonly open: readonly OwnedReminder[] }
  | { readonly kind: "not_found" }
  | { readonly kind: "none_waiting" };

export async function listReminders(
  scopedDb: DataContextDb,
  reminders: ReminderRepository
): Promise<ReminderList> {
  const owned = await reminders.listOwned(scopedDb);
  const now = await reminders.now(scopedDb);
  return {
    now,
    open: bySoonest(owned.filter((reminder) => reminder.state === "queued")),
    finished: owned
      .filter((reminder) => reminder.state !== "queued")
      .slice(0, REMINDER_LIST_FINISHED_LIMIT)
  };
}

/**
 * Runs inside the turn's transaction, so a stopped turn rolls the cancel back. Waiting reminders
 * are matched first; a finished match only explains what already happened to it.
 */
export async function cancelReminder(
  scopedDb: DataContextDb,
  reminders: ReminderRepository,
  target: string | null
): Promise<ReminderCancelResult> {
  const owned = await reminders.listOwned(scopedDb);
  const waiting = bySoonest(owned.filter((reminder) => reminder.state === "queued"));

  if (target === null) {
    if (waiting.length > 1) return { kind: "needs_target", open: waiting };
    if (waiting.length === 1) return settle(scopedDb, reminders, waiting[0]!);

    // Just after delivery, the one reminder still holding a slot is the one the user means.
    const holding = owned.filter(
      (reminder) => reminder.state === "delivered" && reminder.contextState === "pending"
    );
    return holding.length === 1
      ? settle(scopedDb, reminders, holding[0]!)
      : { kind: "none_waiting" };
  }

  const waitingMatches = matchTarget(waiting, target);
  if (waitingMatches.length > 1 && !sameText(waitingMatches)) {
    return { kind: "ambiguous", matches: waitingMatches };
  }
  if (waitingMatches.length > 0) {
    // Reminders with the same words are interchangeable, so the soonest one goes.
    const result = await settle(scopedDb, reminders, waitingMatches[0]!);
    return result.kind === "cancelled" ? { ...result, alike: waitingMatches.length - 1 } : result;
  }

  // Newest first, so a finished match reports the latest reminder with those words.
  const finishedMatches = matchTarget(
    owned.filter((reminder) => reminder.state !== "queued"),
    target
  );
  return finishedMatches.length > 0
    ? settle(scopedDb, reminders, finishedMatches[0]!)
    : { kind: "not_found" };
}

/** Exact text matches win; otherwise every reminder whose text contains the target. */
export function matchTarget(
  owned: readonly OwnedReminder[],
  target: string
): readonly OwnedReminder[] {
  const wanted = normalizeReminderText(target);
  if (wanted.length === 0) return [];
  const exact = owned.filter((reminder) => normalizeReminderText(reminder.text) === wanted);
  if (exact.length > 0) return exact;
  return owned.filter((reminder) => normalizeReminderText(reminder.text).includes(wanted));
}

function bySoonest(reminders: readonly OwnedReminder[]): OwnedReminder[] {
  return [...reminders].sort((a, b) => a.dueAt.getTime() - b.dueAt.getTime());
}

function sameText(reminders: readonly OwnedReminder[]): boolean {
  const first = normalizeReminderText(reminders[0]!.text);
  return reminders.every((reminder) => normalizeReminderText(reminder.text) === first);
}

export function normalizeReminderText(text: string): string {
  return text
    .toLowerCase()
    .replace(/[.!?,;:"']+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function settle(
  scopedDb: DataContextDb,
  reminders: ReminderRepository,
  candidate: OwnedReminder
): Promise<ReminderCancelResult> {
  const locked = await reminders.lockForCancel(scopedDb, candidate.id);
  if (!locked) return { kind: "not_found" };

  switch (locked.state) {
    case "queued":
      await reminders.markCancelled(scopedDb, locked.id);
      return { kind: "cancelled", reminder: { ...locked, state: "cancelled" }, alike: 0 };
    case "delivered":
      if (locked.contextState === "pending") {
        await reminders.dismissContext(scopedDb, locked.id);
      }
      return { kind: "already_delivered", reminder: { ...locked, contextState: "dismissed" } };
    case "cancelled":
      return { kind: "already_cancelled", reminder: locked };
    case "failed":
      return { kind: "already_failed", reminder: locked };
  }
}
