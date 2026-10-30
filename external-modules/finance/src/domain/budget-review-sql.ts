/** An opaque change detector, not an authorization token. RLS owns every input row. */
export const BUDGET_FINGERPRINT_SQL =
  "md5(jsonb_build_array(" +
  [
    ["finance_accounts", "account_id"],
    ["finance_transactions", "id"],
    ["finance_balance_snapshots", "jsonb_build_array(account_id, day)"],
    ["finance_budget_assignments", "jsonb_build_array(month, category_id)"],
    ["finance_budget_drafts", "id"],
    ["finance_budget_draft_lines", "jsonb_build_array(draft_id, category_key)"],
    ["finance_categories", "id"],
    ["finance_targets", "jsonb_build_array(category_id, effective_month)"],
    ["finance_bill_plans", "id"],
    ["finance_bill_occurrences", "jsonb_build_array(plan_id, due_date)"]
  ]
    .map(
      ([table, key]) =>
        `(SELECT coalesce(jsonb_agg(jsonb_build_array(${key}, xmin::text) ORDER BY ${key}), '[]'::jsonb) FROM app.${table})`
    )
    .join(", ") +
  ")::text)";

/** All dependent writes must select from this one successful revision update. */
export function budgetEligibilitySql(index: number, extra = "true"): string {
  return (
    "eligible AS (UPDATE app.finance_budget_policy SET revision = revision + 1 " +
    `WHERE revision = $${index}::bigint AND revision < 9007199254740991 AND taxonomy_ready ` +
    `AND ${BUDGET_FINGERPRINT_SQL} = $${index + 1}::text AND (${extra}) RETURNING owner_user_id)`
  );
}
