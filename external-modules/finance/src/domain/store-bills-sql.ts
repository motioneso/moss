import type { BillCadence } from "./recurrence.js";
import type { BillStore } from "./bills.js";
import type { FinanceDb } from "./store-sql.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";
import { safeCents } from "./values.js";
const logged = (gate: string, kind: string, params: string, at: string) =>
  `logged AS (INSERT INTO app.finance_activity (owner_user_id,id,at,actor,kind,params) SELECT app.current_actor_user_id(),gen_random_uuid(),${at}::timestamptz,'user','${kind}',${params} FROM ${gate} RETURNING id)`;
export function billSqlStore(db: FinanceDb): BillStore {
  return {
    async plans() {
      const result = await db.query<{
        id: string;
        name: string;
        account_id: string;
        category_id: string;
        iso_currency: string;
        amount_cents: string;
        anchor_date: string;
        cadence: BillCadence;
        end_date: string | null;
      }>(
        "SELECT id,name,account_id,category_id,iso_currency,amount_cents,anchor_date::text AS anchor_date,cadence,end_date::text AS end_date FROM app.finance_bill_plans ORDER BY anchor_date,id"
      );
      return result.rows.map((r) => ({
        id: r.id,
        name: r.name,
        accountId: r.account_id,
        categoryId: r.category_id,
        isoCurrency: r.iso_currency,
        amountCents: safeCents(r.amount_cents),
        anchorDate: r.anchor_date,
        cadence: r.cadence,
        endDate: r.end_date
      }));
    },
    async decisions(from, to) {
      const result = await db.query<{
        plan_id: string;
        due_date: string;
        state: "skipped" | "matched";
        transaction_id: string | null;
        actual_cents: string | null;
        matched_valid: boolean;
      }>(
        "SELECT d.plan_id,d.due_date::text AS due_date,d.state,d.transaction_id,t.amount_cents AS actual_cents, coalesce(NOT t.pending AND t.amount_cents > 0 AND t.account_id=p.account_id AND t.iso_currency=p.iso_currency AND coalesce(t.category_id,'') NOT IN ('income','transfers'),false) AS matched_valid FROM app.finance_bill_occurrences d JOIN app.finance_bill_plans p ON p.owner_user_id=d.owner_user_id AND p.id=d.plan_id LEFT JOIN app.finance_transactions t ON t.owner_user_id=d.owner_user_id AND t.id=d.transaction_id WHERE d.due_date >= $1::date AND d.due_date <= $2::date ORDER BY d.due_date,d.plan_id",
        [from, to]
      );
      return result.rows.map((r) => ({
        planId: r.plan_id,
        dueDate: r.due_date,
        state: r.state,
        actualCents: r.actual_cents === null ? null : safeCents(r.actual_cents),
        matchedValid: r.matched_valid,
        transactionId: r.transaction_id
      }));
    },
    async create(p, e, at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH " +
          budgetEligibilitySql(
            10,
            "NOT EXISTS (SELECT 1 FROM app.finance_bill_plans WHERE id=$1::uuid) AND EXISTS (SELECT 1 FROM app.finance_accounts WHERE account_id=$3 AND iso_currency=$5) AND EXISTS (SELECT 1 FROM app.finance_categories WHERE id=$4 AND archived_at IS NULL AND NOT is_income AND id <> 'transfers') AND iso_currency=$5"
          ) +
          ", saved AS (INSERT INTO app.finance_bill_plans (owner_user_id,id,name,account_id,category_id,iso_currency,amount_cents,anchor_date,cadence,created_at) SELECT app.current_actor_user_id(),$1::uuid,$2,$3,$4,$5,$6,$7::date,$8,$9::timestamptz FROM eligible RETURNING id), " +
          logged("saved", "bill.create", "jsonb_build_object('planId',$1::text)", "$9") +
          " SELECT EXISTS (SELECT 1 FROM saved) AS applied",
        [
          p.id,
          p.name,
          p.accountId,
          p.categoryId,
          p.isoCurrency,
          p.amountCents,
          p.anchorDate,
          p.cadence,
          at,
          e.revision,
          e.fingerprint
        ]
      );
      return result.rows[0]?.applied === true;
    },
    async stop(id, end, e, at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH " +
          budgetEligibilitySql(
            4,
            "EXISTS (SELECT 1 FROM app.finance_bill_plans WHERE id=$1::uuid AND end_date IS NULL) AND NOT EXISTS (SELECT 1 FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date > $2::date)"
          ) +
          ", saved AS (UPDATE app.finance_bill_plans SET end_date=$2::date WHERE id=$1::uuid AND EXISTS (SELECT 1 FROM eligible) RETURNING id), " +
          logged(
            "saved",
            "bill.stop",
            "jsonb_build_object('planId',$1::text,'endDate',$2::text)",
            "$3"
          ) +
          " SELECT EXISTS (SELECT 1 FROM saved) AS applied",
        [id, end, at, e.revision, e.fingerprint]
      );
      return result.rows[0]?.applied === true;
    },
    async clear(planId, dueDate, e, at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH " +
          budgetEligibilitySql(
            4,
            "EXISTS (SELECT 1 FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date=$2::date)"
          ) +
          ", saved AS (DELETE FROM app.finance_bill_occurrences WHERE plan_id=$1::uuid AND due_date=$2::date AND EXISTS (SELECT 1 FROM eligible) RETURNING plan_id), " +
          logged(
            "saved",
            "bill.clear",
            "jsonb_build_object('planId',$1::text,'dueDate',$2::text)",
            "$3"
          ) +
          " SELECT EXISTS (SELECT 1 FROM saved) AS applied",
        [planId, dueDate, at, e.revision, e.fingerprint]
      );
      return result.rows[0]?.applied === true;
    },
    async decide(d, e, at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH " +
          budgetEligibilitySql(
            6,
            "EXISTS (SELECT 1 FROM app.finance_bill_plans p WHERE p.id=$1::uuid AND ($3='skipped' OR EXISTS (SELECT 1 FROM app.finance_transactions t WHERE t.id=$4 AND t.account_id=p.account_id AND t.iso_currency=p.iso_currency AND NOT t.pending AND t.amount_cents > 0 AND coalesce(t.category_id,'') NOT IN ('income','transfers')))) AND NOT EXISTS (SELECT 1 FROM app.finance_bill_occurrences WHERE (plan_id=$1::uuid AND due_date=$2::date) OR transaction_id=$4)"
          ) +
          ", saved AS (INSERT INTO app.finance_bill_occurrences (owner_user_id,plan_id,due_date,state,transaction_id,updated_at) SELECT app.current_actor_user_id(),$1::uuid,$2::date,$3,$4,$5::timestamptz FROM eligible RETURNING plan_id), " +
          logged(
            "saved",
            "bill.decide",
            "jsonb_build_object('planId',$1::text,'dueDate',$2::text,'state',$3::text)",
            "$5"
          ) +
          " SELECT EXISTS (SELECT 1 FROM saved) AS applied",
        [d.planId, d.dueDate, d.state, d.transactionId, at, e.revision, e.fingerprint]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
