import { assertDataContextDb, type DataContextDb } from "@moss/db";
import type { FocusLabel } from "@moss/shared";

import type { RecentJudgment } from "./nudge-rules.js";

export interface NewJudgmentRow {
  readonly id: string;
  readonly ownerUserId: string;
  readonly deviceId: string | null;
  readonly blockRef: string;
  readonly label: FocusLabel;
  readonly reason: string;
  readonly nudged: boolean;
}

/**
 * What the judgment service needs from storage. Every method runs on the caller's scoped
 * connection, so the table's owner-only row policy decides whose rows these are; nothing takes an
 * owner filter, because a second filter would only hide a regression in that policy.
 */
export interface FocusJudgmentStore {
  insert(scopedDb: DataContextDb, row: NewJudgmentRow): Promise<void>;
  /** Newest first, this block only. */
  listRecentForBlock(
    scopedDb: DataContextDb,
    blockRef: string,
    limit: number
  ): Promise<RecentJudgment[]>;
  /** The person's newest nudge, whichever block or Mac produced it. */
  lastNudgeAt(scopedDb: DataContextDb): Promise<Date | null>;
  /** True when a row changed. Absent and another person's row are indistinguishable. */
  setCorrection(
    scopedDb: DataContextDb,
    judgmentId: string,
    verdict: "right" | "wrong"
  ): Promise<boolean>;
}

export class FocusJudgmentRepository implements FocusJudgmentStore {
  async insert(scopedDb: DataContextDb, row: NewJudgmentRow): Promise<void> {
    assertDataContextDb(scopedDb);
    await scopedDb.db
      .insertInto("app.focus_judgments")
      .values({
        id: row.id,
        owner_user_id: row.ownerUserId,
        device_id: row.deviceId,
        block_ref: row.blockRef,
        label: row.label,
        reason: row.reason,
        nudged: row.nudged
      })
      .execute();
  }

  async listRecentForBlock(
    scopedDb: DataContextDb,
    blockRef: string,
    limit: number
  ): Promise<RecentJudgment[]> {
    assertDataContextDb(scopedDb);
    const rows = await scopedDb.db
      .selectFrom("app.focus_judgments")
      .select(["label", "created_at"])
      .where("block_ref", "=", blockRef)
      .orderBy("created_at", "desc")
      .limit(limit)
      .execute();
    return rows.map((row) => ({ label: row.label as FocusLabel, at: new Date(row.created_at) }));
  }

  async lastNudgeAt(scopedDb: DataContextDb): Promise<Date | null> {
    assertDataContextDb(scopedDb);
    const row = await scopedDb.db
      .selectFrom("app.focus_judgments")
      .select("created_at")
      .where("nudged", "=", true)
      .orderBy("created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    return row ? new Date(row.created_at) : null;
  }

  async setCorrection(
    scopedDb: DataContextDb,
    judgmentId: string,
    verdict: "right" | "wrong"
  ): Promise<boolean> {
    assertDataContextDb(scopedDb);
    const result = await scopedDb.db
      .updateTable("app.focus_judgments")
      .set({ correction: verdict })
      .where("id", "=", judgmentId)
      .executeTakeFirst();
    return Number(result.numUpdatedRows) > 0;
  }
}
