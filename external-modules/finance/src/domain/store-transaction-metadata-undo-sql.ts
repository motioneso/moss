import type { FinanceDb } from "./store-sql.js";
import type { TransactionMetadataStore } from "./transaction-metadata.js";

/** Restore category metadata, reversal activity and the original undone mark together. */
export function transactionMetadataUndoSql(db: FinanceDb): TransactionMetadataStore["undo"] {
  return async (activityId, writeRevision, at) => {
    const result = await db.query<{ applied: boolean }>(
      `WITH original AS MATERIALIZED (
        SELECT id,params,undo FROM app.finance_activity WHERE id=$1::uuid
          AND kind='transaction.categorize' AND undone_at IS NULL
          AND undo IS NOT NULL AND undo ? 'categoryId' FOR UPDATE
      ), reviewed AS MATERIALIZED (
        SELECT t.id,t.account_id,t.date,t.category_id FROM app.finance_transactions t
        JOIN original a ON t.id=a.params->>'transactionId'
          AND t.account_id=a.params->>'accountId' AND to_char(t.date,'YYYY-MM')=a.params->>'month'
        WHERE md5(t.id||':'||t.xmin::text)=$2 AND t.transfer_id IS NULL AND t.splits='[]'::jsonb
          AND t.category_id IS NOT DISTINCT FROM (a.params->>'categoryId')
        FOR UPDATE OF t
      ), destination AS MATERIALIZED (
        SELECT c.id FROM app.finance_categories c JOIN original a ON c.id=a.undo->>'categoryId'
        WHERE c.archived_at IS NULL FOR SHARE OF c
      ), eligible AS (
        SELECT 1 FROM original a WHERE (SELECT count(*) FROM reviewed)=1
          AND (a.undo->>'categoryId' IS NULL OR EXISTS(SELECT 1 FROM destination))
      ), changed AS (
        UPDATE app.finance_transactions t SET category_id=a.undo->>'categoryId',
          categorized_by=CASE WHEN a.undo->>'categoryId' IS NULL THEN NULL ELSE 'user' END,
          review_state=CASE WHEN a.undo->>'categoryId' IS NULL THEN 'needs_look' ELSE 'confirmed' END
        FROM reviewed r,original a WHERE t.id=r.id AND EXISTS(SELECT 1 FROM eligible) RETURNING t.id
      ), logged AS (
        INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
        SELECT app.current_actor_user_id(),gen_random_uuid(),$3::timestamptz,'user','transaction.categorize',
          jsonb_build_object('transactionId',r.id,'accountId',r.account_id,'month',to_char(r.date,'YYYY-MM'),
            'categoryId',a.undo->>'categoryId','previousCategoryId',r.category_id)
        FROM reviewed r JOIN changed c ON c.id=r.id CROSS JOIN original a RETURNING id
      ), marked AS (
        UPDATE app.finance_activity a SET undone_at=$3::timestamptz FROM original o
        WHERE a.id=o.id AND EXISTS(SELECT 1 FROM logged) RETURNING a.id
      ) SELECT EXISTS(SELECT 1 FROM marked) AS applied`,
      [activityId, writeRevision, at]
    );
    return result.rows[0]?.applied === true;
  };
}
