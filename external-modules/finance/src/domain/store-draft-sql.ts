import type { FinanceDb } from "./store-sql.js";
import type { BudgetReview } from "./budget-context.js";
import type { DraftBuild, DraftLine } from "./draft.js";
import { budgetEligibilitySql } from "./budget-review-sql.js";

export async function createBudgetDraftSql(
  db: FinanceDb,
  build: DraftBuild,
  at: string,
  expected: BudgetReview
): Promise<string | null> {
  const result = await db.query<{ id: string }>(
    "WITH " +
      budgetEligibilitySql(
        6,
        "NOT EXISTS (SELECT 1 FROM app.finance_budget_drafts WHERE status IN ('open', 'started')) AND NOT EXISTS (SELECT 1 FROM app.finance_budget_assignments)"
      ) +
      ", d AS (INSERT INTO app.finance_budget_drafts (owner_user_id, id, status, basis_from, basis_to, monthly_income_cents, created_at) " +
      "SELECT app.current_actor_user_id(), gen_random_uuid(), 'open', $1::date, $2::date, $3::bigint, $4::timestamptz FROM eligible RETURNING id), " +
      "l AS (INSERT INTO app.finance_budget_draft_lines (owner_user_id, draft_id, category_key, group_name, category_name, basis_monthly_cents, proposed_cents) " +
      "SELECT app.current_actor_user_id(), d.id, x.category_key, x.group_name, x.category_name, x.basis_monthly_cents, x.proposed_cents FROM d CROSS JOIN jsonb_to_recordset($5::jsonb) AS x(category_key text, group_name text, category_name text, basis_monthly_cents bigint, proposed_cents bigint) RETURNING draft_id) SELECT id FROM d",
    [
      build.basisFrom,
      build.basisTo,
      build.monthlyIncomeCents,
      at,
      JSON.stringify(
        build.lines.map((l) => ({
          category_key: l.categoryKey,
          group_name: l.groupName,
          category_name: l.categoryName,
          basis_monthly_cents: l.basisMonthlyCents,
          proposed_cents: l.proposedCents
        }))
      ),
      expected.revision,
      expected.fingerprint
    ]
  );
  return result.rows[0]?.id ?? null;
}

export async function saveBudgetDraftLineSql(
  db: FinanceDb,
  draftId: string,
  line: DraftLine,
  expected: BudgetReview
): Promise<boolean> {
  const result = await db.query<{ applied: boolean }>(
    "WITH " +
      budgetEligibilitySql(
        10,
        "EXISTS (SELECT 1 FROM app.finance_budget_drafts WHERE id = $1 AND status = 'open')"
      ) +
      ", l AS (INSERT INTO app.finance_budget_draft_lines (owner_user_id, draft_id, category_key, group_name, category_name, basis_monthly_cents, proposed_cents, adjusted_cents, adjusted_by, dropped) " +
      "SELECT app.current_actor_user_id(), $1, $2, $3, $4, $5, $6, $7, $8, $9 FROM eligible " +
      "ON CONFLICT (owner_user_id, draft_id, category_key) DO UPDATE SET group_name = EXCLUDED.group_name, category_name = EXCLUDED.category_name, adjusted_cents = EXCLUDED.adjusted_cents, adjusted_by = EXCLUDED.adjusted_by, dropped = EXCLUDED.dropped RETURNING category_key) SELECT EXISTS (SELECT 1 FROM l) AS applied",
    [
      draftId,
      line.categoryKey,
      line.groupName,
      line.categoryName,
      line.basisMonthlyCents,
      line.proposedCents,
      line.adjustedCents,
      line.adjustedBy,
      line.dropped,
      expected.revision,
      expected.fingerprint
    ]
  );
  return result.rows[0]?.applied === true;
}
