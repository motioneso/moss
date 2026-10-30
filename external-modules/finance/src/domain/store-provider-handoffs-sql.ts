import type { ProviderHandoffStore } from "./provider-handoffs.js";
import type { FinanceDb } from "./store-sql.js";
import { TXN_COLUMNS, rowToTransaction, type TransactionRow } from "./store-transaction-rows.js";
export function providerHandoffSqlStore(db: FinanceDb): ProviderHandoffStore {
  return {
    async capture(itemId, removedIds, posted, at) {
      if (!removedIds.length && !posted.length) return;
      // Capture the last committed user fields and remove only the locked pending provider row.
      // Amount is serialized as decimal text so JSON parsing cannot round legacy bigint values.
      const columns = TXN_COLUMNS.replace("amount_cents,", "amount_cents::text AS amount_cents,");
      await db.query(
        `WITH pending AS MATERIALIZED (
        SELECT t.* FROM app.finance_transactions t JOIN app.finance_accounts a
          ON a.owner_user_id=t.owner_user_id AND a.account_id=t.account_id
        WHERE a.item_id=$1 AND a.source='provider' AND t.source='provider' AND t.pending
          AND (t.id=ANY($2::text[]) OR EXISTS (
            SELECT 1 FROM jsonb_to_recordset($3::jsonb) r(id text,"accountId" text)
            WHERE r.id=t.id AND r."accountId"=t.account_id))
        ORDER BY t.id FOR UPDATE OF t
      ), snapshots AS (SELECT ${columns} FROM pending), saved AS (
        INSERT INTO app.finance_provider_handoffs(owner_user_id,item_id,transaction_id,account_id,snapshot,captured_at)
        SELECT app.current_actor_user_id(),$1,s.id,s.account_id,to_jsonb(s),$4::timestamptz FROM snapshots s
        ON CONFLICT(owner_user_id,item_id,transaction_id) DO UPDATE SET account_id=EXCLUDED.account_id,
          snapshot=EXCLUDED.snapshot,captured_at=EXCLUDED.captured_at RETURNING transaction_id
      ), removed AS (
        DELETE FROM app.finance_transactions t USING saved s WHERE t.id=s.transaction_id
          AND t.source='provider' AND t.pending RETURNING t.id
      ) SELECT count(*) FROM removed`,
        [itemId, removedIds, JSON.stringify(posted), at]
      );
    },
    async load(itemId, ids) {
      if (!ids.length) return [];
      const result = await db.query<{ snapshot: TransactionRow }>(
        "SELECT snapshot FROM app.finance_provider_handoffs WHERE item_id=$1 AND transaction_id=ANY($2::text[]) ORDER BY transaction_id",
        [itemId, ids]
      );
      return result.rows.map((row) => rowToTransaction(row.snapshot));
    },
    async clear(itemId) {
      await db.query("DELETE FROM app.finance_provider_handoffs WHERE item_id=$1", [itemId]);
    }
  };
}
