import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";
import { MAX_RECONCILE_ENTRIES, type ReconciliationStore } from "./reconciliation.js";

export function reconciliationSqlStore(db: FinanceDb): ReconciliationStore {
  return {
    async read(accountId, statementDate) {
      const result = await db.query<{
        account_id: string;
        name: string;
        iso_currency: string;
        type: string;
        opening_date: string;
        last_reconciled_date: string | null;
        ledger_revision: number;
        baseline: string;
        recorded: string;
        total: string;
        entries: { id: string; date: string; name: string; amount: string; cleared: boolean }[];
      }>(
        `SELECT a.account_id, a.name, a.iso_currency, a.type,
          a.opening_date::text, a.last_reconciled_date::text, a.ledger_revision,
          (a.opening_balance_cents::numeric +
            CASE WHEN a.type IN ('credit', 'loan') THEN 1 ELSE -1 END *
            COALESCE((SELECT sum(t.amount_cents) FROM app.finance_transactions t
              WHERE t.account_id = a.account_id AND t.source = 'manual' AND t.reconciled_at IS NOT NULL
              AND t.date <= $2::date), 0))::text AS baseline,
          (a.opening_balance_cents::numeric +
            CASE WHEN a.type IN ('credit', 'loan') THEN 1 ELSE -1 END *
            COALESCE((SELECT sum(t.amount_cents) FROM app.finance_transactions t
              WHERE t.account_id = a.account_id AND t.source = 'manual' AND t.date <= $2::date), 0))::text AS recorded,
          (SELECT count(*) FROM app.finance_transactions t WHERE t.account_id = a.account_id
            AND t.source = 'manual' AND t.reconciled_at IS NULL AND t.date <= $2::date)::text AS total,
          COALESCE((SELECT jsonb_agg(entry ORDER BY date, id) FROM (
            SELECT id, date::text, name, amount_cents::text AS amount, cleared
            FROM app.finance_transactions t WHERE t.account_id = a.account_id AND t.source = 'manual'
              AND t.reconciled_at IS NULL AND t.date <= $2::date
            ORDER BY date, id LIMIT ${MAX_RECONCILE_ENTRIES}
          ) entry), '[]'::jsonb) AS entries
        FROM app.finance_accounts a WHERE a.account_id = $1 AND a.source = 'manual' AND a.archived_at IS NULL`,
        [accountId, statementDate]
      );
      const row = result.rows[0];
      return row
        ? {
            accountId: row.account_id,
            name: row.name,
            isoCurrency: row.iso_currency,
            debt: ["credit", "loan"].includes(row.type),
            openingDate: row.opening_date,
            lastReconciledDate: row.last_reconciled_date,
            revision: row.ledger_revision,
            baselineCents: safeCents(row.baseline),
            recordedCents: safeCents(row.recorded),
            totalEntries: Number(row.total),
            entries: row.entries.map((entry) => ({
              id: entry.id,
              date: entry.date,
              name: entry.name,
              amountCents: safeCents(entry.amount),
              cleared: entry.cleared
            }))
          }
        : null;
    },
    async finish(input) {
      const result = await db.query<{ id: string }>(
        `WITH locked AS (
          SELECT * FROM app.finance_accounts WHERE account_id = $1 AND source = 'manual' FOR UPDATE
        ), eligible AS (
          SELECT a.account_id FROM locked a WHERE a.archived_at IS NULL AND a.iso_currency = $5
            AND a.ledger_revision = $6 AND $3::date >= a.opening_date
            AND (a.last_reconciled_date IS NULL OR $3::date > a.last_reconciled_date)
            AND (SELECT count(*) FROM app.finance_transactions t WHERE t.account_id = a.account_id
              AND t.source = 'manual' AND t.reconciled_at IS NULL AND t.date <= $3::date) <= ${MAX_RECONCILE_ENTRIES}
            AND (SELECT count(*) FROM app.finance_transactions t WHERE t.account_id = a.account_id
              AND t.source = 'manual' AND t.reconciled_at IS NULL AND t.date <= $3::date
              AND t.id = ANY($7::text[])) = cardinality($7::text[])
            AND COALESCE(a.last_reconciled_balance_cents, a.opening_balance_cents)::numeric +
              CASE WHEN a.type IN ('credit', 'loan') THEN 1 ELSE -1 END *
              COALESCE((SELECT sum(t.amount_cents) FROM app.finance_transactions t
                WHERE t.account_id = a.account_id AND t.source = 'manual' AND t.reconciled_at IS NULL
                  AND t.date <= $3::date AND t.id = ANY($7::text[])), 0) = $4::bigint
        ), receipt AS (
          INSERT INTO app.finance_reconciliations
            (owner_user_id, id, account_id, statement_date, balance_cents, entry_count, operation_digest, created_at)
          SELECT app.current_actor_user_id(), $2, account_id, $3::date, $4::bigint, cardinality($7::text[]), $8, $9::timestamptz
          FROM eligible ON CONFLICT (owner_user_id, id) DO NOTHING RETURNING id, account_id
        ), marked AS (
          UPDATE app.finance_transactions t SET cleared = t.id = ANY($7::text[]),
            reconciled_at = CASE WHEN t.id = ANY($7::text[]) THEN $9::timestamptz ELSE NULL END
          FROM receipt r WHERE t.account_id = r.account_id AND t.source = 'manual'
            AND t.reconciled_at IS NULL AND t.date <= $3::date RETURNING t.id
        ), updated AS (
          UPDATE app.finance_accounts a SET last_reconciled_date = $3::date,
            last_reconciled_balance_cents = $4::bigint, ledger_revision = a.ledger_revision + 1
          FROM receipt r WHERE a.account_id = r.account_id RETURNING a.account_id
        ), logged AS (
          INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params)
          SELECT app.current_actor_user_id(), gen_random_uuid(), $9::timestamptz, 'user',
            'account.reconcile', $10::jsonb FROM receipt r JOIN updated u ON r.account_id = u.account_id RETURNING id
        ) SELECT id FROM receipt`,
        [
          input.accountId,
          input.id,
          input.statementDate,
          input.balanceCents,
          input.isoCurrency,
          input.expectedRevision,
          input.selectedIds,
          input.digest,
          input.at,
          JSON.stringify({
            accountId: input.accountId,
            reconciliationId: input.id,
            statementDate: input.statementDate,
            balanceCents: input.balanceCents,
            entryCount: input.selectedIds.length
          })
        ]
      );
      if (result.rows.length) return "created";
      const prior = await db.query<{ operation_digest: string }>(
        "SELECT operation_digest FROM app.finance_reconciliations WHERE id = $1",
        [input.id]
      );
      return prior.rows[0]?.operation_digest === input.digest ? "unchanged" : "conflict";
    }
  };
}
