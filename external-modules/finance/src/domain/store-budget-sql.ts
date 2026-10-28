import type { FinanceDb } from "./store-sql.js";
import type { BudgetPolicyStore } from "./budget-context.js";
import { safeCents } from "./values.js";

export function budgetSqlStore(db: FinanceDb): BudgetPolicyStore {
  return {
    async get() {
      const result = await db.query<{
        iso_currency: string;
        created_at: string;
        revision: string | number;
      }>(
        "SELECT iso_currency, created_at::text AS created_at, revision FROM app.finance_budget_policy"
      );
      const row = result.rows[0];
      return row
        ? {
            isoCurrency: row.iso_currency,
            createdAt: row.created_at,
            revision: safeCents(row.revision)
          }
        : null;
    },
    async configure(isoCurrency, acknowledgeLegacy, at) {
      const result = await db.query<{ created: boolean }>(
        "WITH configured AS (INSERT INTO app.finance_budget_policy (owner_user_id, iso_currency, created_at, revision) " +
          "SELECT app.current_actor_user_id(), $1, $3::timestamptz, 0 " +
          "WHERE $2::boolean OR (NOT EXISTS (SELECT 1 FROM app.finance_budget_assignments) AND NOT EXISTS (SELECT 1 FROM app.finance_budget_drafts WHERE status = 'open')) " +
          "ON CONFLICT (owner_user_id) DO NOTHING RETURNING owner_user_id), " +
          "discarded AS (UPDATE app.finance_budget_drafts SET status = 'discarded' WHERE status = 'open' " +
          "AND EXISTS (SELECT 1 FROM configured) RETURNING id), " +
          "logged AS (INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params) " +
          "SELECT app.current_actor_user_id(), gen_random_uuid(), $3::timestamptz, 'user', 'budget.configure', " +
          "jsonb_build_object('isoCurrency', $1::text) FROM configured RETURNING id) " +
          "SELECT EXISTS (SELECT 1 FROM configured) AS created",
        [isoCurrency, acknowledgeLegacy, at]
      );
      if (result.rows[0]?.created) return "created";
      const policy = await this.get();
      return policy
        ? policy.isoCurrency === isoCurrency
          ? "unchanged"
          : "conflict"
        : "legacy_review_required";
    }
  };
}
