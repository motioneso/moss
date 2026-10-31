import type { BillSuggestionStore, SuggestedCadence } from "./bill-suggestions.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
export function billSuggestionSqlStore(db: FinanceDb): BillSuggestionStore {
  return {
    async dismissals() {
      const result = await db.query<{
        account_id: string;
        payee_key: string;
        cadence: SuggestedCadence;
        amount_cents: string;
      }>(
        `SELECT account_id,payee_key,cadence,amount_cents FROM app.finance_bill_suggestion_dismissals
         ORDER BY account_id,payee_key,cadence,amount_cents`
      );
      return result.rows.map((r) => ({
        accountId: r.account_id,
        payeeKey: r.payee_key,
        cadence: r.cadence,
        amountCents: safeCents(r.amount_cents)
      }));
    },
    async dismiss(d, at) {
      const result = await db.query<{ applied: boolean }>(
        `WITH account AS (
          SELECT account_id FROM app.finance_accounts WHERE account_id=$1
        ), saved AS (
          INSERT INTO app.finance_bill_suggestion_dismissals(owner_user_id,account_id,payee_key,cadence,amount_cents,dismissed_at)
          SELECT app.current_actor_user_id(),account_id,$2,$3,$4::bigint,$5::timestamptz FROM account
          ON CONFLICT(owner_user_id,account_id,payee_key,cadence,amount_cents) DO UPDATE SET dismissed_at=excluded.dismissed_at
          RETURNING account_id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$5::timestamptz,'user','bill.suggestion-dismiss',
            jsonb_build_object('accountId',$1::text,'cadence',$3::text,'amountCents',$4::bigint) FROM saved RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM saved) AS applied`,
        [d.accountId, d.payeeKey, d.cadence, d.amountCents, at]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
