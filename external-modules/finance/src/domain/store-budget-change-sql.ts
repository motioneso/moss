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
  let flexIndex = 0;
  if (change.flexPolicy) {
    params.push(
      change.flexPolicy.month,
      change.flexPolicy.active,
      JSON.stringify(change.flexPolicy.flexIds),
      JSON.stringify(change.flexPolicy.nonMonthlyIds)
    );
    flexIndex = params.length - 3;
  }
  let cardIndex = 0;
  if (change.cardAssignment) {
    cardIndex = params.length + 1;
    params.push(change.cardAssignment.accountId, change.cardAssignment.assignedCents);
    if (change.cardPolicy) params.push(change.cardPolicy.effectiveMonth);
    guards.push(`EXISTS (SELECT 1 FROM app.finance_accounts WHERE account_id=$${cardIndex}
      AND source='manual' AND type='credit' AND iso_currency=(SELECT iso_currency FROM app.finance_budget_policy))`);
    guards.push(
      change.cardPolicy
        ? `NOT EXISTS (SELECT 1 FROM app.finance_card_policies WHERE account_id=$${cardIndex})`
        : `EXISTS (SELECT 1 FROM app.finance_card_policies WHERE account_id=$${cardIndex} AND effective_month<=$1)`
    );
    if (
      change.cardAssignment.month !== change.month ||
      (change.cardPolicy &&
        (change.cardPolicy.accountId !== change.cardAssignment.accountId ||
          change.cardPolicy.effectiveMonth !== change.month))
    )
      throw new Error("Card reservation must use its reviewed account and month");
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
      (flexIndex
        ? `, f AS (INSERT INTO app.finance_flex_policies (owner_user_id,month,active,flex_ids,non_monthly_ids,updated_at) SELECT app.current_actor_user_id(),$${flexIndex},$${flexIndex + 1},$${flexIndex + 2}::jsonb,$${flexIndex + 3}::jsonb,now() FROM eligible ON CONFLICT (owner_user_id,month) DO UPDATE SET active=EXCLUDED.active,flex_ids=EXCLUDED.flex_ids,non_monthly_ids=EXCLUDED.non_monthly_ids,updated_at=EXCLUDED.updated_at RETURNING month)`
        : "") +
      (cardIndex
        ? (change.cardPolicy
            ? `, cp AS (INSERT INTO app.finance_card_policies(owner_user_id,account_id,effective_month)
          SELECT app.current_actor_user_id(),$${cardIndex},$${cardIndex + 2} FROM eligible RETURNING account_id)`
            : "") +
          `, ca AS (INSERT INTO app.finance_card_assignments(owner_user_id,account_id,month,assigned_cents)
          SELECT app.current_actor_user_id(),$${cardIndex},$1,$${cardIndex + 1}::bigint FROM eligible
          ON CONFLICT(owner_user_id,account_id,month) DO UPDATE SET assigned_cents=EXCLUDED.assigned_cents RETURNING account_id)`
        : "") +
      " SELECT EXISTS (SELECT 1 FROM eligible) AS applied",
    params
  );
  return result.rows[0]?.applied === true;
}
