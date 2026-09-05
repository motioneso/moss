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
   * When Moss's own look at this source may next run. Non-null on a stale source means a look has
   * already been made and came back empty, which is the only case the owner is told about.
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
