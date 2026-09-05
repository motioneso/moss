import { assertDataContextDb, type DataContextDb } from "@moss/db";

import { validateSportsPhotoRule } from "./photo-rule.js";
import { SPORTS_PHOTO_MISS_STREAK_LIMIT, type SportsPhotoOutcome } from "./photo-status.js";

/**
 * #2237 slice 2 - the stored photo record for one custom source: what the last refresh with
 * stories saw, how many refreshes in a row saw nothing, and the instruction Moss found for
 * where an article's lead photo lives.
 *
 * These live beside the source rows they update, not on the source repository class, so slice 3
 * can add the rest of the photo flow without growing that file past the size standard.
 */

/** How long Moss waits before looking at a source whose photos stopped working. */
export const SPORTS_PHOTO_RELOOK_DELAY_MS = 24 * 60 * 60 * 1000;

/**
 * Records what one refresh with stories saw for one source. A hit clears the run of misses, and
 * brings a source that had stopped working back into use. A miss only counts towards giving up
 * when there is a saved instruction to give up on.
 */
export async function recordSportsPhotoOutcome(
  scopedDb: DataContextDb,
  sourceId: string,
  outcome: SportsPhotoOutcome,
  now: Date = new Date()
): Promise<void> {
  assertDataContextDb(scopedDb);
  const row = await scopedDb.db
    .selectFrom("app.sports_custom_sources")
    .select(["photo_rule_state", "photo_miss_streak"])
    .where("id", "=", sourceId)
    .forUpdate()
    .executeTakeFirst();
  if (!row) return;

  if (outcome === "working") {
    await scopedDb.db
      .updateTable("app.sports_custom_sources")
      .set({
        photo_last_outcome: "working",
        photo_miss_streak: 0,
        photo_relook_at: null,
        ...(row.photo_rule_state === "stale" ? { photo_rule_state: "in_use" as const } : {})
      })
      .where("id", "=", sourceId)
      .execute();
    return;
  }

  const counting = row.photo_rule_state === "in_use";
  const streak = counting ? row.photo_miss_streak + 1 : row.photo_miss_streak;
  const giveUp = counting && streak >= SPORTS_PHOTO_MISS_STREAK_LIMIT;
  await scopedDb.db
    .updateTable("app.sports_custom_sources")
    .set({
      photo_last_outcome: "none",
      photo_miss_streak: streak,
      ...(giveUp
        ? {
            photo_rule_state: "stale" as const,
            photo_relook_at: new Date(now.getTime() + SPORTS_PHOTO_RELOOK_DELAY_MS)
          }
        : {})
    })
    .where("id", "=", sourceId)
    .execute();
}

/**
 * Saves the photo instruction Moss found, either while the owner looks at a preview or once they
 * have said to use it. The instruction is checked again here, against this source's own allowed
 * hosts, so nothing can widen where photos are fetched from.
 */
export async function setSportsPhotoRule(
  scopedDb: DataContextDb,
  sourceId: string,
  rule: unknown,
  state: "previewing" | "in_use"
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const source = await scopedDb.db
    .selectFrom("app.sports_custom_sources")
    .select(["confirmed_fetch_hosts"])
    .where("id", "=", sourceId)
    .forUpdate()
    .executeTakeFirst();
  if (!source) return false;
  const checked = validateSportsPhotoRule(rule, { allowedHosts: source.confirmed_fetch_hosts });
  if (!checked.ok) return false;
  const update = await scopedDb.db
    .updateTable("app.sports_custom_sources")
    .set({
      photo_rule_json: { ...checked.rule, fetchHosts: [...checked.rule.fetchHosts] },
      photo_rule_state: state,
      photo_miss_streak: 0,
      photo_relook_at: null
    })
    .where("id", "=", sourceId)
    .executeTakeFirst();
  return (update.numUpdatedRows ?? 0n) > 0n;
}

/**
 * "Stop using Moss's photos": forgets the saved instruction, so the source goes back to the
 * photos its own feed and article pages already offer.
 */
export async function clearSportsPhotoRule(
  scopedDb: DataContextDb,
  sourceId: string
): Promise<boolean> {
  assertDataContextDb(scopedDb);
  const update = await scopedDb.db
    .updateTable("app.sports_custom_sources")
    .set({
      photo_rule_json: null,
      photo_rule_state: "none",
      photo_miss_streak: 0,
      photo_relook_at: null
    })
    .where("id", "=", sourceId)
    .executeTakeFirst();
  return (update.numUpdatedRows ?? 0n) > 0n;
}
