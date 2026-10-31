import type { FinanceDb } from "./store-sql.js";
import type { BudgetPolicyStore } from "./budget-context.js";
import { DEFAULT_CATEGORIES, tableGroupFor, type Category } from "./taxonomy.js";
import { BUDGET_FINGERPRINT_SQL } from "./budget-review-sql.js";
import { safeCents } from "./values.js";

const legacyGroup: Record<string, string> = {
  Bills: "fixed",
  Everyday: "everyday",
  Fun: "personal",
  Savings: "savings-goals",
  Income: "income"
};
export function categoryPayload(categories: readonly Category[]) {
  return categories.map((c, index) => ({
    id: c.id,
    name: c.name,
    group_name: tableGroupFor(c.group),
    archived: c.archived,
    position: index,
    is_income: c.group === "income"
  }));
}
export function categoryUpsertSql(index: number, gate: string): string {
  return (
    "c AS (INSERT INTO app.finance_categories (owner_user_id, id, group_name, name, sort_order, is_income, archived_at) " +
    `SELECT app.current_actor_user_id(), x.id, x.group_name, x.name, (SELECT coalesce(max(sort_order), -1) + 1 FROM app.finance_categories) + x.position, x.is_income, CASE WHEN x.archived THEN now() ELSE NULL END FROM jsonb_to_recordset($${index}::jsonb) AS x(id text, name text, group_name text, archived boolean, position integer, is_income boolean) ` +
    `WHERE EXISTS (SELECT 1 FROM ${gate}) ON CONFLICT (owner_user_id, id) DO UPDATE SET name = EXCLUDED.name, group_name = EXCLUDED.group_name, is_income = EXCLUDED.is_income, archived_at = CASE WHEN EXCLUDED.archived_at IS NULL THEN NULL ELSE coalesce(finance_categories.archived_at, EXCLUDED.archived_at) END RETURNING id)`
  );
}
/** Keep historical rows, but do not revive stale SQL copies absent from the authoritative taxonomy. */
function archiveAbsentSql(index: number, gate: string): string {
  return `archived AS (UPDATE app.finance_categories SET archived_at = coalesce(archived_at, now()) WHERE EXISTS (SELECT 1 FROM ${gate}) AND id NOT IN (SELECT x.id FROM jsonb_to_recordset($${index}::jsonb) AS x(id text)) RETURNING id)`;
}
export function budgetSqlStore(db: FinanceDb): BudgetPolicyStore {
  return {
    async get() {
      const result = await db.query<{
        iso_currency: string;
        created_at: string;
        revision: string | number;
        fingerprint: string;
        taxonomy_ready: boolean;
      }>(
        "SELECT iso_currency, created_at::text AS created_at, revision, taxonomy_ready, " +
          BUDGET_FINGERPRINT_SQL +
          " AS fingerprint FROM app.finance_budget_policy"
      );
      const row = result.rows[0];
      return row
        ? {
            isoCurrency: row.iso_currency,
            createdAt: row.created_at,
            revision: safeCents(row.revision),
            fingerprint: row.fingerprint,
            taxonomyReady: row.taxonomy_ready
          }
        : null;
    },
    async categories() {
      const policy = await db.query<{ taxonomy_ready: boolean }>(
        "SELECT taxonomy_ready FROM app.finance_budget_policy"
      );
      if (!policy.rows[0]?.taxonomy_ready) return null;
      const result = await db.query<{
        id: string;
        group_name: string;
        name: string;
        archived: boolean;
      }>(
        "SELECT id, group_name, name, archived_at IS NOT NULL AS archived FROM app.finance_categories ORDER BY sort_order, id"
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        group: row.id === "transfers" ? "transfers" : (legacyGroup[row.group_name] ?? "everyday"),
        archived: row.archived
      }));
    },
    async initializeCategories(categories, _at) {
      const result = await db.query<{ applied: boolean }>(
        "WITH initialized AS (UPDATE app.finance_budget_policy SET taxonomy_ready = true, revision = revision + 1 WHERE NOT taxonomy_ready RETURNING owner_user_id), " +
          categoryUpsertSql(1, "initialized") +
          ", " +
          archiveAbsentSql(1, "initialized") +
          " SELECT EXISTS (SELECT 1 FROM initialized) AS applied",
        [JSON.stringify(categoryPayload(categories))]
      );
      return result.rows[0]?.applied === true;
    },
    async configure(isoCurrency, acknowledgeLegacy, at, categories = DEFAULT_CATEGORIES) {
      const result = await db.query<{ created: boolean }>(
        "WITH configured AS (INSERT INTO app.finance_budget_policy (owner_user_id, iso_currency, created_at, revision, taxonomy_ready) " +
          "SELECT app.current_actor_user_id(), $1, $3::timestamptz, 0, true " +
          "WHERE $2::boolean OR (NOT EXISTS (SELECT 1 FROM app.finance_budget_assignments) AND NOT EXISTS (SELECT 1 FROM app.finance_budget_drafts WHERE status = 'open')) " +
          "ON CONFLICT (owner_user_id) DO NOTHING RETURNING owner_user_id), " +
          categoryUpsertSql(4, "configured") +
          ", " +
          archiveAbsentSql(4, "configured") +
          ", " +
          "discarded AS (UPDATE app.finance_budget_drafts SET status = 'discarded' WHERE status = 'open' " +
          "AND EXISTS (SELECT 1 FROM configured) RETURNING id), " +
          "logged AS (INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params) " +
          "SELECT app.current_actor_user_id(), gen_random_uuid(), $3::timestamptz, 'user', 'budget.configure', " +
          "jsonb_build_object('isoCurrency', $1::text) FROM configured RETURNING id) " +
          "SELECT EXISTS (SELECT 1 FROM configured) AS created",
        [isoCurrency, acknowledgeLegacy, at, JSON.stringify(categoryPayload(categories))]
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
