import { sql } from "kysely";

import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { localDayKey } from "@moss/module-sdk";

import { HEARTBEAT_DAILY_ATTEMPTS } from "./limits.js";

/** The owner's local calendar day, which is the allowance window. */
export function allowanceDay(now: Date, timeZone: string): string {
  return localDayKey(now, timeZone);
}

/**
 * Reserves one generation attempt for the owner's local day, or returns null when the day is
 * used up. The reservation lives in the caller's transaction, so it commits with the attempt.
 * A timezone change cannot refill the day because the whole UTC-day window also stays capped at
 * twice the daily limit.
 */
export async function reserveAttempt(
  scopedDb: DataContextDb,
  input: { readonly occurrenceId: string; readonly now: Date; readonly timeZone: string }
): Promise<{ readonly attempt: number } | null> {
  assertDataContextDb(scopedDb);
  const today = allowanceDay(input.now, input.timeZone);
  // Beats for one owner queue here until the holder commits, so the count below is never stale.
  await sql`SELECT pg_advisory_xact_lock(hashtextextended('heartbeat-allowance:' || app.current_actor_user_id()::text, 0))`.execute(
    scopedDb.db
  );
  const rows = await scopedDb.db
    .selectFrom("app.heartbeat_allowance_charges")
    .select([sql<string>`local_date::text`.as("local_date"), "attempt"])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("local_date", ">=", sql<string>`(${today}::date - 2)`)
    .execute();
  const todayCount = rows.filter((row) => String(row.local_date).slice(0, 10) === today).length;
  const utcDay = input.now.toISOString().slice(0, 10);
  const nearUtcDay = rows.filter((row) => {
    const day = String(row.local_date).slice(0, 10);
    const delta = Math.abs(Date.parse(day) - Date.parse(utcDay)) / 86_400_000;
    return delta <= 1;
  }).length;
  if (todayCount >= HEARTBEAT_DAILY_ATTEMPTS || nearUtcDay >= HEARTBEAT_DAILY_ATTEMPTS * 2)
    return null;
  const attempt = todayCount + 1;
  await scopedDb.db
    .insertInto("app.heartbeat_allowance_charges")
    .values({
      owner_user_id: sql<string>`app.current_actor_user_id()`,
      local_date: today,
      occurrence_id: input.occurrenceId,
      attempt
    })
    .execute();
  return { attempt };
}
