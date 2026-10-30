import type { AccountCloseBlocker, AccountLifecycleStore } from "./account-lifecycle.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
// The same facts serve review and the locked write; do not replace ledger proof with a mutable balance.
const facts = (source: "app.finance_accounts" | "reviewed") => `
  SELECT a.account_id,a.name,a.type,a.subtype,a.iso_currency,a.balance_cents::text,
    a.opening_balance_cents::text,a.opening_date::text,to_char(a.updated_at::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')||' UTC' AS balance_as_of,
    a.archived_at::text,a.last_reconciled_date::text,ledger.last_entry::text,
    a.opening_date <= $2::date AS opened,ledger.valid AS ledger_valid,ledger.future AS future_entries,
    a.opening_balance_cents::numeric-(CASE WHEN a.type IN ('credit','loan') THEN -1 ELSE 1 END)*ledger.movement=a.balance_cents AS ledger_matches,
    (a.last_reconciled_date=$2::date OR (ledger.n=0 AND a.opening_balance_cents=0)) AS statement_ready,
    (SELECT count(*) FROM app.finance_bill_plans p WHERE p.account_id=a.account_id
      AND (p.end_date IS NULL OR p.end_date>$2::date) AND (p.cadence<>'once' OR p.anchor_date>$2::date)) AS future_plans
  FROM ${source} a CROSS JOIN LATERAL (
    SELECT count(*) AS n,max(t.date) AS last_entry,
      coalesce(sum(t.amount_cents::numeric) FILTER (WHERE t.source='manual' AND NOT t.pending AND t.date <= $2::date),0) AS movement,
      coalesce(bool_and(t.source='manual' AND NOT t.pending AND t.iso_currency=a.iso_currency AND t.date>=a.opening_date
        AND t.amount_cents BETWEEN -9007199254740991 AND 9007199254740991),true) AS valid,
      coalesce(bool_or(t.date>$2::date),false) AS future
      FROM app.finance_transactions t WHERE t.account_id=a.account_id
  ) ledger WHERE a.account_id=$1 AND a.source='manual'`;
const closeEligible =
  "archived_at IS NULL AND opened AND balance_cents::numeric=0 AND ledger_valid AND ledger_matches AND NOT future_entries AND statement_ready AND future_plans=0";
export function accountLifecycleSqlStore(db: FinanceDb): AccountLifecycleStore {
  return {
    async review(accountId, today) {
      const result = await db.query<{
        account_id: string;
        name: string;
        type: string;
        subtype: string | null;
        iso_currency: string;
        balance_cents: string;
        opening_balance_cents: string;
        opening_date: string;
        balance_as_of: string;
        archived_at: string | null;
        last_reconciled_date: string | null;
        last_entry: string | null;
        revision: string;
        opened: boolean;
        ledger_valid: boolean;
        ledger_matches: boolean;
        future_entries: boolean;
        statement_ready: boolean;
        future_plans: string;
      }>(
        `WITH facts AS (${facts("app.finance_accounts")}) SELECT f.*,md5(f.account_id||':'||a.xmin::text) AS revision
        FROM facts f JOIN app.finance_accounts a ON a.account_id=f.account_id`,
        [accountId, today]
      );
      const row = result.rows[0];
      if (!row) return null;
      const balance = safeCents(row.balance_cents),
        plans = Number(row.future_plans),
        blockers: AccountCloseBlocker[] = [];
      if (!row.opened) blockers.push("not_open");
      if (balance !== 0) blockers.push("nonzero_balance");
      if (!row.ledger_valid || !row.ledger_matches) blockers.push("invalid_ledger");
      if (row.future_entries) blockers.push("future_entries");
      if (!row.statement_ready) blockers.push("unreconciled");
      if (plans > 0) blockers.push("future_plans");
      return {
        accountId: row.account_id,
        name: row.name,
        type: row.type,
        subtype: row.subtype,
        isoCurrency: row.iso_currency,
        balanceCents: balance,
        openingBalanceCents: safeCents(row.opening_balance_cents),
        openingDate: row.opening_date,
        balanceAsOf: row.balance_as_of,
        archivedAt: row.archived_at,
        lastReconciledDate: row.last_reconciled_date,
        lastEntryDate: row.last_entry,
        revision: row.revision,
        canClose: row.archived_at === null && blockers.length === 0,
        blockers,
        futurePlanCount: plans
      };
    },
    async update(input) {
      const result = await db.query<{ applied: boolean }>(
        `WITH reviewed AS MATERIALIZED (
        SELECT a.* FROM app.finance_accounts a WHERE account_id=$1 AND source='manual'
          AND md5(account_id||':'||xmin::text)=$3 ORDER BY account_id FOR UPDATE
        ), facts AS (${facts("reviewed")}), eligible AS (
          SELECT * FROM facts WHERE $4='rename' OR ($4='close' AND ${closeEligible}) OR ($4='reopen' AND archived_at IS NOT NULL)
        ), changed AS (
          UPDATE app.finance_accounts a SET name=CASE WHEN $4='rename' THEN $5::text ELSE a.name END,
            archived_at=CASE WHEN $4='close' THEN $6::timestamptz WHEN $4='reopen' THEN NULL ELSE a.archived_at END
            FROM eligible e WHERE a.account_id=e.account_id
              AND ($4<>'rename' OR a.name IS DISTINCT FROM $5::text) RETURNING a.account_id
        ), logged AS (
          INSERT INTO app.finance_activity(owner_user_id,id,at,actor,kind,params)
          SELECT app.current_actor_user_id(),gen_random_uuid(),$6::timestamptz,'user','account.'||$4::text,
            jsonb_build_object('accountId',account_id) FROM changed RETURNING id
        ) SELECT EXISTS(SELECT 1 FROM eligible) AS applied`,
        [
          input.accountId,
          input.today,
          input.expectedRevision,
          input.operation,
          input.name ?? null,
          input.at
        ]
      );
      return result.rows[0]?.applied === true;
    }
  };
}
