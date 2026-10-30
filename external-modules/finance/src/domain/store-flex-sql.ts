import type { FlexStore } from "./flex.js";
import type { FinanceDb } from "./store-sql.js";
export function flexSqlStore(db: FinanceDb): FlexStore {
  return {
    async policies() {
      const result = await db.query<{
        month: string;
        active: boolean;
        flex_ids: string[];
        non_monthly_ids: string[];
      }>(
        "SELECT month,active,flex_ids,non_monthly_ids FROM app.finance_flex_policies ORDER BY month"
      );
      return result.rows.map((r) => ({
        month: r.month,
        active: r.active,
        flexIds: r.flex_ids,
        nonMonthlyIds: r.non_monthly_ids
      }));
    }
  };
}
