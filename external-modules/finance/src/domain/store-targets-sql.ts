import type { TargetStore } from "./targets.js";
import type { FinanceDb } from "./store-sql.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";
import { safeCents } from "./values.js";

export function targetSqlStore(db: FinanceDb): TargetStore {
  return {
    async versions() {
      const result = await db.query<{
        category_id: string;
        effective_month: string;
        kind: "monthly" | "weekly" | "balance" | "removed";
        amount_cents: string;
        due_date: string | null;
        weekday: number | null;
      }>(
        "SELECT category_id,effective_month,kind,amount_cents,due_date::text AS due_date,weekday FROM app.finance_targets ORDER BY effective_month,category_id"
      );
      return result.rows.map((r) => ({
        categoryId: r.category_id,
        effectiveMonth: r.effective_month,
        kind: r.kind,
        amountCents: safeCents(r.amount_cents),
        dueDate: r.due_date,
        ...(typeof r.weekday === "number" ? { weekday: r.weekday } : {})
      }));
    },
    async forMonth(month) {
      const result = await db.query<{
        category_id: string;
        effective_month: string;
        kind: "monthly" | "weekly" | "balance" | "removed";
        amount_cents: string;
        due_date: string | null;
        weekday: number | null;
      }>(
        "SELECT DISTINCT ON (category_id) category_id, effective_month, kind, amount_cents, due_date::text AS due_date,weekday FROM app.finance_targets WHERE effective_month <= $1 ORDER BY category_id, effective_month DESC",
        [month]
      );
      return result.rows
        .filter((r) => r.kind !== "removed")
        .map((r) => ({
          categoryId: r.category_id,
          effectiveMonth: r.effective_month,
          kind: r.kind,
          amountCents: safeCents(r.amount_cents),
          dueDate: r.due_date,
          ...(typeof r.weekday === "number" ? { weekday: r.weekday } : {})
        }));
    },
    async save(target, expected, at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH " +
          budgetEligibilitySql(
            7,
            "EXISTS (SELECT 1 FROM app.finance_categories WHERE id = $1 AND (archived_at IS NULL OR $3 = 'removed') AND NOT is_income AND id <> 'transfers')"
          ) +
          ", t AS (INSERT INTO app.finance_targets (owner_user_id, category_id, effective_month, kind, amount_cents, due_date, updated_at, weekday) SELECT app.current_actor_user_id(), $1, $2, $3, $4, $5::date, $6::timestamptz, $9::smallint FROM eligible ON CONFLICT (owner_user_id, category_id, effective_month) DO UPDATE SET kind = EXCLUDED.kind, amount_cents = EXCLUDED.amount_cents, due_date = EXCLUDED.due_date, weekday = EXCLUDED.weekday, updated_at = EXCLUDED.updated_at RETURNING category_id), " +
          "a AS (INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params) SELECT app.current_actor_user_id(), gen_random_uuid(), $6::timestamptz, 'user', 'target.set', jsonb_build_object('categoryId', $1::text, 'month', $2::text, 'kind', $3::text, 'amountCents', $4::bigint, 'weekday', $9::int) FROM t RETURNING id) SELECT EXISTS (SELECT 1 FROM t) AS applied",
        [
          target.categoryId,
          target.effectiveMonth,
          target.kind,
          target.amountCents,
          target.dueDate,
          at,
          expected.revision,
          expected.fingerprint,
          target.weekday ?? null
        ]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
