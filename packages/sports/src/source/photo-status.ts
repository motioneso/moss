import type { SportsSourcePhotoStatus } from "@moss/shared";

/**
 * #2237 slice 2 — turning one source's stored photo record into the sentence its settings row
 * shows (spec decision 7). Pure and one-way: the status is always derived, never stored, so it
 * cannot drift away from what the last refresh actually wrote.
 */

export type SportsPhotoRuleState = "none" | "previewing" | "in_use" | "stale";
export type SportsPhotoOutcome = "working" | "none";

export interface SportsSourcePhotoRecord {
  readonly photoRuleState: SportsPhotoRuleState;
  readonly photoRuleJson: Readonly<Record<string, unknown>> | null;
  /** What the last refresh that actually had stories saw. Null until one has completed. */
  readonly photoLastOutcome: SportsPhotoOutcome | null;
  /**
   * Set only once Moss's own look at this source has run and come back empty: it is the earliest
   * time the next look may run (spec decision 6c). Null on a stale source means the look is still
   * owed, so the owner is not yet told anything beyond the last refresh's outcome.
   */
  readonly photoRelookAt: Date | null;
}

/** Number of refreshes with stories and no photo before Moss goes and looks at the source again. */
export const SPORTS_PHOTO_MISS_STREAK_LIMIT = 3;

export function photoStatusFor(record: SportsSourcePhotoRecord): SportsSourcePhotoStatus {
  if (record.photoRuleState === "previewing") return "previewing";
  if (record.photoRuleState === "stale" && record.photoRelookAt !== null) return "stopped_working";
  if (record.photoLastOutcome === null) return "pending";
  return record.photoLastOutcome === "working" ? "working" : "none";
}

/**
 * True only when this source's photos come from something Moss found and the owner confirmed, so
 * only such a source offers to stop using them.
 */
export function photosFoundByMoss(record: SportsSourcePhotoRecord): boolean {
  return (
    record.photoRuleJson !== null &&
    (record.photoRuleState === "in_use" || record.photoRuleState === "stale")
  );
}
