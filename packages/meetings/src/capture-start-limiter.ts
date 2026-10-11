import { assertDataContextDb, type DataContextDb } from "@moss/db";
import { sql } from "kysely";
import { MeetingCaptureError } from "./capture-domain.js";

/** Rolling windows, shared by every browser, device and API process for this owner. */
export function captureStartBudget(previous: readonly Date[], at: Date): Date[] {
  const recent = previous
    .filter((entry) => entry.getTime() > at.getTime() - 3600000)
    .sort((a, b) => a.getTime() - b.getTime());
  const minute = recent.filter((entry) => entry.getTime() > at.getTime() - 60000);
  const blockedUntil = Math.max(
    minute.length >= 10 ? minute[minute.length - 10]!.getTime() + 60000 : 0,
    recent.length >= 60 ? recent[recent.length - 60]!.getTime() + 3600000 : 0
  );
  if (blockedUntil > at.getTime())
    throw new MeetingCaptureError(
      "meeting_capture_rate_limited",
      429,
      Math.max(1, Math.ceil((blockedUntil - at.getTime()) / 1000))
    );
  return [...recent, at];
}

export class MeetingCaptureStartLimiter {
  async consume(db: DataContextDb): Promise<void> {
    assertDataContextDb(db);
    // Separate committed transaction: unsuccessful Starts and request replays still consume
    // admission capacity, while simultaneous requests across API processes cannot race it.
    await sql`SELECT pg_advisory_xact_lock(hashtextextended(current_setting('app.actor_user_id'),2983))`.execute(
      db.db
    );
    const clock = await sql<{ at: Date }>`SELECT clock_timestamp() AS at`.execute(db.db);
    const at = clock.rows[0]!.at;
    const previous = await sql<{
      started_at: Date[];
    }>`SELECT started_at FROM app.meeting_capture_start_limits WHERE owner_user_id=app.current_actor_user_id()`.execute(
      db.db
    );
    const startedAt = captureStartBudget(previous.rows[0]?.started_at ?? [], at);
    await sql`INSERT INTO app.meeting_capture_start_limits (started_at) VALUES (${startedAt}::timestamptz[]) ON CONFLICT(owner_user_id) DO UPDATE SET started_at=EXCLUDED.started_at`.execute(
      db.db
    );
  }
}
