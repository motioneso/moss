import type { ImportStore } from "./csv-import.js";
import type { FinanceDb } from "./store-sql.js";
import { safeCents } from "./values.js";

// Conservative ASCII case folding and SQL whitespace normalization, identical for both sources.
const normalize = (column: string) =>
  `translate(btrim(regexp_replace(${column}, '[[:space:]]+', ' ', 'g')), 'ABCDEFGHIJKLMNOPQRSTUVWXYZ', 'abcdefghijklmnopqrstuvwxyz')`;
const rowset = `SELECT * FROM jsonb_to_recordset($2::jsonb) AS r("sourceRow" integer, date date, name text, "amountCents" bigint, notes text, "allowDuplicate" boolean)`;
const duplicate = `(EXISTS (SELECT 1 FROM app.finance_transactions t WHERE t.account_id = $1
  AND t.date = r.date AND t.amount_cents = r."amountCents" AND t.iso_currency = a.iso_currency
  AND ${normalize("t.name")} = ${normalize("r.name")}) OR EXISTS (SELECT 1 FROM rows other
  WHERE other."sourceRow" <> r."sourceRow" AND other.date = r.date AND other."amountCents" = r."amountCents"
  AND ${normalize("other.name")} = ${normalize("r.name")}))`;
export function importSqlStore(db: FinanceDb): ImportStore {
  return {
    async preview(accountId, rows) {
      const result = await db.query<{
        account_id: string;
        iso_currency: string;
        opening_date: string;
        last_reconciled_date: string | null;
        ledger_revision: number;
        balance_cents: string;
        type: string;
        duplicates: number[];
      }>(
        `WITH rows AS (${rowset}) SELECT a.account_id, a.iso_currency, a.opening_date::text,
        a.last_reconciled_date::text, a.ledger_revision, a.balance_cents::text, a.type,
        ARRAY(SELECT r."sourceRow" FROM rows r WHERE ${duplicate} ORDER BY r."sourceRow") AS duplicates
        FROM app.finance_accounts a WHERE a.account_id = $1 AND a.source = 'manual' AND a.archived_at IS NULL`,
        [accountId, JSON.stringify(rows)]
      );
      const row = result.rows[0];
      return row
        ? {
            accountId: row.account_id,
            isoCurrency: row.iso_currency,
            openingDate: row.opening_date,
            lastReconciledDate: row.last_reconciled_date,
            revision: row.ledger_revision,
            balanceCents: safeCents(row.balance_cents),
            debt: ["credit", "loan"].includes(row.type),
            duplicateRows: row.duplicates
          }
        : null;
    },
    async apply(input) {
      const result = await db.query<{ id: string }>(
        `WITH rows AS (${rowset}), locked AS (
        SELECT * FROM app.finance_accounts WHERE account_id = $1 AND source = 'manual' FOR UPDATE
      ), eligible AS (
        SELECT a.account_id, a.balance_cents::numeric + CASE WHEN a.type IN ('credit', 'loan') THEN 1 ELSE -1 END *
          (SELECT sum("amountCents"::numeric) FROM rows) AS balance FROM locked a
        WHERE a.archived_at IS NULL AND a.iso_currency = $4 AND a.ledger_revision = $5
          AND (SELECT count(*) FROM rows) BETWEEN 1 AND 200
          AND (SELECT count(DISTINCT "sourceRow") FROM rows) = (SELECT count(*) FROM rows)
          AND NOT EXISTS (SELECT 1 FROM rows r WHERE r.date < a.opening_date
            OR r.date <= a.last_reconciled_date OR r."amountCents" = 0
            OR r."amountCents" NOT BETWEEN -9007199254740991 AND 9007199254740991
            OR r."sourceRow" NOT BETWEEN 1 AND 200 OR (NOT r."allowDuplicate" AND ${duplicate}))
      ), receipt AS (
        INSERT INTO app.finance_imports (owner_user_id, id, account_id, entry_count, operation_digest, created_at)
        SELECT app.current_actor_user_id(), $3, account_id, (SELECT count(*) FROM rows), $7, $8::timestamptz
          FROM eligible WHERE balance BETWEEN -9007199254740991 AND 9007199254740991
        ON CONFLICT (owner_user_id, id) DO NOTHING RETURNING id, account_id
      ), inserted AS (
        INSERT INTO app.finance_transactions
          (owner_user_id, id, account_id, date, name, amount_cents, iso_currency, notes, pending,
           categorized_by, review_state, source, entry_digest, cleared)
        SELECT app.current_actor_user_id(), receipt.id || ':' || r."sourceRow", receipt.account_id,
          r.date, r.name, r."amountCents", $4, NULLIF(r.notes, ''), false, 'user', 'needs_look', 'manual', $7, $6
        FROM receipt CROSS JOIN rows r RETURNING id
      ), updated AS (
        UPDATE app.finance_accounts a SET balance_cents = e.balance::bigint,
          ledger_revision = a.ledger_revision + 1, updated_at = $8
        FROM receipt r JOIN eligible e ON e.account_id = r.account_id
        WHERE a.account_id = r.account_id AND (SELECT count(*) FROM inserted) = (SELECT count(*) FROM rows)
        RETURNING a.account_id
      ), logged AS (
        INSERT INTO app.finance_activity (owner_user_id, id, at, actor, kind, params)
        SELECT app.current_actor_user_id(), gen_random_uuid(), $8::timestamptz, 'user', 'transaction.import',
          $9::jsonb FROM receipt r JOIN updated u ON u.account_id = r.account_id RETURNING id
      ) SELECT id FROM receipt`,
        [
          input.accountId,
          JSON.stringify(input.rows),
          input.id,
          input.isoCurrency,
          input.expectedRevision,
          input.cleared,
          input.digest,
          input.at,
          JSON.stringify({
            accountId: input.accountId,
            importId: input.id,
            entryCount: input.rows.length
          })
        ]
      );
      if (result.rows.length) return "created";
      // A replay remains valid after subsequent postings/reconciliations change the revision.
      const prior = await db.query<{ operation_digest: string }>(
        "SELECT operation_digest FROM app.finance_imports WHERE id = $1",
        [input.id]
      );
      return prior.rows[0]?.operation_digest === input.digest ? "unchanged" : "conflict";
    }
  };
}
