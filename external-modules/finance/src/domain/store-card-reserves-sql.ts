import type { CardReserveStore } from "./card-reserve-store.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
export function cardReserveSqlStore(db: FinanceDb): CardReserveStore {
  return {
    async policies() {
      const result = await db.query<{ account_id: string; effective_month: string }>(
        "SELECT account_id,effective_month FROM app.finance_card_policies ORDER BY account_id"
      );
      return result.rows.map((r) => ({
        accountId: r.account_id,
        effectiveMonth: r.effective_month
      }));
    },
    async assignments() {
      const result = await db.query<{ account_id: string; month: string; assigned_cents: string }>(
        "SELECT account_id,month,assigned_cents::text FROM app.finance_card_assignments ORDER BY month,account_id"
      );
      return result.rows.map((r) => ({
        accountId: r.account_id,
        month: r.month,
        assignedCents: safeCents(r.assigned_cents)
      }));
    }
  };
}
