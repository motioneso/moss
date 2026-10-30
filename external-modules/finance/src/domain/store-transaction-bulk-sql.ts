import type { TransactionBulkStore } from "./transaction-bulk.js";
import type { FinanceDb } from "./store-sql.js";
import { TXN_COLUMNS, rowToTransaction, type TransactionRow } from "./store-transaction-rows.js";

// A change detector, not an authorization token. RLS still owns every selected row.
const revision = "md5(id || ':' || xmin::text)";
export function transactionBulkSqlStore(db: FinanceDb): TransactionBulkStore {
  return {
    async confirm(rows) {
      const result = await db.query<{ applied: boolean }>(
        `WITH requested AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, "writeRevision" text)
        ), reviewed AS MATERIALIZED (
          SELECT t.id,t.account_id,t.date,t.category_id FROM app.finance_transactions t
          JOIN requested r ON r.id=t.id
          WHERE md5(t.id || ':' || t.xmin::text)=r."writeRevision"
            AND t.review_state='needs_look' AND t.transfer_id IS NULL AND NOT t.pending AND t.splits='[]'::jsonb
            AND t.category_id IS NOT NULL
          ORDER BY t.id FOR UPDATE OF t
        ), categories AS MATERIALIZED (
          SELECT c.id FROM app.finance_categories c WHERE c.archived_at IS NULL
            AND c.id IN (SELECT category_id FROM reviewed) ORDER BY c.id FOR SHARE
        ), eligible AS (
          SELECT 1 WHERE (SELECT count(*) FROM requested) BETWEEN 1 AND 200
            AND (SELECT count(DISTINCT id) FROM requested)=(SELECT count(*) FROM requested)
            AND (SELECT count(*) FROM reviewed)=(SELECT count(*) FROM requested)
            AND (SELECT count(*) FROM reviewed WHERE category_id IN (SELECT id FROM categories))=(SELECT count(*) FROM requested)
        ), changed AS (
          UPDATE app.finance_transactions t SET review_state='confirmed',categorized_by='user'
          FROM reviewed r WHERE t.id=r.id AND EXISTS(SELECT 1 FROM eligible) RETURNING t.id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),now(),'user','transaction.confirm',
            jsonb_build_object('transactionId',r.id,'accountId',r.account_id,
              'month',to_char(r.date,'YYYY-MM'),'categoryId',r.category_id)
          FROM reviewed r JOIN changed c ON c.id=r.id RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM eligible) AS applied`,
        [JSON.stringify(rows)]
      );
      return result.rows[0]?.applied === true;
    },
    async monthRows(month) {
      const [year, index] = month.split("-").map(Number) as [number, number];
      const next =
        index === 12 ? `${year + 1}-01` : `${year}-${String(index + 1).padStart(2, "0")}`;
      const result = await db.query<TransactionRow & { write_revision: string }>(
        `SELECT ${TXN_COLUMNS}, ${revision} AS write_revision FROM app.finance_transactions WHERE date >= $1::date AND date < $2::date ORDER BY date DESC,id ASC`,
        [`${month}-01`, `${next}-01`]
      );
      return result.rows.map((row) => ({
        ...rowToTransaction(row),
        writeRevision: row.write_revision
      }));
    },
    async categorize(rows, categoryId) {
      const result = await db.query<{ applied: boolean }>(
        `WITH requested AS (
          SELECT * FROM jsonb_to_recordset($1::jsonb) AS r(id text, "writeRevision" text)
        ), reviewed AS MATERIALIZED (
          SELECT t.id,t.account_id,t.date,t.category_id FROM app.finance_transactions t
          JOIN requested r ON r.id=t.id
          WHERE md5(t.id || ':' || t.xmin::text)=r."writeRevision"
            AND t.transfer_id IS NULL AND NOT t.pending AND t.splits='[]'::jsonb
          ORDER BY t.id FOR UPDATE OF t
        ), destination AS MATERIALIZED (
          SELECT id FROM app.finance_categories WHERE id=$2 AND archived_at IS NULL AND id<>'transfers' FOR SHARE
        ), eligible AS (
          SELECT 1 WHERE (SELECT count(*) FROM requested) BETWEEN 1 AND 200
            AND (SELECT count(DISTINCT id) FROM requested)=(SELECT count(*) FROM requested)
            AND (SELECT count(*) FROM reviewed)=(SELECT count(*) FROM requested)
            AND EXISTS(SELECT 1 FROM destination)
        ), changed AS (
          UPDATE app.finance_transactions t SET category_id=$2,categorized_by='user',review_state='confirmed'
          FROM reviewed r WHERE t.id=r.id AND EXISTS(SELECT 1 FROM eligible) RETURNING t.id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),now(),'user','transaction.categorize',
            jsonb_build_object('transactionId',r.id,'accountId',r.account_id,'month',to_char(r.date,'YYYY-MM'),
              'categoryId',$2::text,'previousCategoryId',r.category_id)
          FROM reviewed r JOIN changed c ON c.id=r.id RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM eligible) AS applied`,
        [JSON.stringify(rows), categoryId]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
