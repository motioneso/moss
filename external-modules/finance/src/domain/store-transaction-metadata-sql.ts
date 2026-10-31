import { transactionMetadataUndoSql } from "./store-transaction-metadata-undo-sql.js";
import { TXN_COLUMNS, rowToTransaction, type TransactionRow } from "./store-transaction-rows.js";
import type { TransactionMetadataStore } from "./transaction-metadata.js";
import type { FinanceDb } from "./store-sql.js";
/** This writer cannot change financial fields, including the posting/statement state. */
export function transactionMetadataSqlStore(db: FinanceDb): TransactionMetadataStore {
  return {
    undo: transactionMetadataUndoSql(db),
    async rows(accountId, month) {
      const [year, index] = month.split("-").map(Number) as [number, number];
      const next =
        index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
      const result = await db.query<TransactionRow & { write_revision: string }>(
        `SELECT ${TXN_COLUMNS}, md5(id || ':' || xmin::text) AS write_revision FROM app.finance_transactions WHERE account_id=$1 AND date >= $2::date AND date < $3::date ORDER BY date DESC,id ASC`,
        [accountId, `${month}-01`, `${next}-01`]
      );
      return result.rows.map((row) => ({
        ...rowToTransaction(row),
        writeRevision: row.write_revision
      }));
    },
    async apply(rows, actor, at) {
      const requested = rows.map((row) => ({ ...row, hasNotes: row.notes !== undefined }));
      const result = await db.query<{ applied: boolean }>(
        `WITH requested AS (
    SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text,"writeRevision" text,"categoryId" text,notes text,"hasNotes" boolean)
  ), reviewed AS MATERIALIZED (
    SELECT t.id,t.account_id,t.date,t.category_id,t.notes FROM app.finance_transactions t
    JOIN requested r ON r.id=t.id WHERE md5(t.id||':'||t.xmin::text)=r."writeRevision"
      AND t.splits='[]'::jsonb AND t.transfer_id IS NULL
    ORDER BY t.id FOR UPDATE OF t
  ), categories AS MATERIALIZED (
    SELECT id FROM app.finance_categories WHERE archived_at IS NULL AND id IN (SELECT "categoryId" FROM requested)
    ORDER BY id FOR SHARE
  ), eligible AS (
    SELECT 1 WHERE (SELECT count(*) FROM requested) BETWEEN 1 AND 200
      AND (SELECT count(DISTINCT id) FROM requested)=(SELECT count(*) FROM requested)
      AND (SELECT count(*) FROM reviewed)=(SELECT count(*) FROM requested)
      AND (SELECT count(*) FROM requested WHERE "categoryId" IN (SELECT id FROM categories))=(SELECT count(*) FROM requested)
  ), changed AS (
    UPDATE app.finance_transactions t SET category_id=r."categoryId",categorized_by='user',review_state='confirmed',
      notes=CASE WHEN r."hasNotes" THEN r.notes ELSE t.notes END
    FROM requested r WHERE t.id=r.id AND EXISTS(SELECT 1 FROM eligible) RETURNING t.id
  ), logged AS (
    INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params,undo)
    SELECT app.current_actor_user_id(),gen_random_uuid(),$3::timestamptz,$2,
      CASE WHEN $2='user' AND v.category_id IS NOT DISTINCT FROM r."categoryId" THEN 'transaction.confirm' ELSE 'transaction.categorize' END,
      jsonb_build_object('transactionId',v.id,'accountId',v.account_id,'month',to_char(v.date,'YYYY-MM'),
        'categoryId',r."categoryId",'previousCategoryId',v.category_id,'notesChanged',r."hasNotes" AND v.notes IS DISTINCT FROM r.notes),
      CASE WHEN v.category_id IS DISTINCT FROM r."categoryId" THEN jsonb_build_object('transactionId',v.id,'accountId',v.account_id,'month',to_char(v.date,'YYYY-MM'),'categoryId',v.category_id) ELSE NULL END
    FROM reviewed v JOIN requested r ON r.id=v.id JOIN changed c ON c.id=v.id RETURNING id
  ) SELECT EXISTS(SELECT 1 FROM eligible) AS applied`,
        [JSON.stringify(requested), actor, at]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
