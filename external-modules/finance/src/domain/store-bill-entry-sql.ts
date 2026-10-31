import type { BillEntryStore } from "./bill-entry.js";
import type { FinanceDb } from "./store-sql.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";
import { BILL_MEMBERSHIP_SQL } from "./bill-occurrence-sql.js";
export function billEntrySqlStore(db: FinanceDb): BillEntryStore {
  return {
    async entryReplay(id, digest, planId, dueDate) {
      const result = await db.query<{ exact: boolean }>(
        `SELECT (t.source='manual' AND t.entry_digest=$2 AND NOT t.pending AND t.amount_cents>0
          AND coalesce(t.category_id,'') NOT IN ('income','transfers') AND EXISTS(
          SELECT 1 FROM app.finance_bill_occurrences o JOIN app.finance_bill_plans p ON p.id=o.plan_id
          WHERE p.account_id=t.account_id AND p.iso_currency=t.iso_currency AND o.plan_id=$3::uuid
          AND o.due_date=$4::date AND o.state='matched' AND o.transaction_id=t.id)) AS exact
         FROM app.finance_transactions t WHERE t.id=$1`,
        [id, digest, planId, dueDate]
      );
      return result.rows.length ? (result.rows[0]!.exact ? "unchanged" : "conflict") : null;
    },
    async recordEntry(e) {
      const result = await db.query<{ applied: boolean }>(
        `WITH locked AS MATERIALIZED (
          SELECT * FROM app.finance_accounts WHERE account_id=$4 AND source='manual' FOR UPDATE
        ), ` +
          budgetEligibilitySql(
            14,
            `
          iso_currency=$8 AND $7::numeric BETWEEN 1 AND 9007199254740991
          AND $5::date<=$12::date
          AND EXISTS(SELECT 1 FROM locked a WHERE a.archived_at IS NULL AND a.iso_currency=$8
            AND $5::date>=a.opening_date AND (a.last_reconciled_date IS NULL OR $5::date>a.last_reconciled_date)
            AND a.ledger_revision<9007199254740991
            AND a.balance_cents::numeric+(CASE WHEN a.type IN ('credit','loan') THEN 1 ELSE -1 END)*$7::numeric
              BETWEEN -9007199254740991 AND 9007199254740991)
          AND EXISTS(SELECT 1 FROM app.finance_bill_plans p WHERE p.id=$1::uuid
            AND p.account_id=$4 AND p.name=$6 AND p.iso_currency=$8 AND p.category_id=$9
            AND ${BILL_MEMBERSHIP_SQL}
            AND coalesce((SELECT planned_date FROM app.finance_bill_adjustments
              WHERE plan_id=p.id AND due_date=$2::date),$2::date)<=$12::date)
          AND EXISTS(SELECT 1 FROM app.finance_categories WHERE id=$9 AND archived_at IS NULL
            AND NOT is_income AND id<>'transfers')
          AND NOT EXISTS(SELECT 1 FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date=$2::date)
          AND NOT EXISTS(SELECT 1 FROM app.finance_transactions WHERE id=$3)
          AND NOT EXISTS(SELECT 1 FROM app.finance_transactions WHERE account_id=$4 AND iso_currency=$8
            AND NOT pending AND amount_cents=$7::bigint AND date BETWEEN $5::date-7 AND $5::date+7
            AND coalesce(category_id,'') NOT IN ('income','transfers'))
        `
          ) +
          `,
        inserted AS (
          INSERT INTO app.finance_transactions(owner_user_id,id,account_id,date,name,amount_cents,iso_currency,
            category_id,notes,pending,categorized_by,review_state,source,entry_digest,cleared)
          SELECT app.current_actor_user_id(),$3,$4,$5::date,$6,$7::bigint,$8,$9,NULL,false,'user','confirmed',
            'manual',$11,$10::boolean FROM eligible RETURNING id,account_id,amount_cents
        ), balanced AS (
          UPDATE app.finance_accounts a SET balance_cents=a.balance_cents+
            (CASE WHEN a.type IN ('credit','loan') THEN 1 ELSE -1 END)*t.amount_cents,
            ledger_revision=a.ledger_revision+1,updated_at=$13::timestamptz
          FROM inserted t WHERE a.account_id=t.account_id RETURNING a.account_id
        ), matched AS (
          INSERT INTO app.finance_bill_occurrences(owner_user_id,plan_id,due_date,state,transaction_id,updated_at)
          SELECT app.current_actor_user_id(),$1::uuid,$2::date,'matched',t.id,$13::timestamptz
          FROM inserted t JOIN balanced b ON b.account_id=t.account_id RETURNING transaction_id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$13::timestamptz,'user','bill.record-entry',
            jsonb_build_object('planId',$1::text,'dueDate',$2::text,'transactionId',transaction_id,
              'accountId',$4::text,'amountCents',$7::bigint) FROM matched RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM matched) AS applied`,
        [
          e.planId,
          e.dueDate,
          e.id,
          e.accountId,
          e.date,
          e.name,
          e.amountCents,
          e.isoCurrency,
          e.categoryId,
          e.cleared,
          e.digest,
          e.today,
          e.at,
          e.review.revision,
          e.review.fingerprint
        ]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
