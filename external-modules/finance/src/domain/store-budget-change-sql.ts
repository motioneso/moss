import type { FinanceDb } from "./store-sql.js";
import type { BudgetChange } from "./store-port.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";
import { categoryPayload, categoryUpsertSql } from "./store-budget-sql.js";

export async function commitBudgetSql(db: FinanceDb, change: BudgetChange): Promise<boolean> {
  const params: unknown[] = [
    change.month,
    JSON.stringify(
      change.assignments.map((a) => ({ category_id: a.categoryId, assigned_cents: a.amountCents }))
    ),
    JSON.stringify(change.activity.map((a) => ({ ...a, undo: a.undo ?? null }))),
    change.expected.revision,
    change.expected.fingerprint,
    JSON.stringify(categoryPayload(change.categories ?? []))
  ];
  const guards: string[] = [];
  let draftIndex = 0;
  let undoneIndex = 0;
  if (change.startDraft) {
    params.push(change.startDraft.draftId, change.startDraft.at);
    draftIndex = params.length - 1;
    guards.push(
      `EXISTS (SELECT 1 FROM app.finance_budget_drafts WHERE id = $${draftIndex} AND status = 'open')`
    );
  }
  if (change.markUndone) {
    params.push(change.markUndone.activityId, change.markUndone.at);
    undoneIndex = params.length - 1;
    guards.push(
      `EXISTS (SELECT 1 FROM app.finance_activity WHERE id = $${undoneIndex} AND undone_at IS NULL)`
    );
  }
  const result = await db.query<{ applied: boolean }>(
    "WITH " +
      budgetEligibilitySql(4, guards.length ? guards.join(" AND ") : "true") +
      ", a AS (INSERT INTO app.finance_budget_assignments (owner_user_id, month, category_id, assigned_cents) " +
      "SELECT app.current_actor_user_id(), $1, x.category_id, x.assigned_cents " +
      "FROM jsonb_to_recordset($2::jsonb) AS x(category_id text, assigned_cents bigint) " +
      "WHERE EXISTS (SELECT 1 FROM eligible) " +
      "ON CONFLICT (owner_user_id, month, category_id) DO UPDATE SET assigned_cents = EXCLUDED.assigned_cents RETURNING 1), " +
      "l AS (INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params, undo) " +
      "SELECT app.current_actor_user_id(), gen_random_uuid(), now(), x.actor, x.kind, x.params, x.undo " +
      "FROM jsonb_to_recordset($3::jsonb) AS x(actor text, kind text, params jsonb, undo jsonb) " +
      "WHERE EXISTS (SELECT 1 FROM eligible) RETURNING 1), " +
      categoryUpsertSql(6, "eligible") +
      (draftIndex
        ? `, d AS (UPDATE app.finance_budget_drafts SET status = 'started', started_at = $${draftIndex + 1}::timestamptz WHERE id = $${draftIndex} AND EXISTS (SELECT 1 FROM eligible) RETURNING 1)`
        : "") +
      (undoneIndex
        ? `, u AS (UPDATE app.finance_activity SET undone_at = $${undoneIndex + 1}::timestamptz WHERE id = $${undoneIndex} AND EXISTS (SELECT 1 FROM eligible) RETURNING 1)`
        : "") +
      " SELECT EXISTS (SELECT 1 FROM eligible) AS applied",
    params
  );
  return result.rows[0]?.applied === true;
}
