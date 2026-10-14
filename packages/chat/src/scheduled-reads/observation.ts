import { createHash } from "node:crypto";
import type { ScheduledTaskSnapshot } from "./report.js";

/** Only the exact status-check fields carry novelty; model prose is not an observation. */
export function scheduledObservationKey(task: ScheduledTaskSnapshot): string {
  return createHash("sha256")
    .update(JSON.stringify([task.id, task.title, task.status]))
    .digest("hex");
}

export function scheduledObservationDecision(previous: string | null, task: ScheduledTaskSnapshot) {
  if (previous === null) return "baseline";
  return previous === scheduledObservationKey(task) ? "unchanged" : "changed";
}

/** Per-run quiet retries do not increment this persisted exhausted-run counter. */
export function scheduledFailureNotification(previousStreak: number): boolean {
  return previousStreak === 2;
}

export function recurringReadFailureMessage(
  outcome: "failed" | "refused",
  continues: boolean
): string {
  return (
    "Three consecutive task checks could not complete. " +
    (outcome === "refused"
      ? "Restore Tasks access, or delete this check and request one for a task you own. "
      : "Check Tasks and your AI settings. ") +
    (continues
      ? "I will keep checking on the saved cadence; you can pause this check in Settings."
      : "No further run fits before its stop time, so this check is now complete.")
  );
}
