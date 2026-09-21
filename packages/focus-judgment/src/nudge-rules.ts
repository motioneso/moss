import type { FocusLabel } from "@moss/shared";

export interface RecentJudgment {
  readonly label: FocusLabel;
  readonly at: Date;
}

export interface NudgeOptions {
  readonly capMinutes: number;
  readonly inQuietHours: boolean;
}

/**
 * Whether this judgment should make the Mac show a nudge. Decided here, on the server, so a client
 * cannot bypass it.
 *
 * - Quiet hours answer false, not "later": a deferred nudge would arrive after the moment it was
 *   about. (The notifications module defers; it is deliberately not used for this.)
 * - The two newest judgments for this block must both be `distracted`, with nothing between them.
 *   `necessary_detour` and `insufficient_evidence` never count toward a nudge.
 * - At most one nudge per `capMinutes` per person, whichever block or Mac produced it.
 *
 * `recentForBlock` is newest first and already includes the judgment being decided.
 */
export function decideNudge(
  recentForBlock: readonly RecentJudgment[],
  lastNudgeAt: Date | null,
  now: Date,
  options: NudgeOptions
): boolean {
  if (options.inQuietHours) return false;

  const [newest, previous] = recentForBlock;
  if (newest?.label !== "distracted" || previous?.label !== "distracted") return false;

  if (lastNudgeAt !== null) {
    const sinceLastNudgeMs = now.getTime() - lastNudgeAt.getTime();
    if (sinceLastNudgeMs < options.capMinutes * 60_000) return false;
  }
  return true;
}
