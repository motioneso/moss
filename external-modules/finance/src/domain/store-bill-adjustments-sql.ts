import type { BillAdjustmentStore } from "./bill-adjustments.js";
import type { FinanceDb } from "./store-sql.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";
import { safeCents } from "./values.js";
// $2 is the stable original date. Mirror recurrence's anchored month-end/leap-year clamp.
const membership = `p.anchor_date <= $2::date AND (p.end_date IS NULL OR p.end_date >= $2::date) AND (
  (p.cadence='once' AND p.anchor_date=$2::date) OR
  (p.cadence='weekly' AND (($2::date-p.anchor_date)%7)=0) OR
  (p.cadence='fortnightly' AND (($2::date-p.anchor_date)%14)=0) OR
  (p.cadence IN ('monthly','yearly') AND (p.cadence='monthly' OR extract(month FROM p.anchor_date)=extract(month FROM $2::date))
    AND $2::date=make_date(extract(year FROM $2::date)::integer,extract(month FROM $2::date)::integer,
      least(extract(day FROM p.anchor_date)::integer,extract(day FROM (date_trunc('month',$2::date)+interval '1 month -1 day'))::integer)))
)`;
const account = `account AS MATERIALIZED (
  SELECT a.account_id,a.iso_currency FROM app.finance_accounts a JOIN app.finance_bill_plans p ON p.account_id=a.account_id
    WHERE p.id=$1::uuid AND a.archived_at IS NULL AND a.iso_currency=p.iso_currency ORDER BY a.account_id FOR UPDATE OF a
)`;
export function billAdjustmentSqlStore(db: FinanceDb): BillAdjustmentStore {
  return {
    async rows(from, to) {
      const result = await db.query<{
        plan_id: string;
        due_date: string;
        planned_date: string;
        amount_cents: string;
      }>(
        `SELECT plan_id,due_date::text,planned_date::text,amount_cents FROM app.finance_bill_adjustments
         WHERE due_date BETWEEN $1::date AND $2::date OR planned_date BETWEEN $1::date AND $2::date
         ORDER BY planned_date,plan_id,due_date`,
        [from, to]
      );
      return result.rows.map((r) => ({
        planId: r.plan_id,
        dueDate: r.due_date,
        plannedDate: r.planned_date,
        amountCents: safeCents(r.amount_cents)
      }));
    },
    async claimedTransactionIds(ids) {
      if (!ids.length) return [];
      const result = await db.query<{ ids: string[] }>(
        `SELECT coalesce(jsonb_agg(transaction_id),'[]'::jsonb) AS ids FROM app.finance_bill_occurrences
         WHERE transaction_id IN (SELECT jsonb_array_elements_text($1::jsonb))`,
        [JSON.stringify(ids)]
      );
      return result.rows[0]?.ids ?? [];
    },
    async save(c, e, at) {
      const result = await db.query<{ applied: boolean }>(
        `WITH ${account}, ` +
          budgetEligibilitySql(
            6,
            `EXISTS(SELECT 1 FROM account a WHERE a.iso_currency=app.finance_budget_policy.iso_currency)
          AND EXISTS(SELECT 1 FROM app.finance_bill_plans p WHERE p.id=$1::uuid AND ${membership})
          AND NOT EXISTS(SELECT 1 FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date=$2::date)`
          ) +
          `,
        saved AS (
          INSERT INTO app.finance_bill_adjustments(owner_user_id,plan_id,due_date,planned_date,amount_cents,updated_at)
          SELECT app.current_actor_user_id(),$1::uuid,$2::date,$3::date,$4::bigint,$5::timestamptz FROM eligible
          ON CONFLICT(owner_user_id,plan_id,due_date) DO UPDATE SET planned_date=excluded.planned_date,amount_cents=excluded.amount_cents,updated_at=excluded.updated_at
          RETURNING plan_id
        ), touched AS (
          UPDATE app.finance_accounts SET ledger_revision=ledger_revision WHERE source='manual'
            AND account_id IN(SELECT account_id FROM account) AND EXISTS(SELECT 1 FROM saved) RETURNING account_id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$5::timestamptz,'user','bill.adjust',
            jsonb_build_object('planId',$1::text,'dueDate',$2::text,'plannedDate',$3::text,'amountCents',$4::bigint) FROM saved RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM saved) AS applied`,
        [c.planId, c.dueDate, c.plannedDate, c.amountCents, at, e.revision, e.fingerprint]
      );
      return result.rows[0]?.applied === true;
    },
    async reset(planId, dueDate, e, at) {
      const result = await db.query<{ applied: boolean }>(
        `WITH ${account}, ` +
          budgetEligibilitySql(
            4,
            `EXISTS(SELECT 1 FROM account a WHERE a.iso_currency=app.finance_budget_policy.iso_currency)
          AND EXISTS(SELECT 1 FROM app.finance_bill_adjustments WHERE plan_id=$1::uuid AND due_date=$2::date)
          AND NOT EXISTS(SELECT 1 FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date=$2::date)`
          ) +
          `,
        saved AS (DELETE FROM app.finance_bill_adjustments WHERE plan_id=$1::uuid AND due_date=$2::date
          AND EXISTS(SELECT 1 FROM eligible) RETURNING plan_id), touched AS (
          UPDATE app.finance_accounts SET ledger_revision=ledger_revision WHERE source='manual'
            AND account_id IN(SELECT account_id FROM account) AND EXISTS(SELECT 1 FROM saved) RETURNING account_id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$3::timestamptz,'user','bill.adjust-reset',
            jsonb_build_object('planId',$1::text,'dueDate',$2::text) FROM saved RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM saved) AS applied`,
        [planId, dueDate, at, e.revision, e.fingerprint]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
