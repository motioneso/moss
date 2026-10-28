import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { ToolExecute, ToolResult } from "@moss/module-sdk";
import {
  capHeartbeatItems,
  heartbeatRevision,
  localDay,
  parseHeartbeatSourceReadInput,
  type HeartbeatEvidenceItem,
  type HeartbeatSourceRead
} from "@moss/shared";
import { sql } from "kysely";

/** Accepted commitments overdue by more than this many days stop surfacing. */
const OVERDUE_LOOKBACK_DAYS = 7;

/**
 * Input must stay inside the read contract. Extra keys (an owner or user id) are refused, and the
 * query below filters on the actor the data context was opened for.
 */
export async function authorizeCommitmentsHeartbeatRead(
  _scopedDb: DataContextDb,
  input: Record<string, unknown>
): Promise<boolean> {
  return parseHeartbeatSourceReadInput(input) !== null;
}

function shiftDay(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The next instant at which the actor's local date changes, found in 15 minute steps. */
function nextLocalMidnight(now: Date, timeZone: string): string | null {
  const today = localDay(now, timeZone);
  for (let minutes = 15; minutes <= 26 * 60; minutes += 15) {
    const probe = new Date(now.getTime() + minutes * 60_000);
    if (localDay(probe, timeZone) !== today) return probe.toISOString();
  }
  return null;
}

/**
 * Accepted commitments that have a due date, are not yet turned into a task, and fall due inside
 * the horizon. The Memory source reads these rows only; it never runs semantic retrieval.
 */
export const commitmentsHeartbeatOpenExecute: ToolExecute = async (
  scopedDb,
  input,
  ctx
): Promise<ToolResult> => {
  assertDataContextDb(scopedDb);
  const parsed = parseHeartbeatSourceReadInput(input);
  if (!parsed) throw new Error("Invalid heartbeat read input");

  const now = new Date();
  const timeZone = ctx.localTimezone ?? "UTC";
  const today = localDay(now, timeZone);
  const lastDay = localDay(new Date(now.getTime() + parsed.horizonHours * 3_600_000), timeZone);
  const firstDay = shiftDay(today, -OVERDUE_LOOKBACK_DAYS);

  const rows = await scopedDb.db
    .selectFrom("app.commitment_candidates")
    .select([
      "id",
      "title",
      "kind",
      "confidence",
      "counterparty_label",
      sql<string>`due_local_date::text`.as("due_day")
    ])
    .where("owner_user_id", "=", sql<string>`app.current_actor_user_id()`)
    .where("status", "=", "accepted")
    .where("resolution_ref", "is", null)
    .where(sql<boolean>`due_local_date >= ${firstDay}::date`)
    .where(sql<boolean>`due_local_date <= ${lastDay}::date`)
    .orderBy("due_local_date", "asc")
    .orderBy("id")
    .limit(parsed.limit + 1)
    .execute();

  const { items: bounded, truncated } = capHeartbeatItems(rows, parsed.limit);
  const items: HeartbeatEvidenceItem[] = bounded.map((row) => ({
    entityKey: `commitment:${row.id}`,
    episodeKey: `commitment:${row.id}:${row.due_day}`,
    title: row.title,
    at: row.due_day,
    kind: "commitment_due",
    facts: {
      commitmentKind: row.kind,
      confidence: row.confidence,
      counterparty: row.counterparty_label,
      overdue: row.due_day < today
    }
  }));

  const data: HeartbeatSourceRead = {
    source: "memory",
    revision: heartbeatRevision(
      rows.map((row) => [row.id, row.title, row.due_day, row.confidence].join("|"))
    ),
    nextBoundaryAt: nextLocalMidnight(now, timeZone),
    freshness: "fresh",
    truncated,
    items
  };
  return { data };
};
